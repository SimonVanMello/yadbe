import { describe, expect, it } from 'vitest';

import { unwrap } from '../result';
import { mockClient, mockBackend } from '../mockClient';
import { displayCommand, globToRegExp, splitArgs, UnbalancedQuotes } from './redisCli';

describe('the mock redis-cli tokenizer', () => {
  it('splits like redis-cli', () => {
    expect(splitArgs('  HGETALL   user:42 ')).toEqual(['HGETALL', 'user:42']);
    expect(splitArgs('SET k "a b\\n\\"c\\""')).toEqual(['SET', 'k', 'a b\n"c"']);
    expect(splitArgs("SET k 'it\\'s'")).toEqual(['SET', 'k', "it's"]);
    expect(splitArgs('SET "\\xff" v')[1]).toBe('ÿ');
    expect(() => splitArgs('SET "open')).toThrow(UnbalancedQuotes);
  });

  it('redacts secrets in the command it shows', () => {
    expect(displayCommand(['AUTH', 'bob', 's3cret'])).toBe('AUTH bob ***');
    expect(displayCommand(['CONFIG', 'SET', 'requirepass', 'x'])).toBe(
      'CONFIG SET requirepass ***',
    );
    expect(displayCommand(['SET', 'a b', ''])).toBe('SET "a b" ""');
  });

  it('matches glob patterns', () => {
    expect(globToRegExp('user:*').test('user:1')).toBe(true);
    expect(globToRegExp('user:?').test('user:12')).toBe(false);
    expect(globToRegExp('h[ae]llo').test('hello')).toBe(true);
  });
});

describe('the mock key-value server', () => {
  const { commands } = mockClient;

  it('lists, scans, reads and runs commands on the Redis connection', async () => {
    mockBackend.reset();
    mockBackend.setLatency(0);
    await unwrap(commands.connect('conn-cache', null));
    const databases = await unwrap(commands.kvListDatabases('conn-cache'));
    expect(databases.find((db) => db.current)?.index).toBe(0);

    const status = await unwrap(commands.kvScanKeys('conn-cache', 0, null));
    expect(status.state).toBe('done');
    const root = await unwrap(
      commands.kvScanLevel('conn-cache', 0, { text: '', base64: null }, ':', 0, 100),
    );
    expect(root.entries.some((e) => e.type === 'namespace' && e.name.text === 'user')).toBe(true);

    const info = await unwrap(
      commands.kvKeyInfo('conn-cache', 0, { text: 'user:1:profile', base64: null }),
    );
    expect(info.kind).toBe('hash');
    expect(info.length).toBe(5);

    const outcome = await unwrap(
      commands.kvConsoleRun('tab', 'conn-cache', 'PING\nFLUSHDB', false),
    );
    expect(outcome.kind).toBe('needsConfirmation');
    const ran = await unwrap(commands.kvConsoleRun('tab', 'conn-cache', 'PING\nSET k v', false));
    expect(ran.kind === 'ran' && ran.entries.map((e) => e.error)).toEqual([null, null]);
  });

  it('refuses writes on a read-only connection', async () => {
    mockBackend.reset();
    mockBackend.setLatency(0);
    await unwrap(commands.connect('conn-sessions-prod', null));
    const ran = await unwrap(
      commands.kvConsoleRun('tab', 'conn-sessions-prod', 'GET k\nSET k v\nPING', false),
    );
    expect(ran.kind).toBe('ran');
    if (ran.kind !== 'ran') return;
    expect(ran.entries[1]?.error?.code).toBe('readOnlyViolation');
    expect(ran.skipped).toBe(1);
  });
});
