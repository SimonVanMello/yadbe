import { describe, expect, it } from 'vitest';

import { createExtents, measureLoaded, widenColumns } from './columnGrowth';
import type { RowBlock, RowSource } from './rowSource';

const metrics = { charWidth: 7, padding: 16, minWidth: 48, maxWidth: 360 };

function block(offset: number, values: (string | null)[]): RowBlock {
  return {
    offset,
    rowCount: values.length,
    columns: [{ values, kinds: null, truncated: [] }],
  };
}

function sourceOf(blocks: RowBlock[]): RowSource {
  return {
    columns: [{ name: 'n', typeName: '', kind: 'text' }],
    rowCount: 1000,
    block: () => undefined,
    request: () => undefined,
    subscribe: () => () => undefined,
    read: () => Promise.resolve([]),
    fullValue: () => Promise.reject(new Error('unused')),
    loaded: () => blocks,
  };
}

describe('column growth', () => {
  it('measures each block once and reports a longer value', () => {
    const blocks = [block(0, ['1', '22'])];
    const source = sourceOf(blocks);
    const extents = createExtents(1);
    expect(measureLoaded(source, extents, 'NULL')).toBe(true);
    expect(extents.chars).toEqual([2]);
    expect(measureLoaded(source, extents, 'NULL')).toBe(false);
    blocks.push(block(500, ['999999999999']));
    expect(measureLoaded(source, extents, 'NULL')).toBe(true);
    expect(extents.chars).toEqual([12]);
  });

  it('measures NULL cells as the NULL text the grid shows', () => {
    const source = sourceOf([block(0, ['ab', null])]);
    const short = createExtents(1);
    measureLoaded(source, short, '∅');
    expect(short.chars).toEqual([2]);
    const long = createExtents(1);
    measureLoaded(source, long, '<missing>');
    expect(long.chars).toEqual([9]);
  });

  it('widens a column when a later window needs more, never narrows it', () => {
    const extents = createExtents(2);
    extents.chars = [12, 1];
    const widths = [60, 200];
    const next = widenColumns(widths, extents, [0, 0], new Set(), metrics);
    expect(next).toEqual([12 * 7 + 16, 200]);
  });

  it('returns the same array when nothing needs more room', () => {
    const extents = createExtents(1);
    extents.chars = [3];
    const widths = [100];
    expect(widenColumns(widths, extents, [0], new Set(), metrics)).toBe(widths);
  });

  it('leaves the columns the user resized alone and caps the width', () => {
    const extents = createExtents(2);
    extents.chars = [50, 500];
    const next = widenColumns([60, 60], extents, [0, 0], new Set([0]), metrics);
    expect(next).toEqual([60, 360]);
  });
});
