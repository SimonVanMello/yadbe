import { create } from 'zustand';

import { addCloseGuard } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  YadbeIpcError,
  type ColumnMeta,
  type Qualifier,
  type ResultEditInfo,
  type YadbeError,
} from '../../ipc';
import { getTabExecution, getTabTransaction, useExecutionStore } from '../query/executionStore';
import {
  confirmDiscard,
  headerReason,
  registerEditSession,
  setResultEditLocator,
  sourceLabels,
  tableSource,
  type EditTarget,
} from '../table-data/tableActions';
import { TableRowSource } from '../table-data/tableRowSource';
import { getTableSession, useTableSessionStore } from '../table-data/tableSessionStore';
import { gridColumnsOf, sessionIdOf, tableName, toTableInfo } from './resultEditModel';

/**
 * Editable query results (F-087): each result shown is described by the backend once; an
 * editable one becomes an edit session of the table-tab machinery (`tableActions`), keyed
 * `result:<id>`, over the result's rows. The session lives as long as the result: a new run of
 * the tab, or closing it, ends it (after asking when changes are pending).
 */

/** A stored row no result has (`u32::MAX`): what a row added after the result refers to. */
const NO_ROW = 0xffff_ffff;

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

export interface ResultEditEntry {
  /** The query tab that ran it. */
  tabId: string;
  connectionId: string;
  status: 'loading' | 'ready' | 'failed';
  info: ResultEditInfo | null;
  error: YadbeError | null;
}

interface ResultEditStore {
  entries: Record<number, ResultEditEntry>;
  set: (resultId: number, entry: ResultEditEntry) => void;
  remove: (resultId: number) => void;
}

export const useResultEditStore = create<ResultEditStore>()((set) => ({
  entries: {},
  set: (resultId, entry) => {
    set((state) => ({ entries: { ...state.entries, [resultId]: entry } }));
  },
  remove: (resultId) => {
    set((state) => {
      if (!(resultId in state.entries)) return state;
      return {
        entries: Object.fromEntries(
          Object.entries(state.entries).filter(([id]) => Number(id) !== resultId),
        ),
      };
    });
  },
}));

export function useResultEdit(resultId: number): ResultEditEntry | undefined {
  return useResultEditStore((state) => state.entries[resultId]);
}

function entryOf(resultId: number): ResultEditEntry | undefined {
  return useResultEditStore.getState().entries[resultId];
}

/** The result is still one of its tab's current execution. */
function present(tabId: string, resultId: number): boolean {
  return getTabExecution(tabId).results.some((r) => r.resultId === resultId);
}

/**
 * Asks the backend whether a result can be edited (once per result) and, when it can, opens its
 * edit session.
 */
export async function describeResult(
  tabId: string,
  connectionId: string,
  resultId: number,
  columns: readonly ColumnMeta[],
  rowCount: number,
): Promise<void> {
  if (entryOf(resultId)) return;
  const store = useResultEditStore.getState();
  store.set(resultId, { tabId, connectionId, status: 'loading', info: null, error: null });
  const result = await ipc.commands.describeResultEdit(resultId);
  if (!entryOf(resultId)) return;
  if (result.status === 'error') {
    store.set(resultId, {
      tabId,
      connectionId,
      status: 'failed',
      info: null,
      error: result.error,
    });
    return;
  }
  const info = result.data;
  openSession(tabId, connectionId, resultId, columns, rowCount, info);
  store.set(resultId, { tabId, connectionId, status: 'ready', info, error: null });
}

