import { describe, expect, it } from 'vitest';

import type { ConnectionDefinition, FoundConnection } from '../../ipc';
import {
  defaultSelection,
  describeTarget,
  folderLabel,
  passwordsAvailable,
  selectedKeys,
} from './connectionImportModel';

function definition(extra: Partial<ConnectionDefinition>): ConnectionDefinition {
  return {
    name: 'x',
    engine: 'postgres',
    host: 'db.example.com',
    port: null,
    database: '',
    username: '',
    filePath: '',
    auth: 'password',
    tlsMode: 'prefer',
    caCertPath: null,
    connectTimeoutSecs: null,
    options: [],
    groupId: null,
    environment: { kind: 'none', label: null, color: null },
    favorite: false,
    readOnly: false,
    rememberPassword: false,
    historyEnabled: true,
    ssh: null,
    ...extra,
  };
}

function found(key: string, extra: Partial<FoundConnection> = {}): FoundConnection {
  return {
    key,
    definition: definition({}),
    groupPath: [],
    hasPassword: false,
    conflict: null,
    notes: [],
    ...extra,
  };
}

describe('connection import model', () => {
  it('describes where a connection goes', () => {
    expect(describeTarget(found('a'))).toBe('db.example.com');
    expect(
      describeTarget(
        found('a', {
          definition: definition({ port: 5433, database: 'shop', username: 'app' }),
        }),
      ),
    ).toBe('db.example.com:5433 / shop · app');
    expect(
      describeTarget(
        found('a', { definition: definition({ engine: 'sqlite', filePath: '/data/app.sqlite' }) }),
      ),
    ).toBe('/data/app.sqlite');
  });

  it('ticks what does not exist yet and lists keys in file order', () => {
    const list = [
      found('1'),
      found('2', { conflict: { existingId: 'c', existingName: 'n', kind: 'sameTarget' } }),
      found('3'),
    ];
    const selected = defaultSelection(list);
    expect([...selected]).toEqual(['1', '3']);
    expect(selectedKeys(list, new Set(['3', '2']))).toEqual(['2', '3']);
  });

  it('offers passwords only when a ticked connection has one', () => {
    const list = [found('1', { hasPassword: true }), found('2')];
    expect(passwordsAvailable(list, new Set(['1']))).toBe(true);
    expect(passwordsAvailable(list, new Set(['2']))).toBe(false);
    expect(folderLabel(['Prod', 'EU'])).toBe('Prod / EU');
  });
});
