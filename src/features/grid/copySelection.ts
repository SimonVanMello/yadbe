import type { CopyCell, CopyTable } from './copyFormats';
import { blockKind, blockText, blockTruncated, valueText, type RowSource } from './rowSource';
import {
  countRows,
  selectedColumns,
  selectedRowIntervals,
  type Interval,
  type Selection,
} from './selection';

/** Most rows one copy reads; a bigger selection copies its first rows and says so. */
export const MAX_COPY_ROWS = 100_000;
/** Most cells one copy reads (wide results copy fewer rows). */
export const MAX_COPY_CELLS = 2_000_000;
const FULL_VALUE_CONCURRENCY = 6;
const READ_SLICE_ROWS = 10_000;

export interface GatherOptions {
  signal?: AbortSignal;
  /** Rows read so far out of the rows to copy, then cut cells completed out of their count. */
  onProgress?: (done: number, total: number) => void;
  maxRows?: number;
  maxCells?: number;
}

export interface GatherResult {
  table: CopyTable;
  /** Rows the selection covers. */
  selectedRows: number;
  /** Rows actually copied (fewer when the selection exceeds the bound). */
  copiedRows: number;
}

/** The first `limit` rows of the intervals. */
export function clipIntervals(intervals: readonly Interval[], limit: number): Interval[] {
  const out: Interval[] = [];
  let left = limit;
  for (const interval of intervals) {
    if (left <= 0) break;
    const end = Math.min(interval.end, interval.start + left);
    out.push({ start: interval.start, end });
    left -= end - interval.start;
  }
  return out;
}

/**
 * The selected cells as a table, in display order: rows any range covers × columns any range
 * covers. Rows not loaded yet are read from the source; cells cut short are read whole.
 */
export async function gatherSelection(
  source: RowSource,
  selection: Selection,
  order: readonly number[],
  options: GatherOptions = {},
): Promise<GatherResult> {
  const columns = selectedColumns(selection, order.length).map((c) => order[c] ?? c);
  const intervals = selectedRowIntervals(selection, source.rowCount);
  const selectedRows = countRows(intervals);
  const maxCells = options.maxCells ?? MAX_COPY_CELLS;
  const limit = Math.min(
    selectedRows,
    options.maxRows ?? MAX_COPY_ROWS,
    Math.max(1, Math.floor(maxCells / Math.max(1, columns.length))),
  );
  const rows: CopyCell[][] = [];
  const cut: { cell: CopyCell; row: number; col: number }[] = [];

  // Read in slices so a long copy reports its progress (and can be cancelled) as it goes.
  const slices = clipIntervals(intervals, limit).flatMap(({ start, end }) => {
    const parts: Interval[] = [];
    for (let at = start; at < end; at += READ_SLICE_ROWS) {
      parts.push({ start: at, end: Math.min(end, at + READ_SLICE_ROWS) });
    }
    return parts;
  });
  for (const { start, end } of slices) {
    const blocks = await source.read(start, end, options.signal);
    for (const block of blocks) {
      const from = Math.max(start, block.offset);
      const to = Math.min(end, block.offset + block.rowCount);
      for (let row = from; row < to; row++) {
        const index = row - block.offset;
        const cells = columns.map((col): CopyCell => {
          const kind = blockKind(block, index, col, source.columns[col]?.kind ?? 'text');
          const cell = { text: blockText(block, index, col), kind };
          if (blockTruncated(block, index, col)) cut.push({ cell, row, col });
          return cell;
        });
        rows.push(cells);
      }
    }
    options.onProgress?.(rows.length, limit);
  }

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cut.length) {
      if (options.signal?.aborted) throw new DOMException('The copy was cancelled.', 'AbortError');
      const item = cut[next++];
      if (!item) break;
      item.cell.text = valueText(await source.fullValue(item.row, item.col));
      done++;
      if (done % 50 === 0) options.onProgress?.(done, cut.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FULL_VALUE_CONCURRENCY, cut.length) }, () => worker()),
  );

  return {
    table: {
      columns: columns.map((col) => ({
        name: source.columns[col]?.name ?? '',
        kind: source.columns[col]?.kind ?? 'text',
      })),
      rows,
    },
    selectedRows,
    copiedRows: rows.length,
  };
}
