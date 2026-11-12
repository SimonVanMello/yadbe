import { describe, expect, it } from 'vitest';

import type { ResultEditColumn, ResultEditInfo, TableColumn } from '../../ipc';
import {
  gridColumnsOf,
  readOnlyReasons,
  resultIdOf,
  sessionIdOf,
  tableName,
  toTableInfo,
} from './resultEditModel';

function column(name: string, extra: Partial<TableColumn> = {}): TableColumn {
  return {
    name,
    typeName: 'text',
    kind: 'text',
    nullable: true,
    default: null,
    optionalOnInsert: true,
    primaryKey: false,
    readOnlyReason: null,
    enumValues: null,
    ...extra,
  };
}

const sourced = (name: string, extra: Partial<TableColumn> = {}): ResultEditColumn => ({
  source: name,
  column: column(name, extra),
});

const editable: ResultEditInfo = {
  resultId: 4,
  table: { database: 'app', schema: 'shop', name: 'customers' },
  readOnlyReasons: [],
  columns: [
    sourced('id', { kind: 'int', primaryKey: true }),
    { source: null, column: column('loud', { readOnlyReason: 'computed' }) },
    sourced('email'),
  ],
  rowIdentity: ['id'],
  identityColumns: [0],
};

describe('result edit model', () => {
  it('keys a result session apart from table tabs', () => {
    expect(sessionIdOf(12)).toBe('result:12');
    expect(resultIdOf('result:12')).toBe(12);
    expect(resultIdOf('tab-3')).toBeNull();
  });

  it('describes an editable result as a table without inserts or foreign keys', () => {
    const info = toTableInfo(editable);
    expect(info?.columns.map((c) => c.name)).toEqual(['id', 'loud', 'email']);
    expect(info?.columns[1]?.readOnlyReason).toBe('computed');
    expect(info?.rowIdentity).toEqual(['id']);
    expect(info?.readOnlyReasons).toEqual([]);
    expect(info?.foreignKeys).toEqual([]);
    expect(toTableInfo({ ...editable, readOnlyReasons: ['keyNotSelected'] })).toBeNull();
    expect(toTableInfo({ ...editable, table: null })).toBeNull();
    expect(tableName(editable)).toBe('shop.customers');
  });

  it("keeps the result's column names and types on the grid", () => {
    const columns = gridColumnsOf(
      [
        { name: 'id', typeName: 'int4', kind: 'int' },
        { name: 'loud', typeName: 'text', kind: 'text' },
        { name: 'mail', typeName: 'varchar', kind: 'text' },
      ],
      editable,
      (c) => (c.source === null ? 'computed' : null),
    );
    expect(columns.map((c) => [c.name, c.typeName, c.readOnlyReason])).toEqual([
      ['id', 'int4', null],
      ['loud', 'text', 'computed'],
      ['mail', 'varchar', null],
    ]);
  });

  it("adds the query tab's open transaction to the reasons of an editable result", () => {
    const idle = { mode: 'autoCommit', status: 'idle' } as const;
    const open = { mode: 'manual', status: 'open' } as const;
    expect(readOnlyReasons(editable, idle)).toEqual([]);
    expect(readOnlyReasons(editable, open)).toEqual(['openTransaction']);
    const view = { ...editable, readOnlyReasons: ['view' as const] };
    expect(readOnlyReasons(view, open)).toEqual(['view']);
    expect(readOnlyReasons(null, open)).toEqual([]);
  });
});
