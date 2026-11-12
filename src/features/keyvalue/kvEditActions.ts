import { confirm } from '../../app/errors/confirmStore';
import { addCloseGuard, useTabsStore } from '../../app/tabs/tabsStore';
import { localize, showError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import {
  ipc,
  unwrap,
  YadbeIpcError,
  type KvApplyOutcome,
  type KvBytes,
  type KvChangeSet,
  type KvConflict,
  type KvEdit,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { showJournalEntry } from '../journal/journalStore';
import { getPreference } from '../preferences/preferenceStore';
import { findConnection } from '../query/connectionLookup';
import { kvKeys } from './kvKeys';
import { rebase, upsert } from './kvEditModel';
import { patchDialog, patchTab, tabEdits, useKvEditStore, type KvApplySource } from './kvEditStore';
import { tr } from './kvText';

/** "Keep mine", "take theirs" (drop the edit) or "keep editing" for one conflict. */
export type KvConflictChoice = 'mine' | 'theirs' | 'edit';

/** Starts following the pending edits of a key tab (when it opens). */
export function initTabEdits(
  tabId: string,
  connectionId: string,
  database: number,
  key: KvBytes,
): void {
  if (tabEdits(tabId)) return;
  useKvEditStore.setState((state) => ({
    tabs: { ...state.tabs, [tabId]: { connectionId, database, key, edits: [], round: 0 } },
  }));
}

/** The tab of a key that was just deleted goes. */
export function closeKeyTabIfGone(tabId: string): void {
  dropTabEdits(tabId);
  useTabsStore.getState().closeTabsNow([tabId]);
}

let guarded = false;

/**
 * Closing a key tab with pending edits asks first, as a table tab does; the edits of the
 * tabs that close go.
 */
export function installKvCloseGuard(): void {
  if (guarded) return;
  guarded = true;
  addCloseGuard(async (ids) => {
    const pending = ids.filter((id) => (tabEdits(id)?.edits.length ?? 0) > 0);
    if (pending.length > 0) {
      const ok = await confirm({
        title: tr('keyValue.edit.discardTitle'),
        description: tr('keyValue.edit.discardDescription', { count: pending.length }),
        confirmLabel: tr('keyValue.edit.discardConfirm'),
        danger: true,
      });
      if (!ok) return false;
    }
    for (const id of ids) if (tabEdits(id)) dropTabEdits(id);
    return true;
  });
}

/** Forgets a closed tab's pending edits. */
export function dropTabEdits(tabId: string): void {
  useKvEditStore.setState((state) => ({
    tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)),
  }));
}

/** Buffers an edit (F-084 for keys): nothing is sent before Apply. */
export function stageEdit(tabId: string, edit: KvEdit): void {
  const tab = tabEdits(tabId);
  if (!tab) return;
  patchTab(tabId, { edits: upsert(tab.edits, edit) });
}

export function unstageEdit(tabId: string, index: number): void {
  const tab = tabEdits(tabId);
  if (!tab) return;
  patchTab(tabId, { edits: tab.edits.filter((_, i) => i !== index) });
}

export function discardEdits(tabId: string): void {
  patchTab(tabId, { edits: [] });
}

/** The key tab reads its key again (after an apply or a refresh). */
export function rereadTab(tabId: string): void {
  const tab = tabEdits(tabId);
  if (tab) patchTab(tabId, { round: tab.round + 1 });
}

function sourceSet(tabId: string): KvChangeSet | null {
  const tab = tabEdits(tabId);
  if (!tab || tab.edits.length === 0) return null;
  return { database: tab.database, edits: tab.edits };
}

/** Production connections always show the commands first; elsewhere the preference decides. */
export function mustPreviewKeys(connectionId: string): boolean {
  return (
    findConnection(connectionId)?.environment === 'prod' || getPreference('previewBeforeApply')
  );
}

async function loadPreview(source: KvApplySource, set: KvChangeSet | null): Promise<void> {
  const result =
    source.kind === 'revert'
      ? await ipc.commands.kvPreviewRevert(source.connectionId, source.entryId)
      : set
        ? await ipc.commands.kvPreviewChanges(dialogConnection(), set)
        : null;
  if (!result) return;
  if (result.status === 'error') {
    patchDialog({ status: 'failed', error: result.error });
    return;
  }
  patchDialog({ status: 'ready', preview: result.data, dangers: result.data.dangers });
}

