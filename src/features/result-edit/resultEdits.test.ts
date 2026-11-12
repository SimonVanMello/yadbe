import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ipc, unwrap, type Value } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { getTabExecution, startQueryFeed, useExecutionStore } from '../query/executionStore';
import { applyChanges, tableSource, writeCells } from '../table-data/tableActions';
import { getTableSession } from '../table-data/tableSessionStore';
import { sessionIdOf } from './resultEditModel';
import {
  describeResult,
  forgetResult,
  startResultEditFeature,
  useResultEditStore,
} from './resultEdits';

const PG = 'conn-local-pg';
const TAB = 'query-tab';

let stopFeed: () => void = () => undefined;

beforeAll(() => {
  stopFeed = startQueryFeed();
  startResultEditFeature();
});

afterAll(() => {
  stopFeed();
});

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  mockBackend.setTableDataLatency(0);
  mockBackend.setQueryTick(0);
  await unwrap(ipc.commands.connect(PG, null));
});

/** Runs `sql` in the query tab through the execution store, until it ends. */
async function run(sql: string) {
  const store = useExecutionStore.getState();
  store.markStarting(TAB);
  const started = await unwrap(
    ipc.commands.executeQuery({
      tabId: TAB,
      connectionId: PG,
      database: null,
      text: sql,
      scope: { kind: 'all' },
      limits: null,
      parameters: [],
    }),
  );
  store.begin(TAB, started, { connectionId: PG, database: null, sourceText: sql });
  await expect
    .poll(() => getTabExecution(TAB).status, { timeout: 5000 })
    .toMatch(/succeeded|failed/);
  const result = getTabExecution(TAB).results[0];
  if (!result) throw new Error('no result');
  return result;
}

const text = (value: string): Value => ({ kind: 'text', value });

describe('result edits', () => {
  it('opens an edit session over an editable result, applies and reads the rows back', async () => {
    const result = await run('select id, full_name from shop.customers limit 10');
    await describeResult(TAB, PG, result.resultId, result.columns, result.rowCount);
    const id = sessionIdOf(result.resultId);
    expect(useResultEditStore.getState().entries[result.resultId]?.status).toBe('ready');
    expect(getTableSession(id).phase).toBe('ready');
    const source = tableSource(id);
    expect(source?.rowCount).toBe(10);

    await writeCells(id, [{ row: 0, dataCol: 1, value: text('Grace Hopper') }]);
    expect(getTableSession(id).pendingCount).toBe(1);
    await applyChanges(id);
    expect(getTableSession(id).pendingCount).toBe(0);
    expect(await source?.underlyingValue(0, 1)).toEqual(text('Grace Hopper'));

    // A new run of the tab replaces the result: its session ends.
    await run('select 1 as one');
    expect(useResultEditStore.getState().entries[result.resultId]).toBeUndefined();
    expect(tableSource(id)).toBeUndefined();
    expect(getTableSession(id).phase).toBe('idle');
  });

  it('keeps a read-only result without a session, with its reasons', async () => {
    const result = await run('select full_name from shop.customers');
    await describeResult(TAB, PG, result.resultId, result.columns, result.rowCount);
    const entry = useResultEditStore.getState().entries[result.resultId];
    expect(entry?.info?.readOnlyReasons).toEqual(['keyNotSelected']);
    expect(tableSource(sessionIdOf(result.resultId))).toBeUndefined();
    forgetResult(result.resultId);
    expect(useResultEditStore.getState().entries[result.resultId]).toBeUndefined();
  });
});
