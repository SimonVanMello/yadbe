import { beforeEach, describe, expect, it } from 'vitest';

import type { ObjectRef, TableDataChanged, Value, YadbeError } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError } from '../result';

const { commands } = mockClient;
const PG = 'conn-local-pg';
const PROD = 'conn-shop-prod';
const SQLITE = 'conn-app-sqlite';
const TAB = 'table-tab-1';

const ref = (schema: string | null, name: string, database = 'app_dev'): ObjectRef => ({
  database,
  schema,
  name,
});
const int = (n: number): Value => ({ kind: 'int', value: String(n) });
const text = (value: string): Value => ({ kind: 'text', value });

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

const noFilter = { conditions: [], rawWhere: null };

describe('mock table data', () => {
  it('opens tables with their row identity and editability reasons', async () => {
    const orders = await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    expect(orders.rowIdentity).toEqual(['id']);
    expect(orders.readOnlyReasons).toEqual([]);
    expect(orders.defaultOrder).toEqual([{ column: 'id', direction: 'asc' }]);
    const byName = new Map(orders.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.readOnlyReason).toBe('identity');
    expect(byName.get('total')?.readOnlyReason).toBe('generated');
    expect(byName.get('note')?.readOnlyReason).toBeNull();
    expect(byName.get('status')?.enumValues).toContain('paid');

    const view = await unwrap(commands.openTableData(TAB, PG, ref('shop', 'customer_orders')));
    expect(view.readOnlyReasons).toEqual(['view']);
    expect(view.columns.every((c) => c.readOnlyReason === 'table')).toBe(true);

    const keyless = await unwrap(commands.openTableData(TAB, PG, ref('analytics', 'page_views')));
    expect(keyless.rowIdentity).toBeNull();
    expect(keyless.readOnlyReasons).toEqual(['noRowIdentity']);

    await unwrap(commands.connect(PROD, null));
    const prod = await unwrap(commands.openTableData(TAB, PROD, ref('shop', 'orders', 'shop')));
    expect(prod.readOnlyReasons).toEqual(['readOnlyConnection']);
  });

  it('pages, filters and sorts rows kept in the backend', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const page = await unwrap(
      commands.fetchTablePage(TAB, { filter: noFilter, sort: [], offset: 0, limit: 100 }),
    );
    expect(page.rowCount).toBe(100);
    expect(page.hasMore).toBe(true);
    expect(page.window.columns[0]?.values.slice(0, 3)).toEqual(['1', '2', '3']);
    const more = await unwrap(commands.fetchResultWindow(page.resultId, 50, 10));
    expect(more.columns[0]?.values[0]).toBe('51');

    const filtered = await unwrap(
      commands.fetchTablePage(TAB, {
        filter: {
          conditions: [
            { column: 'status', op: 'eq', values: [text('paid')] },
            { column: 'note', op: 'isNotNull', values: [] },
          ],
          rawWhere: 'customer_id > 100',
        },
        sort: [{ column: 'subtotal', direction: 'desc' }],
        offset: 0,
        limit: 500,
      }),
    );
    expect(filtered.order).toEqual([
      { column: 'subtotal', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
    const columns = page.columns.map((c) => c.name);
    const status = filtered.window.columns[columns.indexOf('status')]?.values ?? [];
    const subtotal = filtered.window.columns[columns.indexOf('subtotal')]?.values ?? [];
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((s) => s === 'paid')).toBe(true);
    const numbers = subtotal.map(Number);
    expect([...numbers].sort((a, b) => b - a)).toEqual(numbers);

    expect(
      await errorCode(
        commands.fetchTablePage(TAB, {
          filter: { conditions: [], rawWhere: 'id = 1; DROP TABLE orders' },
          sort: [],
          offset: 0,
          limit: 10,
        }),
      ),
    ).toBe('invalidArgument');
    expect(
      await errorCode(
        commands.fetchTablePage(TAB, {
          filter: { conditions: [{ column: 'nope', op: 'isNull', values: [] }], rawWhere: null },
          sort: [],
          offset: 0,
          limit: 10,
        }),
      ),
    ).toBe('invalidArgument');
  });

  it('serves every value kind, NULLs and empty strings', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('public', 'type_samples')));
    const page = await unwrap(
      commands.fetchTablePage(TAB, { filter: noFilter, sort: [], offset: 0, limit: 64 }),
    );
    const kinds = new Set(page.columns.map((c) => c.kind));
    for (const kind of ['bool', 'int', 'decimal', 'float', 'text', 'bytes', 'date', 'time']) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    expect(page.window.columns.some((c) => c.values.includes(null))).toBe(true);
    expect(page.window.columns.some((c) => c.values.includes(''))).toBe(true);
  });

  it('counts with an estimate or exactly', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const filter = {
      conditions: [
        { column: 'status', op: 'in' as const, values: [text('paid'), text('shipped')] },
      ],
      rawWhere: null,
    };
    const exact = await unwrap(commands.countTableRows(TAB, filter, 'exact'));
    const estimate = await unwrap(commands.countTableRows(TAB, filter, 'estimate'));
    expect(exact.filtered && estimate.filtered).toBe(true);
    expect(exact.count).toBeGreaterThan(0);
    expect(estimate.count).not.toBe(exact.count);

    await unwrap(commands.connect(SQLITE, null));
    await unwrap(commands.openTableData('t2', SQLITE, ref(null, 'notes', 'main')));
    const none = await unwrap(commands.countTableRows('t2', noFilter, 'estimate'));
    expect(none.count).toBeNull();
  });

  it('previews and applies a change set, then reads the rows back', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const events: TableDataChanged[] = [];
    const off = mockClient.events.subscribe('tableDataChanged', (e) => events.push(e));
    const changes = {
      updates: [
        { key: [int(1)], column: 'note', value: text("it's late") },
        { key: [int(1)], column: 'status', value: text('paid') },
        { key: [int(3)], column: 'note', value: { kind: 'null' as const } },
      ],
      inserts: [
        {
          values: [
            { column: 'customer_id', value: int(7) },
            { column: 'subtotal', value: text('12.5') },
          ],
        },
      ],
      deletes: [{ key: [int(2)], values: [] }],
    };
    const preview = await unwrap(commands.previewTableChanges(TAB, changes));
    expect(preview.statements.map((s) => s.change.kind)).toEqual([
      'delete',
      'update',
      'update',
      'insert',
    ]);
    expect(preview.statements[1]?.sql).toBe(
      `UPDATE "shop"."orders" SET "note" = 'it''s late', "status" = 'paid' WHERE "id" = 1`,
    );
    expect(preview.script.startsWith('BEGIN;\nDELETE FROM "shop"."orders" WHERE "id" = 2;')).toBe(
      true,
    );

    const outcome = await unwrap(commands.applyTableChanges(TAB, changes));
    if (outcome.status !== 'applied') throw new Error('expected applied');
    expect(outcome.statements.every((s) => s.rowsAffected === 1)).toBe(true);
    expect(outcome.inserted.positions).toEqual([0]);
    expect(outcome.inserted.window.columns[0]?.values[0]).toMatch(/^\d+$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ updated: 2, inserted: 1, deleted: 1 });
    off();

    const rows = await unwrap(commands.refreshTableRows(TAB, [[int(1)], [int(2)]]));
    expect(rows.positions).toEqual([0, null]);
    const noteIndex = 7;
    expect(rows.window.columns[noteIndex]?.values[0]).toBe("it's late");
  });

  it('rolls back on the one-row check, a constraint or a bad value', async () => {
    const table = ref('shop', 'customers');
    await unwrap(commands.openTableData(TAB, PG, table));
    expect(mockBackend.deleteRowElsewhere(PG, table, [int(5)])).toBe(true);
    const gone = await unwrap(
      commands.applyTableChanges(TAB, {
        updates: [
          { key: [int(4)], column: 'phone', value: text('+33 1') },
          { key: [int(5)], column: 'phone', value: text('+33 2') },
        ],
        inserts: [],
        deletes: [],
      }),
    );
    if (gone.status !== 'conflicted') throw new Error('expected a conflict');
    expect(gone.conflicts).toEqual([expect.objectContaining({ statementIndex: 1, row: 'id = 5' })]);
    expect(gone.current.positions).toEqual([null]);
    const unchanged = await unwrap(commands.refreshTableRows(TAB, [[int(4)]]));
    expect(unchanged.window.columns[3]?.values[0]).not.toBe('+33 1');

    const page = await unwrap(
      commands.fetchTablePage(TAB, { filter: noFilter, sort: [], offset: 0, limit: 2 }),
    );
    const email = page.window.columns[1]?.values[0] ?? '';
    const duplicate = await unwrap(
      commands.applyTableChanges(TAB, {
        updates: [{ key: [int(2)], column: 'email', value: text(email) }],
        inserts: [],
        deletes: [],
      }),
    );
    if (duplicate.status !== 'rolledBack') throw new Error('expected a rollback');
    expect(duplicate.failure.error.code).toBe('constraintViolation');
    expect(duplicate.failure.violation).toEqual({
      kind: 'unique',
      name: 'customers_email_key',
      column: 'email',
    });

    const missing = await unwrap(
      commands.applyTableChanges(TAB, {
        updates: [{ key: [int(2)], column: 'full_name', value: { kind: 'null' } }],
        inserts: [],
        deletes: [],
      }),
    );
    expect(missing.status === 'rolledBack' && missing.failure.violation?.kind).toBe('notNull');

    const bad = await unwrap(
      commands.applyTableChanges(TAB, {
        updates: [{ key: [int(2)], column: 'birth_date', value: text('yesterday') }],
        inserts: [],
        deletes: [],
      }),
    );
    expect(bad.status === 'rolledBack' && bad.failure.error.code).toBe('invalidValue');
  });

  it('checks the values read and reports every conflicting row (F-089)', async () => {
    const table = ref('shop', 'customers');
    await unwrap(commands.openTableData(TAB, PG, table));
    const rows = await unwrap(commands.refreshTableRows(TAB, [[int(4)], [int(6)]]));
    const phoneOf = (row: number): Value => {
      const value = rows.window.columns[3]?.values[row] ?? null;
      return value === null ? { kind: 'null' } : text(value);
    };
    const changes = {
      updates: [
        { key: [int(4)], column: 'phone', value: text('+33 4'), original: phoneOf(0) },
        { key: [int(6)], column: 'phone', value: text('+33 6'), original: phoneOf(1) },
      ],
      inserts: [],
      deletes: [],
    };
    const preview = await unwrap(commands.previewTableChanges(TAB, changes));
    expect(preview.statements[0]?.sql).toMatch(/WHERE "id" = 4 AND "phone" (=|IS NULL)/);

    expect(mockBackend.changeRowElsewhere(PG, table, [int(4)], 'phone', text('+1 elsewhere'))).toBe(
      true,
    );
    expect(mockBackend.deleteRowElsewhere(PG, table, [int(6)])).toBe(true);
    const outcome = await unwrap(commands.applyTableChanges(TAB, changes));
    if (outcome.status !== 'conflicted') throw new Error('expected a conflict');
    expect(outcome.conflicts.map((c) => c.row)).toEqual(['id = 4', 'id = 6']);
    expect(outcome.current.positions).toEqual([0, null]);
    expect(outcome.current.window.columns[3]?.values[0]).toBe('+1 elsewhere');

    // Rebased on what the server holds now, the change applies.
    const rebased = {
      ...changes,
      updates: [{ ...changes.updates[0], key: [int(4)], original: text('+1 elsewhere') }],
    } as typeof changes;
    const applied = await unwrap(commands.applyTableChanges(TAB, rebased));
    expect(applied.status).toBe('applied');
  });

  it('journals change sets and reverts them (F-090)', async () => {
    const table = ref('shop', 'customers');
    const info = await unwrap(commands.openTableData(TAB, PG, table));
    const before = await unwrap(commands.refreshTableRows(TAB, [[int(7)], [int(8)]]));
    const named = (row: number) =>
      info.columns.map((column, c) => {
        const window = before.window.columns[c];
        const text = window?.values[row] ?? null;
        const kind = window?.kinds?.[row] ?? column.kind;
        const value: Value =
          text === null
            ? { kind: 'null' }
            : kind === 'bool'
              ? { kind: 'bool', value: text === 'true' }
              : kind === 'array'
                ? { kind: 'array', value: [] }
                : kind === 'missing'
                  ? { kind: 'missing' }
                  : { kind, value: text };
        return { column: column.name, value };
      });
    const phone = named(0).find((c) => c.column === 'phone')?.value ?? { kind: 'null' };
    const outcome = await unwrap(
      commands.applyTableChanges(TAB, {
        updates: [{ key: [int(7)], column: 'phone', value: text('+44 7'), original: phone }],
        inserts: [],
        deletes: [{ key: [int(8)], values: named(1) }],
      }),
    );
    if (outcome.status !== 'applied') throw new Error('expected applied');
    expect(outcome.journalId).not.toBeNull();
    const page = await unwrap(
      commands.searchChangeJournal({
        text: null,
        connectionId: PG,
        table: null,
        after: null,
        limit: null,
      }),
    );
    expect(page.entries[0]).toMatchObject({ updated: 1, deleted: 1, revertBlocker: null });
    const id = page.entries[0]?.id ?? 0;
    const detail = await unwrap(commands.getChangeJournalEntry(id));
    expect(detail?.inverseStatements).toHaveLength(2);

    const preview = await unwrap(commands.previewChangeSetRevert(TAB, id));
    expect(preview.statements.map((s) => s.change.kind)).toEqual(['update', 'insert']);
    const reverted = await unwrap(commands.applyChangeSetRevert(TAB, id));
    expect(reverted.status).toBe('applied');
    const after = await unwrap(commands.refreshTableRows(TAB, [[int(7)], [int(8)]]));
    expect(after.window.columns.map((c) => c.values)).toEqual(
      before.window.columns.map((c) => c.values),
    );
    const again = await unwrap(
      commands.searchChangeJournal({
        text: null,
        connectionId: null,
        table,
        after: null,
        limit: null,
      }),
    );
    expect(again.entries[0]?.reverts).toBe(id);
    expect(again.entries[1]?.revertedBy).toBe(again.entries[0]?.id);
    expect(await errorCode(commands.previewChangeSetRevert(TAB, id))).toBe('invalidArgument');
  });

  it('refuses edits the backend refuses', async () => {
    await unwrap(commands.openTableData(TAB, PG, ref('shop', 'orders')));
    const change = { updates: [], inserts: [], deletes: [{ key: [int(1)], values: [] }] };
    expect(
      await errorCode(
        commands.previewTableChanges(TAB, {
          updates: [{ key: [int(1)], column: 'total', value: text('1') }],
          inserts: [],
          deletes: [],
        }),
      ),
    ).toBe('invalidArgument');
    expect(await errorCode(commands.previewTableChanges(TAB, { ...change, deletes: [] }))).toBe(
      'invalidArgument',
    );

    await unwrap(commands.openTableData(TAB, PG, ref('analytics', 'page_views')));
    expect(await errorCode(commands.applyTableChanges(TAB, change))).toBe('tableNotEditable');

    await unwrap(commands.connect(PROD, null));
    await unwrap(commands.openTableData(TAB, PROD, ref('shop', 'orders', 'shop')));
    expect(await errorCode(commands.applyTableChanges(TAB, change))).toBe('readOnlyViolation');
    expect(
      await errorCode(
        commands.fetchTablePage(TAB, {
          filter: { conditions: [], rawWhere: '1 = 1) DELETE FROM orders WHERE (1 = 1' },
          sort: [],
          offset: 0,
          limit: 10,
        }),
      ),
    ).toBe('readOnlyViolation');
  });
});
