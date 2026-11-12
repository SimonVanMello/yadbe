import { beforeEach, describe, expect, it } from 'vitest';

import type { QueryFinished, Value, YadbeError } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError } from '../result';
import { parseTableSelect } from './resultEdit';

const { commands } = mockClient;
const PG = 'conn-local-pg';
const PROD = 'conn-shop-prod';
const TAB = 'query-tab-1';

const int = (n: number): Value => ({ kind: 'int', value: String(n) });
const text = (value: string): Value => ({ kind: 'text', value });

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  mockBackend.setTableDataLatency(0);
  mockBackend.setQueryTick(0);
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

/** Runs `sql` in the query tab and returns its first result's id. */
async function run(sql: string, connectionId = PG, tabId = TAB): Promise<number> {
  const done = new Promise<QueryFinished>((resolve) => {
    const off = mockClient.events.subscribe('queryFinished', (payload) => {
      if (payload.tabId !== tabId) return;
      off();
      resolve(payload);
    });
  });
  await unwrap(
    commands.executeQuery({
      tabId,
      connectionId,
      database: null,
      text: sql,
      scope: { kind: 'all' },
      limits: null,
      parameters: [],
    }),
  );
  const finished = await done;
  const id = finished.delta.results[0]?.resultId;
  return id ?? -1;
}

