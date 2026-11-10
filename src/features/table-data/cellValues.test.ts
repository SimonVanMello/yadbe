import { describe, expect, it } from 'vitest';

import type { TableColumn } from '../../ipc';
import { cellValue, parseInput, valuesEqual, type EditColumn } from './cellValues';

function column(
  kind: TableColumn['kind'],
  typeName = '',
  extra: Partial<EditColumn> = {},
): EditColumn {
  return { kind, typeName, enumValues: null, nullable: true, ...extra };
}

function value(input: string, col: EditColumn) {
  const parsed = parseInput(input, col);
  return parsed.ok ? parsed.value : parsed.error;
}

describe('cellValue (keys and originals from a window)', () => {
  it('rebuilds values from the lossless text and the kind', () => {
    expect(cellValue(null, 'int')).toEqual({ kind: 'null' });
    expect(cellValue('true', 'bool')).toEqual({ kind: 'bool', value: true });
    expect(cellValue('9223372036854775807', 'int')).toEqual({
      kind: 'int',
      value: '9223372036854775807',
    });
    expect(cellValue('[{"kind":"text","value":"a"}]', 'array')).toEqual({
      kind: 'array',
      value: [{ kind: 'text', value: 'a' }],
    });
  });

  it('compares values by kind and text', () => {
    expect(valuesEqual({ kind: 'text', value: '' }, { kind: 'null' })).toBe(false);
    expect(valuesEqual({ kind: 'int', value: '1' }, { kind: 'decimal', value: '1' })).toBe(false);
    expect(valuesEqual({ kind: 'bool', value: false }, { kind: 'bool', value: false })).toBe(true);
  });
});

describe('parseInput', () => {
  it('keeps every digit of integers and checks their range', () => {
    expect(value('9223372036854775807', column('int', 'bigint'))).toEqual({
      kind: 'int',
      value: '9223372036854775807',
    });
    expect(value('9223372036854775808', column('int', 'bigint'))).toBe('tableData.invalid.range');
    expect(value('32768', column('int', 'smallint'))).toBe('tableData.invalid.range');
    expect(value(' +007 ', column('int', 'integer'))).toEqual({ kind: 'int', value: '7' });
    expect(value('-0', column('int', 'integer'))).toEqual({ kind: 'int', value: '0' });
    expect(value('1.5', column('int', 'integer'))).toBe('tableData.invalid.int');
  });

  it('keeps decimals as typed and checks the integer digits of numeric(p, s)', () => {
    expect(value('12345678901234.123456', column('decimal', 'numeric(20,6)'))).toEqual({
      kind: 'decimal',
      value: '12345678901234.123456',
    });
    expect(value('123456789012345', column('decimal', 'numeric(20,6)'))).toBe(
      'tableData.invalid.precision',
    );
    expect(value('1e3', column('decimal', 'numeric'))).toEqual({ kind: 'decimal', value: '1e3' });
    expect(value('nan', column('decimal', 'numeric'))).toEqual({ kind: 'decimal', value: 'NaN' });
    expect(value('1,5', column('decimal', 'numeric'))).toBe('tableData.invalid.decimal');
  });

  it('reads floats, booleans and enums', () => {
    expect(value('-1.5e-7', column('float'))).toEqual({ kind: 'float', value: '-1.5e-7' });
    expect(value('-inf', column('float'))).toEqual({ kind: 'float', value: '-Infinity' });
    expect(value('yes', column('bool'))).toEqual({ kind: 'bool', value: true });
    expect(value('0', column('bool'))).toEqual({ kind: 'bool', value: false });
    expect(value('maybe', column('bool'))).toBe('tableData.invalid.bool');
    const status = column('text', 'order_status', { enumValues: ['pending', 'paid'] });
    expect(value('paid', status)).toEqual({ kind: 'text', value: 'paid' });
    expect(value('lost', status)).toBe('tableData.invalid.enum');
  });

  it('checks dates, times and timestamps, with or without a zone as the type says', () => {
    expect(value('2024-2-29', column('date'))).toEqual({ kind: 'date', value: '2024-02-29' });
    expect(value('2023-02-29', column('date'))).toBe('tableData.invalid.date');
    expect(value('9:05', column('time', 'time without time zone'))).toEqual({
      kind: 'time',
      value: '09:05:00',
    });
    expect(value('10:00:00+02', column('time', 'time without time zone'))).toBe(
      'tableData.invalid.time',
    );
    expect(value('10:00:00+02', column('time', 'time with time zone'))).toEqual({
      kind: 'time',
      value: '10:00:00+02',
    });
    expect(value('2025-01-31T08:30:00.123', column('timestamp'))).toEqual({
      kind: 'timestamp',
      value: '2025-01-31 08:30:00.123',
    });
    expect(value('2025-01-31 08:30Z', column('timestampTz'))).toEqual({
      kind: 'timestampTz',
      value: '2025-01-31 08:30:00+00',
    });
    expect(value('2025-01-31 08:30+01:00', column('timestamp'))).toBe(
      'tableData.invalid.timestamp',
    );
  });

  it('normalizes uuids and binary, validates JSON without reformatting it', () => {
    expect(value('{0A1B2C3D-4E5F-4A6B-8C7D-0123456789AB}', column('uuid'))).toEqual({
      kind: 'uuid',
      value: '0a1b2c3d-4e5f-4a6b-8c7d-0123456789ab',
    });
    expect(value('12345', column('uuid'))).toBe('tableData.invalid.uuid');
    expect(value('\\xDE AD', column('bytes'))).toEqual({ kind: 'bytes', value: 'dead' });
    expect(value('abc', column('bytes'))).toBe('tableData.invalid.bytes');
    expect(value('{"n": 12345678901234567890.5}', column('json'))).toEqual({
      kind: 'json',
      value: '{"n": 12345678901234567890.5}',
    });
    expect(value('{oops', column('json'))).toBe('tableData.invalid.json');
  });

  it('keeps text exactly, spaces included, and refuses arrays', () => {
    expect(value('  two  spaces ', column('text'))).toEqual({
      kind: 'text',
      value: '  two  spaces ',
    });
    expect(value('', column('text'))).toEqual({ kind: 'text', value: '' });
    expect(value('{a,b}', column('array'))).toBe('tableData.invalid.array');
  });
});
