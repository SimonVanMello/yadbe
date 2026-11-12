import { beforeEach, describe, expect, it } from 'vitest';

import type { ActivitySession } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError, type IpcResult } from '../result';
import { killStatement } from './activity';

const { commands } = mockClient;
const PG = 'conn-local-pg';
const MSSQL = 'conn-reporting';
const MYSQL = 'conn-wordpress';
const SQLITE = 'conn-app-sqlite';
const PROD = 'conn-shop-prod';

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  for (const id of [PG, MSSQL, MYSQL, SQLITE, PROD]) {
    await unwrap(commands.connect(id, { kind: 'value', value: 'pw' }));
  }
});

async function failure(promise: Promise<IpcResult<unknown>>): Promise<string | null> {
  try {
    await unwrap(promise);
    return null;
  } catch (error) {
    return error instanceof YadbeIpcError ? error.error.code : 'unexpected';
  }
}

const sessionOf = (sessions: ActivitySession[], id: string) => sessions.find((s) => s.id === id);

describe('mock activity monitor', () => {
  it('lists the sessions with a blocker, the session it blocks and its own session', async () => {
    const { sessions, locks, notes } = await unwrap(commands.getActivity(null, PG));
    expect(sessionOf(sessions, '4821')).toMatchObject({ state: 'idleInTransaction' });
    expect(sessionOf(sessions, '4902')).toMatchObject({ state: 'active', blockedBy: ['4821'] });
    expect(sessions.filter((s) => s.isSelf)).toHaveLength(1);
    expect(sessions.some((s) => s.system)).toBe(true);
    expect(locks.some((l) => l.sessionId === '4902' && !l.granted)).toBe(true);
    expect(notes).toEqual([]);
  });

  it('says what a user who may not read other sessions sees', async () => {
    const { sessions, notes } = await unwrap(commands.getActivity(null, PROD));
    expect(notes).toEqual(['statementsHidden']);
    expect(sessionOf(sessions, '4950')?.statement).toBeNull();
    expect(sessions.find((s) => s.isSelf)?.statement).not.toBeNull();
  });

  it('says locks are unavailable on MySQL, and has none for SQLite', async () => {
    const mysql = await unwrap(commands.getActivity(null, MYSQL));
    expect(mysql.notes).toContain('locksUnavailable');
    expect(mysql.locks).toEqual([]);
    expect(await failure(commands.getActivity(null, SQLITE))).toBe('notSupported');
  });

  it('shows an explained error when the user may not see other sessions', async () => {
    mockBackend.setActivityFault(MSSQL, 'insufficientPrivilege');
    try {
      await unwrap(commands.getActivity(null, MSSQL));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(YadbeIpcError);
      if (error instanceof YadbeIpcError) {
        expect(error.error.code).toBe('insufficientPrivilege');
        expect(error.error.message.en).toContain('VIEW SERVER STATE');
      }
    }
    mockBackend.setActivityFault(MSSQL, null);
    await unwrap(commands.getActivity(null, MSSQL));
  });

  it('ends a blocker: the blocked session is released and the locks go with it', async () => {
    const before = await unwrap(commands.getActivity(null, PG));
    const blocker = sessionOf(before.sessions, '4821');
    expect(blocker).toBeDefined();
    const outcome = await unwrap(
      commands.killSession(PG, {
        sessionId: '4821',
        fingerprint: blocker?.fingerprint ?? '',
        mode: 'terminateSession',
      }),
    );
    expect(outcome.statement).toBe('SELECT pg_terminate_backend(4821)');
    const after = await unwrap(commands.getActivity(null, PG));
    expect(sessionOf(after.sessions, '4821')).toBeUndefined();
    expect(sessionOf(after.sessions, '4902')?.blockedBy).toEqual([]);
    expect(after.locks.some((l) => l.sessionId === '4821')).toBe(false);
  });

  it('cancels a query and keeps the session', async () => {
    const before = await unwrap(commands.getActivity(null, PG));
    const report = sessionOf(before.sessions, '4950');
    await unwrap(
      commands.killSession(PG, {
        sessionId: '4950',
        fingerprint: report?.fingerprint ?? '',
        mode: 'cancelQuery',
      }),
    );
    const after = await unwrap(commands.getActivity(null, PG));
    expect(sessionOf(after.sessions, '4950')).toMatchObject({ state: 'idle' });
  });

  it('refuses what the backend refuses', async () => {
    const kill = (
      connection: string,
      id: string,
      fingerprint: string,
      mode: 'cancelQuery' | 'terminateSession',
    ) => commands.killSession(connection, { sessionId: id, fingerprint, mode });
    expect(await failure(kill(PROD, '4950', 'fp-4950', 'terminateSession'))).toBe(
      'readOnlyViolation',
    );
    expect(await failure(kill(PG, '4950', 'another', 'terminateSession'))).toBe('sessionChanged');
    expect(await failure(kill(PG, '5200', 'fp-5200', 'terminateSession'))).toBe('invalidArgument');
    expect(await failure(kill(MSSQL, '4950', 'fp-4950', 'cancelQuery'))).toBe('notSupported');
    expect(await failure(kill(SQLITE, '1', 'x', 'terminateSession'))).toBe('notSupported');
    // Nothing of that touched the session.
    const { sessions } = await unwrap(commands.getActivity(null, PG));
    expect(sessionOf(sessions, '4950')).toBeDefined();
  });

  it('records the kill in the statement log', async () => {
    const { sessions } = await unwrap(commands.getActivity(null, PG));
    await unwrap(
      commands.killSession(PG, {
        sessionId: '4950',
        fingerprint: sessionOf(sessions, '4950')?.fingerprint ?? '',
        mode: 'terminateSession',
      }),
    );
    const log = await unwrap(commands.getStatementLog());
    expect(log.some((entry) => entry.sql === 'SELECT pg_terminate_backend(4950)')).toBe(true);
  });

  it('writes the statement each engine sends', () => {
    expect(killStatement('postgres', 'cancelQuery', '7')).toBe('SELECT pg_cancel_backend(7)');
    expect(killStatement('mssql', 'terminateSession', '7')).toBe('KILL 7');
    expect(killStatement('mysql', 'cancelQuery', '7')).toBe('KILL QUERY 7');
    expect(killStatement('mysql', 'terminateSession', '7')).toBe('KILL 7');
  });
});
