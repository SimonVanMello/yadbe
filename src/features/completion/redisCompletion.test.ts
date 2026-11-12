import { describe, expect, it } from 'vitest';

import { isKeyArgument, redisContext, redisOptions, type RedisData } from './redisCompletion';

const data: RedisData = {
  commands: [
    { name: 'get', arity: 2 },
    { name: 'getdel', arity: 2 },
    { name: 'set', arity: -3 },
    { name: 'del', arity: -2 },
    { name: 'ping', arity: -1 },
  ],
  keys: ['user:1', 'user:2', 'a key'],
};

function context(source: string) {
  const position = source.indexOf('|');
  return redisContext(source.replace('|', ''), position);
}

describe('redis console context', () => {
  it('reads the command being typed, on any line', () => {
    expect(context('ge|')).toEqual({ kind: 'command', from: 0, prefix: 'ge' });
    expect(context('SET a 1\n  ping|')).toEqual({ kind: 'command', from: 10, prefix: 'ping' });
    expect(context('|')).toEqual({ kind: 'command', from: 0, prefix: '' });
  });

  it('reads the key being typed where the command takes one', () => {
    expect(context('GET us|')).toEqual({ kind: 'key', from: 4, prefix: 'us', command: 'get' });
    expect(context('SET |')).toMatchObject({ kind: 'key', prefix: '' });
    expect(context('DEL a b us|')).toMatchObject({ kind: 'key', prefix: 'us' });
    expect(context('OBJECT ENCODING us|')).toMatchObject({ kind: 'key' });
    expect(context('RENAME a b|')).toMatchObject({ kind: 'key' });
  });

  it('suggests nothing for a value, a quote left open, a comment or a non-key argument', () => {
    expect(context('SET a v|')).toEqual({ kind: 'none' });
    expect(context('GET "us|')).toEqual({ kind: 'none' });
    expect(context('# GET us|')).toEqual({ kind: 'none' });
    expect(context('SELECT 1|')).toEqual({ kind: 'none' });
    expect(context('OBJECT en|')).toEqual({ kind: 'none' });
  });

  it('knows which arguments are keys', () => {
    expect(isKeyArgument('hget', 1)).toBe(true);
    expect(isKeyArgument('hget', 2)).toBe(false);
    expect(isKeyArgument('config', 1)).toBe(false);
    expect(isKeyArgument('copy', 2)).toBe(true);
  });
});

describe('redis console suggestions', () => {
  it('lists the commands with their number of arguments', () => {
    const found = redisOptions({ kind: 'command', from: 0, prefix: 'ge' }, data, 2);
    expect(found?.options.map((o) => [o.label, o.detail])).toEqual([
      ['GET', '1'],
      ['GETDEL', '1'],
    ]);
    expect(redisOptions({ kind: 'command', from: 0, prefix: '' }, data, 0)?.options).toHaveLength(
      5,
    );
    const set = redisOptions({ kind: 'command', from: 0, prefix: 'se' }, data, 2);
    expect(set?.options[0]).toMatchObject({ label: 'SET', detail: '2+' });
    expect(redisOptions({ kind: 'command', from: 0, prefix: 'zz' }, data, 2)).toBeNull();
  });

  it('lists the scanned keys, quoted when they need it', () => {
    const found = redisOptions({ kind: 'key', from: 4, prefix: 'u', command: 'get' }, data, 5);
    expect(found?.options.map((o) => [o.label, o.apply])).toEqual([
      ['user:1', 'user:1'],
      ['user:2', 'user:2'],
      ['a key', '"a key"'],
    ]);
    expect(
      redisOptions({ kind: 'key', from: 0, prefix: 'x', command: 'get' }, { ...data, keys: [] }, 1),
    ).toBeNull();
  });
});
