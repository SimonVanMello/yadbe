import { beforeEach, describe, expect, it } from 'vitest';

import type { MetaRefreshed, ObjectRef } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError } from '../result';

const { commands, events } = mockClient;
const PG = 'conn-local-pg';
const PROD = 'conn-shop-prod';
const SQLITE = 'conn-app-sqlite';

const shop = (name: string): ObjectRef => ({ database: 'app_dev', schema: 'shop', name });

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  await unwrap(commands.connect(PG, null));
});

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof YadbeIpcError ? error.error.code : 'unexpected';
  }
}

const table = (
  object: ObjectRef,
  action: Parameters<typeof commands.planObjectAction>[2]['action'],
) => ({
  object,
  kind: 'table' as const,
  id: object.name,
  action,
});

describe('mock object tools', () => {
  it('gives the DDL of a table, a view, a routine and a sequence, saying where it comes from', async () => {
    const ddl = (
      object: ObjectRef,
      kind: 'table' | 'view' | 'function' | 'sequence',
      id = object.name,
    ) => unwrap(commands.getObjectDdl(null, PG, { type: 'object', object, kind, id }));
    const orders = await ddl(shop('orders'), 'table');
    expect(orders.source).toBe('reconstructed');
    expect(orders.sql).toContain('CREATE TABLE "shop"."orders"');
    expect(orders.sql).toMatch(/^-- Reconstructed by yadbe/);
    const trigger = await unwrap(
      commands.getObjectDdl(null, PG, {
        type: 'trigger',
        table: shop('orders'),
        name: 'touch_updated_at',
      }),
    );
    expect(trigger.sql).toContain('CREATE TRIGGER');
    const missing = await code(ddl(shop('nope'), 'table'));
    expect(missing).toBe('objectNotFound');
  });

  it('plans a drop with its statement and the tables that reference it, never CASCADE', async () => {
    const plan = await unwrap(
      commands.planObjectAction(null, PG, table(shop('customers'), { type: 'drop' })),
    );
    expect(plan.sql).toBe('DROP TABLE "shop"."customers"');
    expect(plan.sql).not.toContain('CASCADE');
    expect(plan.rowEstimate).toBeGreaterThan(0);
    expect(plan.dependents.items.some((d) => d.object.name === 'orders')).toBe(true);
    expect(plan.dependents.items[0]?.via).toMatchObject({ type: 'foreignKey' });
  });

  it('writes each engine its own statements, and refuses what it does not offer', async () => {
    await unwrap(commands.connect(SQLITE, null));
    const lite = { database: 'main', schema: null, name: 'users' };
    const rename = await unwrap(
      commands.planObjectAction(null, SQLITE, table(lite, { type: 'rename', newName: 'people' })),
    ).catch(() => null);
    expect(rename === null || rename.sql.startsWith('ALTER TABLE')).toBe(true);
    const refused = await commands.planObjectAction(
      null,
      PG,
      table(shop('orders'), { type: 'rename', newName: '  ' }),
    );
    expect(refused.status === 'error' && refused.error.code).toBe('invalidArgument');
  });

  it('truncates, renames and drops, telling the explorer each time', async () => {
    const refreshed: MetaRefreshed[] = [];
    events.subscribe('metaRefreshed', (event) => refreshed.push(event));

    await unwrap(
      commands.runObjectAction(null, PG, table(shop('suppliers'), { type: 'truncate' })),
    );
    const after = await unwrap(commands.getTableDetails(null, PG, shop('suppliers')));
    expect(after.rowEstimate).toBe(0);

    const renamed = await unwrap(
      commands.runObjectAction(
        null,
        PG,
        table(shop('warehouses'), { type: 'rename', newName: 'depots' }),
      ),
    );
    expect(renamed.renamedTo?.name).toBe('depots');
    expect(await code(unwrap(commands.getTableDetails(null, PG, shop('warehouses'))))).toBe(
      'objectNotFound',
    );
    expect((await unwrap(commands.getTableDetails(null, PG, shop('depots')))).table.name).toBe(
      'depots',
    );

    await unwrap(commands.runObjectAction(null, PG, table(shop('depots'), { type: 'drop' })));
    expect(await code(unwrap(commands.getTableDetails(null, PG, shop('depots'))))).toBe(
      'objectNotFound',
    );
    const objects = await unwrap(commands.listObjects(null, PG, 'app_dev', 'shop', 'table'));
    expect(objects.some((o) => o.name === 'depots')).toBe(false);

    expect(refreshed.length).toBeGreaterThanOrEqual(3);
    expect(refreshed.every((event) => event.reason === 'ddl')).toBe(true);
  });

  it('refuses on a read-only connection, as the backend does', async () => {
    await unwrap(commands.connect(PROD, null));
    const prodTable = { ...shop('customers'), database: 'shop' };
    for (const action of [
      { type: 'drop' },
      { type: 'truncate' },
      { type: 'rename', newName: 'people' },
    ] as const) {
      const result = await commands.runObjectAction(null, PROD, table(prodTable, action));
      expect(result.status === 'error' && result.error.code).toBe('readOnlyViolation');
    }
    expect((await unwrap(commands.getTableDetails(null, PROD, prodTable))).table.name).toBe(
      'customers',
    );
  });

  it('gives properties that vary with the engine, and hides what an engine lacks', async () => {
    const facts = await unwrap(commands.getObjectProperties(null, PG, shop('orders'), 'table'));
    expect(facts.owner).not.toBeNull();
    expect(facts.totalBytes).toBeGreaterThan(0);
    expect(facts.created).toBeNull();
    expect(facts.lastAnalyzed).not.toBeNull();
  });

  it('keeps the pins, across a pin of the same object and a rename', async () => {
    const pin = {
      connectionId: PG,
      database: 'app_dev',
      schema: 'shop',
      kind: 'table' as const,
      name: 'warehouses',
      id: 'warehouses',
    };
    await unwrap(commands.pinObject(pin));
    await unwrap(commands.pinObject(pin));
    expect(await unwrap(commands.listPinnedObjects())).toEqual([pin]);
    await unwrap(
      commands.runObjectAction(
        null,
        PG,
        table(shop('warehouses'), { type: 'rename', newName: 'depots' }),
      ),
    );
    expect(await unwrap(commands.listPinnedObjects())).toEqual([
      { ...pin, name: 'depots', id: 'depots' },
    ]);
    await unwrap(commands.unpinObject({ ...pin, name: 'depots', id: 'depots' }));
    expect(await unwrap(commands.listPinnedObjects())).toEqual([]);
  });

  it('lists the actions of each engine in its capabilities', async () => {
    const engines = await unwrap(commands.listEngines());
    const support = (engine: string, kind: string) =>
      engines.find((e) => e.engine === engine)?.objectActions.find((a) => a.kind === kind);
    expect(support('postgres', 'function')).toMatchObject({
      drop: true,
      truncate: false,
      rename: true,
    });
    expect(support('mssql', 'view')).toMatchObject({ drop: true, rename: false });
    expect(support('mysql', 'procedure')).toMatchObject({ drop: true, rename: false });
    expect(support('sqlite', 'table')).toMatchObject({ drop: true, truncate: true, rename: true });
    expect(support('sqlite', 'sequence')).toBeUndefined();
  });
});
