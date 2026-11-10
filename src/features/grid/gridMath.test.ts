import { describe, expect, it } from 'vitest';

import {
  columnAt,
  columnLefts,
  dropIndex,
  fitWidth,
  gapAt,
  gutterWidth,
  initialWidth,
  moveItem,
  scrollToInclude,
  scrollTopFor,
  verticalMetrics,
  virtualTop,
  visibleColumns,
  visibleRows,
} from './gridMath';

const metrics = { charWidth: 7, padding: 16, minWidth: 48, maxWidth: 360 };

describe('columns', () => {
  const lefts = columnLefts([100, 50, 200, 80]);

  it('accumulates the offsets', () => {
    expect([...lefts]).toEqual([0, 100, 150, 350, 430]);
  });

  it('finds the column under an x', () => {
    expect(columnAt(lefts, 0)).toBe(0);
    expect(columnAt(lefts, 99.5)).toBe(0);
    expect(columnAt(lefts, 100)).toBe(1);
    expect(columnAt(lefts, 349)).toBe(2);
    expect(columnAt(lefts, 5000)).toBe(3);
    expect(columnAt(lefts, -10)).toBe(0);
    expect(columnAt(columnLefts([]), 10)).toBe(0);
  });

  it('lists the visible columns with overscan', () => {
    expect(visibleColumns(lefts, 0, 120, 0)).toEqual({ start: 0, end: 2 });
    expect(visibleColumns(lefts, 120, 100, 0)).toEqual({ start: 1, end: 3 });
    expect(visibleColumns(lefts, 120, 100, 1)).toEqual({ start: 0, end: 4 });
    expect(visibleColumns(lefts, 0, 0, 1)).toEqual({ start: 0, end: 0 });
  });

  it('reorders', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('turns a drop gap into the target index', () => {
    // Dragging column 1 to the gap after column 2 (gap 3) puts it at index 2.
    expect(dropIndex(1, 3)).toBe(2);
    expect(dropIndex(3, 0)).toBe(0);
    expect(dropIndex(1, 1)).toBe(1);
    expect(dropIndex(1, 2)).toBe(1);
  });

  it('finds the closest gap', () => {
    expect(gapAt(lefts, 10)).toBe(0);
    expect(gapAt(lefts, 90)).toBe(1);
    expect(gapAt(lefts, 420)).toBe(4);
  });
});

describe('widths', () => {
  it('gives each kind a width, at least the header', () => {
    expect(initialWidth('int', 40, metrics)).toBe(10 * 7 + 16);
    expect(initialWidth('bool', 120, metrics)).toBe(120);
    expect(initialWidth('uuid', 0, metrics)).toBe(36 * 7 + 16);
    expect(initialWidth('text', 900, metrics)).toBe(360);
  });

  it('fits the longest text within bounds', () => {
    expect(fitWidth(1, 0, metrics)).toBe(48);
    expect(fitWidth(20, 0, metrics)).toBe(156);
    expect(fitWidth(500, 0, metrics)).toBe(360);
  });

  it('sizes the gutter by digits', () => {
    expect(gutterWidth(5, metrics)).toBe(3 * 7 + 16);
    expect(gutterWidth(100_000, metrics)).toBe(6 * 7 + 16);
  });
});

describe('rows', () => {
  it('lists the visible rows with overscan', () => {
    expect(visibleRows(0, 100, 20, 1000, 0)).toEqual({ start: 0, end: 5 });
    expect(visibleRows(30, 100, 20, 1000, 2)).toEqual({ start: 0, end: 9 });
    expect(visibleRows(19_990, 100, 20, 1000, 2)).toEqual({ start: 997, end: 1000 });
    expect(visibleRows(0, 100, 20, 0, 2)).toEqual({ start: 0, end: 0 });
  });

  it('maps scroll positions one to one below the height cap', () => {
    const m = verticalMetrics(100_000, 24, 600);
    expect(m.domHeight).toBe(2_400_000);
    expect(virtualTop(12_345, m)).toBe(12_345);
    expect(scrollTopFor(12_345, m)).toBe(12_345);
  });

  it('scales scroll positions past the height cap', () => {
    const m = verticalMetrics(10_000_000, 24, 600, 1_000_000);
    expect(m.domHeight).toBe(1_000_000);
    expect(virtualTop(0, m)).toBe(0);
    // The end of the scrollbar shows the last rows.
    expect(virtualTop(1_000_000 - 600, m)).toBe(240_000_000 - 600);
    const top = virtualTop(500_000, m);
    expect(scrollTopFor(top, m)).toBeCloseTo(500_000, 6);
  });

  it('scrolls only as much as needed to include a span', () => {
    expect(scrollToInclude(100, 50, 120, 130)).toBe(100);
    expect(scrollToInclude(100, 50, 80, 90)).toBe(80);
    expect(scrollToInclude(100, 50, 160, 170)).toBe(120);
  });
});
