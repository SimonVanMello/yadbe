import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionStateChanged, SessionInfo } from './bindings';
import { mockBackend, mockClient } from './mockClient';
import { blankDefinition } from './mockData';
import { unwrap, YadbeIpcError } from './result';

const { commands } = mockClient;

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
});

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof YadbeIpcError ? error.error.code : 'unexpected';
  }
}

describe('mock client', () => {
  it('answers app_info like the real command', async () => {
    const info = await unwrap(commands.appInfo());
    expect(info).toEqual({ appVersion: '0.1.0', os: 'linux', arch: 'x86_64' });
  });

  it('delivers events to subscribers until they unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = mockClient.events.subscribe('appReady', handler);
    mockBackend.emit('appReady', { appVersion: '1.2.3' });
    expect(handler).toHaveBeenCalledWith({ appVersion: '1.2.3' });
    unsubscribe();
    mockBackend.emit('appReady', { appVersion: '1.2.4' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockBackend.events.listenerCount('appReady')).toBe(0);
  });
});

describe('mock connections', () => {
  it('seeds connections across engines, groups and environments', async () => {
    const connections = await unwrap(commands.listConnections());
    const groups = await unwrap(commands.listConnectionGroups());
    expect(new Set(connections.map((c) => c.definition.engine))).toEqual(
      new Set(['postgres', 'mssql', 'mysql', 'sqlite']),
    );
    expect(new Set(connections.map((c) => c.definition.environment.kind))).toContain('prod');
    expect(groups.some((g) => g.parentId !== null)).toBe(true);
  });

  it('creates, updates, duplicates and deletes connections', async () => {
    const created = await unwrap(
      commands.createConnection({
        ...blankDefinition('postgres', '  new  '),
        host: 'db.local',
      }),
    );
    expect(created.definition.name).toBe('new');
    const updated = await unwrap(
      commands.updateConnection(created.id, { ...created.definition, database: 'shop' }),
    );
    expect(updated.definition.database).toBe('shop');
    const copy = await unwrap(commands.duplicateConnection(created.id, 'new (copy)'));
    expect(copy.id).not.toBe(created.id);
    await unwrap(commands.deleteConnection(created.id));
    expect(await errorCode(unwrap(commands.deleteConnection(created.id)))).toBe(
      'connectionNotFound',
    );
    expect(await errorCode(unwrap(commands.createConnection(blankDefinition('postgres'))))).toBe(
      'invalidArgument',
    );
  });

  it('moves groups and refuses cycles', async () => {
    const child = await unwrap(commands.createConnectionGroup('Child', 'group-local'));
    expect(await errorCode(unwrap(commands.moveConnectionGroup('group-local', child.id, 0)))).toBe(
      'invalidArgument',
    );
    await unwrap(commands.deleteConnectionGroup('group-local'));
    const groups = await unwrap(commands.listConnectionGroups());
    expect(groups.find((g) => g.id === child.id)?.parentId).toBeNull();
    const connections = await unwrap(commands.listConnections());
    expect(connections.find((c) => c.id === 'conn-local-pg')?.definition.groupId).toBeNull();
  });
});

describe('mock sessions', () => {
  it('connects with the remembered password and emits state changes', async () => {
    const states: SessionInfo['state'][] = [];
    mockClient.events.subscribe('connectionStateChanged', (e: ConnectionStateChanged) => {
      states.push(e.session.state);
    });
    const logged = vi.fn();
    mockClient.events.subscribe('statementLogged', logged);
    const info = await unwrap(commands.connect('conn-local-pg', null));
    expect(info).toMatchObject({ state: 'connected', serverVersion: 'PostgreSQL 16.4' });
    expect(states).toEqual(['connecting', 'connected']);
    expect(logged).toHaveBeenCalled();
    expect(await unwrap(commands.listSessions())).toHaveLength(1);
    await unwrap(commands.disconnect('conn-local-pg'));
    expect(states.at(-1)).toBe('closed');
    expect(await unwrap(commands.listSessions())).toHaveLength(0);
  });

  it('simulates the catalog failures', async () => {
    expect(await errorCode(unwrap(commands.connect('conn-fail-auth', null)))).toBe(
      'passwordRequired',
    );
    expect(
      await errorCode(unwrap(commands.connect('conn-fail-auth', { kind: 'value', value: 'x' }))),
    ).toBe('authFailed');
    expect(await errorCode(unwrap(commands.connect('conn-wordpress', null)))).toBe(
      'engineNotSupported',
    );
    const test = (host: string) =>
      errorCode(
        unwrap(
          commands.testConnection(
            'r1',
            { ...blankDefinition('postgres', 't'), host, tlsMode: 'require' },
            { kind: 'value', value: 'pw' },
            null,
            null,
          ),
        ),
      );
    expect(await test('fail-dns')).toBe('hostNotFound');
    expect(await test('fail-refused')).toBe('connectionRefused');
    expect(await test('fail-timeout')).toBe('connectionTimeout');
    expect(await test('fail-tls')).toBe('tlsFailed');
    expect(await test('localhost')).toBeNull();
  });

  it('cancels a running test', async () => {
    mockBackend.setLatency(1000);
    const running = unwrap(
      commands.testConnection(
        'r2',
        { ...blankDefinition('sqlite', 'f'), filePath: '/tmp/a.db' },
        null,
        null,
        null,
      ),
    );
    await unwrap(commands.cancelTestConnection('r2'));
    expect(await errorCode(running)).toBe('cancelled');
  });

  it('reconnects after a dropped link', async () => {
    await unwrap(commands.connect('conn-local-pg', null));
    const states: SessionInfo['state'][] = [];
    mockClient.events.subscribe('connectionStateChanged', (e) => {
      states.push(e.session.state);
    });
    await mockBackend.dropConnection('conn-local-pg');
    expect(states).toEqual(['lost', 'reconnecting', 'connected']);
  });
});

