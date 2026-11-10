import { describe, expect, it } from 'vitest';

import type { TableColumn } from '../../ipc';
import {
  duplicateCells,
  parseDelimited,
  pastedValue,
  planNewRows,
  planRangePaste,
} from './pasteModel';

function col(name: string, extra: Partial<TableColumn> = {}): TableColumn {
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

const texts = (grid: ReturnType<typeof parseDelimited>) =>
  grid.map((row) => row.map((c) => c.text));

describe('parseDelimited', () => {
  it('reads TSV with quoted cells holding tabs, line breaks and quotes', () => {
    const grid = parseDelimited('a\t"b\tc"\n"multi\nline"\t"say ""hi"""\n');
    expect(texts(grid)).toEqual([
      ['a', 'b\tc'],
      ['multi\nline', 'say "hi"'],
    ]);
  });

  it('reads CSV when there is no tab, telling "" from an empty field', () => {
    const grid = parseDelimited('1,"",\r\n2,x,"y,z"');
    expect(texts(grid)).toEqual([
      ['1', '', ''],
      ['2', 'x', 'y,z'],
    ]);
    expect(grid[0]?.[1]?.quoted).toBe(true);
    expect(grid[0]?.[2]?.quoted).toBe(false);
  });

  it('takes a single value as one cell', () => {
    expect(texts(parseDelimited('hello world'))).toEqual([['hello world']]);
    expect(parseDelimited('')).toEqual([]);
  });
});

describe('pastedValue', () => {
  it('makes an empty cell NULL in a nullable column and the default in a new row', () => {
    const cell = { text: '', quoted: false };
    expect(pastedValue(cell, col('note'), false)).toEqual({ ok: true, value: { kind: 'null' } });
    expect(pastedValue(cell, col('note'), true)).toBe('default');
    expect(pastedValue(cell, col('name', { nullable: false }), false)).toEqual({
      ok: true,
      value: { kind: 'text', value: '' },
    });
    expect(pastedValue({ text: '', quoted: true }, col('note'), false)).toEqual({
      ok: true,
      value: { kind: 'text', value: '' },
    });
    expect(
      pastedValue(
        { text: 'x', quoted: false },
        col('n', { kind: 'int', typeName: 'integer' }),
        false,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('planRangePaste', () => {
  const order = [2, 0, 1];

  it('lands right and down from the focused cell in display order, cut at the edges', () => {
    const grid = parseDelimited('a\tb\tc\nd\te\tf\ng\th\ti');
    const { targets, clipped } = planRangePaste(grid, { row: 8, col: 1 }, order, 10, null);
    expect(targets.map((t) => [t.row, t.dataCol, t.cell.text])).toEqual([
      [8, 0, 'a'],
      [8, 1, 'b'],
      [9, 0, 'd'],
      [9, 1, 'e'],
    ]);
    expect(clipped).toBe(1);
  });

  it('fills a selected range with a single value', () => {
    const grid = parseDelimited('x');
    const { targets } = planRangePaste(grid, { row: 0, col: 0 }, order, 10, {
      r0: 1,
      r1: 2,
      c0: 0,
      c1: 1,
    });
    expect(targets.map((t) => [t.row, t.dataCol])).toEqual([
      [1, 2],
      [1, 0],
      [2, 2],
      [2, 0],
    ]);
  });
});

describe('planNewRows', () => {
  const columns = [col('id'), col('email'), col('name')];

  it('maps by the header row when it names columns', () => {
    const { rows, byHeader } = planNewRows(
      parseDelimited('name\tEMAIL\nAna\ta@x\nBo\tb@x'),
      columns,
      [0, 1, 2],
    );
    expect(byHeader).toBe(true);
    expect(rows.map((row) => [...row.entries()].map(([c, cell]) => [c, cell.text]))).toEqual([
      [
        [2, 'Ana'],
        [1, 'a@x'],
      ],
      [
        [2, 'Bo'],
        [1, 'b@x'],
      ],
    ]);
  });

  it('maps by display order otherwise', () => {
    const { rows, byHeader } = planNewRows(parseDelimited('1\tx'), columns, [2, 1, 0]);
    expect(byHeader).toBe(false);
    expect([...(rows[0]?.entries() ?? [])].map(([c, cell]) => [c, cell.text])).toEqual([
      [2, '1'],
      [1, 'x'],
    ]);
  });
});

describe('duplicateCells', () => {
  it('leaves generated keys and read-only columns to the server', () => {
    const columns = [
      col('id', { kind: 'int', primaryKey: true, optionalOnInsert: true }),
      col('code', { primaryKey: true, optionalOnInsert: false }),
      col('total', { readOnlyReason: 'generated' }),
      col('note'),
    ];
    const cells = duplicateCells(
      [
        { kind: 'int', value: '1' },
        { kind: 'text', value: 'A' },
        { kind: 'decimal', value: '3' },
        { kind: 'null' },
      ],
      columns,
    );
    expect([...cells.keys()]).toEqual([1, 3]);
  });
});
