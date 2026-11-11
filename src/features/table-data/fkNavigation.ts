import { create } from 'zustand';

import { isTableTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  type ForeignKey,
  type IncomingForeignKey,
  type KeyValue,
  type ObjectRef,
  type ReferencedRow,
  type Value,
  type YadbeError,
} from '../../ipc';
import type { GridCellRef } from '../grid/DataGrid';
import { foreignKeysOf, keyFilter, referencedKey, referencingKey, sameTable } from './fkModel';
import {
  canMove,
  EMPTY_TRAIL,
  forgetTab,
  moveNav,
  pushNav,
  samePlace,
  type NavLocation,
  type NavTrail,
} from './navTrail';
import { setPendingFocus } from './pendingFocus';
import {
  activeTableTabId,
  confirmDiscard,
  explain,
  gridOf,
  loadPage,
  revealPendingFocus,
  tableSource,
  tableTabOf,
} from './tableActions';
import { getTableSession } from './tableSessionStore';
import { getTableTabState, useTableTabStore } from './tableTabStore';

/**
 * Foreign key navigation (F-088): the peek of a referenced row, the jump to it, the rows that
 * reference a row, and the back / forward trail. Runs outside React, like `tableActions`:
 * the grid, its menu, the strip and the shortcuts call these.
 *
 * A jump opens (or reuses) the target table's tab with one visible `=` chip per key column,
 * replacing its filter: pending changes there are confirmed first, never silently dropped.
 */

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

let requestCounter = 0;
export function newRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export interface PeekState {
  tabId: string;
  cell: GridCellRef;
  fk: ForeignKey;
  key: KeyValue[];
  requestId: string;
  status: 'loading' | 'ready' | 'failed';
  data: ReferencedRow | null;
  error: YadbeError | null;
}

interface FkStore {
  /** The open peek (one at a time). */
  peek: PeekState | null;
  /** Tabs whose "rows referencing this row" panel is open. */
  referencing: Record<string, boolean>;
  trail: NavTrail;
}

export const useFkStore = create<FkStore>()(() => ({
  peek: null,
  referencing: {},
  trail: EMPTY_TRAIL,
}));

// --- Where the user is ---------------------------------------------------------------------

/** The focused cell of a table tab's grid (data column), `null` without one. */
export function focusedCell(tabId: string): GridCellRef | null {
  const grid = gridOf(tabId);
  const source = tableSource(tabId);
  const selection = grid?.selection();
  if (!grid || !source || !selection || selection.focus.row >= source.rowCount) return null;
  const dataCol = grid.order()[selection.focus.col];
  return dataCol === undefined ? null : { row: selection.focus.row, dataCol };
}

function locationOf(tabId: string): NavLocation {
  const cell = focusedCell(tabId);
  const column = cell ? getTableSession(tabId).info?.columns[cell.dataCol]?.name : undefined;
  return {
    tabId,
    filter: getTableTabState(tabId).filter,
    offset: getTableSession(tabId).offset,
    focus: cell && column !== undefined ? { row: cell.row, column } : null,
  };
}

/** The values of `columns` in a row as the grid shows it (pending edits included). */
export async function rowValues(
  tabId: string,
  row: number,
  columns: readonly string[],
): Promise<Map<string, Value> | null> {
  const { info } = getTableSession(tabId);
  const source = tableSource(tabId);
  if (!info || !source) return null;
  const values = new Map<string, Value>();
  for (const name of columns) {
    const col = info.columns.findIndex((column) => column.name === name);
    if (col < 0) return null;
    values.set(name, await source.fullValue(row, col));
  }
  return values;
}

export type CellReference =
  | { ok: true; fk: ForeignKey; key: KeyValue[] }
  | { ok: false; reason: 'notReady' | 'notForeignKey' | 'null' };

