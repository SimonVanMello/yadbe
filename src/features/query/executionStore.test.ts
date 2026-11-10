import { beforeEach, describe, expect, it } from 'vitest';

import type { ExecutionDelta, ExecutionStarted, QueryMessage, ResultSummary } from '../../ipc';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import {
  IDLE_EXECUTION,
  applyDelta,
  beginExecution,
  defaultSelection,
  liveElapsed,
} from './executionModel';
import {
  createExecutionStore,
  getTabExecution,
  restoreTab,
  startQueryFeed,
  useExecutionStore,
} from './executionStore';

const started: ExecutionStarted = {
  executionId: 7,
  statements: [
    { from: 0, to: 8 },
    { from: 10, to: 20 },
  ],
};
const context = { connectionId: 'c1', database: null, sourceText: 'select 1;\nselect 2;' };

function summary(resultId: number, rowCount: number, statementIndex = 0): ResultSummary {
  return {
    resultId,
    statementIndex,
    columns: [{ name: 'n', typeName: 'int4', kind: 'int' }],
    rowCount,
    status: 'streaming',
    truncated: false,
    pausedBy: null,
    bytes: rowCount * 8,
  };
}

function message(seq: number, statementIndex: number | null = 0): QueryMessage {
  return {
    seq,
    statementIndex,
    atMs: seq * 10,
    body: {
      kind: 'statementCompleted',
      durationMs: 1,
      pausedMs: 0,
      rowsAffected: null,
      rowsReturned: 1,
      resultId: null,
    },
  };
}

function delta(patch: Partial<ExecutionDelta> = {}): ExecutionDelta {
  return {
    status: 'running',
    elapsedMs: 100,
    pausedMs: 0,
    currentStatement: 0,
    results: [],
    messages: [],
    ...patch,
  };
}

