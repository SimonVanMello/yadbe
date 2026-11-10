import { beforeEach, describe, expect, it } from 'vitest';

import type { EngineInfo } from '../../ipc';
import { MOCK_ENGINES } from '../../ipc/mockData';
import { mockBackend } from '../../ipc/mockClient';
import { connectionsApi } from './connectionsApi';
import { draftFromSaved, emptyDraft, type ConnectionDraft } from './model';

const first = MOCK_ENGINES[0];
if (!first) throw new Error('mock engines changed');
const postgres: EngineInfo = first;

function draft(patch: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return { ...emptyDraft(postgres), host: 'db.example.com', ...patch };
}

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
});

describe('connectionsApi.save', () => {
  it('creates the connection and puts a typed password in the keychain when asked', async () => {
    const saved = await connectionsApi.save(
      draft({ password: 'pw', rememberPassword: true }),
      postgres,
      null,
    );
    expect(saved.definition).toMatchObject({ name: 'db.example.com', host: 'db.example.com' });
    expect(await connectionsApi.passwordLocation(saved.id)).toBe('keychain');
  });

  it('keeps the password for the session only when "remember" is off', async () => {
    const saved = await connectionsApi.save(
      draft({ password: 'pw', rememberPassword: false }),
      postgres,
      null,
    );
    expect(await connectionsApi.passwordLocation(saved.id)).toBe('session');
  });

  it('uses the password held from a pasted connection string, once', async () => {
    const parsed = await connectionsApi.parseConnectionString(
      'postgres://ana:pw@db.example.com/shop',
      null,
    );
    expect(parsed.passwordId).not.toBeNull();
    const saved = await connectionsApi.save(
      draft({ pendingPasswordId: parsed.passwordId }),
      postgres,
      null,
    );
    expect(await connectionsApi.passwordLocation(saved.id)).toBe('keychain');
    // The held password is consumed: the same id cannot be used again.
    await expect(
      connectionsApi.save(draft({ pendingPasswordId: parsed.passwordId }), postgres, null),
    ).rejects.toMatchObject({ error: { code: 'pendingSecretExpired' } });
  });

  it('updates in place, leaves the stored password alone when none is typed', async () => {
    const { connections } = await connectionsApi.list();
    const prod = connections.find((c) => c.id === 'conn-shop-prod');
    if (!prod) throw new Error('missing seed');
    const edited = draftFromSaved(prod);
    const saved = await connectionsApi.save({ ...edited, name: 'renamed' }, postgres, 'keychain');
    expect(saved.id).toBe(prod.id);
    expect(saved.definition.name).toBe('renamed');
    expect(await connectionsApi.passwordLocation(prod.id)).toBe('keychain');
  });

  it('forgets the keychain password when "remember" is turned off without a new one', async () => {
    const { connections } = await connectionsApi.list();
    const prod = connections.find((c) => c.id === 'conn-shop-prod');
    if (!prod) throw new Error('missing seed');
    const edited = { ...draftFromSaved(prod), rememberPassword: false };
    await connectionsApi.save(edited, postgres, 'keychain');
    expect(await connectionsApi.passwordLocation(prod.id)).toBeNull();
  });
});

describe('connectionsApi.test', () => {
  it('tests an unsaved form with the typed password and reports a typed failure', async () => {
    const ok = await connectionsApi.test('t1', draft({ password: 'pw' }), postgres);
    expect(ok.serverVersion).toBe('PostgreSQL 16.4');
    await expect(
      connectionsApi.test('t2', draft({ host: 'fail-refused', password: 'pw' }), postgres),
    ).rejects.toMatchObject({ error: { code: 'connectionRefused', action: 'editConnection' } });
  });

  it('can be cancelled by its request id', async () => {
    mockBackend.setLatency(50);
    const running = connectionsApi.test('t3', draft({ password: 'pw' }), postgres);
    await connectionsApi.cancelTest('t3');
    await expect(running).rejects.toMatchObject({ error: { code: 'cancelled' } });
  });
});
