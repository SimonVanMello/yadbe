import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { isQueryTab, selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap, type QueryFolder, type SavedQuery, type SavedQueryUpdate } from '../../ipc';
import { fileDialog } from '../../ipc/fileDialog';
import { toast } from '../../ui/toastStore';
import { connectTo } from '../connections/connectionActions';
import type { ConnectionSummary } from '../connections/model';
import type { HistoryEntry } from '../history/historyModel';
import { fullStatement } from '../history/historyActions';
import { findConnection } from '../query/connectionLookup';
import { sameFamily } from '../query/sameFamily';
import { getEditor } from '../query/editorRegistry';
import { insertIntoActiveEditor, openQueryTab } from '../query/openQueryTab';
import { runQuery } from '../query/queryActions';
import { getQueryTabState, useQueryTabStore } from '../query/queryTabStore';
import { selectedRange } from '../query/runScope';
import { useLibraryUi } from './libraryStore';
import { folderContents, folderKey, queryKey } from './libraryModel';
import { useSaveDialog } from './saveDialogStore';
import { currentLibrary, fetchSavedQuery, fetchSnippets, refreshLibrary } from './useLibrary';
import {
  expandVariables,
  flattenSnippet,
  hasPlaceholders,
  localDate,
  type SnippetContext,
} from './snippetSyntax';
import type { BuiltinSnippet } from './builtinSnippets';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** What `${connection}`, `${database}` and `${date}` stand for in a tab of `connection`. */
export function snippetContext(
  connection: ConnectionSummary | undefined,
  database: string | null,
): SnippetContext {
  return {
    connection: connection?.name ?? '',
    database: database ?? connection?.database ?? '',
    date: localDate(new Date()),
  };
}

/** The snippet-flagged queries open as the text their placeholders resolve to. */
function isSnippet(query: SavedQuery): boolean {
  return query.snippetTrigger !== null;
}

/** The whole statement: a list row holds a preview when the text is long. */
async function wholeQuery(query: SavedQuery): Promise<SavedQuery> {
  if (!query.sqlTruncated) return query;
  return (await fetchSavedQuery(query.id)) ?? query;
}

/** The connection a query runs on: its own when it is bound to one, else the active tab's. */
function targetConnection(query: SavedQuery | null): ConnectionSummary | undefined {
  if (query?.connectionId) {
    const bound = findConnection(query.connectionId);
    if (bound) return bound;
  }
  const tab = selectActiveTab(useTabsStore.getState());
  return findConnection(tab.connectionId);
}

function touch(query: SavedQuery): void {
  // Noting a use must never get in the way of using the query.
  void unwrap(ipc.commands.touchSavedQuery(query.id))
    .then(() => refreshLibrary())
    .catch(() => undefined);
}

/**
 * Opens a saved query in a new tab (the tab remembers it: it can update it). Returns the tab's id,
 * `null` when no connection can host it.
 */
export async function openSaved(
  query: SavedQuery,
  options: { connect?: boolean } = {},
): Promise<string | null> {
  const connection = targetConnection(query);
  if (!connection) {
    toast({ variant: 'warning', title: t('library.noConnection') });
    return null;
  }
  try {
    const whole = await wholeQuery(query);
    const context = snippetContext(connection, whole.database);
    const text = isSnippet(whole) ? flattenSnippet(whole.sql, context) : whole.sql;
    const database =
      whole.database === null || whole.database === connection.definition.database
        ? null
        : whole.database;
    const tabId = openQueryTab({
      connectionId: connection.id,
      database,
      initialText: text,
      reuseWelcomeTab: false,
      // A snippet opens as what its fields resolve to: saving that over the template would lose it.
      origin: text === whole.sql ? { queryId: whole.id, baseline: whole.sql } : null,
    });
    if (options.connect !== false) void connectTo(connection);
    touch(query);
    return tabId;
  } catch (error) {
    showError(error);
    return null;
  }
}

