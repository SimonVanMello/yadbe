import { describe, expect, it } from 'vitest';

import type { TableColumn } from '../../ipc';
import {
  chipValues,
  describeChip,
  operatorsFor,
  parseFilterState,
  splitList,
  toTableFilter,
} from './filterModel';

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
  col('id', 'int', { typeName: 'bigint', nullable: false }),
  col('email', 'text'),
  col('status', 'text', { enumValues: ['pending', 'paid'] }),
  col('flag', 'bool'),
  col('at', 'timestamp'),
];

describe('operatorsFor', () => {
  it('offers what fits the kind, and null tests only for nullable columns', () => {
    expect(operatorsFor(columns[0] ?? col('x', 'int'))).toEqual([
      'eq',
      'ne',
      'lt',
      'le',
      'gt',
      'ge',
      'between',
      'in',
    ]);
    expect(operatorsFor(col('t', 'text'))).toContain('contains');
    expect(operatorsFor(col('s', 'text', { enumValues: ['a'] }))).toEqual([
      'eq',
      'ne',
      'in',
      'isNull',
      'isNotNull',
    ]);
    expect(operatorsFor(col('b', 'bool'))).toEqual(['eq', 'isNull', 'isNotNull']);
  });
});

describe('chipValues and toTableFilter', () => {
  it('types values like the column, keeps big integers exact, text for LIKE operators', () => {
    const filter = toTableFilter(
      {
        chips: [
          { column: 'id', op: 'between', values: ['9007199254740993', '9223372036854775807'] },
          { column: 'email', op: 'contains', values: ['50%_off'] },
          { column: 'id', op: 'contains', values: ['12'] },
          { column: 'flag', op: 'eq', values: ['false'] },
          { column: 'email', op: 'isNull', values: [] },
          { column: 'status', op: 'in', values: ['pending', 'paid'] },
        ],
        rawWhere: '  ',
      },
      columns,
    );
    expect(filter).toEqual({
      conditions: [
        {
          column: 'id',
          op: 'between',
          values: [
            { kind: 'int', value: '9007199254740993' },
            { kind: 'int', value: '9223372036854775807' },
          ],
        },
        { column: 'email', op: 'contains', values: [{ kind: 'text', value: '50%_off' }] },
        { column: 'id', op: 'contains', values: [{ kind: 'text', value: '12' }] },
        { column: 'flag', op: 'eq', values: [{ kind: 'bool', value: false }] },
        { column: 'email', op: 'isNull', values: [] },
        {
          column: 'status',
          op: 'in',
          values: [
            { kind: 'text', value: 'pending' },
            { kind: 'text', value: 'paid' },
          ],
        },
      ],
      rawWhere: null,
    });
  });

  it('reports the value that does not fit, and leaves invalid or orphan chips out', () => {
    const id = columns[0] ?? col('x', 'int');
    expect(chipValues({ column: 'id', op: 'eq', values: ['abc'] }, id)).toEqual({
      ok: false,
      index: 0,
      error: 'tableData.invalid.int',
    });
    expect(chipValues({ column: 'id', op: 'between', values: ['1'] }, id)).toMatchObject({
      ok: false,
      error: 'tableData.filter.missingValue',
    });
    const filter = toTableFilter(
      {
        chips: [
          { column: 'gone', op: 'eq', values: ['1'] },
          { column: 'at', op: 'gt', values: ['soon'] },
        ],
        rawWhere: "status = 'paid'",
      },
      columns,
    );
    expect(filter).toEqual({ conditions: [], rawWhere: "status = 'paid'" });
  });
});

describe('describeChip, splitList and parseFilterState', () => {
  it('writes a chip on one line', () => {
    const words = { and: 'and', opLabel: (op: string) => (op === 'between' ? 'between' : '=') };
    expect(describeChip({ column: 'total', op: 'between', values: ['1', '9'] }, words)).toBe(
      'total between 1 and 9',
    );
  });

  it('splits an in list by line, or by comma on one line', () => {
    expect(splitList('a\n b \n\nc')).toEqual(['a', 'b', 'c']);
    expect(splitList('1, 2,3')).toEqual(['1', '2', '3']);
  });

  it('reads a saved filter back, dropping what it does not understand', () => {
    expect(
      parseFilterState({
        chips: [{ column: 'id', op: 'eq', values: ['1', 2] }, { column: 'x', op: 'like' }, null],
        rawWhere: 'a = 1',
      }),
    ).toEqual({ chips: [{ column: 'id', op: 'eq', values: ['1'] }], rawWhere: 'a = 1' });
    expect(parseFilterState('garbage')).toEqual({ chips: [], rawWhere: '' });
  });
});
