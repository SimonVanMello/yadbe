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
  /**
   * Why the column's cells cannot be changed, shown on its header (table editing); absent:
   * nothing to say (a result grid, or an editable column).
   */
  readOnlyReason?: string | null;
  /** Part of a foreign key: its header shows a link (table tabs, F-088). */
  link?: boolean;
}

/** Icons a column header shows before its name (header width). */
export function headerIcons(column: GridColumn): number {
  return (column.readOnlyReason ? 1 : 0) + (column.link ? 1 : 0);
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
  /** Pending-change state of each row, when a source overlays edits (F-084). */
  rowStates?: readonly (EditState | null)[];
}

/**
 * How a row or a cell differs from what the server holds (table editing, F-084); `default`: a
 * cell of a new row the server fills in.
 */
export type EditState = 'modified' | 'inserted' | 'deleted' | 'failed' | 'default';

export interface BlockColumn {
  values: readonly (string | null)[];
  /** Per-cell kinds when some differ from the column's (dynamically typed engines). */
  kinds: readonly ValueKind[] | null;
  /** Indices (in the block) of the cells cut short: the full value needs `fullValue`. */
  truncated: readonly number[];
  /** Pending-change state of each cell, when a source overlays edits (F-084). */
  states?: readonly (EditState | null)[] | null;
  /** Hover text of each cell (the value an edited cell had), when a source overlays edits. */
  titles?: readonly (string | null)[] | null;
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
