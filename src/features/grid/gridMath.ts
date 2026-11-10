import type { ValueKind } from '../../ipc';

/**
 * Geometry of the grid: column offsets, visible ranges and the vertical scroll mapping. Pure
 * functions, shared by the renderer, the header and the keyboard navigation.
 */

/**
 * Tallest scrollable content the grid creates. Engines store layout positions as fixed-point
 * numbers (1/64 px in 32 bits: about 33.5M px in Blink and WebKit); past this height the grid
 * scales the scrollbar instead (1M rows × 24 px would already be 24M px).
 */
export const MAX_SCROLL_HEIGHT = 15_000_000;

export interface Range {
  /** First index, inclusive. */
  start: number;
  /** Last index, exclusive. */
  end: number;
}

/** `lefts[i]` is the x of display column `i`; `lefts[n]` is the total width. */
export function columnLefts(widths: readonly number[]): Float64Array {
  const lefts = new Float64Array(widths.length + 1);
  for (let i = 0; i < widths.length; i++) lefts[i + 1] = (lefts[i] ?? 0) + (widths[i] ?? 0);
  return lefts;
}

/** Display column under `x` (clamped to the columns), by binary search over `lefts`. */
export function columnAt(lefts: Float64Array, x: number): number {
  const count = lefts.length - 1;
  if (count <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lefts[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Columns intersecting `[scrollLeft, scrollLeft + width)`, plus `overscan` on each side. */
export function visibleColumns(
  lefts: Float64Array,
  scrollLeft: number,
  width: number,
  overscan: number,
): Range {
  const count = lefts.length - 1;
  if (count <= 0 || width <= 0) return { start: 0, end: 0 };
  const first = columnAt(lefts, scrollLeft);
  const last = columnAt(lefts, scrollLeft + width - 1);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + 1 + overscan) };
}

export interface VerticalMetrics {
  rowHeight: number;
  /** Height of the rows area (viewport minus header), in px. */
  viewportHeight: number;
  /** Height all the rows would take. */
  realHeight: number;
  /** Height of the scrollable rows area actually created (≤ MAX_SCROLL_HEIGHT). */
  domHeight: number;
}

export function verticalMetrics(
  rowCount: number,
  rowHeight: number,
  viewportHeight: number,
  maxHeight = MAX_SCROLL_HEIGHT,
): VerticalMetrics {
  const realHeight = rowCount * rowHeight;
  return {
    rowHeight,
    viewportHeight,
    realHeight,
    domHeight: Math.min(realHeight, maxHeight),
  };
}

/** Real offset of the rows shown at the top of the viewport, for a DOM `scrollTop`. */
export function virtualTop(scrollTop: number, m: VerticalMetrics): number {
  if (m.domHeight === m.realHeight) return scrollTop;
  const domRange = m.domHeight - m.viewportHeight;
  if (domRange <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, scrollTop / domRange));
  return ratio * (m.realHeight - m.viewportHeight);
}

/** DOM `scrollTop` that shows real offset `top` at the top of the viewport. */
export function scrollTopFor(top: number, m: VerticalMetrics): number {
  if (m.domHeight === m.realHeight) return top;
  const realRange = m.realHeight - m.viewportHeight;
  if (realRange <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, top / realRange));
  return ratio * (m.domHeight - m.viewportHeight);
}

/** Rows intersecting the viewport whose top is at real offset `top`, plus `overscan`. */
export function visibleRows(
  top: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan: number,
): Range {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight);
  return {
    start: Math.max(0, Math.min(rowCount, first - overscan)),
    end: Math.max(0, Math.min(rowCount, last + overscan)),
  };
}

/** Moves the item at `from` so that it ends up at index `to` (in the resulting array). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  if (from < 0 || from >= result.length) return result;
  const [item] = result.splice(from, 1) as [T];
  result.splice(Math.max(0, Math.min(result.length, to)), 0, item);
  return result;
}

/**
 * Where a column dragged from `from` lands when dropped at the gap `gap` (0 = before the first
 * column, n = after the last): the index it takes once removed and reinserted.
 */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** The gap (0..n) closest to `x` in content coordinates. */
export function gapAt(lefts: Float64Array, x: number): number {
  const count = lefts.length - 1;
  if (count <= 0) return 0;
  const col = columnAt(lefts, x);
  const left = lefts[col] ?? 0;
  const right = lefts[col + 1] ?? left;
  return x - left < right - x ? col : col + 1;
}

/** Typical width of each kind's text, in characters of the grid's monospace font. */
const KIND_CHARS: Record<ValueKind, number> = {
  bool: 5,
  int: 10,
  decimal: 12,
  float: 14,
  text: 24,
  bytes: 20,
  date: 10,
  time: 15,
  timestamp: 26,
  timestampTz: 29,
  interval: 18,
  uuid: 36,
  json: 32,
  array: 24,
  other: 20,
};

export interface WidthMetrics {
  /** Advance of one character of the cells' monospace font, in px. */
  charWidth: number;
  /** Horizontal padding of a cell (both sides together). */
  padding: number;
  minWidth: number;
  /** Cap of initial and auto-fit widths (a column can still be dragged wider). */
  maxWidth: number;
}

/** Initial width of a column: its kind's typical text, at least its header. */
export function initialWidth(kind: ValueKind, headerWidth: number, m: WidthMetrics): number {
  const content = KIND_CHARS[kind] * m.charWidth + m.padding;
  return clampWidth(Math.max(content, headerWidth), m);
}

/** Width that shows `chars` characters (auto-fit), at least the header. */
export function fitWidth(chars: number, headerWidth: number, m: WidthMetrics): number {
  return clampWidth(Math.max(chars * m.charWidth + m.padding, headerWidth), m);
}

export function clampWidth(width: number, m: Pick<WidthMetrics, 'minWidth' | 'maxWidth'>): number {
  return Math.round(Math.min(m.maxWidth, Math.max(m.minWidth, width)));
}

/** Width of the row-number gutter for `rowCount` rows (grows by digit, never below 3 digits). */
export function gutterWidth(rowCount: number, m: Pick<WidthMetrics, 'charWidth' | 'padding'>) {
  const digits = Math.max(3, String(Math.max(1, rowCount)).length);
  return Math.ceil(digits * m.charWidth + m.padding);
}

/** Scroll offset that brings `[start, end)` into `[view, view + size)` (unchanged if inside). */
export function scrollToInclude(view: number, size: number, start: number, end: number): number {
  if (start < view) return start;
  if (end > view + size) return Math.max(0, end - size);
  return view;
}
