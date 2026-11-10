import { confirm } from '../../app/errors/confirmStore';
import { showError, showYadbeError } from '../../app/errors/presentError';
import { isQueryTab, selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  YadbeIpcError,
  ipc,
  unwrap,
  type Engine,
  type ExecuteScope,
  type TextRange,
  type TransactionMode,
  type TransactionState,
} from '../../ipc';
import { fileDialog, type SqlFilePickerLabels } from '../../ipc/fileDialog';
import { toast } from '../../ui/toastStore';
import { connectTo } from '../connections/connectionActions';
import { getPreference } from '../preferences/preferenceStore';
import { resultLimits } from '../preferences/resultLimits';
import type { ConnectionSummary } from '../connections/model';
import { findConnection } from './connectionLookup';
import { dangerKindKey, guardApplies, guardLines } from './dangerGuard';
import { findDangerousStatements, type DangerousStatement } from './dangerousStatements';
import { getEditor } from './editorRegistry';
import { isActive } from './executionModel';
import { getTabExecution, getTabTransaction, useExecutionStore } from './executionStore';
import { normalizeLineEndings, useFileIssues } from './fileIssues';
import { fileNameOf, getQueryTabState, hashText, isDirty, useQueryTabStore } from './queryTabStore';
import { scopeFor, type RunMode } from './runScope';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** The query tab with this id, when it is bound to a connection. */
function queryTab(tabId: string) {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  return tab?.connectionId ? tab : undefined;
}

// --- Running (F-041, F-042) -----------------------------------------------------------------

/** The statements a scope would run, as the backend's splitter reads them. */
async function statementsOf(
  engine: Engine,
  text: string,
  scope: ExecuteScope,
): Promise<TextRange[]> {
  switch (scope.kind) {
    case 'all':
      return unwrap(ipc.commands.splitStatements(engine, text));
    case 'range': {
      const parts = await unwrap(
        ipc.commands.splitStatements(engine, text.slice(scope.from, scope.to)),
      );
      return parts.map((part) => ({ from: part.from + scope.from, to: part.to + scope.from }));
    }
    case 'statementAt': {
      const found = await unwrap(ipc.commands.statementAt(engine, text, scope.offset));
      return found ? [found] : [];
    }
  }
}

function environmentName(connection: ConnectionSummary): string | null {
  switch (connection.environment) {
    case null:
      return null;
    case 'custom':
      return connection.environmentLabel ?? t('environment.custom');
    default:
      return t(`environment.${connection.environment}`);
  }
}

/** Shows the statements about to run that can do harm, with where they run (F-051). */
async function confirmDangerous(
  connection: ConnectionSummary,
  text: string,
  ranges: readonly TextRange[],
  dangers: readonly DangerousStatement[],
): Promise<boolean> {
  const lines = guardLines(text, ranges, dangers);
  const environment = environmentName(connection);
  const hidden = ranges.length - lines.length;
  return confirm({
    title: t(dangers.length === 1 ? 'query.guard.title.one' : 'query.guard.title', {
      count: dangers.length,
    }),
    description: t('query.guard.description', {
      connection: connection.name,
      environment: environment === null ? t('query.guard.noEnvironment') : environment,
    }),
    confirmLabel: t('query.guard.confirm'),
    danger: true,
    connection,
    // Each statement once, whole: what is listed is what will be sent.
    items: [
      ...lines.map((line) => ({
        label: line.sql,
        code: true,
        note:
          (ranges.length > 1
            ? `${t('query.guard.statementNumber', { number: line.number })} · `
            : '') +
          (line.kind === null ? t('query.guard.notFlagged') : t(dangerKindKey(line.kind))),
        danger: line.kind !== null,
      })),
      ...(hidden > 0
        ? [{ label: t('query.guard.others', { count: hidden }), note: t('query.guard.notFlagged') }]
        : []),
    ],
  });
}

/**
 * Runs the tab's script (or part of it) on its connection. Connects first when needed, asks
 * before dangerous statements, then hands the whole text to the backend with the scope: results
 * and messages arrive through the execution store.
 */
