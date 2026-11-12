import { describe, expect, it } from 'vitest';

import type { KvBytes, KvDatabase, KvLevel, KvScanStatus } from '../../ipc';
import type { Loadable } from '../explorer/explorerRows';
import { kvExplorerRows, kvNodeKeys, kvRowName, type KvSource } from './kvExplorerRows';

const ready = <T>(data: T): Loadable<T> => ({ state: 'ready', data });
const text = (value: string): KvBytes => ({ text: value, base64: null });

const DATABASES: KvDatabase[] = [
  { index: 0, keys: 5, expires: 1, current: true },
  { index: 3, keys: 60_000, expires: 0, current: false },
];

function scan(database: number, state: KvScanStatus['state'], loaded: number): KvScanStatus {
  return {
    scanId: 1,
    database,
    pattern: null,
    loaded,
    estimate: 60_000,
    state,
    error: null,
    version: 1,
  };
}

const LEVELS: Record<string, KvLevel> = {
  '0:': {
    entries: [
      { type: 'namespace', name: text('user'), prefix: text('user:'), keys: 3 },
      { type: 'key', name: text('counter'), key: text('counter') },
    ],
    total: 2,
    version: 1,
  },
  '0:user:': {
    entries: [{ type: 'key', name: text('1'), key: text('user:1') }],
    total: 3,
    version: 1,
  },
  '3:': {
    entries: [{ type: 'namespace', name: text('metrics'), prefix: text('metrics:'), keys: 10_000 }],
    total: 1,
    version: 1,
  },
};

const source: KvSource = {
  databases: () => ready(DATABASES),
  scan: (database) => ready(database === 3 ? scan(3, 'paused', 10_000) : scan(0, 'done', 5)),
  level: (database, prefix) => {
    const level = LEVELS[`${String(database)}:${prefix.text}`];
    return level ? ready(level) : { state: 'loading' };
  },
};

function rows(expanded: string[], filter = '') {
  return kvExplorerRows({
    connectionId: 'c',
    level: 2,
    expanded: new Set(expanded),
    source,
    delimiter: ':',
    patternOf: () => null,
    typedPatternOf: () => '',
    limitOf: () => 500,
    fetching: true,
    filter,
  });
}

const describeRow = (row: ReturnType<typeof rows>[number]) =>
  `${'  '.repeat(row.level - 2)}${row.type}:${kvRowName(row)}`;

describe('the key-value tree', () => {
  it('lists the databases, closed', () => {
    expect(rows([]).map(describeRow)).toEqual(['kvDatabase:db0', 'kvDatabase:db3']);
  });

  it('shows an open database: its pattern row, its level, then its namespaces open on demand', () => {
    const user = kvNodeKeys.namespace(0, text('user:'));
    expect(rows([kvNodeKeys.database(0), user]).map(describeRow)).toEqual([
      'kvDatabase:db0',
      '  kvPattern:',
      '  kvNamespace:user',
      '    kvKey:1',
      '    kvMore:',
      '  kvKey:counter',
      'kvDatabase:db3',
    ]);
  });

  it('shows where a paused scan stands', () => {
    const shown = rows([kvNodeKeys.database(3)]);
    expect(shown.map(describeRow)).toEqual([
      'kvDatabase:db0',
      'kvDatabase:db3',
      '  kvPattern:',
      '  kvNamespace:metrics',
      '  kvScan:',
    ]);
    const state = shown.at(-1);
    expect(state?.type === 'kvScan' && state.status.loaded).toBe(10_000);
  });

  it('keeps the loaded rows that match the search, with their ancestors', () => {
    const user = kvNodeKeys.namespace(0, text('user:'));
    expect(rows([kvNodeKeys.database(0), user], 'countr').map(describeRow)).toEqual([
      'kvDatabase:db0',
      '  kvKey:counter',
    ]);
  });
});
