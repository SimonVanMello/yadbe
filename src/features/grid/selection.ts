/**
 * Selection model of the grid (F-063): ranges of cells, whole rows, whole columns or
 * everything, plus an anchor (where a shift-extension starts) and a focus (the active cell).
 * Columns are display indices. Pure functions over immutable values.
 */

export interface CellPos {
  row: number;
  col: number;
}

export type RangeKind = 'cells' | 'rows' | 'cols' | 'all';

/** Inclusive bounds. Whole rows / columns / all reach `Infinity`, so they grow while streaming. */
export interface SelRange {
  kind: RangeKind;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface Selection {
  ranges: readonly SelRange[];
  anchor: CellPos;
  focus: CellPos;
}

export interface Bounds {
  rowCount: number;
  colCount: number;
}

export interface Interval {
  start: number;
  /** Exclusive. */
  end: number;
}

function span(kind: RangeKind, a: CellPos, b: CellPos): SelRange {
  const rows = { r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row) };
  const cols = { c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) };
  switch (kind) {
    case 'cells':
      return { kind, ...rows, ...cols };
    case 'rows':
      return { kind, ...rows, c0: 0, c1: Infinity };
    case 'cols':
      return { kind, r0: 0, r1: Infinity, ...cols };
    case 'all':
      return { kind, r0: 0, r1: Infinity, c0: 0, c1: Infinity };
  }
}

export function cellSelection(pos: CellPos): Selection {
  return { ranges: [span('cells', pos, pos)], anchor: pos, focus: pos };
}

function lastKind(sel: Selection): RangeKind {
  return sel.ranges.at(-1)?.kind ?? 'cells';
}

/** Shift-click / shift-arrow: the last range spans anchor → `pos`, keeping its kind. */
export function extendTo(sel: Selection, pos: CellPos): Selection {
  const kind = lastKind(sel);
  return {
    ranges: [...sel.ranges.slice(0, -1), span(kind, sel.anchor, pos)],
    anchor: sel.anchor,
    focus: pos,
  };
}

/** Mod-click: one more cell, which becomes the anchor and the focus. */
export function addCell(sel: Selection, pos: CellPos): Selection {
  return { ranges: [...sel.ranges, span('cells', pos, pos)], anchor: pos, focus: pos };
}

export type SelectMode = 'replace' | 'extend' | 'add';

/** Click on a row number: the whole row (shift: rows from the anchor, mod: one more row). */
export function selectRows(sel: Selection | null, row: number, mode: SelectMode): Selection {
  const col = sel?.focus.col ?? 0;
  const pos = { row, col };
  if (sel && mode === 'extend') {
    const anchor = { row: sel.anchor.row, col };
    return {
      ranges: [...sel.ranges.slice(0, -1), span('rows', anchor, pos)],
      anchor,
      focus: pos,
    };
  }
  const range = span('rows', pos, pos);
  const ranges = sel && mode === 'add' ? [...sel.ranges, range] : [range];
  return { ranges, anchor: pos, focus: pos };
}

/** Click on a column header: the whole column (shift: columns from the anchor, mod: one more). */
export function selectCols(sel: Selection | null, col: number, mode: SelectMode): Selection {
  const row = sel?.focus.row ?? 0;
  const pos = { row, col };
  if (sel && mode === 'extend') {
    const anchor = { row, col: sel.anchor.col };
    return {
      ranges: [...sel.ranges.slice(0, -1), span('cols', anchor, pos)],
      anchor,
      focus: pos,
    };
  }
  const range = span('cols', pos, pos);
  const ranges = sel && mode === 'add' ? [...sel.ranges, range] : [range];
  return { ranges, anchor: pos, focus: pos };
}

export function selectAll(sel: Selection | null): Selection {
  const focus = sel?.focus ?? { row: 0, col: 0 };
  return { ranges: [span('all', focus, focus)], anchor: focus, focus };
}

