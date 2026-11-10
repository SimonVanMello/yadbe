import {
  ipc,
  unwrap,
  type ResultWindow,
  type TableColumn,
  type TablePage,
  type Value,
  type ValueKind,
} from '../../ipc';
import { READ_CHUNK_ROWS, WINDOW_ROWS } from '../grid/resultRowSource';
import {
  valueText,
  type EditState,
  type GridColumn,
  type RowBlock,
  type RowSource,
} from '../grid/rowSource';
import { WindowCache } from '../grid/windowCache';
import { cellValue } from './cellValues';
import { EMPTY_PENDING, type ChangeTarget, type Pending } from './pendingChanges';

/**
 * The rows of a table tab for the grid (F-080, F-084): the page the backend keeps, read by
 * windows like a query result, with the pending changes drawn over it. A window without any
 * change is the backend's block itself (scrolling costs nothing more than in a result grid);
 * a window with changes is composed once per change, never per frame.
 *
 * After an apply, the rows the server sent back (refreshed and inserted rows) replace or extend
 * the page in place, and deleted rows leave it, so the user keeps seeing what they changed.
 */

/** A row read outside the page: refreshed or inserted by an apply. */
export interface LooseRow {
  resultId: number;
  /** Its index in that result. */
  index: number;
  texts: (string | null)[];
  kinds: ValueKind[];
  /** Data columns whose text is cut (the whole value is in the result). */
  truncated: ReadonlySet<number>;
}

/** The rows of a window as loose rows (refreshed or inserted rows of an apply). */
export function looseRows(window: ResultWindow, columns: readonly TableColumn[]): LooseRow[] {
  const rows: LooseRow[] = [];
  for (let i = 0; i < window.rowCount; i++) {
    const truncated = new Set<number>();
    window.columns.forEach((column, c) => {
      if (column.truncated.includes(i)) truncated.add(c);
    });
    rows.push({
      resultId: window.resultId,
      index: window.offset + i,
      texts: window.columns.map((column) => column.values[i] ?? null),
      kinds: window.columns.map((column, c) => column.kinds?.[i] ?? columns[c]?.kind ?? 'text'),
      truncated,
    });
  }
  return rows;
}

export interface SourceLabels {
  /** Hover text of an edited cell. */
  original: (text: string) => string;
  /** Hover text of a column a new row leaves to the server. */
  defaultValue: (expression: string | null) => string;
  null: string;
}

/** What the source shows for one row before pending changes. */
interface Underlying {
  text: (col: number) => string | null;
  kind: (col: number) => ValueKind;
  truncated: (col: number) => boolean;
  resultId: number;
  index: number;
}

type BaseLookup = (row: number) => { block: RowBlock; index: number } | undefined;

/** One column of a window being composed. */
interface ComposedColumn {
  column: TableColumn;
  values: (string | null)[];
  kinds: ValueKind[];
  truncated: number[];
  states: (EditState | null)[] | null;
  titles: (string | null)[] | null;
}

/** Composed windows kept at most (a page has at most 100 windows). */
const MAX_COMPOSED = 64;