describe('mock secrets', () => {
  it('never returns a secret value and falls back to the session without keychain', async () => {
    const location = await unwrap(
      commands.setConnectionSecret(
        'conn-app-sqlite',
        'password',
        { kind: 'value', value: 'pw' },
        true,
      ),
    );
    expect(location).toBe('keychain');
    expect(await unwrap(commands.hasConnectionSecret('conn-app-sqlite', 'password'))).toBe(
      'keychain',
    );
    mockBackend.setKeychainAvailable(false);
    expect((await unwrap(commands.keychainStatus())).available).toBe(false);
    expect(
      await unwrap(
        commands.setConnectionSecret(
          'conn-app-sqlite',
          'password',
          { kind: 'value', value: 'pw' },
          true,
        ),
      ),
    ).toBe('session');
  });

  it('keeps the password of a parsed connection string behind an id', async () => {
    const parsed = await unwrap(
      commands.parseConnectionString('postgres://app:s3cret@db.example.com:6543/shop', null),
    );
    expect(parsed).toMatchObject({
      format: 'url',
      engine: 'postgres',
      host: 'db.example.com',
      port: 6543,
      database: 'shop',
      username: 'app',
    });
    expect(JSON.stringify(parsed)).not.toContain('s3cret');
    expect(parsed.passwordId).not.toBeNull();
    const id = parsed.passwordId ?? '';
    await unwrap(
      commands.setConnectionSecret('conn-app-sqlite', 'password', { kind: 'pending', id }, false),
    );
    expect(
      await errorCode(
        unwrap(
          commands.setConnectionSecret(
            'conn-app-sqlite',
            'password',
            { kind: 'pending', id },
            false,
          ),
        ),
      ),
    ).toBe('pendingSecretExpired');
    const ado = await unwrap(
      commands.parseConnectionString(
        'Server=tcp:sql.example.com,1433;Database=Reporting;User Id=sa;Password=x',
        null,
      ),
    );
    expect(ado).toMatchObject({ format: 'adoNet', engine: 'mssql', port: 1433 });
  });
});

describe('mock store', () => {
  it('round-trips preferences and tabs', async () => {
    const prefs = await unwrap(commands.getPreferences());
    await unwrap(commands.setPreferences({ ...prefs, theme: 'dark' }));
    expect((await unwrap(commands.getPreferences())).theme).toBe('dark');
    await unwrap(
      commands.saveTabs({
        tabs: [
          {
            id: 't1',
            kind: 'query',
            title: 'Query 1',
            connectionId: 'gone',
            database: null,
            content: 'select 1',
            cursor: null,
            pinned: false,
            filePath: null,
            table: null,
            uiState: null,
          },
        ],
        activeTabId: 't1',
      }),
    );
    const tabs = await unwrap(commands.loadTabs());
    expect(tabs.tabs[0]?.connectionId).toBeNull();
  });
});

describe('unwrap', () => {
  it('throws the typed backend error', async () => {
    const error = {
      code: 'internal' as const,
      message: { en: 'Boom', fr: 'Boum' },
      action: null,
      detail: null,
    };
    await expect(unwrap(Promise.resolve({ status: 'error' as const, error }))).rejects.toThrow(
      YadbeIpcError,
    );
  });
});
