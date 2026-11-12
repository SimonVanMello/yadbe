import { describe, expect, it } from 'vitest';

import type { ValueKind } from '../bindings';
import { aggregateSelection, type AggregateCell } from './resultAggregate';

function grid(rows: AggregateCell[][]) {
  return (row: number, column: number) => rows[row]?.[column] ?? null;
}

const int = (text: string): AggregateCell => ['int', text];
const dec = (text: string): AggregateCell => ['decimal', text];
const cell = (kind: ValueKind, text: string): AggregateCell => [kind, text];

describe('aggregateSelection (mock of the backend aggregates)', () => {
  it('adds integers and decimals exactly and skips NULLs', () => {
    const rows = [[int('9223372036854775807')], [dec('0.10')], [null], [dec('0.20')], [int('-5')]];
    const result = aggregateSelection([{ rowStart: 0, rowEnd: 5, columns: [0] }], 5, 1, grid(rows));
    expect(result).toEqual({
      cells: 5,
      nonNull: 4,
      numeric: 4,
      sum: '9223372036854775802.3',
      avg: '2305843009213693950.575',
      min: '-5',
      max: '9223372036854775807',
      exact: true,
    });
  });

  it('counts a cell covered by two ranges once', () => {
    const rows = [
      [int('1'), int('10')],
      [int('2'), int('20')],
      [int('3'), int('30')],
    ];
    const result = aggregateSelection(
      [
        { rowStart: 0, rowEnd: 2, columns: [0, 1] },
        { rowStart: 1, rowEnd: 3, columns: [1] },
      ],
      3,
      2,
      grid(rows),
    );
    expect(result.cells).toBe(5);
    expect(result.sum).toBe('63');
  });

  it('gives no figures when a cell is not a number, only counts', () => {
    const rows = [[int('1')], [cell('text', 'x')], [null]];
    const result = aggregateSelection([{ rowStart: 0, rowEnd: 3, columns: [0] }], 3, 1, grid(rows));
    expect(result).toMatchObject({ cells: 3, nonNull: 2, numeric: 1, sum: null, avg: null });
  });

  it('is floating point as soon as a float takes part', () => {
    const rows = [[cell('float', '1.5')], [int('2')], [dec('-0.5')]];
    const result = aggregateSelection([{ rowStart: 0, rowEnd: 3, columns: [0] }], 3, 1, grid(rows));
    expect(result).toMatchObject({ exact: false, sum: '3', avg: '1', min: '-0.5', max: '2' });
  });

  it('rounds the average half away from zero to six more digits', () => {
    const rows = [[int('-10')], [int('0')], [int('0')]];
    const result = aggregateSelection([{ rowStart: 0, rowEnd: 3, columns: [0] }], 3, 1, grid(rows));
    expect(result.avg).toBe('-3.333333');
  });

  it('clamps ranges to the rows that exist and ignores unknown columns', () => {
    const rows = [[int('4')]];
    const result = aggregateSelection(
      [{ rowStart: 0, rowEnd: 99, columns: [0, 7] }],
      1,
      1,
      grid(rows),
    );
    expect(result.cells).toBe(1);
    expect(result.sum).toBe('4');
  });
});
