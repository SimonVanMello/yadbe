import { describe, expect, it } from 'vitest';

import { GridBody, type BodyFrame, type BodyLayout } from './gridBody';
import { columnLefts } from './gridMath';
import type { RowBlock, RowSource } from './rowSource';
import { cellSelection, extendTo } from './selection';

const COLS = 4;

function block(offset: number, count: number): RowBlock {
  const rows = Array.from({ length: count }, (_, i) => offset + i);
  return {
    offset,
    rowCount: count,
    columns: [
      { values: rows.map(String), kinds: null, truncated: [] },
      { values: rows.map((r) => (r % 2 ? null : '')), kinds: null, truncated: [] },
      { values: rows.map((r) => ` x${String(r)}`), kinds: null, truncated: [0] },
      { values: rows.map((r) => `c${String(r)}`), kinds: null, truncated: [] },
    ],
  };
}

function setup(loaded: number) {
  const blocks = new Map<number, RowBlock>();
  const source: RowSource = {
    columns: [
      { name: 'id', typeName: 'int8', kind: 'int' },
      { name: 'maybe', typeName: 'text', kind: 'text' },
      { name: 'padded', typeName: 'text', kind: 'text' },
      { name: 'other', typeName: 'text', kind: 'text' },
    ],
    rowCount: 1000,
    block: (row) => (row < loaded ? (blocks.get(0) ?? undefined) : undefined),
    request: () => undefined,
    subscribe: () => () => undefined,
    read: () => Promise.resolve([]),
    fullValue: () => Promise.resolve({ kind: 'null' }),
    loaded: () => blocks.values(),
  };
  blocks.set(0, block(0, Math.max(loaded, 1)));
  const grid = document.createElement('div');
  const container = document.createElement('div');
  const gutters = document.createElement('div');
  grid.append(gutters, container);
  const body = new GridBody({
    container,
    gutters,
    grid,
    source,
    focusId: 'g-focus',
    classes: {
      row: 'row',
      gutter: 'gutter',
      cell: 'cell',
      num: 'num',
      null: 'null',
      empty: 'empty',
      mark: 'mark',
    },
    labels: { null: 'NULL', empty: 'empty' },
  });
  const layout: BodyLayout = {
    order: [0, 1, 2, 3],
    lefts: columnLefts([50, 60, 70, 80]),
    gutterWidth: 40,
    rowHeight: 20,
  };
  const frame = (over: Partial<BodyFrame> = {}): BodyFrame => ({
    rows: { start: 0, end: 10 },
    cols: { start: 0, end: COLS },
    shift: 0,
    layout,
    selection: null,
    ...over,
  });
  const rowEl = (row: number) =>
    container.querySelector<HTMLElement>(`[aria-rowindex="${String(row + 2)}"]:not([hidden])`);
  const cellEl = (row: number, col: number) =>
    rowEl(row)?.querySelector<HTMLElement>(`[aria-colindex="${String(col + 1)}"]:not([hidden])`);
  return { body, grid, container, gutters, frame, rowEl, cellEl, layout };
}

describe('GridBody', () => {
  it('draws the visible rows with ARIA indices and typed rendering', () => {
    const { body, frame, rowEl, cellEl, gutters } = setup(100);
    body.render(frame());
    expect(body.renderedRows).toBe(10);
    expect(rowEl(0)?.style.transform).toBe('translateY(0px)');
    expect(rowEl(3)?.style.transform).toBe('translateY(60px)');
    expect(cellEl(0, 0)?.textContent).toBe('0');
    expect(cellEl(0, 0)?.className).toBe('cell num');
    expect(cellEl(0, 0)?.style.left).toBe('40px');
    expect(cellEl(0, 1)?.textContent).toBe('empty');
    expect(cellEl(1, 1)?.textContent).toBe('NULL');
    expect(cellEl(1, 1)?.className).toContain('null');
    expect(cellEl(0, 2)?.querySelector('.mark')?.textContent).toBe('·');
    expect(cellEl(0, 2)?.hasAttribute('data-truncated')).toBe(true);
    expect(cellEl(1, 2)?.hasAttribute('data-truncated')).toBe(false);
    expect(gutters.children[3]?.textContent).toBe('4');
  });

  it('recycles rows and cells instead of creating new ones', () => {
    const { body, frame, container, rowEl, cellEl } = setup(100);
    body.render(frame());
    const elements = container.querySelectorAll('*').length;
    body.render(frame({ rows: { start: 5, end: 15 }, cols: { start: 1, end: 3 } }));
    expect(container.querySelectorAll('*').length).toBe(elements);
    expect(rowEl(0)).toBeNull();
    expect(cellEl(14, 1)?.textContent).toBe('empty');
    expect(cellEl(14, 0)).toBeFalsy();
    expect(body.renderedRows).toBe(10);
  });

  it('marks loading rows, then fills them when their block arrives', () => {
    const { body, frame, rowEl } = setup(0);
    body.render(frame({ rows: { start: 0, end: 2 } }));
    expect(rowEl(1)?.hasAttribute('data-loading')).toBe(true);
  });

  it('shows the selection and the focus, and names the focused cell', () => {
    const { body, frame, cellEl, grid } = setup(100);
    const selection = extendTo(cellSelection({ row: 1, col: 1 }), { row: 2, col: 2 });
    body.render(frame({ selection }));
    expect(cellEl(1, 1)?.getAttribute('aria-selected')).toBe('true');
    expect(cellEl(3, 1)?.getAttribute('aria-selected')).toBe('false');
    expect(cellEl(2, 2)?.hasAttribute('data-focused')).toBe(true);
    expect(cellEl(2, 2)?.id).toBe('g-focus');
    expect(grid.getAttribute('aria-activedescendant')).toBe('g-focus');
    // Scrolled away: no element claims the focus.
    body.render(frame({ rows: { start: 50, end: 60 }, selection }));
    expect(grid.hasAttribute('aria-activedescendant')).toBe(false);
    expect(grid.querySelectorAll('[data-focused]')).toHaveLength(0);
  });

  it('places rows relative to the scaled scroll position', () => {
    const { body, frame, rowEl } = setup(100);
    body.render(frame({ rows: { start: 20, end: 25 }, shift: 300 }));
    expect(rowEl(20)?.style.transform).toBe('translateY(100px)');
  });

  it('follows a column move', () => {
    const { body, frame, cellEl, layout } = setup(100);
    body.render(frame());
    const moved = { ...layout, order: [3, 0, 1, 2], lefts: columnLefts([80, 50, 60, 70]) };
    body.render(frame({ layout: moved }));
    expect(cellEl(0, 0)?.textContent).toBe('c0');
    expect(cellEl(0, 1)?.textContent).toBe('0');
    expect(cellEl(0, 1)?.style.left).toBe('120px');
  });
});