/** Runs a saved query in a new tab, through the normal run path (danger guard included). */
export async function runSaved(query: SavedQuery): Promise<void> {
  // The run connects by itself (and asks for a password): a second attempt started here would
  // make it give up, since it lets a running attempt finish.
  const tabId = await openSaved(query, { connect: false });
  if (tabId !== null) await runQuery(tabId, 'all');
}

/** Inserts a saved query at the cursor of the active editor; a snippet starts its tab stops. */
export async function insertSaved(query: SavedQuery): Promise<void> {
  if (!sameFamily(query.connectionId, selectActiveTab(useTabsStore.getState()).connectionId)) {
    toast({ variant: 'info', title: t('library.insert.otherFamily') });
    return;
  }
  try {
    const whole = await wholeQuery(query);
    const tab = selectActiveTab(useTabsStore.getState());
    const connection = findConnection(tab.connectionId);
    const context = snippetContext(connection, getQueryTabState(tab.id).database);
    const done = insertTemplate(whole.sql, isSnippet(whole), context);
    if (!done) {
      toast({ variant: 'info', title: t('library.insert.noEditor') });
      return;
    }
    touch(query);
  } catch (error) {
    showError(error);
  }
}

/** Inserts text in the active editor, as a snippet (tab stops) when it is one. */
export function insertTemplate(
  template: string,
  asSnippet: boolean,
  context: SnippetContext,
): boolean {
  const tab = selectActiveTab(useTabsStore.getState());
  const editor = isQueryTab(tab) ? getEditor(tab.id) : undefined;
  if (!editor) return false;
  if (asSnippet && hasPlaceholders(template)) {
    editor.insertSnippet(expandVariables(template, context));
    return true;
  }
  return insertIntoActiveEditor(template);
}

export async function copySaved(query: SavedQuery): Promise<void> {
  try {
    const whole = await wholeQuery(query);
    await navigator.clipboard.writeText(whole.sql);
    toast({ variant: 'success', title: t('library.copied') });
  } catch (error) {
    showError(error);
  }
}

/** Every field of a list row as the update command takes it, the text left as it is. */
function updateOf(query: SavedQuery, patch: Partial<SavedQueryUpdate> = {}): SavedQueryUpdate {
  return {
    name: query.name,
    sql: null,
    description: query.description,
    tags: query.tags,
    folderId: query.folderId,
    connectionId: query.connectionId,
    database: query.database,
    snippetTrigger: query.snippetTrigger,
    ...patch,
  };
}

export async function renameSaved(query: SavedQuery, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === query.name) return true;
  try {
    await unwrap(ipc.commands.updateSavedQuery(query.id, updateOf(query, { name: trimmed })));
    await refreshLibrary();
    return true;
  } catch (error) {
    showError(error, { title: t('library.renameFailed') });
    return false;
  }
}

export async function duplicateSaved(query: SavedQuery): Promise<void> {
  try {
    const copy = await unwrap(ipc.commands.duplicateSavedQuery(query.id, t('library.copySuffix')));
    await refreshLibrary();
    useLibraryUi.getState().select(queryKey(copy.id));
  } catch (error) {
    showError(error, { title: t('library.duplicateFailed') });
  }
}

export async function moveSaved(query: SavedQuery, folderId: string | null): Promise<void> {
  if (query.folderId === folderId) return;
  try {
    await unwrap(ipc.commands.moveSavedQuery(query.id, folderId));
    if (folderId !== null) useLibraryUi.getState().setFolded(folderId, false);
    await refreshLibrary();
  } catch (error) {
    showError(error, { title: t('library.moveFailed') });
  }
}

