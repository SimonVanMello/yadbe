import { displayLength } from './cellDisplay';
import { fitWidth, type WidthMetrics } from './gridMath';
import type { RowBlock, RowSource } from './rowSource';

/** Quiet time after the last scroll event before the columns may change width. */
export const SETTLE_MS = 150;

/**
 * The longest displayed value of each column among the blocks loaded so far. Blocks are
 * immutable, so each one is measured once, when it first shows up.
 */
export interface ColumnExtents {
  /** Longest value so far, in characters, per data column. */
  chars: number[];
  seen: WeakSet<RowBlock>;
}

export function createExtents(columns: number): ColumnExtents {
  return { chars: new Array<number>(columns).fill(0), seen: new WeakSet() };
}

/** Measures the loaded blocks not seen yet; `true` when a column's longest value grew. */
export function measureLoaded(source: RowSource, extents: ColumnExtents): boolean {
  let grew = false;
  for (const block of source.loaded()) {
    if (extents.seen.has(block)) continue;
    extents.seen.add(block);
    source.columns.forEach((column, dataCol) => {
      const values = block.columns[dataCol];
      if (!values) return;
      let longest = extents.chars[dataCol] ?? 0;
      for (let i = 0; i < block.rowCount; i++) {
        const kind = values.kinds?.[i] ?? column.kind;
        longest = Math.max(longest, displayLength(values.values[i] ?? null, kind, 'NULL'));
      }
      if (longest > (extents.chars[dataCol] ?? 0)) {
        extents.chars[dataCol] = longest;
        grew = true;
      }
    });
  }
  return grew;
}

/**
 * Widths after a newly loaded window: a column the user did not resize gets wider when its
 * longest value needs it, never narrower (so the layout only ever opens up while scrolling).
 * Returns `widths` itself when nothing changes.
 */
export function widenColumns(
  widths: number[],
  extents: ColumnExtents,
  headerWidths: readonly number[],
  resized: ReadonlySet<number>,
  m: WidthMetrics,
): number[] {
  let next: number[] | null = null;
  for (const [dataCol, width] of widths.entries()) {
    if (resized.has(dataCol)) continue;
    const needed = fitWidth(extents.chars[dataCol] ?? 0, headerWidths[dataCol] ?? 0, m);
    if (needed > width) {
      next ??= [...widths];
      next[dataCol] = needed;
    }
  }
  return next ?? widths;
}