function clampPos(pos: CellPos, b: Bounds): CellPos {
  return {
    row: Math.max(0, Math.min(b.rowCount - 1, pos.row)),
    col: Math.max(0, Math.min(b.colCount - 1, pos.col)),
  };
}

/**
 * Keyboard move of the focus by `dRow` / `dCol` (clamped). Without `extend`, the selection
 * collapses to the new focus; with it, the last range stretches from the anchor (a selection of
 * whole rows or columns stays one).
 */
export function moveFocus(
  sel: Selection,
  dRow: number,
  dCol: number,
  extend: boolean,
  b: Bounds,
): Selection {
  return moveFocusTo(sel, { row: sel.focus.row + dRow, col: sel.focus.col + dCol }, extend, b);
}

export function moveFocusTo(sel: Selection, to: CellPos, extend: boolean, b: Bounds): Selection {
  if (b.rowCount <= 0 || b.colCount <= 0) return sel;
  const pos = clampPos(to, b);
  return extend ? extendTo(sel, pos) : cellSelection(pos);
}

function contains(r: SelRange, row: number, col: number): boolean {
  return row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;
}

export function isCellSelected(sel: Selection | null, row: number, col: number): boolean {
  if (!sel) return false;
  for (const range of sel.ranges) if (contains(range, row, col)) return true;
  return false;
}

/** The row is part of a whole-row (or select-all) range: its number is highlighted. */
export function isRowSelected(sel: Selection | null, row: number): boolean {
  if (!sel) return false;
  for (const r of sel.ranges) {
    if ((r.kind === 'rows' || r.kind === 'all') && row >= r.r0 && row <= r.r1) return true;
  }
  return false;
}

/** The column is part of a whole-column (or select-all) range: its header is highlighted. */
export function isColSelected(sel: Selection | null, col: number): boolean {
  if (!sel) return false;
  for (const r of sel.ranges) {
    if ((r.kind === 'cols' || r.kind === 'all') && col >= r.c0 && col <= r.c1) return true;
  }
  return false;
}

/** Some cell of the column is selected (its header is marked, like a spreadsheet). */
export function colTouched(sel: Selection | null, col: number): boolean {
  return !!sel?.ranges.some((r) => col >= r.c0 && col <= r.c1);
}

/** Some cell of the row is selected (its number is marked). */
export function rowTouched(sel: Selection | null, row: number): boolean {
  return !!sel?.ranges.some((r) => row >= r.r0 && row <= r.r1);
}

/** The rows any range covers, as merged intervals, clipped to `rowCount`. */
export function selectedRowIntervals(sel: Selection | null, rowCount: number): Interval[] {
  if (!sel || rowCount <= 0) return [];
  const intervals = sel.ranges
    .map((r) => ({ start: Math.max(0, r.r0), end: Math.min(rowCount, r.r1 + 1) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The display columns any range covers, sorted. */
export function selectedColumns(sel: Selection | null, colCount: number): number[] {
  if (!sel || colCount <= 0) return [];
  const cols = new Set<number>();
  for (const r of sel.ranges) {
    for (let c = Math.max(0, r.c0); c <= Math.min(colCount - 1, r.c1); c++) cols.add(c);
  }
  return [...cols].sort((a, b) => a - b);
}

export function countRows(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, i) => sum + i.end - i.start, 0);
}

/**
 * The selection after display column `from` moved to `to`: positions follow the moved column,
 * ranges reset to the focus (a range of columns would no longer be contiguous).
 */
export function afterColumnMove(sel: Selection | null, from: number, to: number): Selection | null {
  if (!sel) return null;
  const remap = (c: number) => {
    if (c === from) return to;
    if (from < to && c > from && c <= to) return c - 1;
    if (from > to && c >= to && c < from) return c + 1;
    return c;
  };
  const focus = { row: sel.focus.row, col: remap(sel.focus.col) };
  const kind = lastKind(sel);
  if (kind === 'cols') return selectCols(cellSelection(focus), focus.col, 'replace');
  if (kind === 'rows' || kind === 'all') return { ...sel, anchor: focus, focus };
  return cellSelection(focus);
}
