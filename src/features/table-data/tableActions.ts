import { confirm } from '../../app/errors/confirmStore';
import { localize, showYadbeError } from '../../app/errors/presentError';
import { isTableTab, selectActiveTab, useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  unwrap,
  YadbeIpcError,
  type ApplyOutcome,
  type ChangeSet,
  type ColumnReadOnlyReason,
  type CountMode,
  type EditPreview,
  type IpcResult,
  type ObjectRef,
  type RefreshedRows,
  type TableColumn,
  type TableDataInfo,
  type TableReadOnlyReason,
  type Value,
} from '../../ipc';
import { showJournalEntry } from '../journal/journalStore';
import { toast } from '../../ui/toastStore';
import type { DataGridApi } from '../grid/DataGrid';
import { valueText, type GridColumn } from '../grid/rowSource';
import { selectedRowIntervals, type Selection } from '../grid/selection';
import { findConnection } from '../query/connectionLookup';
import { cellValue, isEditableKind, valuesEqual } from './cellValues';
import { toTableFilter, type FilterState } from './filterModel';
import {
  duplicateCells,
  parseDelimited,
  pastedValue,
  planNewRows,
  planRangePaste,
} from './pasteModel';
import {
  addInserts,
  deleteRows as markDeleted,
  EMPTY_PENDING,
  firstMissingRequired,
  isEmpty,
  rebaseRow,
  revertCells as dropCells,
  revertInsertCells,
  revertRows as dropRows,
  setCell,
  setInsertCell,
  targetOf,
  toChangeSet,
  type ChangeTrace,
  type Pending,
} from './pendingChanges';
import { clearPendingFocus, peekPendingFocus } from './pendingFocus';
import { looseRows, TableRowSource, type LooseRow } from './tableRowSource';
import {
  getTableSession,
  useTableSessionStore,
  type ConflictRow,
  type TableSession,
} from './tableSessionStore';
import { getTableTabState, useTableTabStore, type TableTabState } from './tableTabStore';
import { getPreference } from '../preferences/preferenceStore';

/**
 * What a table tab does (F-080 to F-086): reading pages, counting, buffering edits, previewing
 * and applying them. Runs outside React: the view, the toolbar, the palette and the shortcuts
 * all call these. The rows live in the tab's `TableRowSource`; state the UI shows is in
 * `tableSessionStore`.
 */

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

const sources = new Map<string, TableRowSource>();
const grids = new Map<string, DataGridApi>();
const traces = new Map<string, ChangeTrace>();
/** The latest page request of each tab: older answers are dropped. */
const pageRequests = new Map<string, number>();

function patch(tabId: string, change: Partial<TableSession>): void {
  useTableSessionStore.getState().patch(tabId, change);
}

export function tableTabOf(
  tabId: string,
): (ShellTab & { connectionId: string; table: NonNullable<ShellTab['table']> }) | null {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  return tab && isTableTab(tab) ? tab : null;
}

/** The active tab when it is a table tab. */
export function activeTableTabId(): string | null {
  const tab = selectActiveTab(useTabsStore.getState());
  return isTableTab(tab) ? tab.id : null;
}

export function tableSource(tabId: string): TableRowSource | undefined {
  return sources.get(tabId);
}

// --- Edit targets (F-084, F-085, F-087) ------------------------------------------------------

/**
 * Where the edits of a session go. A table tab needs no registration: its target is built from
 * the tab. An editable query result registers its own (`result-edit/`), with its rows' source:
 * the session id is then not a shell tab id.
 */
export interface EditTarget {
  connectionId: string;
  /** The session still exists (its tab, its result). */
  alive(): boolean;
  preview(changes: ChangeSet): Promise<IpcResult<EditPreview>>;
  apply(changes: ChangeSet): Promise<IpcResult<ApplyOutcome>>;
  /** Rows read again by their identity after an apply; `rows`: their grid rows. */
  refresh(rows: readonly number[], keys: Value[][]): Promise<IpcResult<RefreshedRows>>;
  /** Some rows could not be read back after an apply: everything is read again. */
  reload(): Promise<unknown>;
  /** Data columns of the row identity, in its order (default: by name). */
  identity?: readonly number[];
  /**
   * Whether a data column holds a table column as stored, which a change set can carry (the
   * values of a deleted row, a conflict's comparison); default: every column.
   */
  sourced?(dataCol: number): boolean;
  /** Why nothing can be changed right now, `null` when it can. */
  block?(): string | null;
  /** Why rows cannot be added, `null` when they can. */
  insertBlock?: string | null;
}

const targets = new Map<string, EditTarget>();

/** Registers (or, with `null`, forgets) the target and the rows of a session that is not a tab. */
export function registerEditSession(
  id: string,
  session: { target: EditTarget; source: TableRowSource } | null,
): void {
  if (session) {
    targets.set(id, session.target);
    sources.set(id, session.source);
    return;
  }
  targets.delete(id);
  sources.get(id)?.dispose();
  sources.delete(id);
  grids.delete(id);
  traces.delete(id);
  editorFlushes.delete(id);
  useTableSessionStore.getState().remove(id);
}

function tabTarget(tabId: string): EditTarget | null {
  const tab = tableTabOf(tabId);
  if (!tab) return null;
  return {
    connectionId: tab.connectionId,
    alive: () => tableTabOf(tabId) !== null,
    preview: (changes) => ipc.commands.previewTableChanges(tabId, changes),
    apply: (changes) => ipc.commands.applyTableChanges(tabId, changes),
    refresh: (_rows, keys) => ipc.commands.refreshTableRows(tabId, keys),
    reload: () => loadPage(tabId, { offset: getTableSession(tabId).offset }),
  };
}

/** The target of a session: registered, or the table tab of that id. */
export function editTargetOf(id: string): EditTarget | null {
  return targets.get(id) ?? tabTarget(id);
}

/** `true` unless the session's target says this column is the query's own. */
function sourcedColumn(target: EditTarget | null, dataCol: number): boolean {
  return target?.sourced?.(dataCol) ?? true;
}

let resultEditLocator: (() => string | null) | null = null;

/**
 * Lets the result editing find the edit session of the result grid that has the focus, so the
 * editing shortcuts act on it in a query tab.
 */