/** The foreign key of a cell and the key its value designates. */
export async function cellReference(tabId: string, cell: GridCellRef): Promise<CellReference> {
  const { info } = getTableSession(tabId);
  const column = info?.columns[cell.dataCol];
  if (!info || !column) return { ok: false, reason: 'notReady' };
  const fk = foreignKeysOf(info.foreignKeys, column.name)[0];
  if (!fk) return { ok: false, reason: 'notForeignKey' };
  const values = await rowValues(tabId, cell.row, fk.columns);
  if (!values) return { ok: false, reason: 'notReady' };
  const key = referencedKey(fk, (name) => values.get(name));
  return key ? { ok: true, fk, key } : { ok: false, reason: 'null' };
}

/** Whether a column belongs to an outgoing foreign key (its cells lead somewhere). */
export function isForeignKeyColumn(tabId: string, dataCol: number): boolean {
  const { info } = getTableSession(tabId);
  const column = info?.columns[dataCol];
  return !!info && !!column && info.foreignKeys.some((fk) => fk.columns.includes(column.name));
}

function explainReference(reason: 'notReady' | 'notForeignKey' | 'null'): void {
  if (reason === 'notForeignKey') explain(t('tableData.fk.notForeignKey'));
  else if (reason === 'null') explain(t('tableData.fk.nullValue'));
}

// --- Peek ------------------------------------------------------------------------------------

/** Shows the row a foreign key cell references, read on demand (cancellable). */
export async function peekReference(tabId: string, at?: GridCellRef): Promise<void> {
  const cell = at ?? focusedCell(tabId);
  if (!cell) return;
  const reference = await cellReference(tabId, cell);
  if (!reference.ok) {
    explainReference(reference.reason);
    return;
  }
  const tab = tableTabOf(tabId);
  if (!tab) return;
  closePeek();
  const requestId = newRequestId('peek');
  useFkStore.setState({
    peek: {
      tabId,
      cell,
      fk: reference.fk,
      key: reference.key,
      requestId,
      status: 'loading',
      data: null,
      error: null,
    },
  });
  const result = await ipc.commands.fetchReferencedRow(
    tabId,
    requestId,
    reference.fk.referencedTable,
    reference.key,
  );
  const current = useFkStore.getState().peek;
  if (current?.requestId !== requestId) return;
  useFkStore.setState({
    peek:
      result.status === 'ok'
        ? { ...current, status: 'ready', data: result.data }
        : { ...current, status: 'failed', error: result.error },
  });
}

/** Closes the peek; a read still running is cancelled. */
export function closePeek(): void {
  const peek = useFkStore.getState().peek;
  if (!peek) return;
  if (peek.status === 'loading') void ipc.commands.cancelReferenceLookup(peek.requestId);
  useFkStore.setState({ peek: null });
}

// --- Jumps -----------------------------------------------------------------------------------

/**
 * Opens `table` filtered on `key` (one `=` chip per column) from the tab `fromTabId`, in the
 * tab already showing it or a new one, its first row focused on `focusColumn`. Asks before
 * the target's pending changes are lost. `false` when nothing happened.
 */
export async function navigate(
  fromTabId: string,
  table: ObjectRef,
  key: readonly KeyValue[],
  focusColumn: string,
): Promise<boolean> {
  const from = tableTabOf(fromTabId);
  if (!from) return false;
  const here = locationOf(fromTabId);
  const existing = useTabsStore
    .getState()
    .tabs.find(
      (tab) =>
        isTableTab(tab) && tab.connectionId === from.connectionId && sameTable(tab.table, table),
    );
  if (existing && !(await confirmDiscard([existing.id], 'navigate'))) return false;
  closePeek();
  const filter = keyFilter(key);
  const id = useTabsStore.getState().openTableTab(from.connectionId, table);
  useTableTabStore.getState().update(id, { filter });
  setPendingFocus(id, { row: 0, column: focusColumn });
  const to: NavLocation = {
    tabId: id,
    filter,
    offset: 0,
    focus: { row: 0, column: focusColumn },
  };
  useFkStore.setState((state) => ({ trail: pushNav(state.trail, here, to) }));
  // A tab already showing the table reads its rows again; a new one opens with the filter.
  if (getTableSession(id).phase === 'ready') await loadPage(id, { offset: 0, recount: true });
  return true;
}

