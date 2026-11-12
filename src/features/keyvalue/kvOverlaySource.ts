import type { Value } from '../../ipc';
import type { ResultRowSource } from '../grid/resultRowSource';
import {
  blockKind,
  type BlockColumn,
  type EditState,
  type RowBlock,
  type RowSource,
} from '../grid/rowSource';
import {
  cellBytes,
  identityColumn,
  rowIdentity,
  type CollectionKind,
  type Overlay,
} from './kvEditModel';

/** A collection's rows with its pending edits drawn over them (M4-6). */
export interface KvOverlaySource extends RowSource {
  setOverlay(overlay: Overlay): void;
  /** Rows the server holds (the rest are added by pending edits). */
  readonly serverRows: number;
}

const EMPTY: Overlay = { rows: new Map(), added: [], version: '[]' };

/**
 * Wraps the result rows of a collection: rows the edits change or remove are marked (and
 * show their new cells), rows the edits add follow the server's. A block without changes is
 * the result's block itself; a block with changes is composed once per overlay version.
 */
export function createOverlaySource(base: ResultRowSource, kind: CollectionKind): KvOverlaySource {
  let overlay = EMPTY;
  const listeners = new Set<() => void>();
  let composed = new WeakMap<RowBlock, RowBlock>();
  let addedBlock: RowBlock | null = null;

  const identityKind = (block: RowBlock, i: number) =>
    blockKind(block, i, identityColumn(kind), base.columns[identityColumn(kind)]?.kind ?? 'text');

  function compose(block: RowBlock): RowBlock {
    if (overlay.rows.size === 0) return block;
    const cached = composed.get(block);
    if (cached) return cached;
    const rowStates: (EditState | null)[] = [];
    const columns: BlockColumn[] = block.columns.map((c) => ({
      ...c,
      values: [...c.values],
      states: c.values.map(() => null),
      titles: c.values.map(() => null),
    }));
    let changed = false;
    for (let i = 0; i < block.rowCount; i++) {
      const cells = block.columns.map((c, col) => {
        const kindOf = col === identityColumn(kind) ? identityKind(block, i) : 'text';
        return cellBytes(c.values[i] ?? '', kindOf);
      });
      const mark = overlay.rows.get(rowIdentity(kind, cells));
      rowStates.push(mark?.state ?? null);
      if (!mark) continue;
      changed = true;
      for (const [col, text] of mark.cells) {
        const column = columns[col];
        if (!column) continue;
        (column.values as (string | null)[])[i] = text;
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
    const width = base.columns.length;
    addedBlock = {
      offset: base.rowCount,
      rowCount: overlay.added.length,
      rowStates: overlay.added.map(() => 'inserted'),
      columns: Array.from({ length: width }, (_, col) => ({
        values: overlay.added.map((row) => row[col] ?? null),
        kinds: null,
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
        const text = overlay.added[row - base.rowCount]?.[col] ?? null;
        return text === null ? { kind: 'null' } : { kind: 'text', value: text };
      }
      const block = base.block(row);
      const shown = block ? compose(block) : null;
      const at = shown ? row - shown.offset : -1;
      const column = shown?.columns[col];
      if (column?.states?.[at] === 'modified') {
        const text = column.values[at] ?? null;
        return text === null ? { kind: 'null' } : { kind: 'text', value: text };
      }
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
