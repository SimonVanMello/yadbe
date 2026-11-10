import { describe, expect, it } from 'vitest';

import {
  formatCopy,
  formatCsv,
  formatInList,
  formatInsert,
  formatJson,
  formatMarkdown,
  formatTsv,
  quoteIdentifierAnsi,
  sqlLiteral,
  type CopyTable,
} from './copyFormats';
import { jsonOfCell } from './cellJson';

const table: CopyTable = {
  columns: [
    { name: 'id', kind: 'int' },
    { name: 'name', kind: 'text' },
    { name: 'total', kind: 'decimal' },
  ],
  rows: [
    [
      { text: '9007199254740993', kind: 'int' },
      { text: 'Ana', kind: 'text' },
      { text: '12345678901234567890.25', kind: 'decimal' },
    ],
    [
      { text: '2', kind: 'int' },
      { text: null, kind: 'text' },
      { text: '', kind: 'decimal' },
    ],
  ],
};

const tricky: CopyTable = {
  columns: [{ name: 'v', kind: 'text' }],
  rows: [
    [{ text: 'a\tb', kind: 'text' }],
    [{ text: 'line 1\nline 2', kind: 'text' }],
    [{ text: '"quoted"', kind: 'text' }],
    [{ text: 'it\'s, "x"', kind: 'text' }],
    [{ text: '  padded ', kind: 'text' }],
    [{ text: '', kind: 'text' }],
    [{ text: null, kind: 'text' }],
    [{ text: 'a|b\\c', kind: 'text' }],
  ],
};

describe('TSV', () => {
  it('writes rows, with or without the header', () => {
    expect(formatTsv(table, { headers: true })).toBe(
      'id\tname\ttotal\n9007199254740993\tAna\t12345678901234567890.25\n2\t\t',
    );
    expect(formatTsv(table, { headers: false }).split('\n')).toHaveLength(2);
  });

  it('quotes tabs, line breaks and leading quotes', () => {
    expect(formatTsv(tricky, { headers: false }).split('\n').slice(0, 5)).toEqual([
      '"a\tb"',
      '"line 1',
      'line 2"',
      '"""quoted"""',
      'it\'s, "x"',
    ]);
  });
});

describe('CSV', () => {
  it('keeps NULL and the empty string distinct', () => {
    expect(formatCsv(table, { headers: true })).toBe(
      'id,name,total\n9007199254740993,Ana,12345678901234567890.25\n2,,""',
    );
  });

  it('quotes per RFC 4180', () => {
    expect(formatCsv(tricky, { headers: false })).toBe(
      [
        'a\tb',
        '"line 1\nline 2"',
        '"""quoted"""',
        '"it\'s, ""x"""',
        '"  padded "',
        '""',
        '',
        'a|b\\c',
      ].join('\n'),
    );
  });
});

describe('JSON', () => {
  it('writes objects with exact numbers and nulls', () => {
    expect(formatJson(table, { headers: true })).toBe(
      '[\n  {"id": 9007199254740993, "name": "Ana", "total": 12345678901234567890.25},\n' +
        '  {"id": 2, "name": null, "total": ""}\n]',
    );
  });

  it('writes arrays without headers', () => {
    expect(formatJson(table, { headers: false })).toContain('[2, null, ""]');
    expect(formatJson({ columns: table.columns, rows: [] }, { headers: true })).toBe('[]');
  });

  it('keeps duplicate column names apart', () => {
    const dup: CopyTable = {
      columns: [
        { name: 'id', kind: 'int' },
        { name: 'id', kind: 'int' },
      ],
      rows: [
        [
          { text: '1', kind: 'int' },
          { text: '2', kind: 'int' },
        ],
      ],
    };
    expect(formatJson(dup, { headers: true })).toContain('{"id": 1, "id_2": 2}');
  });

  it('converts each kind', () => {
    expect(jsonOfCell('NaN', 'float')).toBe('"NaN"');
    expect(jsonOfCell('-1.5e10', 'float')).toBe('-1.5e10');
    expect(jsonOfCell('true', 'bool')).toBe('true');
    expect(jsonOfCell('{"a":1.000000000000000000001}', 'json')).toBe(
      '{"a": 1.000000000000000000001}',
    );
    expect(jsonOfCell('{oops', 'json')).toBe('"{oops"');
    const array = JSON.stringify([
      { kind: 'int', value: '9007199254740993' },
      { kind: 'null' },
      { kind: 'text', value: 'x' },
      { kind: 'array', value: [{ kind: 'bool', value: true }] },
    ]);
    expect(jsonOfCell(array, 'array')).toBe('[9007199254740993, null, "x", [true]]');
    expect(jsonOfCell('[1', 'array')).toBe('"[1"');
    expect(jsonOfCell('deadbeef', 'bytes')).toBe('"deadbeef"');
    expect(jsonOfCell('2026-01-01', 'date')).toBe('"2026-01-01"');
  });
});

