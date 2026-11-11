import { describe, expect, it } from 'vitest';

import type { ForeignKey, IncomingForeignKey, Value } from '../../ipc';
import {
  compositeFill,
  describeKey,
  descriptiveColumns,
  foreignKeysOf,
  keyFilter,
  referencedKey,
  referencingKey,
  type DescribableColumn,
} from './fkModel';
import { toTableFilter } from './filterModel';

const int = (n: number): Value => ({ kind: 'int', value: String(n) });
const text = (value: string): Value => ({ kind: 'text', value });
const NULL: Value = { kind: 'null' };

function fk(columns: string[], referencedColumns: string[], name = 'parent'): ForeignKey {
  return {
    name: `${columns.join('_')}_fkey`,
    columns,
    referencedTable: { database: 'db', schema: 'shop', name },
    referencedColumns,
    onUpdate: 'noAction',
    onDelete: 'noAction',
    deferrable: false,
  };
}

const col = (name: string, kind: DescribableColumn['kind'] = 'text', typeName = 'text') => ({
  name,
  kind,
  typeName,
});

describe('foreign key model', () => {
  it('finds the keys of a column, single-column ones first', () => {
    const single = fk(['invoice_id'], ['id'], 'invoices');
    const composite = fk(['invoice_id', 'line_no'], ['invoice_id', 'line_no'], 'invoice_lines');
    expect(foreignKeysOf([composite, single], 'invoice_id')).toEqual([single, composite]);
    expect(foreignKeysOf([composite, single], 'line_no')).toEqual([composite]);
    expect(foreignKeysOf([composite, single], 'amount')).toEqual([]);
  });

  it('maps a foreign key value to the referenced key, composite included', () => {
    const composite = fk(['a', 'b'], ['Key A', 'key b']);
    const row = new Map<string, Value>([
      ['a', int(1)],
      ['b', text("x'y")],
    ]);
    expect(referencedKey(composite, (c) => row.get(c))).toEqual([
      { column: 'Key A', value: int(1) },
      { column: 'key b', value: text("x'y") },
    ]);
    row.set('b', NULL);
    expect(referencedKey(composite, (c) => row.get(c))).toBeNull();
    expect(referencedKey(composite, () => undefined)).toBeNull();
  });

  it('maps a row to the key of the rows referencing it', () => {
    const incoming: IncomingForeignKey = {
      table: { database: 'db', schema: 'shop', name: 'child' },
      foreignKey: fk(['a', 'b'], ['Key A', 'key b']),
    };
    const row = new Map<string, Value>([
      ['Key A', int(2)],
      ['key b', text('z')],
    ]);
    expect(referencingKey(incoming, (c) => row.get(c))).toEqual([
      { column: 'a', value: int(2) },
      { column: 'b', value: text('z') },
    ]);
    row.set('Key A', NULL);
    expect(referencingKey(incoming, (c) => row.get(c))).toBeNull();
  });

  it('turns a key into visible `=` chips the filter model accepts', () => {
    const key = [
      { column: 'id', value: int(42) },
      { column: 'code', value: text('A1') },
    ];
    const filter = keyFilter(key);
    expect(filter).toEqual({
      chips: [
        { column: 'id', op: 'eq', values: ['42'] },
        { column: 'code', op: 'eq', values: ['A1'] },
      ],
      rawWhere: '',
    });
    const columns = [
      {
        name: 'id',
        typeName: 'integer',
        kind: 'int' as const,
        nullable: false,
        default: null,
        optionalOnInsert: false,
        primaryKey: true,
        readOnlyReason: null,
        enumValues: null,
      },
      {
        name: 'code',
        typeName: 'text',
        kind: 'text' as const,
        nullable: true,
        default: null,
        optionalOnInsert: true,
        primaryKey: false,
        readOnlyReason: null,
        enumValues: null,
      },
    ];
    expect(toTableFilter(filter, columns).conditions).toEqual([
      { column: 'id', op: 'eq', values: [int(42)] },
      { column: 'code', op: 'eq', values: [text('A1')] },
    ]);
    expect(describeKey(key)).toBe('id = 42, code = A1');
  });

  it('fills every column of a composite key from the chosen row', () => {
    const composite = fk(['invoice_id', 'line_no'], ['invoice_id', 'line_no']);
    const chosen = new Map<string, Value>([
      ['invoice_id', int(7)],
      ['line_no', int(3)],
      ['label', text('Shipping')],
    ]);
    expect(compositeFill(composite, (c) => chosen.get(c))).toEqual([
      { column: 'invoice_id', value: int(7) },
      { column: 'line_no', value: int(3) },
    ]);
    const renamed = fk(['a', 'b'], ['Key A', 'key b']);
    expect(compositeFill(renamed, (c) => (c === 'Key A' ? int(1) : undefined))).toEqual([
      { column: 'a', value: int(1) },
    ]);
  });
});

describe('descriptive columns', () => {
  it('prefers a unique name-like text column, then other name-like ones', () => {
    const customers = [
      col('id', 'int', 'integer'),
      col('email', 'other', 'shop.email'),
      col('full_name', 'text', 'character varying(200)'),
      col('phone'),
      col('created_at', 'timestampTz', 'timestamp with time zone'),
    ];
    expect(descriptiveColumns(customers, ['id'], [['email']])).toEqual(['email', 'full_name']);
    expect(descriptiveColumns(customers, ['id'], [])).toEqual(['full_name', 'email']);
    expect(descriptiveColumns(customers, ['id'], [], 1)).toEqual(['full_name']);
  });

  it('falls back to the first text columns, never keys, secrets or bodies', () => {
    const users = [
      col('id', 'uuid', 'uuid'),
      col('password_hash'),
      col('api_token'),
      col('body'),
      col('customer_id', 'int', 'integer'),
      col('city'),
      col('country'),
    ];
    expect(descriptiveColumns(users, ['id'], [])).toEqual(['city', 'country']);
    // The key itself is never repeated, even when it is text.
    expect(descriptiveColumns([col('code'), col('label')], ['code'], [['code']])).toEqual([
      'label',
    ]);
  });

  it('without any text column, shows one readable column, if any', () => {
    const rates = [
      col('currency', 'text', 'character(3)'),
      col('day', 'date', 'date'),
      col('rate', 'decimal', 'numeric(18,8)'),
    ];
    expect(descriptiveColumns(rates, ['currency', 'day'], [])).toEqual(['rate']);
    expect(
      descriptiveColumns([col('id', 'int', 'integer'), col('raw', 'bytes', 'bytea')], ['id'], []),
    ).toEqual([]);
  });
});
