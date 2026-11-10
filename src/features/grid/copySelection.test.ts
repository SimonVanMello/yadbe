import { describe, expect, it, vi } from 'vitest';

import type { Value } from '../../ipc';
import { clipIntervals, gatherSelection } from './copySelection';
import type { RowBlock, RowSource } from './rowSource';
import { cellSelection, extendTo, selectAll, selectCols, selectRows } from './selection';

/** 3 columns; row r has `r`, `name r` (cut on every 4th row), and NULL on odd rows. */
function fakeSource(rowCount: number) {
  const read = vi.fn((start: number, end: number): Promise<RowBlock[]> => {
    const count = Math.max(0, Math.min(end, rowCount) - start);
    const rows = Array.from({ length: count }, (_, i) => start + i);
    return Promise.resolve([
      {
        offset: start,
        rowCount: count,
        columns: [
          { values: rows.map(String), kinds: null, truncated: [] },
          {
            values: rows.map((r) => (r % 4 === 0 ? 'cut…' : `name ${String(r)}`)),
            kinds: null,
            truncated: rows.flatMap((r, i) => (r % 4 === 0 ? [i] : [])),
          },
          { values: rows.map((r) => (r % 2 ? null : 'x')), kinds: null, truncated: [] },
        ],
      },
    ]);
  });
  const fullValue = vi.fn((row: number): Promise<Value> =>
    Promise.resolve({ kind: 'text', value: `full name ${String(row)}` }),
  );
  const source: RowSource = {
    columns: [
      { name: 'id', typeName: 'int8', kind: 'int' },
      { name: 'name', typeName: 'text', kind: 'text' },
      { name: 'flag', typeName: 'text', kind: 'text' },
    ],
    rowCount,
    block: () => undefined,
    request: () => undefined,
    subscribe: () => () => undefined,
    read,
    fullValue,
    loaded: () => [],
  };
  return { source, read, fullValue };
}

describe('gatherSelection', () => {
  it('copies a range in display order, completing cut cells', async () => {
    const { source, fullValue } = fakeSource(10);
    // Display order puts `flag` first.
    const order = [2, 0, 1];
    const sel = extendTo(cellSelection({ row: 0, col: 0 }), { row: 1, col: 2 });
    const result = await gatherSelection(source, sel, order);
    expect(result.table.columns.map((c) => c.name)).toEqual(['flag', 'id', 'name']);
    expect(result.table.rows).toEqual([
      [
        { text: 'x', kind: 'text' },
        { text: '0', kind: 'int' },
        { text: 'full name 0', kind: 'text' },
      ],
      [
        { text: null, kind: 'text' },
        { text: '1', kind: 'int' },
        { text: 'name 1', kind: 'text' },
      ],
    ]);
    expect(fullValue).toHaveBeenCalledTimes(1);
  });

  it('copies disjoint rows as one table', async () => {
    const { source } = fakeSource(10);
    const sel = selectRows(selectRows(null, 2, 'replace'), 7, 'add');
    const result = await gatherSelection(source, sel, [0, 1, 2]);
    expect(result.table.rows.map((r) => r[0]?.text)).toEqual(['2', '7']);
    expect(result.table.columns).toHaveLength(3);
  });

  it('bounds huge selections and reports progress', async () => {
    const { source, read } = fakeSource(1_000_000);
    const progress = vi.fn();
    const sel = selectCols(null, 0, 'replace');
    const result = await gatherSelection(source, sel, [0, 1, 2], {
      maxRows: 2_500,
      onProgress: progress,
    });
    expect(result.selectedRows).toBe(1_000_000);
    expect(result.copiedRows).toBe(2_500);
    expect(read).toHaveBeenCalledWith(0, 2_500, undefined);
    expect(progress).toHaveBeenCalledWith(2_500, 2_500);
  });

  it('bounds by cells on wide selections', async () => {
    const { source } = fakeSource(1000);
    const result = await gatherSelection(source, selectAll(null), [0, 1, 2], { maxCells: 30 });
    expect(result.copiedRows).toBe(10);
  });

  it('stops when cancelled', async () => {
    const { source } = fakeSource(100);
    const controller = new AbortController();
    controller.abort();
    await expect(
      gatherSelection(source, selectAll(null), [0, 1, 2], { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});

it('clips intervals to a row budget', () => {
  expect(
    clipIntervals(
      [
        { start: 0, end: 5 },
        { start: 10, end: 20 },
        { start: 30, end: 40 },
      ],
      8,
    ),
  ).toEqual([
    { start: 0, end: 5 },
    { start: 10, end: 13 },
  ]);
});
