import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionDefinition, HistoryQuery, HistoryRow } from '../bindings';
import { blankDefinition } from '../mockData';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands } = mockClient;
const PASSWORD = { kind: 'value', value: 'pw' } as const;

const query = (patch: Partial<HistoryQuery> = {}): HistoryQuery => ({
  text: null,
  connectionId: null,
  outcomes: [],
  from: null,
  to: null,
  minDurationMs: null,
  after: null,
  limit: null,
  ...patch,
});

const search = (patch?: Partial<HistoryQuery>) => unwrap(commands.searchHistory(query(patch)));

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setQueryTick(0);
  mockBackend.setHistoryDebounce(0);
});

describe('mock history', () => {
  it('starts with a few hundred believable entries, newest first', async () => {
    const all: HistoryRow[] = [];
    let after: number | null = null;
    do {
      const page = await search({ after });
      all.push(...page.rows);
      after = page.next;
    } while (after !== null);
    expect(all.length).toBeGreaterThan(300);
    const times = all.map((row) => row.startedAt ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(all.map((row) => row.outcome))).toEqual(
      new Set(['ok', 'error', 'cancelled', 'refused']),
    );
  });

  it('pages by 500 with a keyset cursor and no overlap', async () => {
    mockBackend.seedHistory(1200);
    const first = await search();
    const second = await search({ after: first.next });
    const third = await search({ after: second.next });
    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([500, 500, 200]);
    expect(third.next).toBeNull();
    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(1200);
    expect((await search({ limit: 3 })).rows).toHaveLength(3);
  });

  it('matches words by prefix, in any order', async () => {
    const page = await search({ text: 'ord sel' });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) expect(row.sql.toLowerCase()).toMatch(/\bord/);
    expect((await search({ text: 'zzzzzz' })).rows).toEqual([]);
  });

  it('filters by connection, outcome, period and duration', async () => {
    const wordpress = await search({ connectionId: 'conn-wordpress' });
    expect(wordpress.rows.length).toBeGreaterThan(0);
    expect(wordpress.rows.every((row) => row.connectionId === 'conn-wordpress')).toBe(true);

    const failed = await search({ outcomes: ['error', 'refused'] });
    expect(failed.rows.every((row) => row.outcome === 'error' || row.outcome === 'refused')).toBe(
      true,
    );

    const slow = await search({ minDurationMs: 1000 });
    expect(slow.rows.every((row) => (row.durationMs ?? 0) >= 1000)).toBe(true);

    const lastHour = await search({ from: Date.now() - 3_600_000 });
    const all = await search();
    expect(lastHour.rows.length).toBeLessThan(all.rows.length);
    expect(lastHour.rows.every((row) => (row.startedAt ?? 0) >= Date.now() - 3_600_000)).toBe(true);
  });

  it('cuts long statements in a list row and returns them whole by id', async () => {
    const long = `select ${'x, '.repeat(500)}1`;
    const created = await unwrap(commands.createConnection(withHistory(true)));
    await unwrap(commands.connect(created.id, PASSWORD));
    await run(created.id, long);
    const [row] = (await search({ connectionId: created.id })).rows;
    expect(row?.sqlTruncated).toBe(true);
    expect(row?.sql.length).toBeLessThan(long.length);
    const whole = await unwrap(commands.getHistoryEntry(row?.id ?? null));
    expect(whole?.sql).toBe(long);
    expect(await unwrap(commands.getHistoryEntry(-1))).toBeNull();
  });

  it('counts, deletes and clears', async () => {
    const total = await unwrap(commands.countHistory({ connectionId: null, from: null, to: null }));
    const scope = { connectionId: 'conn-wordpress', from: null, to: null };
    const mine = await unwrap(commands.countHistory(scope));
    expect(mine).toBeGreaterThan(0);
    const [first] = (await search({ connectionId: 'conn-wordpress' })).rows;
    await unwrap(commands.deleteHistoryEntry(first?.id ?? null));
    expect(await unwrap(commands.countHistory(scope))).toBe(mine - 1);
    expect(await unwrap(commands.clearHistory(scope))).toBe(mine - 1);
    expect((await search({ connectionId: 'conn-wordpress' })).rows).toEqual([]);
    expect(await unwrap(commands.countHistory({ connectionId: null, from: null, to: null }))).toBe(
      total - mine,
    );
  });

  it('announces a change once per burst', async () => {
    let events = 0;
    mockClient.events.subscribe('historyChanged', () => {
      events += 1;
    });
    mockBackend.setHistoryDebounce(20);
    const [a, b] = (await search({ limit: 2 })).rows;
    await unwrap(commands.deleteHistoryEntry(a?.id ?? null));
    await unwrap(commands.deleteHistoryEntry(b?.id ?? null));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toBe(1);
  });
});

