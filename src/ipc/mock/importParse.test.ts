import { describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_OPTIONS, detectOptions, MockParseError, readFile } from './importParse';

describe('the mock import parser', () => {
  it('reads quoted fields with delimiters, doubled quotes and line breaks', () => {
    const parsed = readFile('id,note\n1,"a, ""b""\nsecond line"\n2,\n', DEFAULT_PARSE_OPTIONS);
    expect(parsed.columns).toEqual(['id', 'note']);
    expect(parsed.records.map((r) => r.cells)).toEqual([
      ['1', 'a, "b"\nsecond line'],
      ['2', null],
    ]);
    expect(parsed.records.map((r) => r.line)).toEqual([2, 4]);
  });

  it('keeps an empty quoted field as an empty string and honours the null token', () => {
    const parsed = readFile('a,b,c\n"",NULL,x\n', { ...DEFAULT_PARSE_OPTIONS, nullToken: 'NULL' });
    expect(parsed.records[0]?.cells).toEqual(['', null, 'x']);
  });

  it('flags rows that do not have the header width', () => {
    const parsed = readFile('a,b\n1,2\n3\n4,5,6\n', DEFAULT_PARSE_OPTIONS);
    expect(parsed.records.map((r) => r.ragged)).toEqual([null, 1, 3]);
  });

  it('names the columns of a file without a header', () => {
    const parsed = readFile('1,2\n3,4\n', { ...DEFAULT_PARSE_OPTIONS, header: false });
    expect(parsed.columns).toEqual(['Column 1', 'Column 2']);
    expect(parsed.records).toHaveLength(2);
  });

  it('refuses a quote that never closes, with its line', () => {
    expect(() => readFile('a,b\n1,"oops\n', DEFAULT_PARSE_OPTIONS)).toThrow(MockParseError);
    try {
      readFile('a,b\n1,"oops\n', DEFAULT_PARSE_OPTIONS);
    } catch (error) {
      expect((error as MockParseError).line).toBe(2);
    }
  });

  it('reads a JSON array and JSON Lines, with the keys of the first objects as columns', () => {
    const array = readFile('[{"id": 1, "n": "x"}, {"id": 2, "extra": true}]', {
      ...DEFAULT_PARSE_OPTIONS,
      format: 'json',
    });
    expect(array.columns).toEqual(['id', 'n', 'extra']);
    expect(array.records[1]?.cells).toEqual(['2', null, 'true']);
    const lines = readFile('{"id": 1}\n{"id": 2}\n', {
      ...DEFAULT_PARSE_OPTIONS,
      format: 'jsonLines',
    });
    expect(lines.records.map((r) => r.cells)).toEqual([['1'], ['2']]);
    expect(() => readFile('{"id": 1}', { ...DEFAULT_PARSE_OPTIONS, format: 'json' })).toThrow(
      MockParseError,
    );
  });

  it('detects the delimiter, the header, the null token and the format', () => {
    const semicolons = detectOptions('id;name;note\n1;Ana;NULL\n2;Bob;ok\n', '/x/a.csv');
    expect(semicolons.options).toMatchObject({
      format: 'csv',
      delimiter: 'semicolon',
      header: true,
      nullToken: 'NULL',
    });
    expect(detectOptions('1,2,3\n4,5,6\n', '/x/a.txt').options.header).toBe(false);
    expect(detectOptions('[{"a":1}]', '/x/a.json').options.format).toBe('json');
    expect(detectOptions('{"a":1}\n{"a":2}\n', '/x/a.jsonl').options.format).toBe('jsonLines');
    expect(detectOptions('﻿a\tb\n1\t2\n', '/x/a.tsv')).toMatchObject({
      bom: true,
      options: { delimiter: 'tab' },
    });
  });
});