export async function deleteSaved(query: SavedQuery): Promise<boolean> {
  const confirmed = await confirm({
    title: t('library.delete.title', { name: query.name }),
    description: t('library.delete.description'),
    confirmLabel: t('library.delete.confirm'),
    danger: true,
    items: [{ label: query.name, note: t('library.delete.removed'), danger: true }],
  });
  if (!confirmed) return false;
  try {
    await unwrap(ipc.commands.deleteSavedQuery(query.id));
  } catch (error) {
    showError(error, { title: t('library.deleteFailed') });
    return false;
  }
  if (useLibraryUi.getState().selectedKey === queryKey(query.id)) {
    useLibraryUi.getState().select(null);
  }
  await refreshLibrary();
  toast({ variant: 'success', title: t('library.deleted', { name: query.name }) });
  return true;
}

/** A folder named "New folder" under `parentId`, ready to be renamed in place. */
export async function createFolder(parentId: string | null): Promise<void> {
  try {
    const folder = await unwrap(
      ipc.commands.createQueryFolder(t('library.folder.newName'), parentId),
    );
    if (parentId !== null) useLibraryUi.getState().setFolded(parentId, false);
    await refreshLibrary();
    useLibraryUi.getState().select(folderKey(folder.id));
    useLibraryUi.getState().startRename(folderKey(folder.id));
  } catch (error) {
    showError(error, { title: t('library.folderFailed') });
  }
}

export async function renameFolder(folder: QueryFolder, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === folder.name) return true;
  try {
    await unwrap(ipc.commands.renameQueryFolder(folder.id, trimmed));
    await refreshLibrary();
    return true;
  } catch (error) {
    showError(error, { title: t('library.folderFailed') });
    return false;
  }
}

export async function moveFolder(folder: QueryFolder, parentId: string | null): Promise<void> {
  if (folder.parentId === parentId) return;
  try {
    await unwrap(ipc.commands.moveQueryFolder(folder.id, parentId));
    if (parentId !== null) useLibraryUi.getState().setFolded(parentId, false);
    await refreshLibrary();
  } catch (error) {
    showError(error, { title: t('library.moveFailed') });
  }
}

/** Deletes a folder after showing how much goes with it. */
export async function deleteFolder(folder: QueryFolder): Promise<boolean> {
  const { folders, queries } = folderContents(currentLibrary(), folder.id);
  const confirmed = await confirm({
    title: t('library.folder.delete.title', { name: folder.name }),
    description: t('library.folder.delete.description'),
    confirmLabel: t('library.delete.confirm'),
    danger: true,
    items: [
      { label: folder.name, note: t('library.folder.delete.removed'), danger: true },
      ...(folders > 1
        ? [
            {
              label: t('library.folder.delete.folders', { count: folders - 1 }),
              note: t('library.folder.delete.removed'),
              danger: true,
            },
          ]
        : []),
      ...(queries > 0
        ? [
            {
              label: t('library.folder.delete.queries', { count: queries }),
              note: t('library.folder.delete.removed'),
              danger: true,
            },
          ]
        : []),
    ],
  });
  if (!confirmed) return false;
  try {
    await unwrap(ipc.commands.deleteQueryFolder(folder.id));
  } catch (error) {
    showError(error, { title: t('library.folderFailed') });
    return false;
  }
  useLibraryUi.getState().select(null);
  await refreshLibrary();
  return true;
}

// --- Saving (F-050, F-103) ---------------------------------------------------------------------

/** The text a "Save to library" saves: the selection of the tab's editor, else all of it. */
export function editorSaveRequest(tabId: string) {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab?.connectionId) return null;
  const state = getQueryTabState(tabId);
  const range = selectedRange(state.selection);
  const selected = range ? state.content.slice(range.from, range.to) : '';
  const selectionOnly = selected.trim() !== '';
  const sql = selectionOnly ? selected : state.content;
  return { sql, selectionOnly, connectionId: tab.connectionId, database: state.database };
}

/** `Mod+Shift+L`: opens the save dialog for the active editor's text. */
export function saveEditorToLibrary(tabId: string): boolean {
  const request = editorSaveRequest(tabId);
  if (!request) return false;
  if (request.sql.trim() === '') {
    toast({ variant: 'info', title: t('library.save.nothing') });
    return true;
  }
  useSaveDialog.getState().open({
    mode: 'create',
    sql: request.sql,
    connectionId: request.connectionId,
    database: request.database,
    tabId,
    selectionOnly: request.selectionOnly,
  });
  return true;
}

