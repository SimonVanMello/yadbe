import { beforeEach, describe, expect, it } from 'vitest';

import type { ObjectRef, ResultWindow, Value, YadbeError } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError } from '../result';

const { commands } = mockClient;
const PG = 'conn-local-pg';
const TAB = 'table-tab-fk';

const ref = (schema: string | null, name: string): ObjectRef => ({
  database: 'app_dev',
  schema,
  name,
});
const int = (n: number | string): Value => ({ kind: 'int', value: String(n) });

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  mockBackend.setTableDataLatency(0);
  await unwrap(commands.connect(PG, null));
});

async function errorCode(
  promise: Promise<{ status: 'ok'; data: unknown } | { status: 'error'; error: YadbeError }>,
): Promise<string | null> {
  try {
    await unwrap(promise);
    return null;
  } catch (error) {
    return error instanceof YadbeIpcError ? error.error.code : 'unexpected';
  }
}

function column(window: ResultWindow, index: number): (string | null)[] {
  return [...(window.columns[index]?.values ?? [])];
}

describe('mock foreign key navigation', () => {
  it('lists the foreign keys referencing a table, other schemas and self-references included', async () => {
    const orders = await unwrap(commands.getIncomingForeignKeys(null, PG, ref('shop', 'orders')));
    expect(orders.supported).toBe(true);
    const names = orders.keys.map((k) => `${k.table.schema ?? ''}.${k.table.name}`);
    expect(names).toContain('sales.invoices');
    expect(names).toContain('shop.order_items');
    const categories = await unwrap(
      commands.getIncomingForeignKeys(null, PG, ref('shop', 'categories')),
    );
    expect(categories.keys.some((k) => k.table.name === 'categories')).toBe(true);
    const lines = await unwrap(
      commands.getIncomingForeignKeys(null, PG, ref('sales', 'invoice_lines')),
    );
    expect(lines.keys.map((k) => k.foreignKey.columns)).toEqual([['invoice_id', 'line_no']]);
  });

  it('generates foreign key values that reference existing rows', async () => {
    const info = await unwrap(commands.openTableData(TAB, PG, ref('sales', 'refunds')));
    expect(info.foreignKeys.map((fk) => fk.columns)).toEqual([
      ['invoice_id'],
      ['invoice_id', 'line_no'],
    ]);
    const page = await unwrap(
      commands.fetchTablePage(TAB, {
        filter: {
          conditions: [{ column: 'line_no', op: 'isNotNull', values: [] }],
          rawWhere: null,
        },
        sort: [],
        offset: 0,
        limit: 20,
      }),
    );
    const invoice = column(page.window, 1);
    const line = column(page.window, 2);
    expect(page.rowCount).toBeGreaterThan(0);
    for (let row = 0; row < page.rowCount; row++) {
      const peek = await unwrap(
        commands.fetchReferencedRow(TAB, 'peek', ref('sales', 'invoice_lines'), [
          { column: 'invoice_id', value: int(invoice[row] ?? '') },
          { column: 'line_no', value: int(line[row] ?? '') },
        ]),
      );
      expect(peek.matches).toBe(1);
    }
  });

  it('peeks a referenced row and refuses NULL keys', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const peek = await unwrap(
      commands.fetchReferencedRow(TAB, 'peek', ref('shop', 'customers'), [
        { column: 'id', value: int(7) },
      ]),
    );
    expect(peek.matches).toBe(1);
    expect(peek.columns.map((c) => c.name)).toContain('email');
    expect(column(peek.window, 0)).toEqual(['7']);
    const none = await unwrap(
      commands.fetchReferencedRow(TAB, 'peek', ref('shop', 'customers'), [
        { column: 'id', value: int(999_999) },
      ]),
    );
    expect(none.matches).toBe(0);
    expect(
      await errorCode(
        commands.fetchReferencedRow(TAB, 'peek', ref('shop', 'customers'), [
          { column: 'id', value: { kind: 'null' } },
        ]),
      ),
    ).toBe('invalidArgument');
    expect(
      await errorCode(
        commands.fetchReferencedRow(TAB, 'peek', ref('shop', 'gone'), [
          { column: 'id', value: int(1) },
        ]),
      ),
    ).toBe('objectNotFound');
  });

  it('counts referencing rows up to a bound', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'customers')));
    const key = [{ column: 'customer_id', value: int(1) }];
    const exact = await unwrap(
      commands.countReferencingRows(TAB, 'count', ref('shop', 'orders'), key, 100_000),
    );
    expect(exact.more).toBe(false);
    const bounded = await unwrap(
      commands.countReferencingRows(TAB, 'count', ref('shop', 'orders'), key, 0 + 1),
    );
    expect(bounded.count).toBe(Math.min(1, exact.count));
    expect(bounded.more).toBe(exact.count > 1);
  });

  it('searches and pages a referenced table by its key', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const request = {
      table: ref('shop', 'customers'),
      keyColumns: ['id'],
      displayColumns: ['full_name', 'email'],
      search: null,
      offset: 0,
      limit: 50,
    };
    const first = await unwrap(commands.searchReferencedRows(TAB, 'look', request));
    expect(first.columns.map((c) => c.name)).toEqual(['id', 'full_name', 'email']);
    expect(first.hasMore).toBe(true);
    expect(column(first.window, 0).slice(0, 3)).toEqual(['1', '2', '3']);
    const found = await unwrap(
      commands.searchReferencedRows(TAB, 'look', { ...request, search: 'ALICE' }),
    );
    expect(found.window.rowCount).toBeGreaterThan(0);
    expect(column(found.window, 1).every((name) => name?.includes('Alice'))).toBe(true);
  });

  it('cancels a lookup', async () => {
    mockBackend.setTableDataLatency(50);
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const pending = commands.fetchReferencedRow(TAB, 'slow', ref('shop', 'customers'), [
      { column: 'id', value: int(1) },
    ]);
    await commands.cancelReferenceLookup('slow');
    expect(await errorCode(pending)).toBe('cancelled');
  });
});