export function setResultEditLocator(locate: (() => string | null) | null): void {
  resultEditLocator = locate;
}

/** The session editing shortcuts act on: the active table tab, else the focused result. */
export function activeEditId(): string | null {
  return activeTableTabId() ?? resultEditLocator?.() ?? null;
}

/** The grid of a mounted table view registers itself, so actions can read its selection. */
export function registerGrid(tabId: string, api: DataGridApi | null): void {
  if (api) grids.set(tabId, api);
  else grids.delete(tabId);
  if (api) revealPendingFocus(tabId);
}

/** Focuses the cell a navigation asked for (F-088), once the grid and the new page are there. */
export function revealPendingFocus(tabId: string): void {
  const focus = peekPendingFocus(tabId);
  const grid = grids.get(tabId);
  const source = sources.get(tabId);
  const { info, page, loadingSince } = getTableSession(tabId);
  if (!focus || !grid || !source || !info || !page || loadingSince !== null) return;
  clearPendingFocus(tabId);
  if (source.rowCount === 0) return;
  const dataCol = Math.max(
    0,
    info.columns.findIndex((column) => column.name === focus.column),
  );
  grid.focusCell({ row: Math.min(focus.row, source.rowCount - 1), dataCol });
  grid.focus();
}

export function gridOf(tabId: string): DataGridApi | undefined {
  return grids.get(tabId);
}

const editorFlushes = new Map<string, () => Promise<void>>();

/** The open cell editor of a mounted view commits through this before Apply reads the changes. */
export function registerEditorFlush(tabId: string, flush: (() => Promise<void>) | null): void {
  if (flush) editorFlushes.set(tabId, flush);
  else editorFlushes.delete(tabId);
}

/** Commits what is being typed in a cell (a valid value), so Apply and Preview include it. */
export function flushEditor(tabId: string): Promise<void> {
  return editorFlushes.get(tabId)?.() ?? Promise.resolve();
}

// --- Read-only reasons (F-086) ---------------------------------------------------------------

export function tableReasonText(reason: TableReadOnlyReason): string {
  return t(`tableData.readOnly.${reason}`);
}

export function columnReasonText(reason: ColumnReadOnlyReason | 'array'): string {
  return t(`tableData.readOnly.column.${reason}`);
}

function columnReason(column: TableColumn): ColumnReadOnlyReason | 'array' | null {
  // `table`: the whole table is read-only, said once by the banner, not on every header.
  if (column.readOnlyReason && column.readOnlyReason !== 'table') return column.readOnlyReason;
  return isEditableKind(column.kind) ? null : 'array';
}

/** Why a column of an editable session cannot be written, for its header; `null`: it can. */
export function headerReason(column: TableColumn): string | null {
  const reason = columnReason(column);
  return reason ? columnReasonText(reason) : null;
}

function gridColumns(info: TableDataInfo): GridColumn[] {
  return info.columns.map((column) => {
    const reason = columnReason(column);
    return {
      name: column.name,
      typeName: column.typeName,
      kind: column.kind,
      readOnlyReason: reason && info.readOnlyReasons.length === 0 ? columnReasonText(reason) : null,
      link: info.foreignKeys.some((fk) => fk.columns.includes(column.name)),
    };
  });
}

/** The hover texts of a session's rows, in the current language. */
export function sourceLabels() {
  return {
    original: (text: string) => t('tableData.cell.original', { value: text }),
    defaultValue: (expression: string | null) =>
      expression ? t('tableData.cell.defaultOf', { expression }) : t('tableData.cell.default'),
    required: (column: string) => t('tableData.cell.required', { column }),
    null: 'NULL',
  };
}

/** The language changed: hover texts and header reasons follow. */
export function relabelSources(): void {
  for (const [tabId, source] of sources) {
    const info = getTableSession(tabId).info;
    if (info) {
      const fresh = gridColumns(info);
      // The grid keeps the column objects (and its widths) for the source's life.
      source.columns.forEach((column, i) => {
        Object.assign(column, { readOnlyReason: fresh[i]?.readOnlyReason ?? null });
      });
    }
    source.setLabels(sourceLabels());
  }
}

function sameColumns(a: TableDataInfo, b: TableDataInfo): boolean {
  return (
    a.columns.length === b.columns.length &&
    a.columns.every((column, i) => {
      const other = b.columns[i];
      return (
        other !== undefined &&
        other.name === column.name &&
        other.kind === column.kind &&
        other.readOnlyReason === column.readOnlyReason
      );
    }) &&
    a.readOnlyReasons.join() === b.readOnlyReasons.join()
  );
}

// --- Opening and reading pages (F-080, F-081) ------------------------------------------------

/** Reads the table's description, then its first page. Called when the tab can connect. */
export async function openTable(tabId: string): Promise<void> {
  const tab = tableTabOf(tabId);
  if (!tab) return;
  const before = getTableSession(tabId);
  if (before.phase === 'opening') return;
  patch(tabId, { phase: 'opening', error: null });
  const result = await ipc.commands.openTableData(tabId, tab.connectionId, tab.table);
  if (!tableTabOf(tabId)) return;
  if (result.status === 'error') {
    patch(tabId, { phase: 'failed', error: result.error });
    return;
  }
  const info = result.data;
  const kept = before.info && sources.has(tabId) && sameColumns(before.info, info);
  // The source first: the view reads it as soon as `info` is there.
  if (!kept) {
    sources.get(tabId)?.dispose();
    sources.set(tabId, new TableRowSource(info.columns, gridColumns(info), sourceLabels()));
  }
  patch(tabId, { phase: 'ready', info });
  // Reopened with pending changes (reconnection, metadata refresh): they stay, and so do the rows.
  if (kept && !isEmpty(getTableSession(tabId).pending)) return;
  await loadPage(tabId, { offset: kept ? before.offset : 0, recount: true });
}

function filterOf(tabId: string, info: TableDataInfo) {
  return toTableFilter(getTableTabState(tabId).filter, info.columns);
}

/**
 * Reads a page. A raw `WHERE` the engine refuses is shown under its field (`whereError`) and
 * the rows on screen stay. Pending changes are dropped: callers ask first (`confirmDiscard`).
 */
