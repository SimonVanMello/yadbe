import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTERS,
  activeFilterCount,
  clearScope,
  dayDistance,
  groupByDay,
  isFiltered,
  matchRanges,
  previewOf,
  rangeBounds,
  searchWords,
  splitByRanges,
  startOfDay,
  toBaseQuery,
  toEntry,
  type HistoryEntry,
} from './historyModel';

/** Wednesday 2026-11-11, 15:30 local time. */
const NOW = new Date(2026, 10, 11, 15, 30).getTime();
const DAY = new Date(2026, 10, 11).getTime();

function entry(id: number, startedAt: number): HistoryEntry {
  return {
    id,
    connectionId: 'c',
    connectionName: 'c',
    engine: 'postgres',
    database: null,
    sql: 'select 1',
    sqlTruncated: false,
    startedAt,
    durationMs: 1,
    rows: 1,
    outcome: 'ok',
    errorCode: null,
    errorMessage: null,
  };
}

describe('periods', () => {
  it('start at local midnight', () => {
    expect(startOfDay(NOW)).toBe(DAY);
    expect(rangeBounds('any', NOW)).toEqual({ from: null, to: null });
    expect(rangeBounds('today', NOW)).toEqual({ from: DAY, to: null });
    expect(rangeBounds('last7', NOW).from).toBe(new Date(2026, 10, 5).getTime());
    expect(rangeBounds('last30', NOW).from).toBe(new Date(2026, 9, 13).getTime());
  });

  it('counts calendar days, not 24 hours', () => {
    const lateYesterday = new Date(2026, 10, 10, 23, 59).getTime();
    expect(dayDistance(startOfDay(lateYesterday), NOW)).toBe(1);
    expect(dayDistance(DAY, NOW)).toBe(0);
  });

  it('bound a clearing from above only for "older than 30 days"', () => {
    expect(clearScope('c', 'any', NOW)).toEqual({ connectionId: 'c', from: null, to: null });
    expect(clearScope(null, 'older30', NOW)).toEqual({
      connectionId: null,
      from: null,
      to: new Date(2026, 9, 13).getTime(),
    });
    expect(clearScope(null, 'last7', NOW).to).toBeNull();
  });
});

describe('filters', () => {
  it('count what the Filters button counts: everything but the text', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, text: 'select' })).toBe(0);
    expect(
      activeFilterCount({
        text: '',
        connectionId: 'c',
        outcome: 'error',
        range: 'today',
        minDuration: '100',
        thisTab: true,
      }),
    ).toBe(5);
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, text: '  ' })).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, outcome: 'cancelled' })).toBe(true);
  });

  it('become a search request without a page cursor', () => {
    expect(toBaseQuery(EMPTY_FILTERS, NOW)).toEqual({
      text: null,
      connectionId: null,
      tabId: null,
      outcomes: [],
      from: null,
      to: null,
      minDurationMs: null,
      limit: null,
    });
    expect(
      toBaseQuery(
        {
          text: ' orders ',
          connectionId: 'c1',
          outcome: 'refused',
          range: 'today',
          minDuration: '1000',
          thisTab: false,
        },
        NOW,
      ),
    ).toEqual({
      text: 'orders',
      connectionId: 'c1',
      tabId: null,
      outcomes: ['refused'],
      from: DAY,
      to: null,
      minDurationMs: 1000,
      limit: null,
    });
  });
});

describe('the filter of the active tab (F-102)', () => {
  const thisTab = { ...EMPTY_FILTERS, thisTab: true };

  it('names the editor tab on screen', () => {
    expect(toBaseQuery(thisTab, NOW, 'tab-1').tabId).toBe('tab-1');
    // Not asked for: no tab, whatever is on screen.
    expect(toBaseQuery(EMPTY_FILTERS, NOW, 'tab-1').tabId).toBeNull();
  });

  it('asks for a tab that ran nothing when no editor tab is on screen, not for everything', () => {
    expect(toBaseQuery(thisTab, NOW, null).tabId).toBe('');
  });

  it('counts as a filter, so the panel offers to reset it', () => {
    expect(isFiltered(thisTab)).toBe(true);
    expect(activeFilterCount(thisTab)).toBe(1);
  });
});

describe('rows', () => {
  it('get plain numbers where the generated types allow null', () => {
    const row = toEntry({ ...entry(1, 2), id: null, startedAt: null, durationMs: null });
    expect([row.id, row.startedAt, row.durationMs]).toEqual([0, 0, 0]);
  });

  it('are grouped under one heading per day, newest first', () => {
    const items = groupByDay([
      entry(5, DAY + 3_600_000),
      entry(4, DAY + 1_000),
      entry(3, DAY - 1_000),
      entry(2, DAY - 5 * 86_400_000),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'day',
      'entry',
      'entry',
      'day',
      'entry',
      'day',
      'entry',
    ]);
    expect(items[0]).toMatchObject({ kind: 'day', start: DAY });
    expect(groupByDay([])).toEqual([]);
  });

  it('show a statement on one line, cut with an ellipsis', () => {
    expect(previewOf('select *\n  from   t\n', 100)).toBe('select * from t');
    expect(previewOf('select 1234567890', 8)).toBe('select 1…');
  });
});

describe('search highlighting', () => {
  it('reads words as the backend does', () => {
    expect(searchWords('Orders, UPDATE; x_1')).toEqual(['orders', 'update', 'x', '1']);
    expect(searchWords('()')).toEqual([]);
  });

  it('marks the start of every word that begins like a searched word', () => {
    const text = 'SELECT * FROM customers WHERE email LIKE x';
    expect(matchRanges(text, 'cust sel')).toEqual([
      [0, 3],
      [14, 18],
    ]);
    expect(matchRanges(text, 'ustom')).toEqual([]);
    expect(matchRanges(text, '')).toEqual([]);
  });

  it('prefers the longest searched word when several match', () => {
    expect(matchRanges('orders', 'o ord')).toEqual([[0, 3]]);
  });

  it('splits a text into marked and plain runs', () => {
    expect(splitByRanges('select 1', [[0, 3]])).toEqual([
      { text: 'sel', match: true },
      { text: 'ect 1', match: false },
    ]);
    expect(splitByRanges('abc', [])).toEqual([{ text: 'abc', match: false }]);
    expect(splitByRanges('', [])).toEqual([]);
  });
});