export async function runQuery(tabId: string, mode: RunMode = 'auto'): Promise<void> {
  // A second press while the first is still connecting or being confirmed would start a second run.
  if (starting.has(tabId)) return;
  starting.add(tabId);
  try {
    await startRun(tabId, mode);
  } finally {
    starting.delete(tabId);
  }
}

/** Tabs whose run is being prepared: connecting, asking, waiting for the backend's answer. */
const starting = new Set<string>();

async function startRun(tabId: string, mode: RunMode): Promise<void> {
  const tab = queryTab(tabId);
  const connection = findConnection(tab?.connectionId ?? null);
  if (!tab || !connection) return;
  if (isActive(getTabExecution(tabId).status)) return;
  const editor = getQueryTabState(tabId);
  const text = editor.content;
  const scope = scopeFor(mode, editor.selection, text);
  if (!scope) {
    toast({
      variant: 'info',
      title: t(mode === 'selection' ? 'query.nothingSelected' : 'query.nothingToRun'),
    });
    return;
  }
  if (!(await connectTo(connection))) return;

  if (guardApplies(connection, getPreference('confirmDangerous'))) {
    let ranges: TextRange[] = [];
    let dangers: DangerousStatement[] = [];
    try {
      ranges = await statementsOf(connection.engine, text, scope);
      dangers = findDangerousStatements(text, ranges);
    } catch {
      // Without the split the backend cannot run the text either: it reports why.
    }
    if (dangers.length > 0 && !(await confirmDangerous(connection, text, ranges, dangers))) return;
  }

  const { database } = editor;
  const store = useExecutionStore.getState();
  getEditor(tabId)?.markRunStart();
  store.markStarting(tabId);
  const result = await ipc.commands.executeQuery({
    tabId,
    connectionId: connection.id,
    database,
    text,
    scope,
    limits: resultLimits(),
  });
  if (result.status === 'ok') {
    store.begin(tabId, result.data, { connectionId: connection.id, database, sourceText: text });
    return;
  }
  if (result.error.code === 'executionRunning') {
    // Something already runs in this tab: its state is the one to keep showing.
    useExecutionStore.setState((state) => ({
      starting: Object.fromEntries(Object.entries(state.starting).filter(([id]) => id !== tabId)),
    }));
    return;
  }
  store.startFailed(tabId, result.error, { connectionId: connection.id, database });
  showYadbeError(result.error, {
    title: t('query.runFailed'),
    reconnect: () => {
      void connectTo(connection);
    },
    retry: () => {
      void runQuery(tabId, mode);
    },
  });
}

/** Cancels the tab's running execution with the engine's native mechanism (F-042). */
export function cancelQuery(tabId: string): void {
  void ipc.commands.cancelQuery(tabId).then((result) => {
    if (result.status === 'error') showYadbeError(result.error);
  });
}

// --- Transactions (F-047) -------------------------------------------------------------------

export function hasOpenTransaction(tabId: string): boolean {
  return getTabTransaction(tabId).status !== 'idle';
}

function applyTransaction(tabId: string, transaction: TransactionState): void {
  useExecutionStore.getState().setTransaction(tabId, transaction);
}

export async function commitTransaction(tabId: string): Promise<void> {
  try {
    applyTransaction(tabId, await unwrap(ipc.commands.commitTransaction(tabId)));
    toast({ variant: 'success', title: t('query.transaction.committed') });
  } catch (error) {
    showError(error, { title: t('query.transaction.commitFailed') });
  }
}

export async function rollbackTransaction(tabId: string): Promise<void> {
  try {
    applyTransaction(tabId, await unwrap(ipc.commands.rollbackTransaction(tabId)));
    toast({ variant: 'info', title: t('query.transaction.rolledBack') });
  } catch (error) {
    showError(error, { title: t('query.transaction.rollbackFailed') });
  }
}

export async function setTransactionMode(tabId: string, mode: TransactionMode): Promise<void> {
  try {
    applyTransaction(tabId, await unwrap(ipc.commands.setTransactionMode(tabId, mode)));
  } catch (error) {
    showError(error, { title: t('query.transaction.modeFailed') });
  }
}