export async function loadPage(
  tabId: string,
  options: { offset: number; recount?: boolean },
): Promise<boolean> {
  const { info } = getTableSession(tabId);
  const source = sources.get(tabId);
  if (!info || !source) return false;
  const view = getTableTabState(tabId);
  const filter = filterOf(tabId, info);
  const request = (pageRequests.get(tabId) ?? 0) + 1;
  pageRequests.set(tabId, request);
  patch(tabId, { loadingSince: Date.now(), error: null });
  const result = await ipc.commands.fetchTablePage(tabId, {
    filter,
    sort: view.sort,
    offset: options.offset,
    limit: view.pageSize,
  });
  if (pageRequests.get(tabId) !== request || !tableTabOf(tabId)) return false;
  if (result.status === 'error') {
    const { error } = result;
    const whereFault =
      filter.rawWhere !== null &&
      (error.code === 'queryFailed' ||
        error.code === 'invalidArgument' ||
        error.code === 'readOnlyViolation');
    if (error.code === 'cancelled') patch(tabId, { loadingSince: null });
    else if (whereFault) {
      patch(tabId, {
        loadingSince: null,
        whereError: [localize(error.message), error.detail].filter(Boolean).join('\n'),
      });
    } else patch(tabId, { loadingSince: null, error });
    return false;
  }
  const page = result.data;
  // The last page says how many rows match: no estimate to show (a never-analyzed PostgreSQL
  // table can be estimated at ten times its size).
  const known =
    !page.hasMore && (page.rowCount > 0 || page.offset === 0) ? page.offset + page.rowCount : null;
  source.setPage(page);
  traces.delete(tabId);
  const session = getTableSession(tabId);
  patch(tabId, {
    loadingSince: null,
    error: null,
    whereError: null,
    offset: page.offset,
    page: {
      rowCount: page.rowCount,
      hasMore: page.hasMore,
      durationMs: page.durationMs,
      order: page.order,
    },
    pageVersion: session.pageVersion + 1,
    pending: EMPTY_PENDING,
    failure: null,
    preview: null,
    stale: false,
    ...(known !== null
      ? { count: { mode: 'exact', count: known, filtered: true, durationMs: null } }
      : options.recount
        ? { count: null }
        : {}),
  });
  if (options.recount && known === null) void countRows(tabId, 'estimate');
  revealPendingFocus(tabId);
  return true;
}

/** An estimate first (fast), the exact count on demand (cancellable). */
export async function countRows(tabId: string, mode: CountMode): Promise<void> {
  const { info } = getTableSession(tabId);
  if (!info) return;
  if (mode === 'exact') patch(tabId, { counting: true });
  const result = await ipc.commands.countTableRows(tabId, filterOf(tabId, info), mode);
  if (!tableTabOf(tabId)) return;
  if (result.status === 'ok') {
    const current = getTableSession(tabId).count;
    // A late estimate never replaces an exact count.
    if (mode === 'exact' || current?.mode !== 'exact') patch(tabId, { count: result.data });
  } else if (result.error.code !== 'cancelled' && mode === 'exact') {
    showYadbeError(result.error, { title: t('tableData.count.failed') });
  }
  if (mode === 'exact') patch(tabId, { counting: false });
}

/** Stops what the tab runs (a page, a count) with the engine's own mechanism. */
export function cancelTableWork(tabId: string): void {
  void ipc.commands.cancelTableData(tabId);
}

export type DiscardReason =
  'page' | 'filter' | 'sort' | 'refresh' | 'close' | 'pageSize' | 'navigate' | 'revert' | 'run';

/** Asks before pending changes are lost; `true` when there are none or the user agrees. */
export function confirmDiscard(tabIds: readonly string[], reason: DiscardReason): Promise<boolean> {
  const count = tabIds.reduce((sum, id) => sum + getTableSession(id).pendingCount, 0);
  if (count === 0) return Promise.resolve(true);
  const target = tabIds.length === 1 ? editTargetOf(tabIds[0] ?? '') : null;
  const connection = findConnection(target?.connectionId ?? null);
  return confirm({
    ...(connection ? { connection } : {}),
    title: t('tableData.discard.title', { count }),
    description: t(`tableData.discard.${reason}`),
    confirmLabel: t('tableData.discard.confirm'),
    danger: true,
  });
}

async function changeView(
  tabId: string,
  reason: DiscardReason,
  change: Partial<TableTabState> | null,
  offset: number,
  recount: boolean,
): Promise<boolean> {
  if (!(await confirmDiscard([tabId], reason))) return false;
  if (change) useTableTabStore.getState().update(tabId, change);
  return loadPage(tabId, { offset, recount });
}

export function applyFilter(tabId: string, filter: FilterState): Promise<boolean> {
  return changeView(tabId, 'filter', { filter }, 0, true);
}

export function sortBy(tabId: string, dataCol: number, additive: boolean): Promise<boolean> {
  const { info } = getTableSession(tabId);
  const column = info?.columns[dataCol];
  if (!column) return Promise.resolve(false);
  const current = getTableTabState(tabId).sort;
  const index = current.findIndex((key) => key.column === column.name);
  const existing = current[index];
  let sort;
  if (additive) {
    // Shift+click: add the column, flip it, then take it out.
    if (!existing) sort = [...current, { column: column.name, direction: 'asc' as const }];
    else if (existing.direction === 'asc') {
      sort = current.map((key, i) => (i === index ? { ...key, direction: 'desc' as const } : key));
    } else sort = current.filter((_, i) => i !== index);
  } else if (existing && current.length === 1) {
    sort = existing.direction === 'asc' ? [{ ...existing, direction: 'desc' as const }] : [];
  } else {
    sort = [{ column: column.name, direction: 'asc' as const }];
  }
  return changeView(tabId, 'sort', { sort }, 0, false);
}

export function setPageSize(tabId: string, pageSize: number): Promise<boolean> {
  return changeView(tabId, 'pageSize', { pageSize }, 0, false);
}

export function goToPage(
  tabId: string,
  direction: 'first' | 'previous' | 'next',
): Promise<boolean> {
  const session = getTableSession(tabId);
  const size = getTableTabState(tabId).pageSize;
  const offset =
    direction === 'first'
      ? 0
      : direction === 'previous'
        ? Math.max(0, session.offset - size)
        : session.offset + size;
  if (direction === 'next' && !session.page?.hasMore) return Promise.resolve(false);
  if (direction !== 'next' && session.offset === 0) return Promise.resolve(false);
  return changeView(tabId, 'page', null, offset, false);
}

