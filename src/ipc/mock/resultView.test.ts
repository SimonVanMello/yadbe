import { describe, expect, it } from 'vitest';

import type { ResultViewSpec, ViewFilter, ViewFilterOp } from '../bindings';
import type { AggregateCell } from './resultAggregate';
import { viewRows } from './resultView';

const int = (text: string): AggregateCell => ['int', text];
const dec = (text: string): AggregateCell => ['decimal', text];
const text = (value: string): AggregateCell => ['text', value];

const GRID: AggregateCell[][] = [
  [int('10'), text('banana'), dec('1.50')],
  [int('9'), text('Apple'), null],
  [int('-3'), text('cherry'), dec('1.5')],
  [null, text('apple'), dec('0.25')],
  [int('9223372036854775807'), text(''), dec('-1')],
];

function rows(spec: Partial<ResultViewSpec>, grid = GRID): number[] {
  return viewRows(
    { sort: [], filters: [], matchCase: false, ...spec },
    grid.length,
    3,
    (row, column) => grid[row]?.[column] ?? null,
  );
}

const filter = (column: number | null, op: ViewFilterOp, value = ''): ViewFilter => ({
  column,
  op,
  value,
});

describe('viewRows (mock of the backend sort and filter)', () => {
  it('sorts numbers by value, text without case, NULL last in both directions', () => {
    expect(rows({ sort: [{ column: 0, descending: false }] })).toEqual([2, 1, 0, 4, 3]);
    expect(rows({ sort: [{ column: 0, descending: true }] })).toEqual([4, 0, 1, 2, 3]);
    expect(rows({ sort: [{ column: 1, descending: false }] })).toEqual([4, 1, 3, 0, 2]);
    // Equal decimals keep their order.
    expect(rows({ sort: [{ column: 2, descending: false }] })).toEqual([4, 3, 0, 2, 1]);
  });

  it('filters by text, by exact numbers and on NULLs', () => {
    expect(rows({ filters: [filter(1, 'contains', 'PP')] })).toEqual([1, 3]);
    expect(rows({ filters: [filter(1, 'startsWith', 'c')] })).toEqual([2]);
    expect(rows({ filters: [filter(1, 'endsWith', 'ANA')] })).toEqual([0]);
    expect(rows({ filters: [filter(1, 'equals', 'APPLE')] })).toEqual([1, 3]);
    expect(rows({ filters: [filter(1, 'notContains', 'an')] })).toEqual([1, 2, 3, 4]);
    expect(rows({ filters: [filter(2, 'equals', '1.500')] })).toEqual([0, 2]);
    expect(rows({ filters: [filter(0, 'greater', '9')] })).toEqual([0, 4]);
    expect(rows({ filters: [filter(0, 'greater', '9223372036854775806')] })).toEqual([4]);
    expect(rows({ filters: [filter(0, 'lessOrEqual', '9')] })).toEqual([1, 2]);
    expect(rows({ filters: [filter(0, 'isNull')] })).toEqual([3]);
    expect(rows({ filters: [filter(2, 'isNotNull')] })).toEqual([0, 2, 3, 4]);
    expect(rows({ filters: [filter(2, 'notEquals', '1.5')] })).toEqual([1, 3, 4]);
  });

  it('a condition on every column matches when some cell does', () => {
    expect(rows({ filters: [filter(null, 'contains', 'ana')] })).toEqual([0]);
    expect(rows({ filters: [filter(null, 'notContains', 'a')] })).toEqual([2, 4]);
    expect(rows({ filters: [filter(null, 'isNull')] })).toEqual([1, 3]);
  });

  it('filters then sorts, and honours the case option', () => {
    const base = { sort: [{ column: 0, descending: true }] };
    expect(rows({ ...base, filters: [filter(1, 'contains', 'a')] })).toEqual([0, 1, 3]);
    expect(rows({ ...base, filters: [filter(1, 'contains', 'A')], matchCase: true })).toEqual([1]);
  });
});