/** `F12`, `Mod+click`, "Open in table": the referenced row in its table's tab. */
export async function goToReference(tabId: string, at?: GridCellRef): Promise<boolean> {
  const cell = at ?? focusedCell(tabId);
  if (!cell) return false;
  const reference = await cellReference(tabId, cell);
  if (!reference.ok) {
    explainReference(reference.reason);
    return false;
  }
  const column = getTableSession(tabId).info?.columns[cell.dataCol]?.name ?? '';
  const index = reference.fk.columns.indexOf(column);
  const focusColumn = reference.fk.referencedColumns[Math.max(0, index)] ?? '';
  return navigate(tabId, reference.fk.referencedTable, reference.key, focusColumn);
}

/** The jump of the open peek ("Open in table"). */
export function openPeekInTable(): void {
  const peek = useFkStore.getState().peek;
  if (!peek) return;
  void goToReference(peek.tabId, peek.cell);
}

// --- Rows referencing a row ----------------------------------------------------------------

export function setReferencingOpen(tabId: string, open: boolean): void {
  useFkStore.setState((state) => ({ referencing: { ...state.referencing, [tabId]: open } }));
}

/** `Shift+F12` and the menu entry: the panel of the rows referencing the focused row. */
export function openReferencingPanel(tabId: string): void {
  if (!focusedCell(tabId)) {
    explain(t('tableData.fk.selectRow'));
    return;
  }
  setReferencingOpen(tabId, true);
}

/** The key of the rows that reference `row` through `incoming` (`null`: a NULL value). */
export async function referencingKeyOf(
  tabId: string,
  row: number,
  incoming: IncomingForeignKey,
): Promise<KeyValue[] | null> {
  const values = await rowValues(tabId, row, incoming.foreignKey.referencedColumns);
  return values ? referencingKey(incoming, (name) => values.get(name)) : null;
}

/** Opens the referencing table filtered on the rows that reference this one. */
export function openReferencing(
  tabId: string,
  incoming: IncomingForeignKey,
  key: readonly KeyValue[],
): Promise<boolean> {
  setReferencingOpen(tabId, false);
  return navigate(tabId, incoming.table, key, incoming.foreignKey.columns[0] ?? '');
}

// --- Back and forward ----------------------------------------------------------------------

export function canNavigate(tabId: string, step: -1 | 1): boolean {
  return canMove(useFkStore.getState().trail, tabId, step);
}

/** `Alt+←` / `Alt+→` in the active table tab; `false` when the trail has nothing there. */
export function moveInTrail(step: -1 | 1): boolean {
  const tabId = activeTableTabId();
  if (tabId === null || !canNavigate(tabId, step)) return false;
  void (async () => {
    const moved = moveNav(useFkStore.getState().trail, step, locationOf(tabId));
    if (!moved) return;
    const { target } = moved;
    if (!tableTabOf(target.tabId)) {
      forgetNavigation(target.tabId);
      return;
    }
    const current: NavLocation = { ...target, filter: getTableTabState(target.tabId).filter };
    const refilter = !samePlace(current, target);
    const reload = refilter || getTableSession(target.tabId).offset !== target.offset;
    if (reload && !(await confirmDiscard([target.tabId], 'navigate'))) return;
    closePeek();
    useFkStore.setState({ trail: moved.trail });
    useTabsStore.getState().activate(target.tabId);
    setPendingFocus(target.tabId, target.focus);
    if (refilter) useTableTabStore.getState().update(target.tabId, { filter: target.filter });
    if (reload && getTableSession(target.tabId).phase === 'ready') {
      await loadPage(target.tabId, { offset: target.offset, recount: refilter });
    } else revealPendingFocus(target.tabId);
  })();
  return true;
}

/** A table tab closed: its peek, panel and trail entries go. */
export function forgetNavigation(tabId: string): void {
  if (useFkStore.getState().peek?.tabId === tabId) closePeek();
  useFkStore.setState((state) => ({
    referencing: Object.fromEntries(
      Object.entries(state.referencing).filter(([id]) => id !== tabId),
    ),
    trail: forgetTab(state.trail, tabId),
  }));
}