/** Asks before abandoning an open transaction; `true` when there is none or the user agrees. */
export async function confirmAbandonTransaction(
  tabIds: readonly string[],
  action: 'close' | 'switch',
): Promise<boolean> {
  const open = tabIds.filter(hasOpenTransaction);
  if (open.length === 0) return true;
  const connections = new Set(
    open.map((id) => useTabsStore.getState().tabs.find((tab) => tab.id === id)?.connectionId),
  );
  const [only] = connections.size === 1 ? connections : [];
  return confirm({
    connection: findConnection(only ?? null),
    title: t(action === 'close' ? 'query.transaction.closeTitle' : 'query.transaction.switchTitle'),
    description: t(
      action === 'close'
        ? 'query.transaction.closeDescription'
        : 'query.transaction.switchDescription',
    ),
    confirmLabel: t(
      action === 'close' ? 'query.transaction.closeConfirm' : 'query.transaction.switchConfirm',
    ),
    danger: true,
    items: open.map((id) => {
      const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === id);
      const connection = findConnection(tab?.connectionId ?? null);
      return {
        label: [t('tab.query', { number: tab?.ordinal ?? 0 }), connection?.name]
          .filter(Boolean)
          .join(' · '),
        note: t(
          getTabTransaction(id).status === 'failed'
            ? 'query.transaction.failedNote'
            : 'query.transaction.openNote',
        ),
        danger: true,
        connection,
      };
    }),
  });
}

// --- Connection and database (F-046) --------------------------------------------------------

/** Moves a tab to another connection (its database goes back to that connection's own). */
export async function switchConnection(tabId: string, connectionId: string): Promise<void> {
  const tab = queryTab(tabId);
  const target = findConnection(connectionId);
  if (!tab || !target || tab.connectionId === connectionId) return;
  if (isActive(getTabExecution(tabId).status)) {
    toast({ variant: 'warning', title: t('query.switch.running') });
    return;
  }
  if (!(await confirmAbandonTransaction([tabId], 'switch'))) return;
  if (hasOpenTransaction(tabId)) await rollbackTransaction(tabId);
  useTabsStore.getState().setConnection(tabId, connectionId);
  useQueryTabStore.getState().setDatabase(tabId, null);
  void connectTo(target);
}

/** Runs the tab's next statements in another database of the same connection. */
export async function switchDatabase(tabId: string, database: string | null): Promise<void> {
  const state = getQueryTabState(tabId);
  const value = database === null || database.trim() === '' ? null : database.trim();
  if (state.database === value) return;
  if (isActive(getTabExecution(tabId).status)) {
    toast({ variant: 'warning', title: t('query.switch.running') });
    return;
  }
  if (!(await confirmAbandonTransaction([tabId], 'switch'))) return;
  if (hasOpenTransaction(tabId)) await rollbackTransaction(tabId);
  useQueryTabStore.getState().setDatabase(tabId, value);
}

// --- Script files (F-045) -------------------------------------------------------------------

function pickerLabels(titleKey: MessageKey): SqlFilePickerLabels {
  return {
    title: t(titleKey),
    sqlFiles: t('query.file.sqlFiles'),
    allFiles: t('query.file.allFiles'),
  };
}

const SCRIPT_EXTENSION = /\.(sql|ddl|dml|psql|pgsql|tsql|txt)$/i;

async function readScript(path: string): Promise<string> {
  return normalizeLineEndings(await unwrap(ipc.commands.readTextFile(path)));
}

/**
 * Opens a script from disk (`Mod+O`): in the active tab when it is still empty, in a new tab
 * bound to the same connection otherwise; a file that is already open is just shown.
 */
export async function openScript(tabId: string): Promise<void> {
  const tab = queryTab(tabId);
  if (!tab?.connectionId) return;
  let path: string | null;
  try {
    path = await fileDialog.pickSqlFile(pickerLabels('query.file.openTitle'));
  } catch (error) {
    showError(error, { title: t('query.file.openFailed') });
    return;
  }
  if (path === null) return;
  const tabs = useQueryTabStore.getState().tabs;
  const already = Object.entries(tabs).find(([, state]) => state.filePath === path)?.[0];
  if (already) {
    useTabsStore.getState().activate(already);
    void checkExternalChange(already);
    return;
  }
  let text: string;
  try {
    text = await readScript(path);
  } catch (error) {
    showError(error, { title: t('query.file.openFailed') });
    return;
  }
  const current = getQueryTabState(tabId);
  const reuse = current.content === '' && current.filePath === null;
  const target = reuse ? tabId : useTabsStore.getState().openQueryTab(tab.connectionId);
  useQueryTabStore.getState().ensure(target);
  useQueryTabStore.getState().loadFile(target, path, text);
  getEditor(target)?.replaceContent(text);
}

