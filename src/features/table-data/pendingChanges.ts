import type {
  CellUpdate,
  ChangeSet,
  PlannedChange,
  RowInsert,
  TableColumn,
  Value,
} from '../../ipc';
import { valuesEqual } from './cellValues';

/**
 * Pending changes of a table tab (F-084): nothing is sent until Apply. Immutable values; an
 * entry that did not change keeps its identity, so the grid repaints only the rows that did.
 *
 * Rows are the rows of the grid: existing rows by their index (identified to the backend by the
 * key read with them), new rows by their rank among the inserts (drawn after the existing rows).
 * Pending changes never outlive the rows they were made on: another page, filter or sort asks
 * first and drops them (see `TableView`).
 */

export interface CellChange {
  value: Value;
  /** The value read from the server: setting it back drops the change. */
  original: Value;
}

export interface RowChange {
  /** The row's identity as read (`rowIdentity` order), even when a key column is edited. */
  key: Value[];
  /** Data column → new value. */
  cells: ReadonlyMap<number, CellChange>;
  /** Marked for deletion; its cell changes come back if the deletion is reverted. */
  deleted: boolean;
}

export interface InsertChange {
  /** Data column → value; a column left out takes its default. */
  cells: ReadonlyMap<number, Value>;
}

export interface Pending {
  rows: ReadonlyMap<number, RowChange>;
  inserts: readonly InsertChange[];
}

export const EMPTY_PENDING: Pending = { rows: new Map(), inserts: [] };

/** An existing row, with what identifies it. */
export interface RowTarget {
  row: number;
  key: Value[];
}

function withRow(pending: Pending, row: number, change: RowChange | null): Pending {
  const rows = new Map(pending.rows);
  if (change && (change.deleted || change.cells.size > 0)) rows.set(row, change);
  else rows.delete(row);
  return { ...pending, rows };
}

/** Sets a cell of an existing row; setting its original value back drops the change. */
export function setCell(
  pending: Pending,
  target: RowTarget,
  dataCol: number,
  value: Value,
  original: Value,
): Pending {
  const current = pending.rows.get(target.row);
  const cells = new Map(current?.cells);
  const before = cells.get(dataCol);
  const base = before?.original ?? original;
  if (valuesEqual(value, base)) {
    if (!before) return pending;
    cells.delete(dataCol);
  } else {
    if (before && valuesEqual(before.value, value)) return pending;
    cells.set(dataCol, { value, original: base });
  }
  return withRow(pending, target.row, {
    key: current?.key ?? target.key,
    cells,
    deleted: current?.deleted ?? false,
  });
}

/** Sets a cell of a new row; `undefined` gives it back its default. */
export function setInsertCell(
  pending: Pending,
  index: number,
  dataCol: number,
  value: Value | undefined,
): Pending {
  const insert = pending.inserts[index];
  if (!insert) return pending;
  const before = insert.cells.get(dataCol);
  if (value === undefined ? before === undefined : before && valuesEqual(before, value)) {
    return pending;
  }
  const cells = new Map(insert.cells);
  if (value === undefined) cells.delete(dataCol);
  else cells.set(dataCol, value);
  const inserts = [...pending.inserts];
  inserts[index] = { cells };
  return { ...pending, inserts };
}

/** Appends new rows; returns the rank of the first one. */
export function addInserts(
  pending: Pending,
  rows: readonly ReadonlyMap<number, Value>[],
): { pending: Pending; first: number } {
  return {
    pending: { ...pending, inserts: [...pending.inserts, ...rows.map((cells) => ({ cells }))] },
    first: pending.inserts.length,
  };
}

/** Marks existing rows for deletion and drops new rows (a new row deleted is just gone). */
export function deleteRows(
  pending: Pending,
  rows: readonly RowTarget[],
  inserts: readonly number[],
): Pending {
  let next = pending;
  for (const target of rows) {
    const current = next.rows.get(target.row);
    if (current?.deleted) continue;
    next = withRow(next, target.row, {
      key: current?.key ?? target.key,
      cells: current?.cells ?? new Map(),
      deleted: true,
    });
  }
  if (inserts.length > 0) {
    const dropped = new Set(inserts);
    next = { ...next, inserts: next.inserts.filter((_, index) => !dropped.has(index)) };
  }
  return next;
}

