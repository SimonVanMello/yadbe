import type { ColumnMeta, Value, ValueKind } from '../../ipc';
import { parseJson } from '../grid/jsonTree';
import type { ResultRowSource } from '../grid/resultRowSource';
import type { BlockColumn, EditState, RowBlock, RowSource } from '../grid/rowSource';
import { cellOf, changedFields, effective, type DocEdits } from './docEditModel';

/** A grid row the pending edits change. */
export interface OverlayRow {
  state: EditState;
  /** Column → the cell shown instead. */
  cells: ReadonlyMap<number, { text: string | null; kind: ValueKind }>;
  /** Column → the value read (hover text). */
  titles: ReadonlyMap<number, string>;
}

/** What the pending edits change in a page's grid. */
export interface DocOverlay {
  rows: ReadonlyMap<number, OverlayRow>;
  /** New documents, as rows after the page's (one cell per column). */
  added: readonly { text: string | null; kind: ValueKind }[][];
  version: string;
}

export const EMPTY_OVERLAY: DocOverlay = { rows: new Map(), added: [], version: '' };

/**
 * The marks of a page: rows of documents the edits change (`modified`, with their changed
 * top-level cells) or delete (`deleted`), and new documents after the page's rows. `ids`: the
 * `_id` of each row (`CollectionPage.ids`).
 */
export function overlayOf(
  edits: DocEdits,
  ids: readonly (string | null)[],
  columns: readonly ColumnMeta[],
  originalTitle: (text: string | null) => string,
): DocOverlay {
  const rows = new Map<number, OverlayRow>();
  const at = new Map<string, number>();
  ids.forEach((id, row) => {
    if (id !== null) at.set(id, row);
  });
  const index = new Map(columns.map((c, i) => [c.name, i]));
  for (const edit of edits.documents.values()) {
    const row = at.get(edit.id);
    if (row === undefined) continue;
    if (edit.deleted) {
      rows.set(row, { state: 'deleted', cells: new Map(), titles: new Map() });
      continue;
    }
    const before = parseJson(edit.original);
    const after = effective(edit) ?? undefined;
    const cells = new Map<number, { text: string | null; kind: ValueKind }>();
    const titles = new Map<number, string>();
    for (const name of changedFields(before, after)) {
      const col = index.get(name);
      if (col === undefined) continue;
      const node =
        after?.type === 'object' ? after.entries.find(([k]) => k === name)?.[1] : undefined;
      cells.set(col, cellOf(node));
      const was =
        before.type === 'object' ? before.entries.find(([k]) => k === name)?.[1] : undefined;
      titles.set(col, originalTitle(cellOf(was).text));
    }
    rows.set(row, { state: 'modified', cells, titles });
  }
  const added = edits.inserts.map((insert) => {
    let node;
    try {
      node = parseJson(insert.document);
    } catch {
      node = undefined;
    }
    return columns.map((column) =>
      cellOf(
        node?.type === 'object' ? node.entries.find(([k]) => k === column.name)?.[1] : undefined,
      ),
    );
  });
  const version = JSON.stringify([
    ids.length,
    [...edits.documents.values()].map((e) => [
      e.id,
      e.deleted,
      e.replacement,
      [...e.fields.entries()],
    ]),
    edits.inserts,
  ]);
  return { rows, added, version };
}

/** A page's rows with its pending edits drawn over them (the table tab's marks). */
export interface DocOverlaySource extends RowSource {
  setOverlay(overlay: DocOverlay): void;
  /** Rows of the page (the rest are new documents). */
  readonly serverRows: number;
}

/**
 * Wraps the grid result of a page: a window without any change is the result's block itself;
 * a window with changes is composed once per overlay version.
 */
export function createDocOverlaySource(base: ResultRowSource): DocOverlaySource {
  let overlay = EMPTY_OVERLAY;
  const listeners = new Set<() => void>();
  let composed = new WeakMap<RowBlock, RowBlock>();
  let addedBlock: RowBlock | null = null;

  function compose(block: RowBlock): RowBlock {
    if (overlay.rows.size === 0) return block;
    const cached = composed.get(block);
    if (cached) return cached;
    let changed = false;
    const rowStates: (EditState | null)[] = [];
    const columns: BlockColumn[] = block.columns.map((c, col) => ({
      ...c,
      values: [...c.values],
      kinds: c.kinds
        ? [...c.kinds]
        : Array.from({ length: block.rowCount }, () => base.columns[col]?.kind ?? 'text'),
      states: c.values.map(() => null),
      titles: c.values.map(() => null),
    }));
    for (let i = 0; i < block.rowCount; i++) {
      const mark = overlay.rows.get(block.offset + i);
      rowStates.push(mark?.state ?? null);
      if (!mark) continue;
      changed = true;
      for (const [col, cell] of mark.cells) {
        const column = columns[col];
        if (!column) continue;
        (column.values as (string | null)[])[i] = cell.text;
        (column.kinds as ValueKind[])[i] = cell.kind;
        (column.states as (EditState | null)[])[i] = 'modified';
        (column.titles as (string | null)[])[i] = mark.titles.get(col) ?? null;
      }
    }
    const result: RowBlock = changed ? { ...block, columns, rowStates } : block;
    composed.set(block, result);
    return result;
  }

  function added(): RowBlock | null {
    if (overlay.added.length === 0) return null;
    if (addedBlock && addedBlock.offset === base.rowCount) return addedBlock;
    addedBlock = {
      offset: base.rowCount,
      rowCount: overlay.added.length,
      rowStates: overlay.added.map(() => 'inserted'),
      columns: base.columns.map((_, col) => ({
        values: overlay.added.map((row) => row[col]?.text ?? ''),
        kinds: overlay.added.map((row) => row[col]?.kind ?? 'missing'),
        truncated: [],
        states: overlay.added.map(() => 'inserted' as const),
        titles: null,
      })),
    };
    return addedBlock;
  }

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const shownValue = (text: string | null, kind: ValueKind): Value =>
    kind === 'missing'
      ? { kind: 'missing' }
      : text === null
        ? { kind: 'null' }
        : { kind: 'text', value: text };

  return {
    columns: base.columns,
    get rowCount() {
      return base.rowCount + overlay.added.length;
    },
    get serverRows() {
      return base.rowCount;
    },
    block: (row) => {
      if (row >= base.rowCount) return added() ?? undefined;
      const block = base.block(row);
      return block ? compose(block) : undefined;
    },
    request: (start, end) => {
      base.request(start, Math.min(end, base.rowCount));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const off = base.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    read: async (start, end, signal) => {
      const blocks = (await base.read(start, Math.min(end, base.rowCount), signal)).map(compose);
      const extra = added();
      if (extra && end > base.rowCount) blocks.push(extra);
      return blocks;
    },
    fullValue: async (row, col): Promise<Value> => {
      if (row >= base.rowCount) {
        const cell = overlay.added[row - base.rowCount]?.[col];
        return shownValue(cell?.text ?? null, cell?.kind ?? 'missing');
      }
      const cell = overlay.rows.get(row)?.cells.get(col);
      if (cell) return shownValue(cell.text, cell.kind);
      return base.fullValue(row, col);
    },
    loaded: () => {
      const blocks = [...base.loaded()].map(compose);
      const extra = added();
      return extra ? [...blocks, extra] : blocks;
    },
    setOverlay: (next) => {
      if (next.version === overlay.version) return;
      overlay = next;
      composed = new WeakMap();
      addedBlock = null;
      notify();
    },
  };
}