describe('applying deltas', () => {
  const begin = () => beginExecution(started, context, 0);

  it('starts connecting, with the statements and the text the positions refer to', () => {
    expect(begin()).toMatchObject({
      executionId: 7,
      status: 'connecting',
      statements: started.statements,
      sourceText: context.sourceText,
    });
  });

  it('updates status, elapsed time and current statement', () => {
    const next = applyDelta(begin(), 7, delta({ elapsedMs: 250, currentStatement: 1 }), 5);
    expect(next).toMatchObject({ status: 'running', elapsedMs: 250, currentStatement: 1 });
  });

  it('replaces a result by its id and appends the new ones, in order', () => {
    let exec = applyDelta(begin(), 7, delta({ results: [summary(1, 10)] }), 1);
    exec = applyDelta(exec, 7, delta({ elapsedMs: 200, results: [summary(2, 3, 1)] }), 2);
    exec = applyDelta(exec, 7, delta({ elapsedMs: 300, results: [summary(1, 500)] }), 3);
    expect(exec.results.map((r) => [r.resultId, r.rowCount])).toEqual([
      [1, 500],
      [2, 3],
    ]);
  });

  it('appends messages in seq order and never twice', () => {
    let exec = applyDelta(begin(), 7, delta({ messages: [message(0), message(1)] }), 1);
    exec = applyDelta(exec, 7, delta({ elapsedMs: 200, messages: [message(1), message(2)] }), 2);
    expect(exec.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it('ignores events of another execution, older events, and anything after the end', () => {
    const running = applyDelta(begin(), 7, delta({ elapsedMs: 500 }), 1);
    expect(applyDelta(running, 6, delta({ elapsedMs: 900 }), 2)).toBe(running);
    expect(applyDelta(running, 7, delta({ elapsedMs: 100 }), 2)).toBe(running);
    const done = applyDelta(running, 7, delta({ status: 'succeeded', elapsedMs: 600 }), 3);
    expect(done.status).toBe('succeeded');
    expect(applyDelta(done, 7, delta({ status: 'running', elapsedMs: 700 }), 4)).toBe(done);
  });

  it('picks the first result of a good run, the messages of a failed one', () => {
    const ok = applyDelta(begin(), 7, delta({ results: [summary(4, 1)] }), 1);
    expect(defaultSelection(ok)).toEqual({ kind: 'result', resultId: 4 });
    const failed = applyDelta(ok, 7, delta({ status: 'failed', elapsedMs: 200 }), 2);
    expect(defaultSelection(failed)).toEqual({ kind: 'messages' });
    expect(defaultSelection(IDLE_EXECUTION)).toEqual({ kind: 'messages' });
  });
});

describe('liveElapsed', () => {
  it('ticks while the run works and stands still while it is paused at its cap', () => {
    const running = {
      ...IDLE_EXECUTION,
      status: 'running' as const,
      elapsedMs: 700,
      elapsedAt: 1000,
    };
    expect(liveElapsed(running, 1500)).toBe(1200);
    expect(liveElapsed({ ...running, status: 'paused' }, 9000)).toBe(700);
  });
});

describe('the execution store', () => {
  let store: ReturnType<typeof createExecutionStore>;
  beforeEach(() => {
    store = createExecutionStore();
  });
  const exec = () => store.getState().executions['t1'];

  it('applies events once the run began', () => {
    store.getState().markStarting('t1');
    store.getState().begin('t1', started, context);
    store.getState().receive('t1', 7, delta({ results: [summary(1, 5)] }));
    store.getState().receive('t1', 7, delta({ status: 'succeeded', elapsedMs: 300 }));
    expect(exec()).toMatchObject({ status: 'succeeded', elapsedMs: 300 });
    expect(exec()?.results).toHaveLength(1);
  });

  it('keeps the events that arrive before executeQuery answers, and replays them in order', () => {
    store.getState().markStarting('t1');
    store.getState().receive('t1', 7, delta({ messages: [message(0)], elapsedMs: 10 }));
    store
      .getState()
      .receive('t1', 7, delta({ status: 'succeeded', elapsedMs: 40, messages: [message(1)] }));
    expect(exec()).toBeUndefined();
    store.getState().begin('t1', started, context);
    expect(exec()).toMatchObject({ status: 'succeeded', elapsedMs: 40 });
    expect(exec()?.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(store.getState().early['t1']).toBeUndefined();
  });

  it('drops events of a tab that is not running anything', () => {
    store.getState().receive('t1', 3, delta());
    expect(exec()).toBeUndefined();
  });

  it('does not mistake the previous run for the one being started', () => {
    store.getState().markStarting('t1');
    store.getState().begin('t1', started, context);
    store.getState().receive('t1', 7, delta({ status: 'succeeded', elapsedMs: 20 }));
    store.getState().markStarting('t1');
    // An event of the old run is applied to it (and ignored: it is over); the new one waits.
    store.getState().receive('t1', 7, delta({ elapsedMs: 30 }));
    store.getState().receive('t1', 8, delta({ elapsedMs: 5 }));
    expect(store.getState().early['t1']).toHaveLength(1);
    store.getState().begin('t1', { executionId: 8, statements: started.statements }, context);
    expect(exec()).toMatchObject({ executionId: 8, status: 'running' });
  });

  it('shows a run that could not start as a failed one, with the reason', () => {
    const error = {
      code: 'notConnected' as const,
      message: { en: 'The connection is not open.', fr: 'La connexion n’est pas ouverte.' },
      action: 'reconnect' as const,
      detail: null,
    };
    store.getState().markStarting('t1');
    store.getState().startFailed('t1', error, { connectionId: 'c1', database: null });
    expect(exec()).toMatchObject({ status: 'failed', startError: error });
    expect(store.getState().starting['t1']).toBeUndefined();
  });

  it('remembers the user’s sub-tab until the next run', () => {
    store.getState().select('t1', { kind: 'messages' });
    expect(store.getState().selections['t1']).toEqual({ kind: 'messages' });
    store.getState().begin('t1', started, context);
    expect(store.getState().selections['t1']).toBeUndefined();
  });

  it('forgets a closed tab entirely', () => {
    store.getState().begin('t1', started, context);
    store.getState().setTransaction('t1', { mode: 'manual', status: 'open' });
    store.getState().forget('t1');
    expect(store.getState().executions['t1']).toBeUndefined();
    expect(store.getState().transactions['t1']).toBeUndefined();
  });
});

describe('against the backend (mock)', () => {
  beforeEach(() => {
    useExecutionStore.getState().reset();
    mockBackend.reset();
    mockBackend.setLatency(0);
    mockBackend.setQueryTick(0);
  });

  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
    expect(await check()).toBe(true);
  };

  it('follows a run through the events and ends with query-finished', async () => {
    const off = startQueryFeed();
    await mockClient.commands.connect('conn-local-pg', null);
    const text = 'select 1 as a; select * from nowhere; select 3;';
    const store = useExecutionStore.getState();
    store.markStarting('tab-a');
    const result = await mockClient.commands.executeQuery({
      tabId: 'tab-a',
      connectionId: 'conn-local-pg',
      database: null,
      text,
      scope: { kind: 'all' },
      limits: null,
    });
    if (result.status !== 'ok') throw new Error('the run should start');
    store.begin('tab-a', result.data, {
      connectionId: 'conn-local-pg',
      database: null,
      sourceText: text,
    });
    await until(() => getTabExecution('tab-a').status === 'failed');
    const done = getTabExecution('tab-a');
    expect(done.results).toHaveLength(1);
    expect(done.messages.at(-1)?.body.kind).toBe('error');
    expect(done.messages.map((m) => m.seq)).toEqual(done.messages.map((_, i) => i));
    off();
  });

  it('restores a tab after a remount from getQueryTab, once', async () => {
    await mockClient.commands.connect('conn-local-pg', null);
    const result = await mockClient.commands.executeQuery({
      tabId: 'tab-b',
      connectionId: 'conn-local-pg',
      database: null,
      text: 'select 1; begin;',
      scope: { kind: 'all' },
      limits: null,
    });
    if (result.status !== 'ok') throw new Error('the run should start');
    // No feed, no begin: this view mounts after the run went by.
    await until(() => mockBackendRan('tab-b'));
    await restoreTab('tab-b');
    const restored = getTabExecution('tab-b');
    expect(restored).toMatchObject({ executionId: result.data.executionId, status: 'succeeded' });
    expect(restored.sourceText).toBeNull();
    expect(restored.results).toHaveLength(1);
    expect(useExecutionStore.getState().transactions['tab-b']?.status).toBe('open');
    // Restoring twice does not ask again.
    useExecutionStore.setState({ executions: {} });
    await restoreTab('tab-b');
    expect(getTabExecution('tab-b').status).toBe('idle');
  });
});

async function mockBackendRan(tabId: string): Promise<boolean> {
  const info = await mockClient.commands.getQueryTab(tabId);
  return info.status === 'ok' && info.data.execution?.status === 'succeeded';
}
