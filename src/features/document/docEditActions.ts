import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { addCloseGuard, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type DocApplyOutcome, type DocConflict } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { tr } from '../keyvalue/kvText';
import { showJournalEntry } from '../journal/journalStore';
import { fetchPage } from './collectionActions';
import { getCollectionTab } from './collectionStore';
import {
  addDocument,
  compactJson,
  deleteDocuments,
  duplicateOf,
  editableText,
  effective,
  keepMine,
  pendingCount,
  removeInsert,
  replaceDocument,
  revertDocument,
  setField,
  toChangeSet,
  undelete,
  updateInsert,
  valueAt,
  withId,
  withoutApplied,
  type DocEdits,
  type Path,
  type Target,
} from './docEditModel';
import {
  dropTabDocEdits,
  patchDocDialog,
  setTabDocEdits,
  tabDocEdits,
  useDocEditStore,
  type DocApplySource,
} from './docEditStore';
import { parseJson } from '../grid/jsonTree';

/** Why the documents of a collection tab cannot be changed (an i18n key), or `null`. */
export type EditBlock =
  | 'mongo.edit.blocked.readOnly'
  | 'mongo.edit.blocked.view'
  | 'mongo.edit.blocked.timeseries'
  | 'mongo.edit.blocked.system'
  | 'mongo.edit.blocked.projection';

function tabOf(tabId: string) {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab?.connectionId && tab.table
    ? { connectionId: tab.connectionId, table: tab.table }
    : null;
}

/** Why the tab's documents cannot be changed now, or `null` when they can. */
export function editBlockOf(tabId: string, readOnly: boolean): EditBlock | null {
  const target = tabOf(tabId);
  const state = getCollectionTab(tabId);
  if (readOnly) return 'mongo.edit.blocked.readOnly';
  if (state.info?.kind === 'view') return 'mongo.edit.blocked.view';
  if (state.info?.kind === 'timeseries') return 'mongo.edit.blocked.timeseries';
  if (target?.table.name.startsWith('system.')) return 'mongo.edit.blocked.system';
  if (state.applied.projection.trim() !== '') return 'mongo.edit.blocked.projection';
  return null;
}

function update(tabId: string, next: DocEdits | null): boolean {
  if (next === null) {
    toast({ variant: 'warning', title: tr('mongo.edit.unreachable') });
    return false;
  }
  setTabDocEdits(tabId, next);
  return true;
}

/** Document `row` of the tab's page as read (its `_id` and whole text), or `null`. */
export async function targetOf(tabId: string, row: number): Promise<Target | null> {
  const page = getCollectionTab(tabId).page;
  const id = page?.ids[row];
  if (!page || id === undefined || id === null) return null;
  const [original] = await unwrap(
    ipc.commands.mongoFetchDocuments(page.documents.documentsId, row, 1),
  );
  return original === undefined ? null : { id, original };
}

/** The value at `path` with the pending edits, Extended JSON (`null`: missing). */
function currentValue(tabId: string, target: Target, path: Path): string | null {
  const edit = tabDocEdits(tabId).documents.get(target.id);
  const doc = edit ? effective(edit) : parseJson(target.original);
  const node = valueAt(doc ?? undefined, path);
  return node === undefined ? null : compactJson(node);
}

/** Opens the field editor on `path` of a document (`adding`: a new field inside `path`). */
export function editField(tabId: string, target: Target, path: Path, adding = false): void {
  useDocEditStore.setState({
    form: {
      kind: 'field',
      tabId,
      target,
      path,
      adding,
      current: adding ? null : currentValue(tabId, target, path),
    },
  });
}

/** Opens the JSON editor on a whole document. */
export function editDocument(tabId: string, target: Target): void {
  const edit = tabDocEdits(tabId).documents.get(target.id);
  const doc = edit ? effective(edit) : parseJson(target.original);
  useDocEditStore.setState({
    form: {
      kind: 'json',
      tabId,
      mode: 'replace',
      target,
      path: [],
      insertKey: null,
      text: editableText(compactJson(doc ?? parseJson(target.original))),
    },
  });
}

/** Opens the JSON editor on the value at `path` (a sub-document, an array). */
export function editValueAsJson(tabId: string, target: Target, path: Path): void {
  const value = currentValue(tabId, target, path);
  useDocEditStore.setState({
    form: {
      kind: 'json',
      tabId,
      mode: 'value',
      target,
      path,
      insertKey: null,
      text: value === null ? '{}' : editableText(value),
    },
  });
}

/** Opens the JSON editor on a new document (`text`: to start from, e.g. a duplicate). */
export function newDocument(
  tabId: string,
  text = '{\n  \n}',
  insertKey: number | null = null,
): void {
  useDocEditStore.setState({
    form: { kind: 'json', tabId, mode: 'insert', target: null, path: [], insertKey, text },
  });
}

export function closeForm(): void {
  useDocEditStore.setState({ form: null });
}

/** Stages a field's new value (`null`: unset). `false`: refused (shown). */
export function stageField(
  tabId: string,
  target: Target,
  path: Path,
  value: string | null,
): boolean {
  return update(tabId, setField(tabDocEdits(tabId), target, path, value));
}