function withHistory(historyEnabled: boolean): ConnectionDefinition {
  return {
    ...blankDefinition('postgres', historyEnabled ? 'recorded' : 'private'),
    host: 'localhost',
    database: 'app',
    username: 'u',
    historyEnabled,
  };
}

function finished(executionId: number): Promise<void> {
  return new Promise((resolve) => {
    const off = mockClient.events.subscribe('queryFinished', (payload) => {
      if (payload.executionId !== executionId) return;
      off();
      resolve();
    });
  });
}

async function run(connectionId: string, text: string, tabId = 'tab-1'): Promise<void> {
  const started = await unwrap(
    commands.executeQuery({
      tabId,
      connectionId,
      database: null,
      text,
      scope: { kind: 'all' },
      limits: null,
    }),
  );
  await finished(started.executionId);
}

describe('statements run through the mock runner', () => {
  it('are recorded with their outcome, and nothing is when the connection opted out', async () => {
    const recorded = await unwrap(commands.createConnection(withHistory(true)));
    const private_ = await unwrap(commands.createConnection(withHistory(false)));
    for (const { id } of [recorded, private_]) await unwrap(commands.connect(id, PASSWORD));

    await run(recorded.id, 'select 1; select * from nowhere; select 3');
    await run(private_.id, 'select 42');

    const page = await search({ connectionId: recorded.id });
    // The third statement did not run: the script stopped at the error.
    expect(page.rows.map((row) => [row.sql, row.outcome])).toEqual([
      ['select * from nowhere', 'error'],
      ['select 1', 'ok'],
    ]);
    expect(page.rows[0]?.errorMessage).toContain('nowhere');
    expect(page.rows[1]?.rows).toBe(1);
    expect(page.rows[1]?.connectionName).toBe('recorded');
    expect((await search({ connectionId: private_.id })).rows).toEqual([]);
  });

  it('records a refused statement on a read-only connection', async () => {
    await unwrap(commands.connect('conn-shop-prod', null));
    await run('conn-shop-prod', 'delete from orders');
    const [row] = (await search({ connectionId: 'conn-shop-prod', outcomes: ['refused'] })).rows;
    expect(row).toMatchObject({ sql: 'delete from orders', outcome: 'refused' });
    expect(row?.errorCode).toBe('readOnlyViolation');
  });

  it('keeps the editor tab each statement ran in, and can list what ran in one tab (F-102)', async () => {
    await unwrap(commands.connect('conn-shop-staging', null));
    await run('conn-shop-staging', 'select 1', 'tab-a');
    await run('conn-shop-staging', 'select 2', 'tab-b');
    await run('conn-shop-staging', 'select 3', 'tab-a');
    const sqls = async (tabId: string | null) =>
      (await search({ tabId, connectionId: 'conn-shop-staging', limit: 10 })).rows
        .map((row) => row.sql)
        .filter((sql) => /^select [123]$/.test(sql));
    expect(await sqls('tab-a')).toEqual(['select 3', 'select 1']);
    expect(await sqls('tab-b')).toEqual(['select 2']);
    expect(await sqls('tab-gone')).toEqual([]);
    // No tab filter: every tab's statements, and the seeded history that ran in none.
    expect(await sqls(null)).toEqual(['select 3', 'select 2', 'select 1']);
  });
});