export function refreshTable(tabId: string): Promise<boolean> {
  return changeView(tabId, 'refresh', null, getTableSession(tabId).offset, true);
}

// --- Editing (F-082, F-083, F-084, F-086) ----------------------------------------------------

/** Why a cell cannot be changed, `null` when it can. */
export function cellBlock(tabId: string, row: number, dataCol: number): string | null {
  const { info, pending } = getTableSession(tabId);
  const source = sources.get(tabId);
  if (!info || !source) return t('tableData.edit.notReady');
  const tableReason = info.readOnlyReasons[0];
  if (tableReason) return tableReasonText(tableReason);
  const blocked = editTargetOf(tabId)?.block?.() ?? null;
  if (blocked) return blocked;
  const column = info.columns[dataCol];
  if (!column) return t('tableData.edit.notReady');
  const reason = columnReason(column);
  if (reason)
    return t('tableData.edit.columnReadOnly', {
      column: column.name,
      reason: columnReasonText(reason),
    });
  if (pending.rows.get(row)?.deleted) return t('tableData.edit.deletedRow');
  return null;
}

/** Explains, once per attempt, why something cannot be edited. */
export function explain(message: string): void {
  toast({ variant: 'info', title: message });
}

/** Why the table cannot take new rows or deletions, `null` when it can. */
export function tableBlock(tabId: string): string | null {
  const { info } = getTableSession(tabId);
  if (!info || !sources.has(tabId)) return t('tableData.edit.notReady');
  const reason = info.readOnlyReasons[0];
  return reason ? tableReasonText(reason) : (editTargetOf(tabId)?.block?.() ?? null);
}

/** Why the session cannot take new rows, `null` when it can. */
function insertBlock(tabId: string): string | null {
  return tableBlock(tabId) ?? editTargetOf(tabId)?.insertBlock ?? null;
}

function setPending(tabId: string, pending: Pending): void {
  const session = getTableSession(tabId);
  if (pending === session.pending) return;
  // Fixing or reverting after a failed apply: the highlight of the failure goes.
  patch(tabId, { pending, failure: null });
  const source = sources.get(tabId);
  source?.setPending(pending);
  if (session.failure) source?.setFailed(null);
}

function identityColumns(tabId: string, info: TableDataInfo): number[] {
  const own = editTargetOf(tabId)?.identity;
  if (own) return [...own];
  return (info.rowIdentity ?? []).map((name) => info.columns.findIndex((c) => c.name === name));
}

export interface CellWrite {
  row: number;
  dataCol: number;
  /** `undefined`: back to the default (new rows only). */
  value: Value | undefined;
}

/** Writes cells into the pending changes (keys and originals are read first, all or nothing). */
export async function writeCells(tabId: string, writes: readonly CellWrite[]): Promise<void> {
  const { info } = getTableSession(tabId);
  const source = sources.get(tabId);
  if (!info || !source || writes.length === 0) return;
  const identity = identityColumns(tabId, info);
  const rows = [...new Set(writes.map((w) => w.row))].filter(
    (row) => source.rowKind(row).kind === 'row',
  );
  const keys = new Map<number, Value[]>();
  const originals = new Map<string, Value>();
  await Promise.all([
    ...rows.map(async (row) => {
      keys.set(row, await source.keyOf(row, identity));
    }),
    ...writes
      .filter((w) => source.rowKind(w.row).kind === 'row')
      .map(async (w) => {
        originals.set(
          `${String(w.row)}:${String(w.dataCol)}`,
          await source.underlyingValue(w.row, w.dataCol),
        );
      }),
  ]);
  let pending = getTableSession(tabId).pending;
  for (const write of writes) {
    const at = source.rowKind(write.row);
    if (at.kind === 'insert') {
      pending = setInsertCell(pending, at.index, write.dataCol, write.value);
      continue;
    }
    const key = keys.get(write.row);
    const original = originals.get(`${String(write.row)}:${String(write.dataCol)}`);
    if (!key || !original) continue;
    pending =
      write.value === undefined
        ? dropCells(pending, write.row, [write.dataCol])
        : setCell(pending, { row: write.row, key }, write.dataCol, write.value, original);
  }
  setPending(tabId, pending);
}

/** Cells of a selection as data positions (display columns mapped through the order). */
function selectedCells(
  selection: Selection,
  order: readonly number[],
  rowCount: number,
): { row: number; dataCol: number }[] {
  const cells: { row: number; dataCol: number }[] = [];
  const seen = new Set<string>();
  for (const range of selection.ranges) {
    for (let row = range.r0; row <= Math.min(range.r1, rowCount - 1); row++) {
      for (let col = range.c0; col <= Math.min(range.c1, order.length - 1); col++) {
        const dataCol = order[col];
        const id = `${String(row)}:${String(dataCol)}`;
        if (dataCol === undefined || seen.has(id)) continue;
        seen.add(id);
        cells.push({ row, dataCol });
      }
    }
  }
  if (cells.length === 0) {
    const dataCol = order[selection.focus.col];
    if (dataCol !== undefined && selection.focus.row < rowCount) {
      cells.push({ row: selection.focus.row, dataCol });
    }
  }
  return cells;
}

function selectionOf(
  tabId: string,
): { cells: { row: number; dataCol: number }[]; rows: number[] } | null {
  const grid = grids.get(tabId);
  const source = sources.get(tabId);
  const selection = grid?.selection();
  if (!grid || !source || !selection) return null;
  const rowCount = source.rowCount;
  const rows: number[] = [];
  for (const interval of selectedRowIntervals(selection, rowCount)) {
    for (let row = interval.start; row < interval.end; row++) rows.push(row);
  }
  if (rows.length === 0 && selection.focus.row < rowCount) rows.push(selection.focus.row);
  return { cells: selectedCells(selection, grid.order(), rowCount), rows };
}

