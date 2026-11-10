import { beforeEach, describe, expect, it } from 'vitest';

import type { SessionInfo, YadbeError } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { startConnectionFeed, stateOf, useSessions } from './connectionStore';

const failure: YadbeError = {
  code: 'connectionRefused',
  message: { en: 'refused', fr: 'refusé' },
  action: 'retry',
  detail: null,
};

function session(patch: Partial<SessionInfo>): SessionInfo {
  return {
    connectionId: 'c1',
    state: 'connected',
    serverVersion: 'PostgreSQL 16.4',
    error: null,
    reconnectAttempt: null,
    ...patch,
  };
}

beforeEach(() => {
  useSessions.setState({ sessions: {}, errors: {} });
});

describe('stateOf', () => {
  it('reads a missing or closed session as disconnected and keeps the other states', () => {
    expect(stateOf(undefined)).toBe('disconnected');
    expect(stateOf(session({ state: 'closed' }))).toBe('disconnected');
    for (const state of ['connecting', 'connected', 'lost', 'reconnecting'] as const) {
      expect(stateOf(session({ state }))).toBe(state);
    }
  });
});

describe('session store', () => {
  it('tracks the open sessions and drops a closed one', () => {
    const { apply } = useSessions.getState();
    apply(session({ state: 'connecting' }));
    apply(session({ connectionId: 'c2' }));
    expect(Object.keys(useSessions.getState().sessions).sort()).toEqual(['c1', 'c2']);
    apply(session({ state: 'closed' }));
    expect(Object.keys(useSessions.getState().sessions)).toEqual(['c2']);
  });

  it('keeps why an attempt failed or a link dropped until the connection works again', () => {
    const { apply } = useSessions.getState();
    apply(session({ state: 'closed', error: failure }));
    expect(useSessions.getState().errors['c1']).toEqual(failure);
    apply(session({ state: 'connecting' }));
    expect(useSessions.getState().errors['c1']).toEqual(failure);
    apply(session({ state: 'connected' }));
    expect(useSessions.getState().errors['c1']).toBeUndefined();
  });

  it('forgets a connection that was deleted', () => {
    const { apply, forget } = useSessions.getState();
    apply(session({ state: 'lost', error: failure }));
    forget('c1');
    expect(useSessions.getState()).toMatchObject({ sessions: {}, errors: {} });
  });
});

describe('connection feed', () => {
  it('follows connection-state-changed events from the backend', async () => {
    mockBackend.reset();
    mockBackend.setLatency(0);
    await startConnectionFeed();
    await mockBackend.commands.connect('conn-local-pg', null);
    expect(stateOf(useSessions.getState().sessions['conn-local-pg'])).toBe('connected');
    await mockBackend.commands.disconnect('conn-local-pg');
    expect(stateOf(useSessions.getState().sessions['conn-local-pg'])).toBe('disconnected');
  });
});
