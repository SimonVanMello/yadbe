import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CompletionCatalog, MetaNode } from '../../ipc';
import { catalogKeys, invalidateCatalogs } from './catalogCache';

const catalog = (database: string): CompletionCatalog => ({
  database,
  schemas: [],
  searchPath: [],
  typeNames: [],
  relations: [],
  routines: [],
  foreignKeys: [],
});

let client: QueryClient;
const stale = (connectionId: string, database: string) =>
  client.getQueryState(catalogKeys.database(connectionId, database))?.isInvalidated;

beforeEach(() => {
  client = new QueryClient();
  for (const [connectionId, database] of [
    ['a', 'shop'],
    ['a', 'crm'],
    ['b', 'shop'],
  ] as const) {
    client.setQueryData(catalogKeys.database(connectionId, database), catalog(database));
  }
});

describe('invalidateCatalogs', () => {
  it.each<[string, MetaNode]>([
    ['a database', { level: 'database', database: 'shop' }],
    ['a schema', { level: 'schema', database: 'shop', schema: 'public' }],
    ['a kind of objects', { level: 'objects', database: 'shop', schema: 'public', kind: 'table' }],
    ['a table', { level: 'table', table: { database: 'shop', schema: 'public', name: 'orders' } }],
  ])('makes the catalog of its database stale when %s is refreshed', async (_, node) => {
    await invalidateCatalogs(client, 'a', node);
    expect(stale('a', 'shop')).toBe(true);
    // Another database, another connection: untouched.
    expect(stale('a', 'crm')).toBe(false);
    expect(stale('b', 'shop')).toBe(false);
  });

  it('makes every catalog of a connection stale when the connection is refreshed', async () => {
    await invalidateCatalogs(client, 'a', { level: 'connection' });
    expect(stale('a', 'shop')).toBe(true);
    expect(stale('a', 'crm')).toBe(true);
    expect(stale('b', 'shop')).toBe(false);
  });
});