/** A history entry's statement into the save dialog (F-103: the star). */
export async function saveHistoryEntry(entry: HistoryEntry): Promise<void> {
  try {
    const sql = await fullStatement(entry);
    const connection = findConnection(entry.connectionId);
    useSaveDialog.getState().open({
      mode: 'create',
      sql,
      connectionId: connection?.id ?? null,
      database: entry.database,
    });
  } catch (error) {
    showError(error);
  }
}

/** A built-in snippet inserted at the cursor of the active editor, its tab stops started. */
export function insertBuiltin(snippet: BuiltinSnippet): void {
  const tab = selectActiveTab(useTabsStore.getState());
  const context = snippetContext(
    findConnection(tab.connectionId),
    getQueryTabState(tab.id).database,
  );
  if (!insertTemplate(snippet.template, true, context)) {
    toast({ variant: 'info', title: t('library.insert.noEditor') });
  }
}

/** A built-in snippet copied into the library, to be customized. */
export function copyBuiltin(snippet: BuiltinSnippet): void {
  useSaveDialog.getState().open({
    mode: 'create',
    sql: snippet.template,
    name: t(snippet.name),
    connectionId: null,
    database: null,
    snippet: true,
    trigger: snippet.trigger,
    tabId: null,
    selectionOnly: false,
  });
}

/**
 * Writes the text of a tab over the saved query it came from. A query deleted in the meantime
 * is reported, and the tab stops pointing at it.
 */
export async function updateSavedFromTab(tabId: string): Promise<boolean> {
  const state = getQueryTabState(tabId);
  const origin = state.origin;
  if (!origin) return false;
  try {
    const current = await fetchSavedQuery(origin.queryId);
    if (!current) {
      useQueryTabStore.getState().setOrigin(tabId, null);
      toast({ variant: 'warning', title: t('library.update.missing') });
      return true;
    }
    const saved = await unwrap(
      ipc.commands.updateSavedQuery(origin.queryId, updateOf(current, { sql: state.content })),
    );
    useQueryTabStore.getState().setOrigin(tabId, { queryId: saved.id, baseline: state.content });
    await refreshLibrary();
    toast({ variant: 'success', title: t('library.updated', { name: saved.name }) });
  } catch (error) {
    showError(error, { title: t('library.saveFailed') });
  }
  return true;
}

// --- Import and export -------------------------------------------------------------------------

export async function exportLibrary(): Promise<void> {
  try {
    const path = await fileDialog.pickJsonSavePath(
      {
        title: t('library.file.title.export'),
        jsonFiles: t('library.file.json'),
        allFiles: t('library.file.all'),
      },
      'yadbe-library.json',
    );
    if (path === null) return;
    await unwrap(ipc.commands.exportSavedQueries(path));
    toast({ variant: 'success', title: t('library.exported') });
  } catch (error) {
    showError(error, { title: t('library.exportFailed') });
  }
}

export async function importLibrary(): Promise<void> {
  try {
    const path = await fileDialog.pickJsonFile({
      title: t('library.file.title.import'),
      jsonFiles: t('library.file.json'),
      allFiles: t('library.file.all'),
    });
    if (path === null) return;
    const report = await unwrap(ipc.commands.importSavedQueries(path));
    await refreshLibrary();
    toast({
      variant: 'success',
      title: t('library.imported', {
        queries: report.queries,
        folders: report.folders,
        skipped: report.skipped,
      }),
    });
  } catch (error) {
    showError(error, { title: t('library.importFailed') });
  }
}

/** Snippets are read by the editor on every completion: warm the cache. */
export function warmSnippets(): void {
  void fetchSnippets().catch(() => undefined);
}
