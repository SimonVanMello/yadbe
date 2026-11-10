import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend } from '../../ipc/mockClient';
import type { StatementLogEntry } from '../../ipc';
import {
  LOG_ENTRIES_KEPT,
  clearStatementLog,
  failedCount,
  startStatementLogFeed,
  useStatementLog,
  visibleEntries,
} from './statementLogStore';

function entry(id: number, failed = false): StatementLogEntry {
  return {
    id,
    connectionId: 'c1',
    connectionName: 'pg-eu',
    sql: `select ${String(id)}`,
    startedAt: 1_762_000_000_000,
    durationMs: 3,
    outcome: failed
      ? {
          kind: 'error',
          error: {
            code: 'queryFailed',
            message: { en: 'boom', fr: 'boum' },
            action: null,
            detail: null,
          },
        }
      : { kind: 'ok', rows: 1 },
  };
}

beforeEach(() => {
  mockBackend.reset();
  useStatementLog.setState({ entries: [], filter: 'all', selectedId: null });
});

describe('statement log store', () => {
  it('ignores a statement it already has (initial list and event overlap)', () => {
    const { add } = useStatementLog.getState();
    add(entry(1));
    add(entry(1));
    expect(useStatementLog.getState().entries).toHaveLength(1);
  });

  it('keeps only the most recent entries', () => {
    const { add } = useStatementLog.getState();
    for (let id = 1; id <= LOG_ENTRIES_KEPT + 5; id += 1) add(entry(id));
    const { entries } = useStatementLog.getState();
    expect(entries).toHaveLength(LOG_ENTRIES_KEPT);
    expect(entries[0]?.id).toBe(6);
  });

  it('shows newest first and can keep the failures only', () => {
    const entries = [entry(1), entry(2, true), entry(3)];
    expect(visibleEntries(entries, 'all').map((e) => e.id)).toEqual([3, 2, 1]);
    expect(visibleEntries(entries, 'errors').map((e) => e.id)).toEqual([2]);
    expect(failedCount(entries)).toBe(1);
  });

  it('follows the statement-logged event and clears backend and view together', async () => {
    await startStatementLogFeed();
    mockBackend.emit('statementLogged', { entry: entry(7) });
    expect(useStatementLog.getState().entries.map((e) => e.id)).toEqual([7]);
    useStatementLog.getState().select(7);
    await clearStatementLog();
    expect(useStatementLog.getState()).toMatchObject({ entries: [], selectedId: null });
    expect(await mockBackend.commands.getStatementLog()).toEqual({ status: 'ok', data: [] });
  });
});
