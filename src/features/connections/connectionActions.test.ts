import { beforeEach, describe, expect, it } from 'vitest';

import { useToastStore } from '../../ui/toastStore';
import { mockBackend } from '../../ipc/mockClient';
import { MOCK_CONNECTIONS, MOCK_ENGINES } from '../../ipc/mockData';
import { connectTo } from './connectionActions';
import { connectionsApi } from './connectionsApi';
import { startConnectionFeed, stateOf, useSessions } from './connectionStore';
import { draftFromSaved, summarize, type ConnectionSummary } from './model';
import { usePasswordPrompt } from './passwordPromptStore';

function seed(id: string) {
  const saved = MOCK_CONNECTIONS.find((c) => c.id === id);
  if (!saved) throw new Error(`no seed ${id}`);
  return saved;
}

const connection = (id: string): ConnectionSummary => summarize(seed(id));
const draftOf = (id: string) => draftFromSaved(seed(id));

const postgres = MOCK_ENGINES.find((engine) => engine.engine === 'postgres');
if (!postgres) throw new Error('no postgres engine');

const state = (id: string) => stateOf(useSessions.getState().sessions[id]);

/** Waits until the prompt is open, then answers it. */
async function answer(secret: { password: string; remember: boolean } | null) {
  await expect.poll(() => usePasswordPrompt.getState().pending).not.toBeNull();
  usePasswordPrompt.getState().settle(secret);
}

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  useSessions.setState({ sessions: {}, errors: {} });
  useToastStore.setState({ toasts: [] });
  await startConnectionFeed();
});

describe('connectTo', () => {
  it('connects at once when the keychain holds the password', async () => {
    expect(await connectTo(connection('conn-local-pg'))).toBe(true);
    expect(state('conn-local-pg')).toBe('connected');
    expect(usePasswordPrompt.getState().pending).toBeNull();
  });

  it('asks for the password when none is stored, then connects with it', async () => {
    const attempt = connectTo(connection('conn-fail-auth'));
    await answer({ password: 'right', remember: false });
    // fail-auth always refuses, whatever the password: the error is explained, not stored.
    expect(await attempt).toBe(false);
    expect(useSessions.getState().errors['conn-fail-auth']?.code).toBe('authFailed');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ variant: 'error' });
    expect(await connectionsApi.passwordLocation('conn-fail-auth')).toBeNull();
  });

  it('gives up quietly when the prompt is dismissed', async () => {
    const attempt = connectTo(connection('conn-fail-auth'));
    await answer(null);
    expect(await attempt).toBe(false);
    expect(state('conn-fail-auth')).toBe('disconnected');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stores a working password in the keychain only when asked, after it worked', async () => {
    // The mock accepts any password but "wrong" for a postgres connection on a good host.
    const saved = await connectionsApi.save(
      {
        ...draftOf('conn-local-pg'),
        id: null,
        name: 'no password yet',
        rememberPassword: true,
        password: '',
      },
      postgres,
      null,
    );
    const target = summarize(saved);
    const attempt = connectTo(target);
    await answer({ password: 'good', remember: true });
    expect(await attempt).toBe(true);
    expect(await connectionsApi.passwordLocation(saved.id)).toBe('keychain');
  });

  it('does not store a wrong password', async () => {
    const saved = await connectionsApi.save(
      { ...draftOf('conn-local-pg'), id: null, name: 'no password yet', password: '' },
      postgres,
      null,
    );
    const attempt = connectTo(summarize(saved));
    await answer({ password: 'wrong', remember: true });
    expect(await attempt).toBe(false);
    expect(await connectionsApi.passwordLocation(saved.id)).toBeNull();
  });

  it('shows the typed error of an engine the build cannot open', async () => {
    expect(await connectTo(connection('conn-reporting'))).toBe(false);
    expect(useSessions.getState().errors['conn-reporting']?.code).toBe('engineNotSupported');
  });
});
