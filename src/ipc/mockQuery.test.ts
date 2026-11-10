import { beforeEach, describe, expect, it } from 'vitest';

import type { ExecutionDelta, QueryFinished, ResultSummary } from './bindings';
import { mockBackend, mockClient } from './mockClient';
import { mockSplit, mockStatementAt } from './mockSplit';
import { unwrap, YadbeIpcError } from './result';

const { commands } = mockClient;

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setQueryTick(0);
});

const texts = (engine: Parameters<typeof mockSplit>[0], text: string) =>
  mockSplit(engine, text).map((st) => text.slice(st.from, st.to));

describe('mock statement splitter', () => {
  it('keeps dollar quotes and strings whole and leaves comments out on PostgreSQL', () => {
    const text = `select 'a;b'; -- c;\nDO $x$ begin perform 1; end $x$;\n/* a /* nested; */ ; */ select E'\\';'`;
    expect(texts('postgres', text)).toEqual([
      "select 'a;b'",
      'DO $x$ begin perform 1; end $x$',
      "select E'\\';'",
    ]);
  });

  it('splits SQL Server batches on GO lines and MySQL on its DELIMITER', () => {
    expect(texts('mssql', 'select 1; select 2\nGO\nprint 1\n  go 2\n')).toEqual([
      'select 1; select 2',
      'print 1',
    ]);
    const mysql =
      'DELIMITER //\ncreate procedure p() begin select 1; end //\nDELIMITER ;\nselect 2;';
    expect(texts('mysql', mysql)).toEqual(['create procedure p() begin select 1; end', 'select 2']);
  });

  it('keeps SQLite trigger bodies whole', () => {
    const text =
      'create trigger t after insert on a begin insert into b values (case when 1 then 2 end); end; select 1';
    expect(texts('sqlite', text)).toEqual([
      'create trigger t after insert on a begin insert into b values (case when 1 then 2 end); end',
      'select 1',
    ]);
  });

  it('finds the statement under the cursor', () => {
    const text = 'select 1;\nselect 2;\n\n\n\nselect 3';
    expect(mockStatementAt('postgres', text, 3)?.from).toBe(0);
    expect(mockStatementAt('postgres', text, 9)?.from).toBe(0);
    expect(mockStatementAt('postgres', text, 20)?.from).toBe(10);
    expect(mockStatementAt('postgres', text, 21)).toBeNull();
  });
});

function finished(executionId: number): Promise<QueryFinished> {
  return new Promise((resolve) => {
    const off = mockClient.events.subscribe('queryFinished', (payload) => {
      if (payload.executionId !== executionId) return;
      off();
      resolve(payload);
    });
  });
}

/** Collects the deltas of an execution, as the frontend would apply them. */
function collect() {
  const deltas: ExecutionDelta[] = [];
  const offs = [
    mockClient.events.subscribe('queryProgress', (p) => deltas.push(p.delta)),
    mockClient.events.subscribe('queryFinished', (p) => deltas.push(p.delta)),
  ];
  return {
    deltas,
    results(): Map<number, ResultSummary> {
      const map = new Map<number, ResultSummary>();
      for (const d of deltas) for (const r of d.results) map.set(r.resultId, r);
      return map;
    },
    stop: () => {
      offs.forEach((off) => {
        off();
      });
    },
  };
}

async function connected(name: string): Promise<string> {
  const connections = await unwrap(commands.listConnections());
  const conn = connections.find((c) => c.definition.name === name);
  if (!conn) throw new Error(`no connection ${name}`);
  await unwrap(commands.connect(conn.id, { kind: 'value', value: 'secret' }));
  return conn.id;
}

async function firstPostgres(): Promise<string> {
  const connections = await unwrap(commands.listConnections());
  const conn = connections.find(
    (c) => c.definition.engine === 'postgres' && !c.definition.readOnly,
  );
  if (!conn) throw new Error('no postgres connection');
  return connected(conn.definition.name);
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof YadbeIpcError ? error.error.code : 'unexpected';
  }
}

