import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '../../ipc';
import {
  blockerMessage,
  countParts,
  EMPTY_JOURNAL_FILTERS,
  isJournalFiltered,
  revertState,
  tableKey,
  tableText,
  toJournalQuery,
} from './journalModel';

const entry: JournalEntry = {
  id: 7,
  connectionId: 'c1',
  connectionName: 'Local',
  engine: 'postgres',
  family: 'sql',
  targetKind: 'table',
  table: { database: 'shop', schema: 'public', name: 'orders' },
  appliedAt: 1_700_000_000_000,
  durationMs: 4.2,
  updated: 2,
  inserted: 0,
  deleted: 1,
  statementCount: 3,
  preview: 'UPDATE',
  revertBlocker: null,
  reverts: null,
  revertedBy: null,
};

describe('journal model', () => {
  it('turns the filters into a query, blank search included', () => {
    expect(isJournalFiltered(EMPTY_JOURNAL_FILTERS)).toBe(false);
    expect(toJournalQuery({ ...EMPTY_JOURNAL_FILTERS, text: '  ' }).text).toBeNull();
    const filters = { text: ' paid ', connectionId: 'c1', table: entry.table };
    expect(isJournalFiltered(filters)).toBe(true);
    expect(toJournalQuery(filters)).toEqual({
      text: 'paid',
      connectionId: 'c1',
      table: entry.table,
      after: null,
      limit: null,
    });
  });

  it('names tables and tells them apart', () => {
    expect(tableText(entry.table, 'schema')).toBe('public.orders');
    expect(tableText({ database: 'main', schema: null, name: 't' }, 'none')).toBe('t');
    // MySQL: the database names the table, as a schema does elsewhere.
    expect(tableText({ database: 'shop_re', schema: null, name: 'items' }, 'database')).toBe(
      'shop_re.items',
    );
    expect(tableKey(entry.table)).not.toBe(tableKey({ ...entry.table, schema: 'sales' }));
  });

  it('says whether a change set can be reverted, and why not', () => {
    expect(revertState(entry)).toEqual({ kind: 'revertible' });
    expect(revertState({ ...entry, revertedBy: 9 })).toEqual({ kind: 'reverted', by: 9 });
    const blocker = { kind: 'unwritableColumn' as const, column: 'shape' };
    expect(revertState({ ...entry, revertBlocker: blocker })).toEqual({ kind: 'blocked', blocker });
    expect(blockerMessage(blocker)).toEqual({
      key: 'journal.blocker.unwritableColumn',
      params: { column: 'shape' },
    });
    expect(blockerMessage({ kind: 'columnsNotLoaded', columns: ['a', 'b'] }).params).toEqual({
      columns: 'a, b',
    });
    expect(blockerMessage({ kind: 'tooLarge' })).toEqual({ key: 'journal.blocker.tooLarge' });
  });

  it('counts only what changed', () => {
    expect(countParts(entry)).toEqual([
      { key: 'journal.count.updated', count: 2 },
      { key: 'journal.count.deleted', count: 1 },
    ]);
  });
});
