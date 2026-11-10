import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MetaRefreshed } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError } from '../result';

const { commands } = mockClient;
const PG = 'conn-local-pg';
const SQLITE = 'conn-app-sqlite';

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  await unwrap(commands.connect(PG, null));
  await unwrap(commands.connect(SQLITE, null));
});

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof YadbeIpcError ? error.error.code : 'unexpected';
  }
}

describe('mock metadata', () => {
  it('lists databases, schemas, counts and objects lazily', async () => {
    const databases = await unwrap(commands.listDatabases(null, PG));
    const current = databases.find((d) => d.current);
    expect(current?.name).toBe('app_dev');
    expect(databases.some((d) => !d.accessible)).toBe(true);

    const schemas = await unwrap(commands.listSchemas(null, PG, 'app_dev'));
    expect(schemas.filter((s) => !s.system).map((s) => s.name)).toEqual([
      'analytics',
      'auth',
      'public',
      'sales',
      'shop',
    ]);
    expect(schemas.find((s) => s.name === 'pg_catalog')?.system).toBe(true);

    const counts = await unwrap(commands.listObjectCounts(null, PG, 'app_dev', 'shop'));
    expect(counts.map((c) => c.kind)).toEqual([
      'table',
      'view',
      'materializedView',
      'function',
      'procedure',
      'sequence',
      'type',
    ]);
    const tables = await unwrap(commands.listObjects(null, PG, 'app_dev', 'shop', 'table'));
    expect(tables).toHaveLength(counts[0]?.count ?? -1);
    const functions = await unwrap(commands.listObjects(null, PG, 'app_dev', 'shop', 'function'));
    const overloads = functions.filter((f) => f.name === 'price_at');
    expect(new Set(overloads.map((f) => f.id)).size).toBe(2);
  });

  it('describes a table with keys, generated and identity columns', async () => {
    const orders = await unwrap(
      commands.getTableDetails(null, PG, { database: 'app_dev', schema: 'shop', name: 'orders' }),
    );
    expect(orders.primaryKey?.columns).toEqual(['id']);
    expect(orders.columns.find((c) => c.name === 'id')?.identity).toBe('always');
    expect(orders.columns.find((c) => c.name === 'total')?.generated?.stored).toBe(true);
    expect(orders.foreignKeys[0]?.referencedTable.name).toBe('customers');

    const lines = await unwrap(
      commands.getTableDetails(null, PG, {
        database: 'app_dev',
        schema: 'sales',
        name: 'invoice_lines',
      }),
    );
    expect(lines.primaryKey?.columns).toEqual(['invoice_id', 'line_no']);
    const invoices = await unwrap(
      commands.getTableDetails(null, PG, {
        database: 'app_dev',
        schema: 'sales',
        name: 'invoices',
      }),
    );
    expect(invoices.foreignKeys[0]?.referencedTable).toEqual({
      database: 'app_dev',
      schema: 'shop',
      name: 'orders',
    });

    expect(
      await errorCode(
        unwrap(
          commands.getTableDetails(null, PG, { database: 'app_dev', schema: 'shop', name: 'nope' }),
        ),
      ),
    ).toBe('objectNotFound');
  });

  it('serves SQLite without schemas', async () => {
    const databases = await unwrap(commands.listDatabases(null, SQLITE));
    expect(databases.map((d) => d.name)).toEqual(['main']);
    expect(await unwrap(commands.listSchemas(null, SQLITE, 'main'))).toEqual([]);
    const counts = await unwrap(commands.listObjectCounts(null, SQLITE, 'main', null));
    expect(counts).toEqual([
      { kind: 'table', count: 5, systemCount: 1 },
      { kind: 'view', count: 1, systemCount: 0 },
    ]);
    expect(await errorCode(unwrap(commands.listObjectCounts(null, SQLITE, 'main', 'x')))).toBe(
      'invalidArgument',
    );
  });

  it('fails when not connected or when the database is denied', async () => {
    expect(await errorCode(unwrap(commands.listDatabases(null, 'conn-shop-staging')))).toBe(
      'notConnected',
    );
    expect(await errorCode(unwrap(commands.listSchemas(null, PG, 'analytics_archive')))).toBe(
      'queryFailed',
    );
  });

  it('caches nodes, logs first loads only, and refreshes on demand', async () => {
    await unwrap(commands.clearStatementLog());
    await unwrap(commands.listSchemas(null, PG, 'app_dev'));
    await unwrap(commands.listSchemas(null, PG, 'app_dev'));
    expect(await unwrap(commands.getStatementLog())).toHaveLength(1);

    const events: MetaRefreshed[] = [];
    mockClient.events.subscribe('metaRefreshed', (e) => events.push(e));
    await unwrap(commands.refreshMeta(PG, { level: 'database', database: 'app_dev' }));
    expect(events).toEqual([
      { connectionId: PG, node: { level: 'database', database: 'app_dev' }, reason: 'refresh' },
    ]);
    await unwrap(commands.listSchemas(null, PG, 'app_dev'));
    expect(await unwrap(commands.getStatementLog())).toHaveLength(2);
  });

  it('cancels a slow load', async () => {
    mockBackend.setMetaLatency(10_000);
    const pending = unwrap(commands.listDatabases('req-1', PG));
    await unwrap(commands.cancelMetaRequest('req-1'));
    expect(await errorCode(pending)).toBe('cancelled');
  });

  it('tells the frontend to reload after a reconnection', async () => {
    vi.useFakeTimers();
    try {
      await unwrap(commands.listDatabases(null, PG));
      const handler = vi.fn();
      mockClient.events.subscribe('metaRefreshed', handler);
      const drop = mockBackend.dropConnection(PG);
      await vi.runAllTimersAsync();
      await drop;
      expect(handler).toHaveBeenCalledWith({
        connectionId: PG,
        node: { level: 'connection' },
        reason: 'reconnected',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a compact completion catalog', async () => {
    const catalog = await unwrap(commands.getCompletionCatalog(null, PG, 'app_dev', false));
    expect(catalog.schemas.some((s) => s.system)).toBe(false);
    expect(catalog.searchPath).toEqual(['public']);
    const orders = catalog.relations.findIndex((r) => r.name === 'orders');
    const relation = catalog.relations[orders];
    expect(relation?.columns).toContain('customer_id');
    expect(relation?.columnTypes.every((t) => catalog.typeNames[t] !== undefined)).toBe(true);
    const fk = catalog.foreignKeys.find((f) => f.from === orders);
    expect(catalog.relations[fk?.to ?? -1]?.name).toBe('customers');
    expect(catalog.routines.some((r) => r.name === 'order_total')).toBe(true);
  });

  it('offers a large synthetic catalog', async () => {
    mockBackend.setMetaCatalog('large');
    const catalog = await unwrap(commands.getCompletionCatalog(null, PG, 'app_dev', false));
    expect(catalog.relations.length + catalog.routines.length).toBe(10_000);
  });

  it('scripts a table with the dialect quoting', async () => {
    const table = { database: 'app_dev', schema: 'shop', name: 'Order Notes' };
    expect(await unwrap(commands.scriptTable(PG, table, 'qualifiedName'))).toBe(
      '"shop"."Order Notes"',
    );
    expect(await unwrap(commands.scriptTable(PG, table, 'delete'))).toBe(
      'DELETE FROM "shop"."Order Notes"\nWHERE "id" = <id, integer>;',
    );
    expect(await unwrap(commands.scriptTable(PG, table, 'insert'))).toBe(
      'INSERT INTO "shop"."Order Notes" (\n  "order_id",\n  "Select",\n  "author name"\n) VALUES (\n  <order_id, integer>,\n  <Select, text>,\n  <author name, text>\n);',
    );
  });
});