/** `Mod+Backspace` (F-082): the selected cells become NULL. */
export async function setNullOnSelection(tabId: string): Promise<void> {
  const selected = selectionOf(tabId);
  const { info } = getTableSession(tabId);
  if (!selected || !info) return;
  const writes: CellWrite[] = [];
  for (const { row, dataCol } of selected.cells) {
    const block = cellBlock(tabId, row, dataCol);
    const column = info.columns[dataCol];
    if (block) {
      explain(block);
      return;
    }
    if (column && !column.nullable) {
      explain(t('tableData.edit.notNullable', { column: column.name }));
      return;
    }
    writes.push({ row, dataCol, value: { kind: 'null' } });
  }
  await writeCells(tabId, writes);
}

/** The first column a user can write, in display order, for focusing a new row. */
function firstWritable(tabId: string): number {
  const { info } = getTableSession(tabId);
  const order = grids.get(tabId)?.order() ?? [];
  const writable = order.find((dataCol) => {
    const column = info?.columns[dataCol];
    return column !== undefined && columnReason(column) === null;
  });
  return writable ?? order[0] ?? 0;
}

function addRows(tabId: string, rows: readonly ReadonlyMap<number, Value>[]): void {
  const source = sources.get(tabId);
  if (!source || rows.length === 0) return;
  const { pending, first } = addInserts(getTableSession(tabId).pending, rows);
  setPending(tabId, pending);
  const grid = grids.get(tabId);
  const row = source.mappedCount + first;
  if (rows.length > 1) grid?.selectRows(row, row + rows.length - 1);
  else grid?.focusCell({ row, dataCol: firstWritable(tabId) });
  grid?.focus();
}

/** A new empty row (F-083): every column takes its default until edited. */
export function insertRow(tabId: string): void {
  const block = insertBlock(tabId);
  if (block) {
    explain(block);
    return;
  }
  addRows(tabId, [new Map()]);
}

/** Copies of the selected rows, keys and generated columns left to the server. */
export async function duplicateRows(tabId: string): Promise<void> {
  const block = insertBlock(tabId);
  const selected = selectionOf(tabId);
  const { info } = getTableSession(tabId);
  const source = sources.get(tabId);
  if (block) {
    explain(block);
    return;
  }
  if (!selected || !info || !source) return;
  const copies = await Promise.all(
    selected.rows.map(async (row) => {
      const values = await Promise.all(info.columns.map((_, col) => source.fullValue(row, col)));
      return duplicateCells(values, info.columns);
    }),
  );
  addRows(tabId, copies);
}

/** Marks the selected rows for deletion; new rows are simply removed. */
export async function deleteSelectedRows(tabId: string): Promise<void> {
  const block = tableBlock(tabId);
  const selected = selectionOf(tabId);
  const { info } = getTableSession(tabId);
  const source = sources.get(tabId);
  if (block) {
    explain(block);
    return;
  }
  if (!selected || !info || !source) return;
  const identity = identityColumns(tabId, info);
  const existing = selected.rows.filter((row) => source.rowKind(row).kind === 'row');
  const inserts = selected.rows.flatMap((row) => {
    const at = source.rowKind(row);
    return at.kind === 'insert' ? [at.index] : [];
  });
  // The whole row as read: the delete checks it (F-089) and the journal can put it back (F-090).
  const targets = await Promise.all(
    existing.map(async (row) => ({
      row,
      key: await source.keyOf(row, identity),
      values: await Promise.all(info.columns.map((_, col) => source.underlyingValue(row, col))),
    })),
  );
  setPending(tabId, markDeleted(getTableSession(tabId).pending, targets, inserts));
}

/** Reverts the selected cells (an edit, or a new row's value back to its default). */
export function revertSelectedCells(tabId: string): void {
  const selected = selectionOf(tabId);
  const source = sources.get(tabId);
  if (!selected || !source) return;
  let pending = getTableSession(tabId).pending;
  for (const { row, dataCol } of selected.cells) {
    const at = source.rowKind(row);
    pending =
      at.kind === 'insert'
        ? revertInsertCells(pending, at.index, [dataCol])
        : dropCells(pending, row, [dataCol]);
  }
  setPending(tabId, pending);
}

/** Reverts the selected rows: edits and deletion undone, new rows removed. */
export function revertSelectedRows(tabId: string): void {
  const selected = selectionOf(tabId);
  const source = sources.get(tabId);
  if (!selected || !source) return;
  const rows: number[] = [];
  const inserts: number[] = [];
  for (const row of selected.rows) {
    const at = source.rowKind(row);
    if (at.kind === 'insert') inserts.push(at.index);
    else rows.push(row);
  }
  setPending(tabId, dropRows(getTableSession(tabId).pending, rows, inserts));
}

export async function revertAll(tabId: string): Promise<void> {
  const { pendingCount } = getTableSession(tabId);
  if (pendingCount === 0) return;
  const confirmed = await confirm({
    title: t('tableData.revertAll.title', { count: pendingCount }),
    description: t('tableData.revertAll.description'),
    confirmLabel: t('tableData.revertAll.confirm'),
    danger: true,
  });
  if (confirmed) setPending(tabId, EMPTY_PENDING);
}

/**
 * Pasted text (F-082, F-083): over the cells from the focused one (a single value fills the
 * selected range), or as new rows. All the values are checked first: one that does not fit its
 * column stops the paste and says where.
 */
