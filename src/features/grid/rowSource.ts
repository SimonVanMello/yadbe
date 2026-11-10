import type { Value, ValueKind } from '../../ipc';

/**
 * What the grid shows, independent of where rows come from. The query result grid reads a
 * backend result (`resultRowSource.ts`); the table editor (M2-3) will wrap a source to overlay
 * pending changes. Columns are in data order; the grid keeps its own display order.
 */
export interface GridColumn {
  name: string;
  /** The engine's type name, shown in the header (may be empty). */
  typeName: string;
  kind: ValueKind;
}

/**
 * Consecutive loaded rows, column by column (same shape as the backend's result window). Each
 * cell is its lossless text, `null` for SQL `NULL`. Blocks are immutable: a new block replaces
 * an old one, so the renderer can tell repainted rows by identity.
 */
export interface RowBlock {
  offset: number;
  rowCount: number;
  columns: readonly BlockColumn[];
}

export interface BlockColumn {
  values: readonly (string | null)[];
  /** Per-cell kinds when some differ from the column's (dynamically typed engines). */
  kinds: readonly ValueKind[] | null;
  /** Indices (in the block) of the cells cut short: the full value needs `fullValue`. */
  truncated: readonly number[];
}

export interface RowSource {
  readonly columns: readonly GridColumn[];
  /** Rows that exist so far (grows while a result streams). */
  readonly rowCount: number;
  /** The loaded block holding `row`, or `undefined` while it is not loaded. Called per frame. */
  block(row: number): RowBlock | undefined;
  /** Rows `[start, end)` are on screen: load what is missing. The latest call wins. */
  request(start: number, end: number): void;
  /** Called when blocks arrive or `rowCount` changes. */
  subscribe(listener: () => void): () => void;
  /**
   * Rows `[start, end)` for a copy or an export, loaded if needed (in order, covering the
   * range; fewer rows if the source has fewer).
   */
  read(start: number, end: number, signal?: AbortSignal): Promise<RowBlock[]>;
  /** The whole value of a cell (blocks cut long ones). */
  fullValue(row: number, col: number): Promise<Value>;
  /** Blocks in memory now (auto-fit measures the loaded rows). */
  loaded(): Iterable<RowBlock>;
}

export function blockText(block: RowBlock, index: number, col: number): string | null {
  return block.columns[col]?.values[index] ?? null;
}

export function blockKind(
  block: RowBlock,
  index: number,
  col: number,
  columnKind: ValueKind,
): ValueKind {
  const kinds = block.columns[col]?.kinds;
  return kinds ? (kinds[index] ?? columnKind) : columnKind;
}

export function blockTruncated(block: RowBlock, index: number, col: number): boolean {
  const truncated = block.columns[col]?.truncated;
  return !!truncated && truncated.length > 0 && truncated.includes(index);
}

/** The text form of a whole value, the same as the cells of a block (`null` for NULL). */
export function valueText(value: Value): string | null {
  switch (value.kind) {
    case 'null':
      return null;
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'array':
      return JSON.stringify(value.value);
    default:
      return value.value;
  }
}