function dialogConnection(): string {
  return useKvEditStore.getState().dialog?.connectionId ?? '';
}

/** Opens the apply dialog on a key tab's pending edits: their commands, then Apply. */
export async function previewTab(tabId: string): Promise<void> {
  const tab = tabEdits(tabId);
  const set = sourceSet(tabId);
  if (!tab || !set) return;
  useKvEditStore.setState({
    dialog: {
      source: { kind: 'tab', tabId },
      connectionId: tab.connectionId,
      database: tab.database,
      status: 'loading',
      preview: null,
      error: null,
      dangers: [],
      conflicts: [],
      edits: tab.edits,
    },
  });
  await loadPreview({ kind: 'tab', tabId }, set);
}

/** Apply from the tab: straight away, unless the preview must be shown first. */
export async function applyTab(tabId: string): Promise<void> {
  const tab = tabEdits(tabId);
  if (!tab || tab.edits.length === 0) return;
  if (mustPreviewKeys(tab.connectionId)) {
    await previewTab(tabId);
    return;
  }
  useKvEditStore.setState({
    dialog: null,
  });
  await runApply({ kind: 'tab', tabId }, false, tab.connectionId, tab.database, tab.edits);
}

/** "Revert this change set" of a key-value journal entry: the inverse, reviewed first. */
export async function openKvRevert(connectionId: string, entryId: number): Promise<void> {
  useKvEditStore.setState({
    dialog: {
      source: { kind: 'revert', connectionId, entryId },
      connectionId,
      database: 0,
      status: 'loading',
      preview: null,
      error: null,
      dangers: [],
      conflicts: [],
      edits: [],
    },
  });
  await loadPreview({ kind: 'revert', connectionId, entryId }, null);
}

export function closeApplyDialog(): void {
  useKvEditStore.setState({ dialog: null });
}

/** Applies what the dialog shows (`confirmed`: its dangers were confirmed). */
export async function applyDialog(confirmed: boolean): Promise<void> {
  const dialog = useKvEditStore.getState().dialog;
  if (!dialog) return;
  const edits = dialog.source.kind === 'tab' ? (tabEdits(dialog.source.tabId)?.edits ?? []) : [];
  patchDialog({ status: 'applying' });
  await runApply(dialog.source, confirmed, dialog.connectionId, dialog.database, edits);
}

async function runApply(
  source: KvApplySource,
  confirmed: boolean,
  connectionId: string,
  database: number,
  edits: KvEdit[],
): Promise<void> {
  const result =
    source.kind === 'revert'
      ? await ipc.commands.kvApplyRevert(source.connectionId, source.entryId)
      : await ipc.commands.kvApplyChanges(connectionId, { database, edits }, confirmed);
  const open = () => useKvEditStore.getState().dialog;
  const show = (patch: Parameters<typeof patchDialog>[0]) => {
    if (!open()) {
      useKvEditStore.setState({
        dialog: {
          source,
          connectionId,
          database,
          status: 'loading',
          preview: null,
          error: null,
          dangers: [],
          conflicts: [],
          edits,
        },
      });
    }
    patchDialog(patch);
  };
  if (result.status === 'error') {
    show({ status: 'failed', error: result.error });
    return;
  }
  const outcome = result.data;
  switch (outcome.status) {
    case 'needsConfirmation':
      show({ status: 'confirm', dangers: outcome.dangers });
      if (!open()?.preview) await loadPreview(source, { database, edits });
      patchDialog({ status: 'confirm' });
      return;
    case 'conflicted':
      show({ status: 'conflicted', conflicts: outcome.conflicts, edits });
      return;
    case 'applied':
      closeApplyDialog();
      afterApply(
        connectionId,
        outcome,
        source.kind === 'tab' ? source.tabId : null,
        source.kind === 'revert' ? tr('journal.revert.done') : tr('keyValue.edit.applied'),
      );
      return;
  }
}