export async function pasteText(tabId: string, text: string, asRows: boolean): Promise<void> {
  const { info } = getTableSession(tabId);
  const source = sources.get(tabId);
  const grid = grids.get(tabId);
  if (!info || !source || !grid) return;
  const block = asRows ? insertBlock(tabId) : tableBlock(tabId);
  if (block) {
    explain(block);
    return;
  }
  const pasted = parseDelimited(text);
  if (pasted.length === 0) return;
  const order = grid.order();
  if (asRows) {
    const { rows } = planNewRows(pasted, info.columns, order);
    const values: Map<number, Value>[] = [];
    for (const [r, cells] of rows.entries()) {
      const row = new Map<number, Value>();
      for (const [dataCol, cell] of cells) {
        const column = info.columns[dataCol];
        // Generated columns copied along with the rows keep their default.
        if (!column || columnReason(column)) continue;
        const parsed = pastedValue(cell, column, true);
        if (parsed === 'default') continue;
        if (!parsed.ok) {
          explain(
            t('tableData.paste.invalid', {
              row: r + 1,
              column: column.name,
              reason: t(parsed.error, parsed.params),
            }),
          );
          return;
        }
        row.set(dataCol, parsed.value);
      }
      values.push(row);
    }
    addRows(tabId, values);
    toast({ variant: 'success', title: t('tableData.paste.rows', { count: values.length }) });
    return;
  }
  const selection = grid.selection();
  if (!selection) return;
  const only = selection.ranges.length === 1 ? selection.ranges[0] : undefined;
  const { targets, clipped } = planRangePaste(
    pasted,
    selection.focus,
    order,
    source.rowCount,
    only ?? null,
  );
  const writes: CellWrite[] = [];
  for (const target of targets) {
    const column = info.columns[target.dataCol];
    const reason = cellBlock(tabId, target.row, target.dataCol);
    if (!column || reason) {
      explain(reason ?? t('tableData.edit.notReady'));
      return;
    }
    const isNew = source.rowKind(target.row).kind === 'insert';
    const parsed = pastedValue(target.cell, column, isNew);
    if (parsed === 'default') {
      writes.push({ row: target.row, dataCol: target.dataCol, value: undefined });
      continue;
    }
    if (!parsed.ok) {
      explain(
        t('tableData.paste.invalid', {
          row: target.row + 1,
          column: column.name,
          reason: t(parsed.error, parsed.params),
        }),
      );
      return;
    }
    writes.push({ row: target.row, dataCol: target.dataCol, value: parsed.value });
  }
  await writeCells(tabId, writes);
  if (clipped > 0) explain(t('tableData.paste.clipped', { count: clipped }));
}

// --- Preview and apply (F-085) ---------------------------------------------------------------

/** Production connections always show the SQL first; elsewhere the preference decides. */
export function mustPreview(tabId: string): boolean {
  const connection = findConnection(editTargetOf(tabId)?.connectionId ?? null);
  return connection?.environment === 'prod' || getPreference('previewBeforeApply');
}

export async function openPreview(tabId: string): Promise<void> {
  const { info, pending } = getTableSession(tabId);
  if (!info || isEmpty(pending)) return;
  patch(tabId, { preview: { status: 'loading', data: null, error: null } });
  const target = editTargetOf(tabId);
  if (!target) return;
  const { changes } = toChangeSet(pending, info.columns, (col) => sourcedColumn(target, col));
  const result = await target.preview(changes);
  if (getTableSession(tabId).preview === null) return;
  patch(tabId, {
    preview:
      result.status === 'ok'
        ? { status: 'ready', data: result.data, error: null }
        : { status: 'failed', data: null, error: result.error },
  });
}

export function closePreview(tabId: string): void {
  patch(tabId, { preview: null });
}

/**
 * A new row misses a value the server requires: says which, and focuses the cell. The server
 * would refuse the insert and roll everything back.
 */
function missingRequired(tabId: string): boolean {
  const { info, pending } = getTableSession(tabId);
  const missing = info ? firstMissingRequired(pending, info.columns) : null;
  const source = sources.get(tabId);
  if (!info || !missing || !source) return false;
  const grid = grids.get(tabId);
  grid?.focusCell({ row: source.mappedCount + missing.index, dataCol: missing.dataCol });
  grid?.focus();
  toast({
    variant: 'warning',
    title: t('tableData.apply.required', { column: info.columns[missing.dataCol]?.name ?? '' }),
  });
  return true;
}

/** `Mod+S`: shows the SQL first when it must, else applies. */
export function requestApply(tabId: string): void {
  const { pending, applying } = getTableSession(tabId);
  if (isEmpty(pending) || applying || missingRequired(tabId)) return;
  if (mustPreview(tabId)) void openPreview(tabId);
  else void applyChanges(tabId);
}

/** The key of a row once its update ran: edited key columns take their new values. */
function keyAfter(
  key: Value[],
  cells: ReadonlyMap<number, { value: Value }>,
  identity: number[],
): Value[] {
  return key.map((value, i) => {
    const col = identity[i];
    return (col !== undefined ? cells.get(col)?.value : undefined) ?? value;
  });
}

/**
 * Applies the pending changes in one transaction. On success the rows show what the server
 * stored; on a rollback nothing is lost: the changes stay, the failing one is highlighted and
 * focused, and the error is shown with what to do.
 */