describe('Markdown', () => {
  it('writes a table with numeric columns right-aligned', () => {
    expect(formatMarkdown(table)).toBe(
      [
        '| id | name | total |',
        '| ---: | --- | ---: |',
        '| 9007199254740993 | Ana | 12345678901234567890.25 |',
        '| 2 | NULL |  |',
      ].join('\n'),
    );
  });

  it('escapes pipes, backslashes and line breaks', () => {
    const out = formatMarkdown(tricky).split('\n');
    expect(out[3]).toBe('| line 1<br>line 2 |');
    expect(out[9]).toBe('| a\\|b\\\\c |');
  });
});

describe('SQL', () => {
  it('writes literals per kind', () => {
    expect(sqlLiteral({ text: null, kind: 'int' })).toBe('NULL');
    expect(sqlLiteral({ text: '42', kind: 'int' })).toBe('42');
    expect(sqlLiteral({ text: 'NaN', kind: 'float' })).toBe("'NaN'");
    expect(sqlLiteral({ text: 'false', kind: 'bool' })).toBe('FALSE');
    expect(sqlLiteral({ text: '00ff', kind: 'bytes' })).toBe("X'00ff'");
    expect(sqlLiteral({ text: "O'Brien", kind: 'text' })).toBe("'O''Brien'");
    expect(sqlLiteral({ text: '', kind: 'text' })).toBe("''");
  });

  it('quotes identifiers only when needed', () => {
    expect(quoteIdentifierAnsi('total')).toBe('total');
    expect(quoteIdentifierAnsi('Total')).toBe('"Total"');
    expect(quoteIdentifierAnsi('order')).toBe('"order"');
    expect(quoteIdentifierAnsi('a"b')).toBe('"a""b"');
  });

  it('writes one INSERT per row', () => {
    expect(formatInsert(table, { headers: true, tableName: 'orders' })).toBe(
      "INSERT INTO orders (id, name, total) VALUES (9007199254740993, 'Ana', 12345678901234567890.25);\n" +
        "INSERT INTO orders (id, name, total) VALUES (2, NULL, '');",
    );
    expect(formatInsert(table, { headers: false })).toMatch(/^INSERT INTO table_name VALUES \(/);
    expect(
      formatInsert(table, { headers: true, quoteIdentifier: (n) => `[${n}]` }).split('\n')[0],
    ).toContain('([id], [name], [total])');
  });

  it('writes an IN list without duplicates', () => {
    const ids: CopyTable = {
      columns: [{ name: 'id', kind: 'int' }],
      rows: [['1'], ['2'], ['1'], [null]].map(([text]) => [{ text: text ?? null, kind: 'int' }]),
    };
    expect(formatInList(ids)).toBe('(1, 2, NULL)');
    expect(formatCopy('inList', tricky, { headers: true })).toMatch(/^\('a\tb', /);
  });
});

it('dispatches every format', () => {
  for (const format of ['tsv', 'csv', 'json', 'markdown', 'insert', 'inList'] as const) {
    expect(formatCopy(format, table, { headers: true }).length).toBeGreaterThan(0);
  }
});