/** Stages what the JSON editor holds; throws on text that is not a JSON document. */
export function stageJson(form: {
  tabId: string;
  mode: 'insert' | 'replace' | 'value';
  target: Target | null;
  path: Path;
  insertKey: number | null;
  text: string;
}): boolean {
  const { tabId, target } = form;
  const node = parseJson(form.text);
  const text = compactJson(node);
  switch (form.mode) {
    case 'insert': {
      if (node.type !== 'object') throw new Error('not a document');
      const document = compactJson(withId(node));
      const edits = tabDocEdits(tabId);
      setTabDocEdits(
        tabId,
        form.insertKey === null
          ? addDocument(edits, document)
          : updateInsert(edits, form.insertKey, document),
      );
      return true;
    }
    case 'replace':
      if (node.type !== 'object' || !target) throw new Error('not a document');
      setTabDocEdits(tabId, replaceDocument(tabDocEdits(tabId), target, text));
      return true;
    case 'value':
      return target ? stageField(tabId, target, form.path, text) : false;
  }
}

/** Removes array element `path` (an index): the whole array is written without it. */
export function removeElement(tabId: string, target: Target, path: Path): boolean {
  const index = path[path.length - 1];
  const parent = path.slice(0, -1);
  const array = currentValue(tabId, target, parent);
  if (typeof index !== 'number' || array === null) return false;
  const node = parseJson(array);
  if (node.type !== 'array') return false;
  const items = node.items.filter((_, i) => i !== index);
  return stageField(tabId, target, parent, compactJson({ type: 'array', items }));
}

export function removeNewDocument(tabId: string, key: number): void {
  setTabDocEdits(tabId, removeInsert(tabDocEdits(tabId), key));
}

export function deleteTargets(tabId: string, targets: readonly Target[]): void {
  setTabDocEdits(tabId, deleteDocuments(tabDocEdits(tabId), targets));
}

export function revertTarget(tabId: string, id: string): void {
  setTabDocEdits(tabId, revertDocument(tabDocEdits(tabId), id));
}

export function undeleteTarget(tabId: string, id: string): void {
  setTabDocEdits(tabId, undelete(tabDocEdits(tabId), id));
}

/** A new document copied from `target` (with the pending changes), with a new `_id`. */
export function duplicate(tabId: string, target: Target): void {
  const edit = tabDocEdits(tabId).documents.get(target.id);
  const doc = edit ? effective(edit) : null;
  const text = duplicateOf(doc ? compactJson(doc) : target.original);
  setTabDocEdits(tabId, addDocument(tabDocEdits(tabId), text));
}

export async function discardDocEdits(tabId: string): Promise<void> {
  const count = pendingCount(tabDocEdits(tabId));
  if (count === 0) return;
  const ok = await confirm({
    title: tr('mongo.edit.discardTitle'),
    description: tr('mongo.edit.discardDescription', { count }),
    confirmLabel: tr('mongo.edit.discardConfirm'),
    danger: true,
  });
  if (ok) dropTabDocEdits(tabId);
}

let guarded = false;

/** Closing a collection tab with pending edits asks first; the closed tabs' edits go. */
export function installDocCloseGuard(): void {
  if (guarded) return;
  guarded = true;
  addCloseGuard(async (ids) => {
    const pending = ids.filter((id) => pendingCount(tabDocEdits(id)) > 0);
    if (pending.length > 0) {
      const ok = await confirm({
        title: tr('mongo.edit.discardTitle'),
        description: tr('mongo.edit.closeDescription', { count: pending.length }),
        confirmLabel: tr('mongo.edit.discardConfirm'),
        danger: true,
      });
      if (!ok) return false;
    }
    for (const id of ids) if (useDocEditStore.getState().tabs[id]) dropTabDocEdits(id);
    return true;
  });
}

// --- Apply ----------------------------------------------------------------------------------

function changeSetOf(tabId: string) {
  const target = tabOf(tabId);
  if (!target) return null;
  return {
    target,
    ...toChangeSet(tabDocEdits(tabId), target.table.database, target.table.name),
  };
}

/** Opens the apply dialog on the tab's pending edits, with their preview. */
export async function reviewChanges(tabId: string): Promise<void> {
  const set = changeSetOf(tabId);
  if (!set || set.changes.edits.length === 0) return;
  useDocEditStore.setState({
    dialog: {
      source: { kind: 'tab', tabId },
      connectionId: set.target.connectionId,
      label: `${set.target.table.database}.${set.target.table.name}`,
      status: 'loading',
      preview: null,
      error: null,
      outcome: null,
      conflicts: [],
      refs: set.refs,
    },
  });
  try {
    const preview = await unwrap(
      ipc.commands.mongoPreviewChanges(set.target.connectionId, set.changes),
    );
    patchDocDialog({ status: 'ready', preview });
  } catch (error) {
    patchDocDialog({
      status: 'failed',
      error: error instanceof YadbeIpcError ? error.error : null,
    });
    if (!(error instanceof YadbeIpcError)) showError(error);
  }
}