export async function applyChanges(tabId: string): Promise<void> {
  const session = getTableSession(tabId);
  const { info, pending } = session;
  const source = sources.get(tabId);
  const target = editTargetOf(tabId);
  if (!info || !source || !target || isEmpty(pending) || session.applying) return;
  if (missingRequired(tabId)) {
    patch(tabId, { preview: null });
    return;
  }
  const blocked = target.block?.() ?? null;
  if (blocked) {
    patch(tabId, { preview: null });
    explain(blocked);
    return;
  }
  patch(tabId, { applying: true });
  const sourced = (col: number) => sourcedColumn(target, col);
  const { changes, trace } = toChangeSet(pending, info.columns, sourced);
  traces.set(tabId, trace);
  let result;
  try {
    result = await target.apply(changes);
  } catch (error) {
    patch(tabId, { applying: false });
    throw error;
  }
  if (!target.alive()) return;
  if (result.status === 'error') {
    patch(tabId, { applying: false, preview: null });
    showYadbeError(result.error, {
      title: t('tableData.apply.failed'),
      retry: () => {
        void applyChanges(tabId);
      },
    });
    return;
  }
  const outcome = result.data;
  if (outcome.status === 'rolledBack') {
    const { failure } = outcome;
    const target = failure.change
      ? targetOf(
          failure.change,
          trace,
          (name) => info.columns.findIndex((c) => c.name === name),
          failure.violation?.column ?? null,
        )
      : null;
    patch(tabId, { applying: false, preview: null, failure: { failure, target } });
    source.setFailed(target);
    revealTarget(tabId, target);
    return;
  }
  if (outcome.status === 'conflicted') {
    const rows = await conflictRows(info, source, pending, trace, outcome, sourced);
    if (!target.alive()) return;
    patch(tabId, { applying: false, preview: null, conflict: { rows } });
    return;
  }

  const identity = identityColumns(tabId, info);
  const deleted = new Set(trace.deletes);
  const updated = [...pending.rows.entries()].filter(
    ([, change]) => !change.deleted && change.cells.size > 0,
  );
  const refreshed = new Map<number, LooseRow>();
  let reload = false;
  if (updated.length > 0) {
    const keys = updated.map(([, change]) => keyAfter(change.key, change.cells, identity));
    const fresh = await target.refresh(
      updated.map(([row]) => row),
      keys,
    );
    if (fresh.status === 'ok') {
      const rows = looseRows(fresh.data.window, info.columns);
      updated.forEach(([row], i) => {
        const position = fresh.data.positions[i];
        const loose = position === null || position === undefined ? undefined : rows[position];
        if (loose) refreshed.set(row, loose);
        else reload = true;
      });
    } else reload = true;
  }
  const insertedRows = looseRows(outcome.inserted.window, info.columns);
  const inserted = outcome.inserted.positions.flatMap((position) => {
    const row = position === null ? undefined : insertedRows[position];
    if (!row) reload = true;
    return row ? [row] : [];
  });
  source.applied({ deleted, refreshed, inserted });
  traces.delete(tabId);
  const counts = { updated: 0, inserted: 0, deleted: 0 };
  for (const { change } of outcome.statements) {
    if (change.kind === 'update') counts.updated++;
    else if (change.kind === 'insert') counts.inserted++;
    else counts.deleted++;
  }
  const count = getTableSession(tabId).count;
  patch(tabId, {
    applying: false,
    pending: EMPTY_PENDING,
    failure: null,
    preview: null,
    page: session.page
      ? { ...session.page, rowCount: session.page.rowCount + counts.inserted - counts.deleted }
      : null,
    pageVersion: session.pageVersion + 1,
    count:
      count && count.count !== null
        ? { ...count, count: Math.max(0, count.count + counts.inserted - counts.deleted) }
        : count,
  });
  const journalId = outcome.journalId;
  toast({
    variant: 'success',
    title: t('tableData.apply.done'),
    description: t('tableData.apply.counts', counts),
    ...(journalId !== null
      ? {
          action: {
            label: t('journal.showEntry'),
            onClick: () => {
              showJournalEntry(journalId);
            },
          },
        }
      : {}),
  });
  // Rows the server could not send back (triggers, no key to read them): read them again.
  if (reload) await target.reload();
}

function revealTarget(tabId: string, target: ReturnType<typeof targetOf>): void {
  const grid = grids.get(tabId);
  const source = sources.get(tabId);
  if (!grid || !source || !target) return;
  const row = source.rowOf(target);
  const dataCol = target.dataCols[0];
  if (dataCol === undefined) grid.selectRows(row, row);
  else grid.focusCell({ row, dataCol });
  grid.focus();
}

/** Shows the failing change again (the banner's "Show"). */
export function revealFailure(tabId: string): void {
  revealTarget(tabId, getTableSession(tabId).failure?.target ?? null);
}

/** Reverts the change that failed (the banner's "Revert this change"). */
export function revertFailure(tabId: string): void {
  const target = getTableSession(tabId).failure?.target;
  if (!target) return;
  const pending = getTableSession(tabId).pending;
  setPending(
    tabId,
    target.kind === 'insert'
      ? dropRows(pending, [], [target.index])
      : dropRows(pending, [target.row], []),
  );
}

export function dismissFailure(tabId: string): void {
  patch(tabId, { failure: null });
  sources.get(tabId)?.setFailed(null);
}

// --- Conflicts (F-089) -----------------------------------------------------------------------

/** The whole value of a cell of a loose row (its text may be cut). */
function looseValue(loose: LooseRow, col: number): Promise<Value> {
  if (loose.truncated.has(col)) {
    return unwrap(ipc.commands.fetchResultCell(loose.resultId, loose.index, col));
  }
  return Promise.resolve(cellValue(loose.texts[col] ?? null, loose.kinds[col] ?? 'text'));
}

/**
 * The conflicting rows of an apply, each with the cells the user edited (as read, as wanted, as
 * stored now) and the ones changed elsewhere.
 */
async function conflictRows(
  info: TableDataInfo,
  source: TableRowSource,
  pending: Pending,
  trace: ChangeTrace,
  outcome: Extract<ApplyOutcome, { status: 'conflicted' }>,
  sourced: (dataCol: number) => boolean,
): Promise<ConflictRow[]> {
  const current = looseRows(outcome.current.window, info.columns);
  const columnOf = (name: string) => info.columns.findIndex((c) => c.name === name);
  const rows = await Promise.all(
    outcome.conflicts.map(async (conflict, i): Promise<ConflictRow | null> => {
      const target = targetOf(conflict.change, trace, columnOf, null);
      if (target?.kind !== 'row') return null;
      const change = pending.rows.get(target.row);
      if (!change) return null;
      const position = outcome.current.positions[i];
      const asRead = await Promise.all(
        info.columns.map((_, col) => source.underlyingValue(target.row, col)),
      );
      const found = position === null || position === undefined ? null : current[position];
      // Columns the query computed are not read again: they keep what the row was read with.
      const currentRow = found ? keepComputed(found, asRead, sourced) : null;
      const theirs = currentRow
        ? await Promise.all(info.columns.map((_, col) => looseValue(currentRow, col)))
        : null;
      const cells = info.columns.flatMap((column, col) => {
        if (!sourced(col)) return [];
        const edit = change.cells.get(col);
        const original = edit?.original ?? asRead[col] ?? NULL;
        const now = theirs ? (theirs[col] ?? NULL) : null;
        const changedElsewhere = now !== null && !valuesEqual(original, now);
        if (!edit && !changedElsewhere) return [];
        return [
          {
            column: column.name,
            original,
            mine: change.deleted ? null : (edit?.value ?? original),
            theirs: now,
            edited: !!edit && !change.deleted,
          },
        ];
      });
      return {
        row: target.row,
        kind: change.deleted ? 'delete' : 'update',
        label: conflict.row,
        sql: conflict.sql,
        current: theirs,
        currentRow: currentRow ?? null,
        cells,
      };
    }),
  );
  return rows.filter((row): row is ConflictRow => row !== null);
}

const NULL: Value = { kind: 'null' };

