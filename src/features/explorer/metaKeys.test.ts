import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MetaNode, ObjectRef } from '../../ipc';
import { invalidationFilters, metaKeys } from './metaKeys';

const ORDERS: ObjectRef = { database: 'app', schema: 'shop', name: 'orders' };
const CUSTOMERS: ObjectRef = { database: 'app', schema: 'shop', name: 'customers' };

let client: QueryClient;

/** Name of each cached query, to compare what a refresh makes stale. */
const keys = {
  databases: metaKeys.databases('c1'),
  schemas: metaKeys.schemas('c1', 'app'),
  counts: metaKeys.counts('c1', 'app', 'shop'),
  tables: metaKeys.objects('c1', 'app', 'shop', 'table'),
  views: metaKeys.objects('c1', 'app', 'shop', 'view'),
  orders: metaKeys.table('c1', ORDERS, 'table'),
  customers: metaKeys.table('c1', CUSTOMERS, 'table'),
  salesCounts: metaKeys.counts('c1', 'app', 'sales'),
  otherDatabase: metaKeys.schemas('c1', 'archive'),
  otherConnection: metaKeys.databases('c2'),
};

beforeEach(() => {
  client = new QueryClient();
  for (const key of Object.values(keys)) client.setQueryData([...key], 'data');
});

async function stale(node: MetaNode, connectionId = 'c1'): Promise<string[]> {
  await Promise.all(
    invalidationFilters(connectionId, node).map((filters) => client.invalidateQueries(filters)),
  );
  return Object.entries(keys)
    .filter(([, key]) => client.getQueryState([...key])?.isInvalidated)
    .map(([name]) => name);
}

describe('invalidating by node', () => {
  it('drops the whole connection and nothing of another', async () => {
    const dropped = await stale({ level: 'connection' });
    expect(dropped).not.toContain('otherConnection');
    expect(dropped).toHaveLength(Object.keys(keys).length - 1);
  });

  it('drops a database with its schemas, and no other database', async () => {
    const dropped = await stale({ level: 'database', database: 'app' });
    expect(dropped).toEqual(
      expect.arrayContaining(['schemas', 'counts', 'tables', 'orders', 'salesCounts']),
    );
    expect(dropped).not.toContain('databases');
    expect(dropped).not.toContain('otherDatabase');
  });

  it('drops a schema with what is in it, but not the list of schemas', async () => {
    const dropped = await stale({ level: 'schema', database: 'app', schema: 'shop' });
    expect(dropped.sort()).toEqual(['counts', 'customers', 'orders', 'tables', 'views']);
  });

  it('drops one kind of object, the counts and the details of those objects', async () => {
    const dropped = await stale({
      level: 'objects',
      database: 'app',
      schema: 'shop',
      kind: 'table',
    });
    expect(dropped.sort()).toEqual(['counts', 'customers', 'orders', 'tables']);
  });

  it('drops one table whatever its kind', async () => {
    const dropped = await stale({ level: 'table', table: ORDERS });
    expect(dropped).toEqual(['orders']);
  });
});