/** Opens the revert of a document journal entry, with its preview. */
export async function openDocRevert(
  connectionId: string,
  entryId: number,
  label: string,
): Promise<void> {
  useDocEditStore.setState({
    dialog: {
      source: { kind: 'revert', connectionId, entryId },
      connectionId,
      label,
      status: 'loading',
      preview: null,
      error: null,
      outcome: null,
      conflicts: [],
      refs: [],
    },
  });
  const result = await ipc.commands.mongoPreviewRevert(connectionId, entryId);
  if (result.status === 'error') patchDocDialog({ status: 'failed', error: result.error });
  else patchDocDialog({ status: 'ready', preview: result.data });
}

export function closeDocApply(): void {
  useDocEditStore.setState({ dialog: null });
}

/** Re-reads the page of every collection tab on this collection. */
function refreshCollection(connectionId: string, database: string, collection: string): void {
  for (const tab of useTabsStore.getState().tabs) {
    if (
      tab.connectionId === connectionId &&
      tab.table?.database === database &&
      tab.table.name === collection
    ) {
      const page = getCollectionTab(tab.id).page;
      if (page) void fetchPage(tab.id, page.page);
    }
  }
}

function toastApplied(outcome: DocApplyOutcome, title: string): void {
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

/** Applies what the dialog shows. */
export async function applyDocDialog(): Promise<void> {
  const dialog = useDocEditStore.getState().dialog;
  if (!dialog) return;
  const source: DocApplySource = dialog.source;
  let refs = dialog.refs;
  let database: string;
  let collection: string;
  patchDocDialog({ status: 'applying', error: null });
  let result;
  if (source.kind === 'tab') {
    const set = changeSetOf(source.tabId);
    if (!set) return;
    refs = set.refs;
    database = set.target.table.database;
    collection = set.target.table.name;
    result = await ipc.commands.mongoApplyChanges(dialog.connectionId, set.changes);
  } else {
    [database = '', collection = ''] = dialog.label.split(/\.(.*)/s);
    result = await ipc.commands.mongoApplyRevert(source.connectionId, source.entryId);
  }
  if (result.status === 'error') {
    patchDocDialog({ status: 'failed', error: result.error });
    return;
  }
  const outcome = result.data;
  if (source.kind === 'tab' && outcome.applied.length > 0) {
    setTabDocEdits(source.tabId, withoutApplied(tabDocEdits(source.tabId), refs, outcome.applied));
  }
  if (outcome.applied.length > 0) refreshCollection(dialog.connectionId, database, collection);
  switch (outcome.status) {
    case 'applied':
      closeDocApply();
      toastApplied(
        outcome,
        source.kind === 'revert' ? tr('journal.revert.done') : tr('mongo.edit.applied'),
      );
      return;
    case 'conflicted':
      patchDocDialog({ status: 'conflicted', outcome, conflicts: outcome.conflicts, refs });
      return;
    case 'failed':
      patchDocDialog({ status: 'failed', outcome, error: outcome.error, refs });
      return;
    case 'uncertain':
      patchDocDialog({ status: 'uncertain', outcome, error: outcome.error, refs });
      return;
  }
}

/** "Keep mine" or "take theirs" (drop the change) for one conflict. */
export type DocConflictChoice = 'mine' | 'theirs';

/** Settles the conflicts of a tab's apply, then previews what is left. */
export async function resolveDocConflicts(
  choices: ReadonlyMap<number, DocConflictChoice>,
): Promise<void> {
  const dialog = useDocEditStore.getState().dialog;
  if (dialog?.source.kind !== 'tab') {
    closeDocApply();
    return;
  }
  const tabId = dialog.source.tabId;
  let edits = tabDocEdits(tabId);
  for (const conflict of dialog.conflicts) {
    const choice = choices.get(conflict.edit) ?? defaultChoice(conflict);
    const ref = dialog.refs[conflict.edit];
    if (choice === 'mine') {
      edits = keepMine(edits, conflict);
    } else if (ref?.kind === 'document') {
      edits = revertDocument(edits, ref.id);
    } else if (ref?.kind === 'insert') {
      edits = { ...edits, inserts: edits.inserts.filter((i) => i.key !== ref.key) };
    }
  }
  setTabDocEdits(tabId, edits);
  const page = getCollectionTab(tabId).page;
  if (page) void fetchPage(tabId, page.page);
  if (pendingCount(edits) === 0) {
    closeDocApply();
    return;
  }
  await reviewChanges(tabId);
}

/** What a conflict resolves to unless chosen: an insert or a gone document cannot be kept. */
export function defaultChoice(conflict: DocConflict): DocConflictChoice {
  return conflict.kind === 'changed' ? 'mine' : 'theirs';
}

/** Edits an insert again from the apply dialog's conflict (an `_id` that exists). */
export function editInsertAgain(tabId: string, key: number): void {
  const insert = tabDocEdits(tabId).inserts.find((i) => i.key === key);
  if (!insert) return;
  closeDocApply();
  newDocument(tabId, editableText(insert.document), key);
}
