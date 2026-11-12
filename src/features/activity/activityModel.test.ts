import { describe, expect, it } from 'vitest';

import type { ActivityLock, ActivitySession } from '../../ipc';
import {
  DEFAULT_FILTERS,
  blockingCounts,
  displayState,
  filterLocks,
  filterSessions,
  formatDuration,
  isFiltered,
  killAvailability,
  relatives,
  sortSessions,
  summarize,
} from './activityModel';

function session(id: string, patch: Partial<ActivitySession> = {}): ActivitySession {
  return {
    id,
    fingerprint: `fp-${id}`,
    user: 'shop_app',
    database: 'shop',
    client: '10.0.0.1:5000',
    application: null,
    state: 'idle',
    stateText: 'idle',
    wait: null,
    statement: null,
    statementTruncated: false,
    runningSecs: null,
    transactionSecs: null,
    blockedBy: [],
    isSelf: false,
    system: false,
    ...patch,
  };
}

const blocker = session('10', { state: 'idleInTransaction', transactionSecs: 200 });
const blocked = session('11', { state: 'active', blockedBy: ['10'], runningSecs: 90 });
const report = session('12', {
  state: 'active',
  runningSecs: 120,
  user: 'analyst',
  statement: 'SELECT sum(total) FROM orders',
});
const idle = session('13');
const worker = session('1', { system: true, state: 'other' });
const all = [idle, worker, blocked, report, blocker];

describe('sortSessions', () => {
  it('puts blockers first, then the blocked, then what runs longest, then the idle', () => {
    expect(sortSessions(all).map((s) => s.id)).toEqual(['10', '11', '12', '13', '1']);
  });

  it('keeps the numeric order of ids among equals', () => {
    const a = session('9');
    const b = session('100');
    expect(sortSessions([b, a]).map((s) => s.id)).toEqual(['9', '100']);
  });
});

describe('filterSessions', () => {
  it('hides the system sessions until asked', () => {
    expect(filterSessions(all, DEFAULT_FILTERS).map((s) => s.id)).not.toContain('1');
    expect(
      filterSessions(all, { ...DEFAULT_FILTERS, showSystem: true }).map((s) => s.id),
    ).toContain('1');
  });

  it('matches every word anywhere in the session, without case', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, text: 'ANALYST sum' })).toEqual([report]);
    expect(filterSessions(all, { ...DEFAULT_FILTERS, text: 'analyst nothing' })).toEqual([]);
    expect(filterSessions(all, { ...DEFAULT_FILTERS, text: '12' })).toEqual([report]);
  });

  it('filters by state, a waiting session counting as blocked and not as running', () => {
    const byState = (state: 'running' | 'idleInTransaction' | 'blocked') =>
      filterSessions(all, { ...DEFAULT_FILTERS, state }).map((s) => s.id);
    expect(byState('running')).toEqual(['12']);
    expect(byState('idleInTransaction')).toEqual(['10']);
    expect(byState('blocked')).toEqual(['11']);
  });

  it('knows when a filter is on', () => {
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, text: ' x' })).toBe(true);
    expect(isFiltered({ ...DEFAULT_FILTERS, state: 'blocked' })).toBe(true);
    expect(isFiltered({ ...DEFAULT_FILTERS, showSystem: true })).toBe(false);
  });
});

describe('blocking', () => {
  it('counts what each session blocks and shows a waiting session as blocked', () => {
    const counts = blockingCounts(all);
    expect(counts.get('10')).toBe(1);
    expect(counts.get('11')).toBeUndefined();
    expect(displayState(blocked)).toBe('blocked');
    expect(displayState(blocker)).toBe('idleInTransaction');
  });

  it('summarizes what is shown', () => {
    expect(summarize(all, false)).toEqual({ sessions: 4, running: 1, blocked: 1 });
    expect(summarize(all, true).sessions).toBe(5);
  });

  it('finds who a session waits for and who it blocks', () => {
    const snapshot = { sessions: all };
    expect(relatives(snapshot, blocked).waitingFor).toEqual([blocker]);
    expect(relatives(snapshot, blocker).blocking).toEqual([blocked]);
    expect(relatives(snapshot, report)).toEqual({ waitingFor: [], blocking: [] });
  });
});

describe('filterLocks', () => {
  const lock = (sessionId: string, granted: boolean, object: string): ActivityLock => ({
    sessionId,
    lockType: 'relation',
    mode: 'RowExclusiveLock',
    granted,
    object,
  });
  const locks = [lock('1', true, 'shop.orders'), lock('2', false, 'shop.orders')];

  it('lists the waiting locks first and filters by words', () => {
    expect(filterLocks(locks, '').map((l) => l.sessionId)).toEqual(['2', '1']);
    expect(filterLocks(locks, 'orders exclusive')).toHaveLength(2);
    expect(filterLocks(locks, 'customers')).toEqual([]);
    expect(filterLocks(locks, '2')).toEqual([locks[1]]);
  });
});

describe('formatDuration', () => {
  it('writes the unit that reads best', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(0.25)).toBe('250 ms');
    expect(formatDuration(4.26)).toBe('4.3 s');
    expect(formatDuration(42.9)).toBe('42 s');
    expect(formatDuration(187)).toBe('3m 07s');
    expect(formatDuration(3720)).toBe('1h 02m');
    expect(formatDuration(200_000)).toBe('2d 7h');
  });
});

describe('killAvailability', () => {
  const engine = { readOnly: false, cancelQuery: true };

  it('offers both on a running session', () => {
    expect(killAvailability(report, engine)).toEqual({ cancelQuery: null, terminate: null });
  });

  it('cannot cancel what does not run, but can end the session', () => {
    expect(killAvailability(idle, engine)).toEqual({
      cancelQuery: 'activity.kill.disabled.notRunning',
      terminate: null,
    });
  });

  it('says why an engine without a query cancel only ends sessions', () => {
    expect(killAvailability(report, { ...engine, cancelQuery: false })).toEqual({
      cancelQuery: 'activity.kill.disabled.noCancel',
      terminate: null,
    });
  });

  it('refuses a read-only connection, the monitor itself and system sessions', () => {
    const readOnly = killAvailability(report, { ...engine, readOnly: true });
    expect(readOnly.terminate).toBe('activity.kill.disabled.readOnly');
    expect(readOnly.cancelQuery).toBe('activity.kill.disabled.readOnly');
    expect(killAvailability(session('5', { isSelf: true }), engine).terminate).toBe(
      'activity.kill.disabled.self',
    );
    expect(killAvailability(worker, engine).terminate).toBe('activity.kill.disabled.system');
  });
});
