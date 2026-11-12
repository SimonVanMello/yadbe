import { describe, expect, it } from 'vitest';

import type { Value } from '../../ipc';
import {
  addInserts,
  deleteRows,
  EMPTY_PENDING,
  firstMissingRequired,
  isEmpty,
  pendingCount,
  rebaseRow,
  revertCells,
  revertInsertCells,
  revertRows,
  setCell,
  setInsertCell,
  targetOf,
  toChangeSet,
} from './pendingChanges';

const int = (value: string): Value => ({ kind: 'int', value });
const text = (value: string): Value => ({ kind: 'text', value });
const NULL: Value = { kind: 'null' };
const columns = [{ name: 'id' }, { name: 'email' }, { name: 'total' }];

describe('pending changes', () => {
  it('coalesces edits of a cell: the last value wins, the original stays the first read', () => {
    let pending = setCell(EMPTY_PENDING, { row: 3, key: [int('4')] }, 1, text('a@x'), text('old'));
    pending = setCell(pending, { row: 3, key: [int('4')] }, 1, text('b@x'), text('ignored'));
    const cell = pending.rows.get(3)?.cells.get(1);
    expect(cell).toEqual({ value: text('b@x'), original: text('old') });
    expect(pendingCount(pending)).toBe(1);
    const { changes } = toChangeSet(pending, columns);
    expect(changes.updates).toEqual([
      { key: [int('4')], column: 'email', value: text('b@x'), original: text('old') },
    ]);
  });

  it('drops a change set back to its original value, and the row with its last change', () => {
    let pending = setCell(EMPTY_PENDING, { row: 0, key: [int('1')] }, 1, text('new'), text('old'));
    pending = setCell(pending, { row: 0, key: [int('1')] }, 1, text('old'), text('old'));
    expect(isEmpty(pending)).toBe(true);
  });

  it('tells NULL from the empty string', () => {
    const pending = setCell(EMPTY_PENDING, { row: 0, key: [int('1')] }, 1, text(''), NULL);
    expect(pending.rows.get(0)?.cells.get(1)?.value).toEqual(text(''));
    expect(isEmpty(setCell(pending, { row: 0, key: [int('1')] }, 1, NULL, NULL))).toBe(true);
  });

  it('keeps an untouched entry identical, so only changed rows repaint', () => {
    const one = setCell(EMPTY_PENDING, { row: 0, key: [int('1')] }, 1, text('a'), text('b'));
    const two = setCell(one, { row: 9, key: [int('10')] }, 2, int('5'), int('6'));
    expect(two.rows.get(0)).toBe(one.rows.get(0));
    expect(setCell(two, { row: 9, key: [int('10')] }, 2, int('5'), int('6'))).toBe(two);
  });

  it('removes a new row that is deleted: nothing to insert, nothing to delete', () => {
    const { pending, first } = addInserts(EMPTY_PENDING, [new Map([[1, text('x')]]), new Map()]);
    expect(first).toBe(0);
    const after = deleteRows(pending, [], [0]);
    expect(after.inserts).toHaveLength(1);
    expect(after.inserts[0]?.cells.size).toBe(0);
    expect(isEmpty(deleteRows(after, [], [0]))).toBe(true);
  });

  it('deletes an edited row without its updates, and gets the edits back on restore', () => {
    const edited = setCell(EMPTY_PENDING, { row: 2, key: [int('3')] }, 1, text('e'), text('o'));
    const row = [int('3'), text('o'), NULL];
    const deleted = deleteRows(edited, [{ row: 2, key: [int('3')], values: row }], []);
    const { changes, trace } = toChangeSet(deleted, columns);
    expect(changes.updates).toEqual([]);
    // The whole row as read: the delete checks it (F-089) and the journal can put it back.
    expect(changes.deletes).toEqual([
      {
        key: [int('3')],
        values: [
          { column: 'id', value: int('3') },
          { column: 'email', value: text('o') },
          { column: 'total', value: NULL },
        ],
      },
    ]);
    expect(trace.deletes).toEqual([2]);
    expect(pendingCount(deleted)).toBe(1);
    // Reverting the whole row drops edits and deletion alike.
    expect(isEmpty(revertRows(deleted, [2], []))).toBe(true);
  });

  it('reverts single cells of existing and new rows', () => {
    let pending = setCell(EMPTY_PENDING, { row: 1, key: [int('2')] }, 1, text('a'), text('b'));
    pending = setCell(pending, { row: 1, key: [int('2')] }, 2, int('7'), int('8'));
    pending = revertCells(pending, 1, [1]);
    expect([...(pending.rows.get(1)?.cells.keys() ?? [])]).toEqual([2]);
    const added = addInserts(pending, [new Map([[1, text('n')]])]).pending;
    const reverted = revertInsertCells(added, 0, [1]);
    expect(reverted.inserts[0]?.cells.size).toBe(0);
    expect(setInsertCell(reverted, 0, 1, undefined)).toBe(reverted);
  });

  it('builds a change set in row and column order, values as lossless strings', () => {
    const key = [int('9223372036854775807'), text('fr')];
    let pending = setCell(
      EMPTY_PENDING,
      { row: 5, key },
      2,
      { kind: 'decimal', value: '12345678901234567890.123456' },
      NULL,
    );
    pending = setCell(pending, { row: 5, key }, 1, text('z'), text('y'));
    pending = setCell(pending, { row: 0, key: [int('1'), text('en')] }, 1, NULL, text('q'));
    pending = addInserts(pending, [
      new Map([
        [2, int('3')],
        [1, text('new')],
      ]),
    ]).pending;
    const { changes, trace } = toChangeSet(pending, columns);
    expect(changes.updates).toEqual([
      { key: [int('1'), text('en')], column: 'email', value: NULL, original: text('q') },
      { key, column: 'email', value: text('z'), original: text('y') },
      {
        key,
        column: 'total',
        value: { kind: 'decimal', value: '12345678901234567890.123456' },
        original: NULL,
      },
    ]);
    expect(changes.inserts).toEqual([
      {
        values: [
          { column: 'email', value: text('new') },
          { column: 'total', value: int('3') },
        ],
      },
    ]);
    expect(trace.updates).toEqual([
      { row: 0, dataCol: 1 },
      { row: 5, dataCol: 1 },
      { row: 5, dataCol: 2 },
    ]);
    expect(trace.inserts).toEqual([0]);
  });

  it('rebases a conflicting row on what the server holds now (F-089)', () => {
    let pending = setCell(EMPTY_PENDING, { row: 1, key: [int('2')] }, 1, text('mine'), text('o'));
    pending = setCell(pending, { row: 1, key: [int('2')] }, 2, int('5'), int('1'));
    const theirs = [int('2'), text('theirs'), int('5')];
    const rebased = rebaseRow(pending, 1, theirs);
    // My value stays, compared with theirs; a cell already as I want it has nothing left to do.
    expect(rebased.rows.get(1)?.cells.get(1)).toEqual({
      value: text('mine'),
      original: text('theirs'),
    });
    expect(rebased.rows.get(1)?.cells.has(2)).toBe(false);
    const same = rebaseRow(pending, 1, [int('2'), text('mine'), int('5')]);
    expect(isEmpty(same)).toBe(true);
    const deleted = deleteRows(
      EMPTY_PENDING,
      [{ row: 3, key: [int('4')], values: [int('4')] }],
      [],
    );
    expect(rebaseRow(deleted, 3, [int('4'), text('x')]).rows.get(3)?.values).toEqual([
      int('4'),
      text('x'),
    ]);
    expect(rebaseRow(EMPTY_PENDING, 0, [])).toBe(EMPTY_PENDING);
  });

  it('points a failed statement back at its row and cells', () => {
    let pending = setCell(EMPTY_PENDING, { row: 4, key: [int('5')] }, 1, text('dup'), text('o'));
    pending = setCell(pending, { row: 4, key: [int('5')] }, 2, int('1'), int('2'));
    pending = addInserts(pending, [new Map()]).pending;
    const { trace } = toChangeSet(pending, columns);
    const columnOf = (name: string) => columns.findIndex((c) => c.name === name);
    expect(
      targetOf({ kind: 'update', key: [int('5')], updates: [0, 1] }, trace, columnOf, 'email'),
    ).toEqual({ kind: 'row', row: 4, dataCols: [1] });
    expect(
      targetOf({ kind: 'update', key: [int('5')], updates: [0, 1] }, trace, columnOf, null),
    ).toEqual({
      kind: 'row',
      row: 4,
      dataCols: [1, 2],
    });
    expect(targetOf({ kind: 'insert', insert: 0 }, trace, columnOf, 'id')).toEqual({
      kind: 'insert',
      index: 0,
      dataCols: [0],
    });
  });
});

describe('required cells of new rows', () => {
  const cols = [
    { optionalOnInsert: true },
    { optionalOnInsert: false },
    { optionalOnInsert: false },
  ];

  it('points at the first column the server needs a value for', () => {
    let pending = addInserts(EMPTY_PENDING, [new Map(), new Map()]).pending;
    expect(firstMissingRequired(pending, cols)).toEqual({ index: 0, dataCol: 1 });
    pending = setInsertCell(pending, 0, 1, text('a'));
    expect(firstMissingRequired(pending, cols)).toEqual({ index: 0, dataCol: 2 });
    pending = setInsertCell(pending, 0, 2, NULL);
    expect(firstMissingRequired(pending, cols)).toEqual({ index: 1, dataCol: 1 });
  });

  it('finds nothing when every required cell has a value, or without new rows', () => {
    expect(firstMissingRequired(EMPTY_PENDING, cols)).toBeNull();
    const full = new Map([
      [1, text('a')],
      [2, text('b')],
    ]);
    expect(firstMissingRequired(addInserts(EMPTY_PENDING, [full]).pending, cols)).toBeNull();
  });
});