/** Saves the tab to its file (`Mod+S`), asking where first when it has none (`Mod+Shift+S`). */
export async function saveScript(tabId: string, askWhere = false): Promise<boolean> {
  const tab = queryTab(tabId);
  if (!tab) return false;
  const state = getQueryTabState(tabId);
  let path = state.filePath;
  try {
    if (path === null || askWhere) {
      const defaultName = path
        ? fileNameOf(path)
        : `${t('tab.query', { number: tab.ordinal })}.sql`;
      path = await fileDialog.pickSqlSavePath(pickerLabels('query.file.saveTitle'), defaultName);
      if (path === null) return false;
      // The backend only writes script files: a name typed without an extension gets `.sql`.
      if (!SCRIPT_EXTENSION.test(path)) path = `${path}.sql`;
    }
    const content = state.content;
    await unwrap(ipc.commands.writeTextFile(path, content));
    useQueryTabStore.getState().markSaved(tabId, path, content);
    useFileIssues.getState().set(tabId, null);
    toast({ variant: 'success', title: t('query.file.saved', { name: fileNameOf(path) }) });
    return true;
  } catch (error) {
    showError(error, { title: t('query.file.saveFailed') });
    return false;
  }
}

/** Compares the tab's file with what the tab last read or wrote (on focus, no watcher). */
export async function checkExternalChange(tabId: string): Promise<void> {
  const { filePath, fileHash } = getQueryTabState(tabId);
  if (filePath === null || fileHash === null) return;
  const issues = useFileIssues.getState();
  try {
    const text = await readScript(filePath);
    const now = getQueryTabState(tabId);
    // Saved, reloaded or bound elsewhere while the file was being read: this answer is stale.
    if (now.filePath !== filePath || now.fileHash !== fileHash) return;
    issues.set(tabId, hashText(text) === fileHash ? null : { kind: 'modified', diskText: text });
  } catch (error) {
    if (error instanceof YadbeIpcError && error.error.code === 'fileNotFound') {
      issues.set(tabId, { kind: 'missing' });
    }
    // Any other failure (permissions, a network drive away) is not worth a banner.
  }
}

/** Takes the file's text over the tab's own. */
export function reloadFromDisk(tabId: string): void {
  const issue = useFileIssues.getState().issues[tabId];
  const { filePath } = getQueryTabState(tabId);
  if (issue?.kind !== 'modified' || filePath === null) return;
  useQueryTabStore.getState().loadFile(tabId, filePath, issue.diskText);
  getEditor(tabId)?.replaceContent(issue.diskText);
  useFileIssues.getState().set(tabId, null);
}

/** Keeps the tab's text over a change of the file: the change is acknowledged, not applied. */
export function keepMine(tabId: string): void {
  const issue = useFileIssues.getState().issues[tabId];
  if (issue?.kind === 'modified') {
    useQueryTabStore.getState().setFileHash(tabId, hashText(issue.diskText));
  } else if (issue?.kind === 'missing') {
    // The file is gone: the tab becomes a plain script, saved where the user decides.
    useQueryTabStore.getState().detachFile(tabId);
  }
  useFileIssues.getState().set(tabId, null);
}

/** Whether the tab has unsaved changes (also exposed as `useIsDirty`). */
export function isTabDirty(tabId: string): boolean {
  return isDirty(getQueryTabState(tabId));
}

/** The active query tab's id, for shortcuts and toolbar actions. */
export function activeQueryTabId(): string | null {
  const tab = selectActiveTab(useTabsStore.getState());
  return isQueryTab(tab) ? tab.id : null;
}
