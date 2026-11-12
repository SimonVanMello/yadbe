import { showError } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type SearchEdit, type YadbeError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { showJournalEntry } from '../journal/journalStore';
import { fetchIndexPage } from './indexActions';
import { getIndexTab } from './indexStore';
import {
  afterApply,
  changeSetOf,
  documentError,
  duplicateTarget,
  hitRefOf,
  rebase,
  stage,
  unstage,
  type HitRef,
} from './searchEditModel';
import {
  getSearchEditTab,
  patchApplyDialog,
  patchEditor,
  useSearchEditStore,
  type DocEditor,
} from './searchEditStore';

function tr(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

function errorOf(error: unknown): YadbeError | null {
  return error instanceof YadbeIpcError ? error.error : null;
}

/** The connection and target of an index tab. */
function tabTarget(tabId: string): { connectionId: string; target: string } | null {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab?.connectionId && tab.table
    ? { connectionId: tab.connectionId, target: tab.table.name }
    : null;
}

/** Reads what the edits of the tab can do (read-only, data streams, blocks). */
export async function loadEditInfo(tabId: string): Promise<void> {
  const target = tabTarget(tabId);
  if (!target) return;
  try {
    const info = await unwrap(ipc.commands.searchEditInfo(target.connectionId, target.target));
    useSearchEditStore.getState().patchTab(tabId, { info });
  } catch (error) {
    // Without it the backend still refuses what it must; the menus only lose their reasons.
    if (!errorOf(error)) showError(error);
  }
}

/** The hit `index` / `id` of the page shown, read whole (its version, routing, `_source`). */
export async function findHit(tabId: string, index: string, id: string): Promise<HitRef | null> {
  const page = getIndexTab(tabId).page;
  if (!page) return null;
  const { documentsId, count } = page.documents;
  for (let offset = 0; offset < count; offset += 500) {
    const texts = await unwrap(
      ipc.commands.searchFetchDocuments(documentsId, offset, Math.min(500, count - offset)),
    );
    for (const text of texts) {
      const hit = hitRefOf(text);
      if (hit && hit.index === index && hit.id === id) return hit;
    }
  }
  return null;
}

/** Hit number `document` of the page shown. */
export async function hitAt(tabId: string, document: number): Promise<HitRef | null> {
  const page = getIndexTab(tabId).page;
  if (!page) return null;
  const [text] = await unwrap(
    ipc.commands.searchFetchDocuments(page.documents.documentsId, document, 1),
  );
  return text === undefined ? null : hitRefOf(text);
}

function openEditor(editor: Omit<DocEditor, 'loading' | 'error'>, load: boolean): void {
  useSearchEditStore.setState({ editor: { ...editor, loading: load, error: null } });
}

/** Opens `hit` in the editor, read again by id (exact numbers, current version). */
export async function editHit(tabId: string, hit: HitRef): Promise<void> {
  const target = tabTarget(tabId);
  if (!target) return;
  openEditor(
    {
      tabId,
      connectionId: target.connectionId,
      mode: 'edit',
      index: hit.index,
      id: hit.id,
      routing: hit.routing ?? '',
      text: '',
      guard: hit.guard,
      changedSince: false,
    },
    true,
  );
  try {
    const version = await unwrap(
      ipc.commands.searchGetDocument(target.connectionId, hit.index, hit.id, hit.routing),
    );
    if (!version.found || version.source === null) {
      patchEditor({
        loading: false,
        error: {
          code: 'objectNotFound',
          message: {
            en: translate('en', 'search.edit.editor.gone'),
            fr: translate('fr', 'search.edit.editor.gone'),
          },
          action: null,
          detail: null,
        },
      });
      return;
    }
    patchEditor({
      loading: false,
      text: version.source,
      guard: version.guard,
      changedSince:
        hit.guard !== null &&
        version.guard !== null &&
        (hit.guard.seqNo !== version.guard.seqNo ||
          hit.guard.primaryTerm !== version.guard.primaryTerm),
    });
  } catch (error) {
    patchEditor({ loading: false, error: errorOf(error) });
    if (!errorOf(error)) showError(error);
  }
}

/** Opens a copy of `hit` as a new document (same routing, no id: the server picks one). */
export async function duplicateHit(tabId: string, hit: HitRef): Promise<void> {
  const target = tabTarget(tabId);
  if (!target) return;
  const info = getSearchEditTab(tabId).info;
  openEditor(
    {
      tabId,
      connectionId: target.connectionId,
      mode: 'create',
      index: duplicateTarget(info, hit),
      id: '',
      routing: hit.routing ?? '',
      text: '',
      guard: null,
      changedSince: false,
    },
    true,
  );
  try {
    const version = await unwrap(
      ipc.commands.searchGetDocument(target.connectionId, hit.index, hit.id, hit.routing),
    );
    patchEditor({ loading: false, text: version.source ?? '{\n  \n}' });
  } catch (error) {
    patchEditor({ loading: false, error: errorOf(error) });
  }
}

/** Opens an empty document to add, in the first place the tab can write to. */
export function newDocument(tabId: string): void {
  const target = tabTarget(tabId);
  const info = getSearchEditTab(tabId).info;
  if (!target || !info) return;
  openEditor(
    {
      tabId,
      connectionId: target.connectionId,
      mode: 'create',
      index: info.createTargets[0] ?? target.target,
      id: '',
      routing: '',
      text: '{\n  \n}',
      guard: null,
      changedSince: false,
    },
    false,
  );
}

export function closeEditor(): void {
  useSearchEditStore.setState({ editor: null });
}

/** Stages what the editor holds; `false` when the text is not a JSON object. */
export function stageEditor(): boolean {
  const editor = useSearchEditStore.getState().editor;
  if (!editor || documentError(editor.text) !== null) return false;
  const routing = editor.routing.trim() === '' ? null : editor.routing.trim();
  let edit: SearchEdit;
  if (editor.mode === 'edit') {
    if (!editor.guard) return false;
    edit = {
      kind: 'replace',
      index: editor.index,
      id: editor.id,
      routing,
      guard: editor.guard,
      source: editor.text,
    };
  } else {
    edit = {
      kind: 'create',
      index: editor.index,
      id: editor.id.trim() === '' ? null : editor.id.trim(),
      routing,
      source: editor.text,
    };
  }
  const tab = getSearchEditTab(editor.tabId);
  useSearchEditStore.getState().patchTab(editor.tabId, { pending: stage(tab.pending, edit) });
  closeEditor();
  return true;
}

/** Stages the deletion of `hit` at the version the page read. */
export async function deleteHit(tabId: string, hit: HitRef): Promise<void> {
  let guard = hit.guard;
  if (!guard) {
    const target = tabTarget(tabId);
    if (!target) return;
    try {
      const version = await unwrap(
        ipc.commands.searchGetDocument(target.connectionId, hit.index, hit.id, hit.routing),
      );
      guard = version.guard;
    } catch (error) {
      showError(error);
      return;
    }
  }
  if (!guard) return;
  const tab = getSearchEditTab(tabId);
  useSearchEditStore.getState().patchTab(tabId, {
    pending: stage(tab.pending, {
      kind: 'delete',
      index: hit.index,
      id: hit.id,
      routing: hit.routing,
      guard,
    }),
  });
}

export function unstageDoc(tabId: string, key: string): void {
  const tab = getSearchEditTab(tabId);
  useSearchEditStore.getState().patchTab(tabId, { pending: unstage(tab.pending, key) });
}

export function discardPending(tabId: string): void {
  useSearchEditStore.getState().patchTab(tabId, { pending: [] });
}

async function loadPreview(): Promise<void> {
  const dialog = useSearchEditStore.getState().dialog;
  if (!dialog) return;
  patchApplyDialog({ status: 'loading', preview: null, outcome: null, error: null });
  try {
    const preview =
      dialog.source.kind === 'revert'
        ? (
            await unwrap(
              ipc.commands.searchPreviewRevert(dialog.connectionId, dialog.source.entryId),
            )
          ).preview
        : await unwrap(ipc.commands.searchPreviewChanges(dialog.connectionId, dialog.changes));
    patchApplyDialog({ status: 'ready', preview });
  } catch (error) {
    patchApplyDialog({ status: 'failed', error: errorOf(error) });
    if (!errorOf(error)) showError(error);
  }
}

/** Opens the apply dialog on the tab's pending edits: the requests as they will be sent. */
export async function openSearchApply(tabId: string): Promise<void> {
  const target = tabTarget(tabId);
  const { pending } = getSearchEditTab(tabId);
  if (!target || pending.length === 0) return;
  useSearchEditStore.setState({
    dialog: {
      source: { kind: 'tab', tabId },
      connectionId: target.connectionId,
      changes: changeSetOf(target.target, pending),
      status: 'loading',
      preview: null,
      outcome: null,
      error: null,
    },
  });
  await loadPreview();
}

/** Opens the revert of a search journal entry. */
export async function openSearchRevert(connectionId: string, entryId: number): Promise<void> {
  useSearchEditStore.setState({
    dialog: {
      source: { kind: 'revert', entryId },
      connectionId,
      changes: { target: '', edits: [] },
      status: 'loading',
      preview: null,
      outcome: null,
      error: null,
    },
  });
  try {
    const revert = await unwrap(ipc.commands.searchPreviewRevert(connectionId, entryId));
    patchApplyDialog({ status: 'ready', changes: revert.changes, preview: revert.preview });
  } catch (error) {
    patchApplyDialog({ status: 'failed', error: errorOf(error) });
  }
}

export function closeSearchApply(): void {
  useSearchEditStore.setState({ dialog: null });
}

/** Re-reads the page an index tab shows, after documents changed. */
function refreshTab(tabId: string): void {
  const page = getIndexTab(tabId).page;
  void fetchIndexPage(tabId, page?.page ?? 0);
}

/** Applies what the dialog shows, one document at a time. */
export async function applySearchDialog(): Promise<void> {
  const dialog = useSearchEditStore.getState().dialog;
  if (!dialog || dialog.status !== 'ready') return;
  patchApplyDialog({ status: 'applying', error: null });
  try {
    const outcome = await unwrap(
      dialog.source.kind === 'revert'
        ? ipc.commands.searchApplyRevert(dialog.connectionId, dialog.source.entryId)
        : ipc.commands.searchApplyChanges(dialog.connectionId, dialog.changes),
    );
    if (dialog.source.kind === 'tab') {
      const { tabId } = dialog.source;
      const tab = getSearchEditTab(tabId);
      useSearchEditStore.getState().patchTab(tabId, { pending: afterApply(tab.pending, outcome) });
      if (outcome.applied.length > 0) refreshTab(tabId);
    } else {
      // A revert changes documents an open tab may show.
      for (const [tabId, state] of Object.entries(useSearchEditStore.getState().tabs)) {
        if (state.info !== null && tabTarget(tabId)?.connectionId === dialog.connectionId) {
          refreshTab(tabId);
        }
      }
    }
    if (outcome.stopped === null) {
      closeSearchApply();
      const journalId = outcome.journalId;
      toast({
        variant: 'success',
        title: tr(
          dialog.source.kind === 'revert' ? 'search.edit.reverted' : 'search.edit.applied',
          { count: outcome.applied.length },
        ),
        description:
          outcome.notVisible.length > 0
            ? tr('search.edit.notVisible', { indices: outcome.notVisible.join(', ') })
            : undefined,
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
      return;
    }
    patchApplyDialog({ status: 'done', outcome });
  } catch (error) {
    patchApplyDialog({ status: 'ready', error: errorOf(error) });
    if (!errorOf(error)) showError(error);
  }
}

/**
 * After a conflict: keep my edit, written over the server's version now (it becomes the
 * version the edit is guarded by), then preview again.
 */
export async function keepMine(): Promise<void> {
  const dialog = useSearchEditStore.getState().dialog;
  const stop = dialog?.outcome?.stopped;
  if (!dialog || dialog.source.kind !== 'tab' || stop?.reason.kind !== 'conflict') return;
  const guard = stop.reason.conflict.current?.guard;
  if (!guard) return;
  const { tabId } = dialog.source;
  // The stopped edit is the first one left pending.
  const pending = rebase(getSearchEditTab(tabId).pending, 0, guard);
  useSearchEditStore.getState().patchTab(tabId, { pending });
  const target = tabTarget(tabId);
  if (!target) return;
  patchApplyDialog({ changes: changeSetOf(target.target, pending) });
  await loadPreview();
}

/** After a conflict: drop my edit of that document, keep the server's version. */
export async function takeTheirs(): Promise<void> {
  const dialog = useSearchEditStore.getState().dialog;
  if (!dialog || dialog.source.kind !== 'tab') return;
  const { tabId } = dialog.source;
  const [first, ...rest] = getSearchEditTab(tabId).pending;
  if (!first) return;
  useSearchEditStore.getState().patchTab(tabId, { pending: rest });
  const target = tabTarget(tabId);
  if (rest.length === 0 || !target) {
    closeSearchApply();
    return;
  }
  patchApplyDialog({ changes: changeSetOf(target.target, rest) });
  await loadPreview();
}

export function forgetSearchEdits(tabId: string): void {
  useSearchEditStore.getState().forget(tabId);
}
