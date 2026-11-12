import { ipc, unwrap, type ColumnMeta } from '../../ipc';
import type { RowBlock, RowSource } from './rowSource';
import { WindowCache } from './windowCache';

/** Rows per screen window (rule 8: the frontend reads windows of 500 rows). */
export const WINDOW_ROWS = 500;
/** Largest window the backend serves; used to read selections for a copy. */
export const READ_CHUNK_ROWS = 2000;
/** Cells kept in the window cache, whatever the column count (bounded memory). */
const MAX_CACHED_CELLS = 1_500_000;
const MIN_WINDOWS = 8;
const MAX_WINDOWS = 400;

export interface ResultRowSource extends RowSource {
  /** The result streamed more rows (`ResultSummary.rowCount`). */
  setRowCount(count: number): void;
  /** The rows behind the indices changed (a sort or a filter): drops what was read. */
  resetRows(count: number): void;
  /** Stops fetching and frees the rows; `revive` starts again (remount). */
  dispose(): void;
  revive(): void;
  /** Number of window requests sent so far (measurements). */
  readonly fetchCount: number;
}

function abortError(): Error {
  return new DOMException('The copy was cancelled.', 'AbortError');
}

/** A result of the backend's `ResultStore`, read through `fetch_result_window` (M1-3). */
export function createResultRowSource(
  resultId: number,
  columns: readonly ColumnMeta[],
  rowCount: number,
): ResultRowSource {
  const fetchWindow = (offset: number, limit: number): Promise<RowBlock> =>
    unwrap(ipc.commands.fetchResultWindow(resultId, offset, limit));
  const perWindow = WINDOW_ROWS * Math.max(1, columns.length);
  const cache = new WindowCache({
    fetch: fetchWindow,
    windowSize: WINDOW_ROWS,
    maxWindows: Math.max(
      MIN_WINDOWS,
      Math.min(MAX_WINDOWS, Math.floor(MAX_CACHED_CELLS / perWindow)),
    ),
  });
  cache.setRowCount(rowCount);
  const gridColumns = columns.map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind }));

  async function read(start: number, end: number, signal?: AbortSignal): Promise<RowBlock[]> {
    const stop = Math.min(end, cache.rowCount);
    const blocks: RowBlock[] = [];
    let row = Math.max(0, start);
    while (row < stop) {
      if (signal?.aborted) throw abortError();
      const cached = cache.get(row);
      if (cached) {
        blocks.push(cached);
        row = cached.offset + cached.rowCount;
        continue;
      }
      // Up to the next cached row, in chunks the backend accepts.
      let missingEnd = row;
      while (missingEnd < stop && missingEnd - row < READ_CHUNK_ROWS && !cache.get(missingEnd)) {
        missingEnd = Math.min(stop, (Math.floor(missingEnd / WINDOW_ROWS) + 1) * WINDOW_ROWS);
      }
      const limit = Math.min(READ_CHUNK_ROWS, Math.max(1, missingEnd - row));
      const block = await fetchWindow(row, limit);
      if (block.rowCount === 0) break;
      blocks.push(block);
      row = block.offset + block.rowCount;
    }
    return blocks;
  }

  return {
    columns: gridColumns,
    get rowCount() {
      return cache.rowCount;
    },
    get fetchCount() {
      return cache.fetchCount;
    },
    block: (row) => cache.get(row),
    request: (start, end) => {
      cache.want(start, end);
    },
    subscribe: (listener) => cache.subscribe(listener),
    read,
    loaded: () => cache.blocks(),
    fullValue: (row, col) => unwrap(ipc.commands.fetchResultCell(resultId, row, col)),
    setRowCount: (count) => {
      cache.setRowCount(count);
    },
    resetRows: (count) => {
      cache.reset(count);
    },
    dispose: () => {
      cache.dispose();
    },
    revive: () => {
      cache.revive();
    },
  };
}
