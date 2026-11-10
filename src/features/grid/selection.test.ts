import { describe, expect, it } from 'vitest';

import {
  addCell,
  afterColumnMove,
  cellSelection,
  colTouched,
  extendTo,
  isCellSelected,
  isColSelected,
  isRowSelected,
  moveFocus,
  moveFocusTo,
  selectAll,
  selectCols,
  selectedColumns,
  selectedRowIntervals,
  selectRows,
} from './selection';

const bounds = { rowCount: 100, colCount: 10 };

describe('selection', () => {
  it('selects one cell', () => {
    const sel = cellSelection({ row: 3, col: 2 });
    expect(isCellSelected(sel, 3, 2)).toBe(true);
    expect(isCellSelected(sel, 3, 3)).toBe(false);
    expect(isCellSelected(null, 0, 0)).toBe(false);
  });

  it('extends a range from the anchor (shift-click), in any direction', () => {
    const sel = extendTo(cellSelection({ row: 5, col: 5 }), { row: 2, col: 7 });
    expect(sel.anchor).toEqual({ row: 5, col: 5 });
    expect(sel.focus).toEqual({ row: 2, col: 7 });
    expect(sel.ranges).toEqual([{ kind: 'cells', r0: 2, r1: 5, c0: 5, c1: 7 }]);
    expect(isCellSelected(sel, 4, 6)).toBe(true);
    expect(isCellSelected(sel, 6, 6)).toBe(false);
  });

  it('adds disjoint cells (mod-click) and extends the last one only', () => {
    let sel = addCell(cellSelection({ row: 0, col: 0 }), { row: 10, col: 3 });
    sel = extendTo(sel, { row: 11, col: 4 });
    expect(sel.ranges).toHaveLength(2);
    expect(isCellSelected(sel, 0, 0)).toBe(true);
    expect(isCellSelected(sel, 11, 4)).toBe(true);
    expect(isCellSelected(sel, 5, 2)).toBe(false);
  });

  it('selects whole rows that keep growing while the result streams', () => {
    let sel = selectRows(null, 4, 'replace');
    sel = selectRows(sel, 6, 'extend');
    expect(isRowSelected(sel, 5)).toBe(true);
    expect(isCellSelected(sel, 5, 1_000)).toBe(true);
    sel = selectRows(sel, 20, 'add');
    expect(selectedRowIntervals(sel, 100)).toEqual([
      { start: 4, end: 7 },
      { start: 20, end: 21 },
    ]);
  });

  it('selects whole columns, including rows not streamed yet', () => {
    let sel = selectCols(cellSelection({ row: 7, col: 0 }), 2, 'replace');
    expect(sel.focus).toEqual({ row: 7, col: 2 });
    sel = selectCols(sel, 4, 'extend');
    expect(isColSelected(sel, 3)).toBe(true);
    expect(isColSelected(sel, 5)).toBe(false);
    expect(isCellSelected(sel, 1_000_000, 3)).toBe(true);
    expect(selectedColumns(sel, 10)).toEqual([2, 3, 4]);
    expect(selectedRowIntervals(sel, 100)).toEqual([{ start: 0, end: 100 }]);
  });

  it('selects everything', () => {
    const sel = selectAll(cellSelection({ row: 3, col: 3 }));
    expect(sel.focus).toEqual({ row: 3, col: 3 });
    expect(isRowSelected(sel, 99)).toBe(true);
    expect(isColSelected(sel, 9)).toBe(true);
    expect(selectedColumns(sel, 10)).toHaveLength(10);
  });

  it('marks the headers of touched columns', () => {
    const sel = extendTo(cellSelection({ row: 1, col: 1 }), { row: 2, col: 2 });
    expect(colTouched(sel, 2)).toBe(true);
    expect(colTouched(sel, 3)).toBe(false);
  });

  it('moves the focus with the keyboard, clamped to the grid', () => {
    let sel = cellSelection({ row: 0, col: 0 });
    sel = moveFocus(sel, -1, -1, false, bounds);
    expect(sel.focus).toEqual({ row: 0, col: 0 });
    sel = moveFocus(sel, 30, 20, false, bounds);
    expect(sel.focus).toEqual({ row: 30, col: 9 });
    expect(sel.ranges).toHaveLength(1);
  });

  it('extends with shift+arrows from the anchor', () => {
    let sel = cellSelection({ row: 5, col: 5 });
    sel = moveFocus(sel, 1, 0, true, bounds);
    sel = moveFocus(sel, 1, 1, true, bounds);
    expect(sel.anchor).toEqual({ row: 5, col: 5 });
    expect(sel.ranges).toEqual([{ kind: 'cells', r0: 5, r1: 7, c0: 5, c1: 6 }]);
    // Back over the anchor flips the range.
    sel = moveFocusTo(sel, { row: 3, col: 5 }, true, bounds);
    expect(sel.ranges).toEqual([{ kind: 'cells', r0: 3, r1: 5, c0: 5, c1: 5 }]);
  });

  it('keeps a row selection a row selection when extended with the keyboard', () => {
    const sel = moveFocus(selectRows(null, 2, 'replace'), 2, 0, true, bounds);
    expect(sel.ranges[0]?.kind).toBe('rows');
    expect(isRowSelected(sel, 4)).toBe(true);
  });

  it('does nothing on an empty grid', () => {
    const sel = cellSelection({ row: 0, col: 0 });
    expect(moveFocus(sel, 1, 0, false, { rowCount: 0, colCount: 3 })).toBe(sel);
    expect(selectedRowIntervals(sel, 0)).toEqual([]);
  });

  it('follows a moved column', () => {
    const sel = afterColumnMove(cellSelection({ row: 1, col: 1 }), 1, 4);
    expect(sel?.focus).toEqual({ row: 1, col: 4 });
    const other = afterColumnMove(cellSelection({ row: 1, col: 3 }), 1, 4);
    expect(other?.focus.col).toBe(2);
    const cols = afterColumnMove(selectCols(null, 0, 'replace'), 0, 2);
    expect(cols && isColSelected(cols, 2)).toBe(true);
  });
});
