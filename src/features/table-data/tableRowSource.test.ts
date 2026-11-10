import { afterEach, describe, expect, it, vi } from 'vitest';

import { ipc, type TableColumn, type TablePage, type Value } from '../../ipc';
import { addInserts, deleteRows, EMPTY_PENDING, setCell } from './pendingChanges';
import { TableRowSource } from './tableRowSource';

function col(
  name: string,
  kind: TableColumn['kind'],
  extra: Partial<TableColumn> = {},
): TableColumn {
  return {
    name,
    typeName: kind,
    kind,
    nullable: true,
    default: null,
    optionalOnInsert: true,
    primaryKey: false,
    readOnlyReason: null,
    enumValues: null,
    ...extra,
  };
}

const columns = [
  col('tenant', 'text', { primaryKey: true }),
  col('id', 'int', { primaryKey: true }),
  col('note', 'text', { default: "'n/a'" }),
];

const labels = {
  original: (text: string) => `was ${text}`,
  defaultValue: (expression: string | null) => `default ${expression ?? ''}`,
  null: 'NULL',
};

/** A page of three rows; the first tenant is cut (longer than a window cell). */
function page(): TablePage {
  return {
    resultId: 7,
    columns: columns.map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind })),
    offset: 0,
    rowCount: 3,
    hasMore: false,
    window: {
      resultId: 7,
      offset: 0,
      rowCount: 3,
      columns: [
        { values: ['acme-cut', 'beta', 'beta'], kinds: null, truncated: [0] },
        { values: ['9223372036854775807', '1', '2'], kinds: null, truncated: [] },
        { values: ['x', null, ''], kinds: null, truncated: [] },
      ],
    },
    order: [],
    durationMs: 1,
  };
}

function source() {
  const s = new TableRowSource(
    columns,
    columns.map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind })),
    labels,
  );
  s.setPage(page());
  return s;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TableRowSource', () => {
  it('serves the backend block itself while a window has no change', () => {
    const s = source();
    const block = s.block(1);
    expect(block?.columns[1]?.values).toEqual(['9223372036854775807', '1', '2']);
    expect(block?.rowStates).toBeUndefined();
  });

  it('builds composite keys from the window, fetching a cut key cell whole', async () => {
    const fetchCell = vi
      .spyOn(ipc.commands, 'fetchResultCell')
      .mockResolvedValue({ status: 'ok', data: { kind: 'text', value: 'acme-full-name' } });
    const s = source();
    expect(await s.keyOf(1, [0, 1])).toEqual([
      { kind: 'text', value: 'beta' },
      { kind: 'int', value: '1' },
    ]);
    expect(fetchCell).not.toHaveBeenCalled();
    expect(await s.keyOf(0, [0, 1])).toEqual([
      { kind: 'text', value: 'acme-full-name' },
      { kind: 'int', value: '9223372036854775807' },
    ]);
    expect(fetchCell).toHaveBeenCalledWith(7, 0, 0);
  });

  it('draws pending changes: modified cells with their original, deleted and new rows', () => {
    const s = source();
    const key: Value[] = [
      { kind: 'text', value: 'beta' },
      { kind: 'int', value: '1' },
    ];
    let pending = setCell(
      EMPTY_PENDING,
      { row: 1, key },
      2,
      { kind: 'text', value: 'hi' },
      { kind: 'null' },
    );
    pending = deleteRows(pending, [{ row: 2, key }], []);
    pending = addInserts(pending, [new Map([[0, { kind: 'text', value: 'new' }]])]).pending;
    s.setPending(pending);
    expect(s.rowCount).toBe(4);
    const block = s.block(0);
    expect(block?.rowStates).toEqual([null, 'modified', 'deleted', 'inserted']);
    expect(block?.columns[2]?.values).toEqual(['x', 'hi', '', null]);
    expect(block?.columns[2]?.states).toEqual([null, 'modified', null, 'default']);
    expect(block?.columns[2]?.titles?.[1]).toBe('was NULL');
    expect(block?.columns[2]?.titles?.[3]).toBe("default 'n/a'");
    // The cut cell keeps its mark at its place in the composed block.
    expect(block?.columns[0]?.truncated).toEqual([0]);
    expect(s.pendingValue(3, 1)).toEqual({ kind: 'null' });
    expect(s.rowKind(3)).toEqual({ kind: 'insert', index: 0 });
  });

  it('shows what the server stored after an apply: deleted rows leave, new rows follow', () => {
    const s = source();
    s.applied({
      deleted: new Set([0]),
      refreshed: new Map([
        [
          2,
          {
            resultId: 8,
            index: 0,
            texts: ['beta', '2', 'fresh'],
            kinds: ['text', 'int', 'text'],
            truncated: new Set(),
          },
        ],
      ]),
      inserted: [
        {
          resultId: 9,
          index: 0,
          texts: ['gamma', '3', 'n/a'],
          kinds: ['text', 'int', 'text'],
          truncated: new Set(),
        },
      ],
    });
    expect(s.rowCount).toBe(3);
    const block = s.block(0);
    expect(block?.columns[0]?.values).toEqual(['beta', 'beta', 'gamma']);
    expect(block?.columns[2]?.values).toEqual([null, 'fresh', 'n/a']);
    expect(block?.rowStates).toEqual([null, null, null]);
  });
});