export class TableRowSource implements RowSource {
  readonly columns: readonly GridColumn[];
  private readonly tableColumns: readonly TableColumn[];
  private labels: SourceLabels;
  private page: { resultId: number; rowCount: number; cache: WindowCache } | null = null;
  private stopCache: (() => void) | null = null;
  /** View row → page row (≥ 0) or extra row (`-1 - index`); `null`: the page as it is. */
  private mapping: Int32Array | null = null;
  private overrides = new Map<number, LooseRow>();
  private extras: LooseRow[] = [];
  private pending: Pending = EMPTY_PENDING;
  private failed: ChangeTarget | null = null;
  private readonly composed = new Map<number, RowBlock>();
  /** Windows holding an edited, failed or refreshed row. */
  private touched = new Set<number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    columns: readonly TableColumn[],
    gridColumns: readonly GridColumn[],
    labels: SourceLabels,
  ) {
    this.tableColumns = columns;
    this.columns = gridColumns;
    this.labels = labels;
  }

  // --- RowSource ------------------------------------------------------------------------------

  get rowCount(): number {
    return this.mappedCount + this.pending.inserts.length;
  }

  /** Rows that exist on the server (the page, as patched by applies). */
  get mappedCount(): number {
    return this.mapping ? this.mapping.length : (this.page?.rowCount ?? 0);
  }

  block(row: number): RowBlock | undefined {
    const window = Math.floor(row / WINDOW_ROWS);
    if (!this.needsCompose(window)) return this.page?.cache.get(row);
    let block = this.composed.get(window);
    if (block) {
      // Most recently used last.
      this.composed.delete(window);
      this.composed.set(window, block);
    } else {
      const start = window * WINDOW_ROWS;
      block = this.compose(start, Math.min(this.rowCount, start + WINDOW_ROWS), this.cacheLookup);
      if (!block) return undefined;
      this.composed.set(window, block);
      for (const old of this.composed.keys()) {
        if (this.composed.size <= MAX_COMPOSED) break;
        this.composed.delete(old);
      }
    }
    return row - block.offset < block.rowCount ? block : undefined;
  }

  request(start: number, end: number): void {
    const cache = this.page?.cache;
    if (!cache) return;
    const last = Math.min(end, this.mappedCount) - 1;
    if (last < start) return;
    if (!this.mapping) {
      cache.want(start, last + 1);
      return;
    }
    let first = -1;
    let final = -1;
    for (let row = start; row <= last; row++) {
      const base = this.mapping[row] ?? -1;
      if (base < 0) continue;
      if (first < 0) first = base;
      final = base;
    }
    if (first >= 0) cache.want(first, final + 1);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async read(start: number, end: number, signal?: AbortSignal): Promise<RowBlock[]> {
    const stop = Math.min(end, this.rowCount);
    const blocks: RowBlock[] = [];
    for (let from = Math.max(0, start); from < stop;) {
      if (signal?.aborted) throw new DOMException('The copy was cancelled.', 'AbortError');
      const to = Math.min(stop, (Math.floor(from / WINDOW_ROWS) + 1) * WINDOW_ROWS);
      const fetched = await this.loadBase(from, to);
      const lookup: BaseLookup = (base) => {
        const block = fetched.find((b) => base >= b.offset && base < b.offset + b.rowCount);
        return block ? { block, index: base - block.offset } : this.cacheLookup(base);
      };
      const block = this.compose(from, to, lookup);
      if (!block) break;
      blocks.push(block);
      from = to;
    }
    return blocks;
  }

  async fullValue(row: number, col: number): Promise<Value> {
    const pending = this.pendingValue(row, col);
    if (pending !== undefined) return pending;
    return this.underlyingValue(row, col);
  }

  *loaded(): Iterable<RowBlock> {
    if (!this.page) return;
    if (!this.mapping && this.touched.size === 0) {
      yield* this.page.cache.blocks();
      return;
    }
    yield* this.composed.values();
  }

  // --- Table editing ------------------------------------------------------------------------

  /** A new page: the previous one, its patches and the pending changes are gone. */
  setPage(page: TablePage | null): void {
    this.stopCache?.();
    this.page?.cache.dispose();
    this.page = null;
    this.stopCache = null;
    if (page) {
      const { resultId } = page;
      const cache = new WindowCache({
        fetch: (offset, limit) => unwrap(ipc.commands.fetchResultWindow(resultId, offset, limit)),
        windowSize: WINDOW_ROWS,
        maxWindows: 120,
      });
      cache.setRowCount(page.rowCount);
      if (page.window.rowCount > 0) cache.put(page.window);
      this.page = { resultId, rowCount: page.rowCount, cache };
      this.stopCache = cache.subscribe(() => {
        this.notify();
      });
    }
    this.mapping = null;
    this.overrides = new Map();
    this.extras = [];
    this.pending = EMPTY_PENDING;
    this.failed = null;
    this.touched = new Set();
    this.composed.clear();
    this.notify();
  }

  setPending(next: Pending): void {
    const previous = this.pending;
    if (next === previous) return;
    this.pending = next;
    const dirty = new Set<number>();
    for (const row of new Set([...previous.rows.keys(), ...next.rows.keys()])) {
      if (previous.rows.get(row) !== next.rows.get(row)) dirty.add(Math.floor(row / WINDOW_ROWS));
    }
    if (previous.inserts !== next.inserts) {
      let first = 0;
      while (
        first < Math.min(previous.inserts.length, next.inserts.length) &&
        previous.inserts[first] === next.inserts[first]
      ) {
        first++;
      }
      const end = this.mappedCount + Math.max(previous.inserts.length, next.inserts.length);
      for (
        let w = Math.floor((this.mappedCount + first) / WINDOW_ROWS);
        w * WINDOW_ROWS < end;
        w++
      ) {
        dirty.add(w);
      }
    }
    this.retouch();
    for (const window of dirty) this.composed.delete(window);
    this.notify();
  }

  setFailed(target: ChangeTarget | null): void {
    const before = this.failed;
    this.failed = target;
    for (const t of [before, target]) {
      if (t) this.composed.delete(Math.floor(this.rowOf(t) / WINDOW_ROWS));
    }
    this.retouch();
    this.notify();
  }

  setLabels(labels: SourceLabels): void {
    this.labels = labels;
    this.composed.clear();
    this.notify();
  }

  /** The grid row of a change target. */
  rowOf(target: ChangeTarget): number {
    return target.kind === 'row' ? target.row : this.mappedCount + target.index;
  }

  /** `insert`: the rank among the new rows of a row drawn after the existing ones. */
  rowKind(row: number): { kind: 'row'; row: number } | { kind: 'insert'; index: number } {
    const mapped = this.mappedCount;
    return row < mapped ? { kind: 'row', row } : { kind: 'insert', index: row - mapped };
  }

  /**
   * The rows an apply changed: deleted rows leave, refreshed rows replace what was read, and
   * inserted rows (as the server stored them) follow the existing ones. Pending changes are gone.
   */
  applied(change: {
    deleted: ReadonlySet<number>;
    refreshed: ReadonlyMap<number, LooseRow>;
    inserted: readonly LooseRow[];
  }): void {
    const mapped = this.mappedCount;
    const mapping: number[] = [];
    for (let row = 0; row < mapped; row++) {
      if (change.deleted.has(row)) continue;
      const source = this.mapping ? (this.mapping[row] ?? row) : row;
      const fresh = change.refreshed.get(row);
      if (fresh) {
        if (source >= 0) this.overrides.set(source, fresh);
        else this.extras[-1 - source] = fresh;
      }
      mapping.push(source);
    }
    for (const row of change.inserted) {
      this.extras.push(row);
      mapping.push(-this.extras.length);
    }
    this.mapping = Int32Array.from(mapping);
    this.pending = EMPTY_PENDING;
    this.failed = null;
    this.composed.clear();
    this.retouch();
    this.notify();
  }

  /** The value of a cell as the server holds it (pending changes ignored). */
  async underlyingValue(row: number, col: number): Promise<Value> {
    const known = this.underlying(row, this.cacheLookup);
    if (known && !known.truncated(col)) return cellValue(known.text(col), known.kind(col));
    if (known) return unwrap(ipc.commands.fetchResultCell(known.resultId, known.index, col));
    const base = this.mapping ? (this.mapping[row] ?? -1) : row;
    const page = this.page;
    if (base >= 0 && page) {
      const override = this.overrides.get(base);
      if (override)
        return unwrap(ipc.commands.fetchResultCell(override.resultId, override.index, col));
      return unwrap(ipc.commands.fetchResultCell(page.resultId, base, col));
    }
    return { kind: 'null' };
  }

  /** The key of an existing row as read (`identity`: data columns of the row identity). */
  keyOf(row: number, identity: readonly number[]): Promise<Value[]> {
    return Promise.all(identity.map((col) => this.underlyingValue(row, col)));
  }

  /** The pending value of a cell, `undefined` when it has none. New rows' untouched cells are NULL. */
  pendingValue(row: number, col: number): Value | undefined {
    const at = this.rowKind(row);
    if (at.kind === 'insert') {
      const insert = this.pending.inserts[at.index];
      return insert ? (insert.cells.get(col) ?? { kind: 'null' }) : undefined;
    }
    return this.pending.rows.get(row)?.cells.get(col)?.value;
  }

  dispose(): void {
    this.stopCache?.();
    this.stopCache = null;
    this.page?.cache.dispose();
    this.composed.clear();
  }

  // --- Internals ----------------------------------------------------------------------------

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private readonly cacheLookup: BaseLookup = (base) => {
    const block = this.page?.cache.get(base);
    return block ? { block, index: base - block.offset } : undefined;
  };

  private retouch(): void {
    const touched = new Set<number>();
    for (const row of this.pending.rows.keys()) touched.add(Math.floor(row / WINDOW_ROWS));
    if (this.failed) touched.add(Math.floor(this.rowOf(this.failed) / WINDOW_ROWS));
    this.touched = touched;
  }

  private needsCompose(window: number): boolean {
    if (this.mapping || this.overrides.size > 0 || this.touched.has(window)) return true;
    return this.pending.inserts.length > 0 && (window + 1) * WINDOW_ROWS > this.mappedCount;
  }

  /** Loads the page rows behind view rows `[from, to)` that the cache does not hold. */
  private async loadBase(from: number, to: number): Promise<RowBlock[]> {
    const page = this.page;
    if (!page) return [];
    const missing: number[] = [];
    for (let row = from; row < Math.min(to, this.mappedCount); row++) {
      const base = this.mapping ? (this.mapping[row] ?? -1) : row;
      if (base >= 0 && !this.overrides.has(base) && !page.cache.get(base)) missing.push(base);
    }
    const blocks: RowBlock[] = [];
    let index = 0;
    while (index < missing.length) {
      const first = missing[index] ?? 0;
      const limit = Math.min(READ_CHUNK_ROWS, (missing.at(-1) ?? first) - first + 1);
      const block = await unwrap(ipc.commands.fetchResultWindow(page.resultId, first, limit));
      if (block.rowCount === 0) break;
      blocks.push(block);
      while (index < missing.length && (missing[index] ?? 0) < block.offset + block.rowCount)
        index++;
    }
    return blocks;
  }

  private underlying(row: number, lookup: BaseLookup): Underlying | undefined {
    if (row >= this.mappedCount) return undefined;
    const base = this.mapping ? (this.mapping[row] ?? -1) : row;
    const loose = base >= 0 ? this.overrides.get(base) : this.extras[-1 - base];
    if (loose) {
      return {
        text: (col) => loose.texts[col] ?? null,
        kind: (col) => loose.kinds[col] ?? 'text',
        truncated: (col) => loose.truncated.has(col),
        resultId: loose.resultId,
        index: loose.index,
      };
    }
    const found = base >= 0 ? lookup(base) : undefined;
    const page = this.page;
    if (!found || !page) return undefined;
    const { block, index } = found;
    return {
      text: (col) => block.columns[col]?.values[index] ?? null,
      kind: (col) => block.columns[col]?.kinds?.[index] ?? this.tableColumns[col]?.kind ?? 'text',
      truncated: (col) => block.columns[col]?.truncated.includes(index) ?? false,
      resultId: page.resultId,
      index: base,
    };
  }

  /** Rows `[start, end)` as one block, pending changes drawn; `undefined` while rows load. */
  private compose(start: number, end: number, lookup: BaseLookup): RowBlock | undefined {
    const count = end - start;
    if (count <= 0) return undefined;
    const outs: ComposedColumn[] = this.tableColumns.map((column) => ({
      column,
      values: new Array<string | null>(count).fill(null),
      kinds: new Array<ValueKind>(count).fill(column.kind),
      truncated: [],
      states: null,
      titles: null,
    }));
    const rowStates = new Array<EditState | null>(count).fill(null);
    const mark = (out: ComposedColumn, i: number, state: EditState, title: string | null) => {
      (out.states ??= new Array<EditState | null>(count).fill(null))[i] = state;
      if (title !== null) (out.titles ??= new Array<string | null>(count).fill(null))[i] = title;
    };
    const failed = this.failed;
    const failedRow = failed ? this.rowOf(failed) : -1;
    for (let i = 0; i < count; i++) {
      const row = start + i;
      const at = this.rowKind(row);
      if (at.kind === 'insert') {
        const insert = this.pending.inserts[at.index];
        rowStates[i] = 'inserted';
        outs.forEach((out, col) => {
          const value = insert?.cells.get(col);
          if (value === undefined) {
            mark(out, i, 'default', this.labels.defaultValue(out.column.default));
            return;
          }
          out.values[i] = valueText(value);
          if (value.kind !== 'null') out.kinds[i] = value.kind;
        });
      } else {
        const source = this.underlying(row, lookup);
        if (!source) return undefined;
        const change = this.pending.rows.get(row);
        outs.forEach((out, col) => {
          const edit = change?.cells.get(col);
          if (edit) {
            out.values[i] = valueText(edit.value);
            if (edit.value.kind !== 'null') out.kinds[i] = edit.value.kind;
            mark(out, i, 'modified', this.labels.original(source.text(col) ?? this.labels.null));
            return;
          }
          out.values[i] = source.text(col);
          out.kinds[i] = source.kind(col);
          if (source.truncated(col)) out.truncated.push(i);
        });
        if (change) rowStates[i] = change.deleted ? 'deleted' : 'modified';
      }
      if (row === failedRow && failed) {
        rowStates[i] = 'failed';
        for (const col of failed.dataCols) {
          const out = outs[col];
          if (out) mark(out, i, 'failed', null);
        }
      }
    }
    return {
      offset: start,
      rowCount: count,
      rowStates,
      columns: outs.map((out) => ({
        values: out.values,
        kinds: out.kinds.some((kind) => kind !== out.column.kind) ? out.kinds : null,
        truncated: out.truncated,
        states: out.states,
        titles: out.titles,
      })),
    };
  }
}