/** Reverts cells of existing rows (`dataCols` of `row`). */
export function revertCells(pending: Pending, row: number, dataCols: readonly number[]): Pending {
  const current = pending.rows.get(row);
  if (!current || !dataCols.some((col) => current.cells.has(col))) return pending;
  const cells = new Map(current.cells);
  for (const col of dataCols) cells.delete(col);
  return withRow(pending, row, { ...current, cells });
}

/** Reverts cells of a new row to their defaults. */
export function revertInsertCells(
  pending: Pending,
  index: number,
  dataCols: readonly number[],
): Pending {
  let next = pending;
  for (const col of dataCols) next = setInsertCell(next, index, col, undefined);
  return next;
}

/** Everything about existing rows goes (edits and deletion); new rows are removed. */
export function revertRows(
  pending: Pending,
  rows: readonly number[],
  inserts: readonly number[],
): Pending {
  let next = pending;
  for (const row of rows) if (next.rows.has(row)) next = withRow(next, row, null);
  if (inserts.length > 0) {
    const dropped = new Set(inserts);
    next = { ...next, inserts: next.inserts.filter((_, index) => !dropped.has(index)) };
  }
  return next;
}

/** Rows that Apply would change: edited or deleted existing rows, and new rows. */
export function pendingCount(pending: Pending): number {
  return pending.rows.size + pending.inserts.length;
}

export function isEmpty(pending: Pending): boolean {
  return pending.rows.size === 0 && pending.inserts.length === 0;
}

/** Where each entry of a change set comes from, to point at what failed. */
export interface ChangeTrace {
  updates: { row: number; dataCol: number }[];
  deletes: number[];
  /** Rank of each insert among the pending new rows. */
  inserts: number[];
}

/**
 * The change set Apply sends: updates of the rows not deleted (in row then column order),
 * deletions, new rows with the columns they set. Values go as they are: lossless strings.
 */
export function toChangeSet(
  pending: Pending,
  columns: readonly Pick<TableColumn, 'name'>[],
): { changes: ChangeSet; trace: ChangeTrace } {
  const updates: CellUpdate[] = [];
  const deletes: Value[][] = [];
  const trace: ChangeTrace = { updates: [], deletes: [], inserts: [] };
  const rows = [...pending.rows.entries()].sort(([a], [b]) => a - b);
  for (const [row, change] of rows) {
    if (change.deleted) {
      deletes.push(change.key);
      trace.deletes.push(row);
      continue;
    }
    const cells = [...change.cells.entries()].sort(([a], [b]) => a - b);
    for (const [dataCol, cell] of cells) {
      const column = columns[dataCol];
      if (!column) continue;
      updates.push({ key: change.key, column: column.name, value: cell.value });
      trace.updates.push({ row, dataCol });
    }
  }
  const inserts: RowInsert[] = pending.inserts.map((insert, index) => {
    trace.inserts.push(index);
    return {
      values: [...insert.cells.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([dataCol, value]) => {
          const column = columns[dataCol];
          return column ? [{ column: column.name, value }] : [];
        }),
    };
  });
  return { changes: { updates, inserts, deletes }, trace };
}

/** What a failed statement points at in the grid. */
export type ChangeTarget =
  | { kind: 'row'; row: number; dataCols: number[] }
  | { kind: 'insert'; index: number; dataCols: number[] };

/** The rows and cells of a planned statement (the one that failed), from the trace. */
export function targetOf(
  change: PlannedChange,
  trace: ChangeTrace,
  columnOf: (name: string) => number,
  violationColumn: string | null,
): ChangeTarget | null {
  const violated = violationColumn === null ? -1 : columnOf(violationColumn);
  switch (change.kind) {
    case 'update': {
      const cells = change.updates.flatMap((index) => {
        const cell = trace.updates[index];
        return cell ? [cell] : [];
      });
      const first = cells[0];
      if (!first) return null;
      const dataCols = cells.map((cell) => cell.dataCol);
      return {
        kind: 'row',
        row: first.row,
        dataCols: violated >= 0 && dataCols.includes(violated) ? [violated] : dataCols,
      };
    }
    case 'delete': {
      const row = trace.deletes[change.delete];
      return row === undefined ? null : { kind: 'row', row, dataCols: [] };
    }
    case 'insert': {
      const index = trace.inserts[change.insert];
      return index === undefined
        ? null
        : { kind: 'insert', index, dataCols: violated >= 0 ? [violated] : [] };
    }
  }
}