describe('mock result edits', () => {
  it('parses the plain SELECT of one qualified table it serves from the table', () => {
    expect(parseTableSelect('select * from shop.customers')).toEqual({
      schema: 'shop',
      table: 'customers',
      items: null,
      limit: null,
    });
    expect(
      parseTableSelect(
        'SELECT c.id, upper(c.email) AS loud, c.email FROM shop.customers c LIMIT 5;',
      )?.items,
    ).toEqual([
      { column: 'id', name: 'id' },
      { column: null, name: 'loud' },
      { column: 'email', name: 'email' },
    ]);
    expect(parseTableSelect('select * from orders')).toBeNull();
    expect(
      parseTableSelect('select * from shop.orders o join shop.customers c on true'),
    ).toBeNull();
    expect(parseTableSelect('select * from shop.orders where id = 1')).toBeNull();
  });

  it('describes a result of one table with its key as editable', async () => {
    const id = await run('select id, email, upper(email) as loud from shop.customers limit 20');
    const info = await unwrap(commands.describeResultEdit(id));
    expect(info.readOnlyReasons).toEqual([]);
    expect(info.table).toEqual({ database: 'app_dev', schema: 'shop', name: 'customers' });
    expect(info.columns.map((c) => c.source)).toEqual(['id', 'email', null]);
    expect(info.columns[2]?.column.readOnlyReason).toBe('computed');
    expect(info.rowIdentity).toEqual(['id']);
    expect(info.identityColumns).toEqual([0]);
  });

  it('says why other results are read-only', async () => {
    const reasons = async (sql: string) =>
      (await unwrap(commands.describeResultEdit(await run(sql)))).readOnlyReasons;
    expect(await reasons('select email, full_name from shop.customers')).toEqual([
      'keyNotSelected',
    ]);
    expect(await reasons('select * from shop.customer_orders')).toEqual(['view']);
    expect(await reasons('select * from analytics.page_views')).toEqual(['noRowIdentity']);
    expect(
      await reasons('select * from shop.orders o join shop.customers c on c.id = o.customer_id'),
    ).toEqual(['notSingleTable']);
    expect(await reasons('select * from orders')).toEqual(['originUnknown']);

    await unwrap(commands.connect(PROD, null));
    const prod = await run('select * from shop.customers limit 3', PROD, 'query-tab-prod');
    expect((await unwrap(commands.describeResultEdit(prod))).readOnlyReasons).toEqual([
      'readOnlyConnection',
    ]);
    expect(
      await errorCode(commands.applyResultChanges(prod, { updates: [], inserts: [], deletes: [] })),
    ).toBe('readOnlyViolation');
  });

  it('applies updates and deletes to the table and reads the rows back in the result columns', async () => {
    const id = await run('select id, email, upper(email) as loud from shop.customers limit 5');
    await unwrap(commands.describeResultEdit(id));
    const first = await unwrap(commands.fetchResultWindow(id, 0, 5));
    const email = first.columns[1]?.values[0] ?? '';
    const loud = first.columns[2]?.values[0] ?? null;
    const outcome = await unwrap(
      commands.applyResultChanges(id, {
        updates: [
          { key: [int(1)], column: 'email', value: text('new@example.com'), original: text(email) },
        ],
        inserts: [],
        deletes: [{ key: [int(2)], values: [{ column: 'id', value: int(2) }] }],
      }),
    );
    expect(outcome.status).toBe('applied');

    const fresh = await unwrap(
      commands.refreshResultRows(id, [
        { row: 0, key: [int(1)] },
        { row: 1, key: [int(2)] },
      ]),
    );
    expect(fresh.positions).toEqual([0, null]);
    expect(fresh.window.columns[1]?.values[0]).toBe('new@example.com');
    // The query's own column keeps what it read.
    expect(fresh.window.columns[2]?.values[0]).toBe(loud);

    // The table tab of the same table sees the change.
    await unwrap(
      commands.openTableData('table-tab', PG, {
        database: 'app_dev',
        schema: 'shop',
        name: 'customers',
      }),
    );
    const rows = await unwrap(commands.refreshTableRows('table-tab', [[int(1)], [int(2)]]));
    expect(rows.positions[1]).toBeNull();

    expect(
      await errorCode(
        commands.applyResultChanges(id, {
          updates: [{ key: [int(1)], column: 'loud', value: text('x'), original: null }],
          inserts: [],
          deletes: [],
        }),
      ),
    ).toBe('invalidArgument');
  });

  it('reports a row changed elsewhere as a conflict, in the result columns', async () => {
    const id = await run('select id, full_name from shop.customers limit 5');
    await unwrap(commands.describeResultEdit(id));
    const first = await unwrap(commands.fetchResultWindow(id, 0, 1));
    const name = first.columns[1]?.values[0] ?? '';
    // Opens the result's own table tab, then another session changes the row.
    await unwrap(
      commands.previewResultChanges(id, {
        updates: [
          { key: [int(1)], column: 'full_name', value: text('Mine'), original: text(name) },
        ],
        inserts: [],
        deletes: [],
      }),
    );
    const table = { database: 'app_dev', schema: 'shop', name: 'customers' };
    expect(mockBackend.changeRowElsewhere(PG, table, [int(1)], 'full_name', text('Theirs'))).toBe(
      true,
    );
    const outcome = await unwrap(
      commands.applyResultChanges(id, {
        updates: [
          { key: [int(1)], column: 'full_name', value: text('Mine'), original: text(name) },
        ],
        inserts: [],
        deletes: [],
      }),
    );
    if (outcome.status !== 'conflicted') throw new Error(outcome.status);
    expect(outcome.current.positions).toEqual([0]);
    expect(outcome.current.window.columns[1]?.values[0]).toBe('Theirs');
  });

  it('addresses stored rows through a sorted and filtered view (F-065 × F-087)', async () => {
    const id = await run('select id, email, upper(email) as loud from shop.customers limit 5');
    await unwrap(commands.describeResultEdit(id));
    const ids = (window: { columns: { values: (string | null)[] }[] }) => window.columns[0]?.values;
    const view = await unwrap(
      commands.setResultView(id, {
        sort: [{ column: 0, descending: true }],
        filters: [{ column: 0, op: 'lessOrEqual', value: '4' }],
        matchCase: false,
      }),
    );
    expect(view).toEqual({ rowCount: 4, sourceRows: 5 });
    expect(ids(await unwrap(commands.fetchResultWindow(id, 0, 10)))).toEqual(['4', '3', '2', '1']);
    const stored = await unwrap(commands.fetchResultStoredWindow(id, 0, 10));
    expect(ids(stored)).toEqual(['1', '2', '3', '4', '5']);
    expect(await unwrap(commands.fetchResultStoredCell(id, 0, 0))).toEqual(int(1));
    expect(await unwrap(commands.fetchResultCell(id, 0, 0))).toEqual(int(4));

    // Stored row 3 (shown first) gets a new email, stored row 1 (shown third) is deleted.
    const email = stored.columns[1]?.values[3] ?? '';
    const loud = stored.columns[2]?.values[3] ?? null;
    const outcome = await unwrap(
      commands.applyResultChanges(id, {
        updates: [
          {
            key: [int(4)],
            column: 'email',
            value: text('four@example.com'),
            original: text(email),
          },
        ],
        inserts: [],
        deletes: [{ key: [int(2)], values: [{ column: 'id', value: int(2) }] }],
      }),
    );
    expect(outcome.status).toBe('applied');
    await unwrap(commands.refreshResultRows(id, [{ row: 3, key: [int(4)] }]));
    await unwrap(commands.removeResultRows(id, [1]));

    expect(await unwrap(commands.getResultView(id))).toEqual({ rowCount: 3, sourceRows: 4 });
    const shown = await unwrap(commands.fetchResultWindow(id, 0, 10));
    expect(ids(shown)).toEqual(['4', '3', '1']);
    expect(shown.columns[1]?.values[0]).toBe('four@example.com');
    expect(shown.columns[2]?.values[0]).toBe(loud);
    // An edit keeps addressing the stored rows, the deleted one included.
    expect(ids(await unwrap(commands.fetchResultStoredWindow(id, 0, 10)))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    // Without the view, the deleted row stays out of what the grid shows.
    await unwrap(commands.setResultView(id, { sort: [], filters: [], matchCase: false }));
    expect(ids(await unwrap(commands.fetchResultWindow(id, 0, 10)))).toEqual(['1', '3', '4', '5']);

    const other = await run('select * from orders', PG, 'query-tab-2');
    expect(await errorCode(commands.removeResultRows(other, [0]))).toBe('resultNotFound');
  });

  it('refuses an apply while the query tab has an open transaction', async () => {
    await run('begin');
    const id = await run('select id, email from shop.customers limit 3');
    expect((await unwrap(commands.describeResultEdit(id))).readOnlyReasons).toEqual([]);
    expect(
      await errorCode(
        commands.applyResultChanges(id, {
          updates: [{ key: [int(1)], column: 'email', value: text('a@b.c'), original: null }],
          inserts: [],
          deletes: [],
        }),
      ),
    ).toBe('tableNotEditable');
    await unwrap(commands.closeResultEdit(id));
  });
});
