import type { TableColumn, Value } from '../../ipc';
import { parseInput, type ParseResult } from './cellValues';

/**
 * Pasting into a table tab (F-082, F-083): a block of TSV (what spreadsheets and the grid's own
 * copy put on the clipboard) or CSV, over a range of cells or as new rows.
 */

export interface PastedCell {
  text: string;
  /** Written between quotes: an empty quoted field is the empty string, not NULL (CSV). */
  quoted: boolean;
}

export type PastedGrid = PastedCell[][];

/** Splits clipboard text into rows and cells: tabs when there are any, else commas (CSV). */
export function parseDelimited(text: string): PastedGrid {
  const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (body === '') return [];
  const firstLine = body.split('\n', 1)[0] ?? '';
  const delimiter = body.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : null;
  const rows: PastedGrid = [];
  let row: PastedCell[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let start = true;
  const endField = () => {
    row.push({ text: field, quoted });
    field = '';
    quoted = false;
    start = true;
  };
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    if (inQuotes) {
      if (char === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && start) {
      inQuotes = true;
      quoted = true;
      start = false;
    } else if (delimiter !== null && char === delimiter) {
      endField();
    } else if (char === '\n') {
      endField();
      rows.push(row);
      row = [];
    } else {
      field += char;
      start = false;
    }
  }
  endField();
  rows.push(row);
  return rows;
}

/**
 * The value a pasted cell gives `column`. An empty unquoted cell is NULL in a nullable column
 * (spreadsheets write NULL that way), the empty string in a text column, and no value otherwise;
 * `'default'` in a new row: the column keeps its default.
 */
export function pastedValue(
  cell: PastedCell,
  column: TableColumn,
  newRow: boolean,
): ParseResult | 'default' {
  if (cell.text === '' && !cell.quoted) {
    if (newRow) return 'default';
    if (column.nullable) return { ok: true, value: { kind: 'null' } };
  }
  return parseInput(cell.text, column);
}

export interface RangeTarget {
  row: number;
  dataCol: number;
  cell: PastedCell;
}

/**
 * Where a block lands when pasted at the focused cell: right and down from it, in display
 * order, cut at the last column and the last row. A single value pasted on a selected range
 * fills the range.
 */
export function planRangePaste(
  grid: PastedGrid,
  focus: { row: number; col: number },
  order: readonly number[],
  rowCount: number,
  fill: { r0: number; r1: number; c0: number; c1: number } | null,
): { targets: RangeTarget[]; clipped: number } {
  const targets: RangeTarget[] = [];
  const single = grid.length === 1 && grid[0]?.length === 1 ? grid[0][0] : undefined;
  if (single && fill) {
    for (let row = fill.r0; row <= Math.min(fill.r1, rowCount - 1); row++) {
      for (let col = fill.c0; col <= Math.min(fill.c1, order.length - 1); col++) {
        const dataCol = order[col];
        if (dataCol !== undefined) targets.push({ row, dataCol, cell: single });
      }
    }
    return { targets, clipped: 0 };
  }
  let clipped = 0;
  grid.forEach((cells, r) => {
    const row = focus.row + r;
    if (row >= rowCount) {
      clipped++;
      return;
    }
    cells.forEach((cell, c) => {
      const dataCol = order[focus.col + c];
      if (dataCol !== undefined) targets.push({ row, dataCol, cell });
    });
  });
  return { targets, clipped };
}

/**
 * The cells of new rows from a pasted block. A first row naming columns maps by name (any
 * order, unknown names ignored); otherwise cells go to the columns in display order.
 */
export function planNewRows(
  grid: PastedGrid,
  columns: readonly Pick<TableColumn, 'name'>[],
  order: readonly number[],
): { rows: Map<number, PastedCell>[]; byHeader: boolean } {
  const first = grid[0] ?? [];
  const names = new Map(columns.map((column, dataCol) => [column.name.toLowerCase(), dataCol]));
  const headerCols = first.map((cell) => names.get(cell.text.trim().toLowerCase()));
  const byHeader =
    grid.length > 1 && first.length > 0 && headerCols.every((col) => col !== undefined);
  const mapping = byHeader ? headerCols : order;
  const rows = (byHeader ? grid.slice(1) : grid).map((cells) => {
    const row = new Map<number, PastedCell>();
    cells.forEach((cell, c) => {
      const dataCol = mapping[c];
      if (dataCol !== undefined) row.set(dataCol, cell);
    });
    return row;
  });
  return { rows, byHeader };
}

/** A copy of a row for "Duplicate": values of the columns the user can write and that the server does not generate. */
export function duplicateCells(
  values: readonly Value[],
  columns: readonly TableColumn[],
): Map<number, Value> {
  const cells = new Map<number, Value>();
  columns.forEach((column, dataCol) => {
    // A key the server can generate (identity, serial) would clash with the row copied.
    if (column.readOnlyReason || (column.primaryKey && column.optionalOnInsert)) return;
    const value = values[dataCol];
    if (value) cells.set(dataCol, value);
  });
  return cells;
}