function openSession(
  tabId: string,
  connectionId: string,
  resultId: number,
  columns: readonly ColumnMeta[],
  rowCount: number,
  info: ResultEditInfo,
): void {
  const table = toTableInfo(info);
  if (!table) return;
  const id = sessionIdOf(resultId);
  const source = new TableRowSource(
    table.columns,
    gridColumnsOf(columns, info, (column) => headerReason(column.column)),
    sourceLabels(),
  );
  source.setResult(resultId, rowCount);
  const target: EditTarget = {
    connectionId,
    alive: () => entryOf(resultId) !== undefined && present(tabId, resultId),
    preview: (changes) => ipc.commands.previewResultChanges(resultId, changes),
    apply: (changes) => ipc.commands.applyResultChanges(resultId, changes),
    // Stored rows, never grid positions: the backend replaces the row it reads back.
    refresh: (rows, keys) =>
      ipc.commands.refreshResultRows(
        resultId,
        rows.map((row, i) => ({ row: source.baseRow(row) ?? NO_ROW, key: keys[i] ?? [] })),
      ),
    reload: () => {
      useTableSessionStore.getState().patch(id, { stale: true });
      return Promise.resolve();
    },
    // The grid rows of the source are stored rows minus those an earlier apply deleted.
    removed: (rows) =>
      ipc.commands.removeResultRows(
        resultId,
        rows.flatMap((row) => {
          const base = source.baseRow(row);
          return base === null ? [] : [base];
        }),
      ),
    identity: info.identityColumns,
    sourced: (dataCol) => (info.columns[dataCol]?.source ?? null) !== null,
    block: () =>
      getTabTransaction(tabId).status === 'idle' ? null : t('resultEdit.readOnly.openTransaction'),
    insertBlock: t('resultEdit.noInserts'),
  };
  registerEditSession(id, { target, source });
  useTableSessionStore.getState().patch(id, { phase: 'ready', info: table });
}

/** The result streamed more rows: an edit session shows them too. */
export function growResult(resultId: number, rowCount: number): void {
  const id = sessionIdOf(resultId);
  if (getTableSession(id).phase !== 'ready') return;
  tableSource(id)?.extend(rowCount);
}

/** Ends a result's edits: its session, its rows read again, its server connection. */
export function forgetResult(resultId: number): void {
  if (!entryOf(resultId)) return;
  useResultEditStore.getState().remove(resultId);
  registerEditSession(sessionIdOf(resultId), null);
  void ipc.commands.closeResultEdit(resultId).catch((error: unknown) => {
    if (!(error instanceof YadbeIpcError)) console.warn('Could not close the result edit', error);
  });
}

/** The edit sessions of a query tab's results with pending changes. */
function pendingSessions(tabIds: readonly string[]): string[] {
  const tabs = new Set(tabIds);
  return Object.entries(useResultEditStore.getState().entries)
    .filter(([, entry]) => tabs.has(entry.tabId))
    .map(([resultId]) => sessionIdOf(Number(resultId)))
    .filter((id) => getTableSession(id).pendingCount > 0);
}

/** Asks before a new run of the tab replaces results holding changes not applied. */
export function confirmRunOver(tabId: string): Promise<boolean> {
  const ids = pendingSessions([tabId]);
  return ids.length === 0 ? Promise.resolve(true) : confirmDiscard(ids, 'run');
}

/** A short label of the table an editable result writes to. */
export function editTableLabel(entry: ResultEditEntry | undefined, qualifier: Qualifier): string {
  return entry?.info ? tableName(entry.info, qualifier) : '';
}

let started = false;

/**
 * Wires the result edits into the shell, once per app launch: sessions end with their result,
 * closing a query tab asks about pending changes, and editing shortcuts find the result grid
 * that has the focus.
 */
export function startResultEditFeature(): void {
  if (started) return;
  started = true;

  useExecutionStore.subscribe((state, previous) => {
    if (state.executions === previous.executions) return;
    for (const [resultId, entry] of Object.entries(useResultEditStore.getState().entries)) {
      const id = Number(resultId);
      if (!present(entry.tabId, id)) forgetResult(id);
    }
  });

  addCloseGuard((ids) => {
    const pending = pendingSessions(ids);
    return pending.length === 0 ? true : confirmDiscard(pending, 'close');
  });

  setResultEditLocator(() => {
    const active = document.activeElement;
    const host = active instanceof Element ? active.closest('[data-result-edit]') : null;
    return host?.getAttribute('data-result-edit') ?? null;
  });
}