/** A row read again, the columns a query computed taken from the row as read. */
function keepComputed(
  row: LooseRow,
  asRead: readonly Value[],
  sourced: (dataCol: number) => boolean,
): LooseRow {
  if (asRead.every((_, col) => sourced(col))) return row;
  const texts = [...row.texts];
  const kinds = [...row.kinds];
  const truncated = new Set(row.truncated);
  asRead.forEach((value, col) => {
    if (sourced(col)) return;
    texts[col] = valueText(value);
    if (value.kind !== 'null') kinds[col] = value.kind;
    truncated.delete(col);
  });
  return { ...row, texts, kinds, truncated };
}

export type ConflictChoice = 'mine' | 'theirs' | 'edit';

/** The choices a conflicting row offers: a row deleted elsewhere can only be let go. */
export function conflictChoices(row: ConflictRow): ConflictChoice[] {
  return row.current ? ['mine', 'theirs', 'edit'] : ['theirs'];
}

/**
 * Applies the per-row choices of the conflict dialog: "keep mine" and "keep editing" compare
 * with what the server holds now (the next Apply overwrites it, by choice), "take theirs" drops
 * the change. The rows show what the server holds. Without "keep editing", Apply runs again;
 * otherwise the first row to edit is focused.
 */
export function resolveConflicts(
  tabId: string,
  choices: ReadonlyMap<number, ConflictChoice>,
): void {
  const session = getTableSession(tabId);
  const source = sources.get(tabId);
  const conflict = session.conflict;
  if (!conflict || !source) return;
  let pending = session.pending;
  const refreshed = new Map<number, LooseRow>();
  let gone = false;
  let editRow: number | null = null;
  for (const item of conflict.rows) {
    const choice = item.current ? (choices.get(item.row) ?? 'edit') : 'theirs';
    if (item.currentRow) refreshed.set(item.row, item.currentRow);
    else gone = true;
    if (choice === 'theirs' || !item.current) {
      pending = dropRows(pending, [item.row], []);
      continue;
    }
    pending = rebaseRow(pending, item.row, item.current);
    if (choice === 'edit') editRow ??= item.row;
  }
  source.refreshRows(refreshed);
  setPending(tabId, pending);
  patch(tabId, { conflict: null, stale: session.stale || gone });
  if (editRow !== null) {
    const grid = grids.get(tabId);
    grid?.selectRows(editRow, editRow);
    grid?.focus();
    return;
  }
  if (!isEmpty(pending)) requestApply(tabId);
}

/** Closes the conflict dialog: nothing changes, the next Apply conflicts again. */
export function closeConflicts(tabId: string): void {
  patch(tabId, { conflict: null });
}

// --- Revert a change set (F-090) -------------------------------------------------------------

/** Waits until the tab's table is open and its first page read; `false` if the tab closes. */
function whenReady(tabId: string): Promise<boolean> {
  const ready = () => {
    const session = getTableSession(tabId);
    return session.info !== null && session.page !== null && session.loadingSince === null;
  };
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const stop = useTableSessionStore.subscribe(() => {
      if (!tableTabOf(tabId)) {
        stop();
        resolve(false);
      } else if (ready()) {
        stop();
        resolve(true);
      }
    });
  });
}

/**
 * "Revert this change set": opens (or shows) the table's tab, then its SQL to review before it
 * runs. The tab's pending changes go first, after asking.
 */
export async function revertChangeSet(
  connectionId: string,
  table: ObjectRef,
  entryId: number,
): Promise<void> {
  const tabId = useTabsStore.getState().openTableTab(connectionId, table);
  if (!(await whenReady(tabId))) return;
  if (!(await confirmDiscard([tabId], 'revert'))) return;
  if (!isEmpty(getTableSession(tabId).pending)) setPending(tabId, EMPTY_PENDING);
  patch(tabId, {
    revert: {
      entryId,
      status: 'loading',
      preview: null,
      error: null,
      conflicts: [],
      failure: null,
    },
  });
  const result = await ipc.commands.previewChangeSetRevert(tabId, entryId);
  const revert = getTableSession(tabId).revert;
  if (revert?.entryId !== entryId) return;
  patch(tabId, {
    revert:
      result.status === 'ok'
        ? { ...revert, status: 'ready', preview: result.data }
        : { ...revert, status: 'failed', error: result.error },
  });
}

/** Runs the reviewed revert in one transaction; the rows are read again once it is applied. */
export async function applyRevert(tabId: string): Promise<void> {
  const revert = getTableSession(tabId).revert;
  if (revert?.status !== 'ready') return;
  patch(tabId, { revert: { ...revert, status: 'applying' } });
  const result = await ipc.commands.applyChangeSetRevert(tabId, revert.entryId);
  if (!tableTabOf(tabId) || getTableSession(tabId).revert?.entryId !== revert.entryId) return;
  if (result.status === 'error') {
    patch(tabId, { revert: { ...revert, status: 'failed', error: result.error } });
    return;
  }
  const outcome = result.data;
  if (outcome.status === 'conflicted') {
    patch(tabId, {
      revert: {
        ...revert,
        status: 'conflicted',
        conflicts: outcome.conflicts.map((conflict, i) => ({
          label: conflict.row,
          sql: conflict.sql,
          gone: outcome.current.positions[i] === null,
        })),
      },
    });
    return;
  }
  if (outcome.status === 'rolledBack') {
    patch(tabId, { revert: { ...revert, status: 'rolledBack', failure: outcome.failure } });
    return;
  }
  patch(tabId, { revert: null });
  toast({ variant: 'success', title: t('journal.revert.done') });
  await loadPage(tabId, { offset: getTableSession(tabId).offset, recount: true });
}

export function closeRevert(tabId: string): void {
  patch(tabId, { revert: null });
}

// --- Life of a tab ---------------------------------------------------------------------------

/** The tab closed: its connection, its rows and its pending changes go. */
export function forgetTableTab(tabId: string): void {
  sources.get(tabId)?.dispose();
  sources.delete(tabId);
  grids.delete(tabId);
  traces.delete(tabId);
  pageRequests.delete(tabId);
  clearPendingFocus(tabId);
  useTableSessionStore.getState().remove(tabId);
  void ipc.commands.closeTableData(tabId).catch((error: unknown) => {
    if (!(error instanceof YadbeIpcError)) console.warn('Could not close the table tab', error);
  });
}
