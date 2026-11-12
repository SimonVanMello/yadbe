import { describe, expect, it } from 'vitest';

import type { ImportTargetColumn } from '../../ipc';
import {
  autoMatch,
  duplicatedFileColumns,
  fileNameOf,
  isLargeFile,
  mappedCount,
  missingRequired,
  rejectsName,
  rematch,
  toMapping,
  usesKind,
  type ColumnPlan,
} from './importModel';

function column(name: string, extra: Partial<ImportTargetColumn> = {}): ImportTargetColumn {
  return {
    name,
    typeName: 'text',
    kind: 'text',
    nullable: true,
    filledByServer: false,
    primaryKey: false,
    readOnlyReason: null,
    ...extra,
  };
}

const target = [
  column('id', { kind: 'int', nullable: false, primaryKey: true }),
  column('order_id', { kind: 'int' }),
  column('Customer Email', { nullable: false }),
  column('created', { kind: 'timestamp', nullable: false, filledByServer: true }),
  column('seq', { kind: 'int', readOnlyReason: 'identity' }),
];

const choices = (plans: readonly ColumnPlan[]) => plans.map((p) => p.choice);

describe('autoMatch', () => {
  it('pairs by exact name first, then ignoring case and separators', () => {
    const plans = autoMatch(['Order ID', 'customer_email', 'id', 'extra'], target);
    expect(choices(plans)).toEqual([
      { kind: 'file', index: 2 },
      { kind: 'file', index: 0 },
      { kind: 'file', index: 1 },
      { kind: 'skip' },
      { kind: 'skip' },
    ]);
  });

  it('uses a file column once and never matches a read-only column', () => {
    const plans = autoMatch(['seq', 'id', 'ID'], target);
    expect(plans[4]?.choice).toEqual({ kind: 'skip' });
    expect(plans[0]?.choice).toEqual({ kind: 'file', index: 1 });
    const same = autoMatch(['Id'], [column('id'), column('ID2'), column('i_d')]);
    expect(choices(same).filter((c) => c.kind === 'file')).toHaveLength(1);
  });

  it('matches nothing in a file without a header row', () => {
    const plans = autoMatch(['Column 1', 'Column 2'], target);
    expect(plans.every((p) => p.choice.kind === 'skip')).toBe(true);
  });
});

describe('rematch', () => {
  it('keeps what the user chose while the columns still exist', () => {
    const before: ColumnPlan[] = [
      { column: target[0] as ImportTargetColumn, choice: { kind: 'file', index: 1 } },
      { column: target[1] as ImportTargetColumn, choice: { kind: 'constant', value: '7' } },
      { column: target[2] as ImportTargetColumn, choice: { kind: 'null' } },
      { column: target[3] as ImportTargetColumn, choice: { kind: 'skip' } },
      { column: target[4] as ImportTargetColumn, choice: { kind: 'skip' } },
    ];
    const plans = rematch(before, ['a', 'key'], ['key', 'a', 'created'], target);
    expect(plans[0]?.choice).toEqual({ kind: 'file', index: 0 });
    expect(plans[1]?.choice).toEqual({ kind: 'constant', value: '7' });
    expect(plans[2]?.choice).toEqual({ kind: 'null' });
    expect(plans[3]?.choice).toEqual({ kind: 'file', index: 2 });
  });
});

describe('the mapping', () => {
  const plans: ColumnPlan[] = [
    { column: target[0] as ImportTargetColumn, choice: { kind: 'file', index: 0 } },
    { column: target[1] as ImportTargetColumn, choice: { kind: 'null' } },
    { column: target[2] as ImportTargetColumn, choice: { kind: 'skip' } },
    { column: target[3] as ImportTargetColumn, choice: { kind: 'skip' } },
    { column: target[4] as ImportTargetColumn, choice: { kind: 'skip' } },
  ];

  it('lists what is written and leaves the rest to the server', () => {
    expect(toMapping(plans)).toEqual([
      { column: 'id', source: { kind: 'file', index: 0 } },
      { column: 'order_id', source: { kind: 'null' } },
    ]);
    expect(mappedCount(plans)).toBe(2);
  });

  it('names the required columns nothing writes', () => {
    expect(missingRequired(plans)).toEqual(['Customer Email']);
  });

  it('spots a file column mapped twice and the kinds that need an option', () => {
    const twice: ColumnPlan[] = [
      { column: target[0] as ImportTargetColumn, choice: { kind: 'file', index: 3 } },
      { column: target[1] as ImportTargetColumn, choice: { kind: 'file', index: 3 } },
    ];
    expect(duplicatedFileColumns(twice)).toEqual([3]);
    expect(usesKind(plans, ['int'])).toBe(true);
    expect(usesKind(plans, ['decimal', 'float'])).toBe(false);
  });
});

describe('file helpers', () => {
  it('names the rejects file after the import file', () => {
    expect(fileNameOf('/home/ana/data/orders.2024.csv')).toBe('orders.2024.csv');
    expect(fileNameOf('C:\\data\\orders.csv')).toBe('orders.csv');
    expect(rejectsName('/x/orders.csv')).toBe('orders-rejected.csv');
    expect(rejectsName('/x/noext')).toBe('noext-rejected.csv');
  });

  it('flags files where one transaction is a real cost', () => {
    expect(isLargeFile(null)).toBe(false);
    expect(isLargeFile(10 * 1024 * 1024)).toBe(false);
    expect(isLargeFile(300 * 1024 * 1024)).toBe(true);
  });
});