/** What an apply leaves to do: the tab re-reads its key, the explorer its keys, a toast. */
function afterApply(
  connectionId: string,
  outcome: Extract<KvApplyOutcome, { status: 'applied' }>,
  tabId: string | null,
  title: string,
): void {
  if (tabId !== null) discardEdits(tabId);
  refreshKeys(connectionId, outcome.database);
  const journalId = outcome.journalId;
  toast({
    variant: 'success',
    title,
    ...(journalId !== null
      ? {
          action: {
            label: tr('journal.showEntry'),
            onClick: () => {
              showJournalEntry(journalId);
            },
          },
        }
      : {}),
  });
}

/** What the key tabs and the explorer show of a database is read again. */
export function refreshKeys(connectionId: string, database: number): void {
  void queryClient.invalidateQueries({ queryKey: ['kvKeyInfo', connectionId, database] });
  void queryClient.invalidateQueries({ queryKey: ['kvSummary', connectionId, database] });
  void queryClient.invalidateQueries({ queryKey: kvKeys.databases(connectionId) });
  void queryClient.invalidateQueries({ queryKey: kvKeys.levels(connectionId, database) });
  for (const [tabId, tab] of Object.entries(useKvEditStore.getState().tabs)) {
    if (tab?.connectionId === connectionId && tab.database === database) rereadTab(tabId);
  }
}

/**
 * Settles the conflicts of a tab's apply: "keep mine" applies the edit over what the server
 * holds now, "take theirs" drops it, "keep editing" leaves the edit for the user. Then the
 * preview of what is left.
 */
export async function resolveConflicts(
  choices: ReadonlyMap<number, KvConflictChoice>,
): Promise<void> {
  const dialog = useKvEditStore.getState().dialog;
  if (dialog?.source.kind !== 'tab') {
    closeApplyDialog();
    return;
  }
  const tabId = dialog.source.tabId;
  const byEdit = new Map<number, KvConflict>(dialog.conflicts.map((c) => [c.edit, c]));
  const next: KvEdit[] = [];
  let editing = false;
  for (const [index, edit] of dialog.edits.entries()) {
    const conflict = byEdit.get(index);
    const choice = conflict ? (choices.get(index) ?? 'edit') : null;
    if (!conflict || choice === null) {
      next.push(edit);
    } else if (choice === 'mine') {
      const mine = rebase(edit, conflict);
      if (mine) next.push(mine);
    } else if (choice === 'edit') {
      editing = true;
      next.push(edit);
    }
  }
  patchTab(tabId, { edits: next });
  // The tab shows the server's values again under the edits kept.
  rereadTab(tabId);
  if (editing || next.length === 0) {
    closeApplyDialog();
    return;
  }
  await previewTab(tabId);
}

/**
 * A change applied at once from the explorer or a key tab (delete, rename, copy, create):
 * confirmed with its commands and measured effect, then applied. A conflict is reported.
 * Resolves to the outcome when it applied.
 */
export async function applyNow(
  connectionId: string,
  changes: KvChangeSet,
  ask: { title: string; confirmLabel: string; danger: boolean },
): Promise<Extract<KvApplyOutcome, { status: 'applied' }> | 'conflicted' | null> {
  const connection = findConnection(connectionId);
  let preview;
  try {
    preview = await unwrap(ipc.commands.kvPreviewChanges(connectionId, changes));
  } catch (error) {
    showError(error, { title: tr('keyValue.edit.failed') });
    return null;
  }
  const ok = await confirm({
    title: ask.title,
    description:
      preview.dangers.length > 0
        ? preview.dangers.map((d) => localize(d.effect)).join(' ')
        : tr('keyValue.edit.confirmDescription', { count: preview.commands }),
    statement: preview.lines.map((l) => l.text).join('\n'),
    confirmLabel: ask.confirmLabel,
    danger: ask.danger || preview.dangers.length > 0,
    ...(connection ? { connection } : {}),
  });
  if (!ok) return null;
  let outcome: KvApplyOutcome;
  try {
    outcome = await unwrap(ipc.commands.kvApplyChanges(connectionId, changes, true));
  } catch (error) {
    showError(error, { title: tr('keyValue.edit.failed') });
    return null;
  }
  if (outcome.status === 'applied') {
    afterApply(connectionId, outcome, null, tr('keyValue.edit.applied'));
    return outcome;
  }
  if (outcome.status === 'conflicted') return 'conflicted';
  return null;
}

/** The error of a failed command, for a dialog. */
export function errorOf(error: unknown) {
  return error instanceof YadbeIpcError ? error.error : null;
}