describe('mock query execution', () => {
  it('needs an open connection', async () => {
    const connections = await unwrap(commands.listConnections());
    const id = connections[0]?.id ?? '';
    expect(
      await errorCode(
        unwrap(
          commands.executeQuery({
            tabId: 't',
            connectionId: id,
            database: null,
            text: 'select 1',
            scope: { kind: 'all' },
            limits: null,
          }),
        ),
      ),
    ).toBe('notConnected');
  });

  it('streams several result sets and messages, then serves windows', async () => {
    const connectionId = await firstPostgres();
    const events = collect();
    const text =
      "select 1 as one, 'x' as label;\nselect * from orders;\ninsert into t values (1), (2)";
    const started = await unwrap(
      commands.executeQuery({
        tabId: 'tab-1',
        connectionId,
        database: null,
        text,
        scope: { kind: 'all' },
        limits: null,
      }),
    );
    expect(started.statements).toHaveLength(3);
    const done = await finished(started.executionId);
    expect(done.delta.status).toBe('succeeded');
    const results = [...events.results().values()];
    expect(results.map((r) => r.rowCount)).toEqual([1, 1284]);
    expect(results.every((r) => r.status === 'complete')).toBe(true);
    const messages = events.deltas.flatMap((d) => d.messages);
    expect(messages.map((m) => m.body.kind)).toEqual([
      'statementCompleted',
      'statementCompleted',
      'statementCompleted',
    ]);
    const last = messages[2]?.body;
    expect(last?.kind === 'statementCompleted' && last.rowsAffected).toBe(2);

    const [literal, orders] = results;
    const one = await unwrap(commands.fetchResultWindow(literal?.resultId ?? 0, 0, 500));
    expect(one.columns.map((c) => c.values)).toEqual([['1'], ['x']]);
    const window = await unwrap(commands.fetchResultWindow(orders?.resultId ?? 0, 0, 500));
    expect(window.rowCount).toBe(500);
    const notes = window.columns[12];
    expect(notes?.truncated).toContain(7);
    const misc = window.columns[13];
    expect(misc?.kinds?.slice(0, 3)).toEqual(['int', 'text', 'float']);
    const full = await unwrap(commands.fetchResultCell(orders?.resultId ?? 0, 7, 12));
    expect(full.kind === 'text' && full.value.length).toBeGreaterThan(2000);
    events.stop();
  });

  it('pauses at the row limit and resumes on load more', async () => {
    const connectionId = await firstPostgres();
    const events = collect();
    const started = await unwrap(
      commands.executeQuery({
        tabId: 'tab-1',
        connectionId,
        database: null,
        text: 'select * from generate_series(1, 2500)',
        scope: { kind: 'all' },
        limits: { maxRows: 1000, maxBytes: 1 << 30 },
      }),
    );
    await new Promise<void>((resolve) => {
      const off = mockClient.events.subscribe('queryProgress', (p) => {
        if (p.delta.status === 'paused') {
          off();
          resolve();
        }
      });
    });
    const paused = [...events.results().values()][0];
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedBy).toBe('rowLimit');
    expect(paused?.rowCount).toBe(1000);
    const done = finished(started.executionId);
    await unwrap(commands.resumeResult(paused?.resultId ?? 0, 'all'));
    expect((await done).delta.status).toBe('succeeded');
    expect([...events.results().values()][0]?.rowCount).toBe(2500);
    events.stop();
  });

  it('cancels a long statement and reports an error position', async () => {
    const connectionId = await firstPostgres();
    const started = await unwrap(
      commands.executeQuery({
        tabId: 'tab-1',
        connectionId,
        database: null,
        text: 'select pg_sleep(30)',
        scope: { kind: 'all' },
        limits: null,
      }),
    );
    const done = finished(started.executionId);
    await unwrap(commands.cancelQuery('tab-1'));
    expect((await done).delta.status).toBe('cancelled');

    const failed = await unwrap(
      commands.executeQuery({
        tabId: 'tab-1',
        connectionId,
        database: null,
        text: 'select 1;\nselect * from nowhere',
        scope: { kind: 'statementAt', offset: 15 },
        limits: null,
      }),
    );
    const result = await finished(failed.executionId);
    expect(result.delta.status).toBe('failed');
    const error = result.delta.messages.find((m) => m.body.kind === 'error')?.body;
    expect(error?.kind === 'error' && error.position).toEqual({ offset: 24, line: 2, column: 15 });
  });

  it('tracks manual transactions and refuses writes on read-only connections', async () => {
    const connectionId = await firstPostgres();
    await unwrap(commands.setTransactionMode('tab-1', 'manual'));
    const started = await unwrap(
      commands.executeQuery({
        tabId: 'tab-1',
        connectionId,
        database: null,
        text: 'update t set a = 1 where id = 2',
        scope: { kind: 'all' },
        limits: null,
      }),
    );
    await finished(started.executionId);
    const tab = await unwrap(commands.getQueryTab('tab-1'));
    expect(tab.transaction).toEqual({ mode: 'manual', status: 'open' });
    expect(await errorCode(unwrap(commands.setTransactionMode('tab-1', 'autoCommit')))).toBe(
      'transactionOpen',
    );
    expect(await unwrap(commands.commitTransaction('tab-1'))).toEqual({
      mode: 'manual',
      status: 'idle',
    });

    const connections = await unwrap(commands.listConnections());
    const readOnly = connections.find((c) => c.definition.readOnly);
    if (!readOnly) throw new Error('the mock data has a read-only connection');
    const roId = await connected(readOnly.definition.name);
    const refused = await unwrap(
      commands.executeQuery({
        tabId: 'tab-2',
        connectionId: roId,
        database: null,
        text: 'select 1; delete from orders',
        scope: { kind: 'all' },
        limits: null,
      }),
    );
    const result = await finished(refused.executionId);
    expect(result.delta.status).toBe('failed');
    const error = result.delta.messages[0]?.body;
    expect(error?.kind === 'error' && error.error.code).toBe('readOnlyViolation');
  });
});
