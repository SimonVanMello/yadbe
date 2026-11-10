import { useEffect, useState } from 'react';
import { create } from 'zustand';

import {
  ipc,
  unwrap,
  type ExecutionDelta,
  type ExecutionStarted,
  type TransactionState,
  type YadbeError,
} from '../../ipc';
import {
  IDLE_EXECUTION,
  applyDelta,
  beginExecution,
  failedToStart,
  fromSnapshot,
  isActive,
  liveElapsed,
  type ResultsSelection,
  type TabExecution,
} from './executionModel';

/**
 * The per-tab execution store: the seam between the backend's execution events and every view of
 * a query tab (results area, toolbar, status bar, history, export…).
 *
 * - `useTabExecution(tabId)`: the latest execution of the tab (`IDLE_EXECUTION` before a run).
 *   `results` are the `ResultSummary` of the run, already merged by `resultId`; `messages` are in
 *   `seq` order; `status` is `'idle'` until the first run.
 * - `useTabTransaction(tabId)`: the tab's transaction mode and status.
 * - `useTabRunning(tabId)`: whether the tab has an execution in progress.
 * - `useElapsedMs(tabId)`: elapsed time of the run, ticking live while it is in progress.
 * - `getTabExecution(tabId)` / `getTabTransaction(tabId)`: the same without subscribing.
 *
 * The store is fed by `startQueryFeed()` (events, for the life of the app) and by `runQuery`
 * (`queryActions.ts`); a view that mounts after a remount calls `restoreTab(tabId)`.
 */

interface EarlyEvent {
  executionId: number;
  delta: ExecutionDelta;
}

interface ExecutionStore {
  executions: Record<string, TabExecution>;
  transactions: Record<string, TransactionState>;
  /** Sub-tab picked by the user in the results area; absent: follow the default. */
  selections: Record<string, ResultsSelection>;
  /** Tabs whose `executeQuery` is in flight: events can arrive before its answer. */
  starting: Record<string, true>;
  early: Record<string, EarlyEvent[]>;
  /** Tabs already restored from `getQueryTab` (or that ran): no need to ask again. */
  restored: Record<string, true>;
  markStarting: (tabId: string) => void;
  begin: (
    tabId: string,
    started: ExecutionStarted,
    context: { connectionId: string; database: string | null; sourceText: string },
  ) => void;
  startFailed: (
    tabId: string,
    error: YadbeError,
    context: { connectionId: string; database: string | null },
  ) => void;
  /** Applies an event's delta, or buffers it while the start is in flight. */
  receive: (tabId: string, executionId: number, delta: ExecutionDelta) => void;
  setTransaction: (tabId: string, transaction: TransactionState) => void;
  select: (tabId: string, selection: ResultsSelection | null) => void;
  /** Forgets everything about a closed tab. */
  forget: (tabId: string) => void;
  /** Drops the tab's execution (its connection was closed or lost, results are gone). */
  reset: () => void;
}

const AUTO_COMMIT_IDLE: TransactionState = { mode: 'autoCommit', status: 'idle' };

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

export function createExecutionStore() {
  return create<ExecutionStore>()((set, get) => ({
    executions: {},
    transactions: {},
    selections: {},
    starting: {},
    early: {},
    restored: {},

    markStarting: (tabId) => {
      set((state) => ({
        starting: { ...state.starting, [tabId]: true },
        restored: { ...state.restored, [tabId]: true },
      }));
    },

    begin: (tabId, started, context) => {
      const now = performance.now();
      let execution = beginExecution(started, context, now);
      const buffered = get().early[tabId] ?? [];
      for (const event of buffered) {
        execution = applyDelta(execution, event.executionId, event.delta, now);
      }
      set((state) => ({
        executions: { ...state.executions, [tabId]: execution },
        starting: without(state.starting, tabId),
        early: without(state.early, tabId),
        selections: without(state.selections, tabId),
      }));
    },

    startFailed: (tabId, error, context) => {
      set((state) => ({
        executions: {
          ...state.executions,
          [tabId]: failedToStart(error, context, performance.now()),
        },
        starting: without(state.starting, tabId),
        early: without(state.early, tabId),
        selections: without(state.selections, tabId),
      }));
    },

    receive: (tabId, executionId, delta) => {
      const { executions, starting } = get();
      const current = executions[tabId];
      if (starting[tabId] && (current?.executionId ?? 0) < executionId) {
        // `executeQuery` has not answered yet: keep the event for `begin`.
        set((state) => ({
          early: {
            ...state.early,
            [tabId]: [...(state.early[tabId] ?? []), { executionId, delta }],
          },
        }));
        return;
      }
      if (!current) return;
      const next = applyDelta(current, executionId, delta, performance.now());
      if (next !== current) set({ executions: { ...executions, [tabId]: next } });
    },

    setTransaction: (tabId, transaction) => {
      set((state) => ({ transactions: { ...state.transactions, [tabId]: transaction } }));
    },

    select: (tabId, selection) => {
      set((state) => ({
        selections:
          selection === null
            ? without(state.selections, tabId)
            : { ...state.selections, [tabId]: selection },
      }));
    },

    forget: (tabId) => {
      set((state) => ({
        executions: without(state.executions, tabId),
        transactions: without(state.transactions, tabId),
        selections: without(state.selections, tabId),
        starting: without(state.starting, tabId),
        early: without(state.early, tabId),
        restored: without(state.restored, tabId),
      }));
    },

    reset: () => {
      set({
        executions: {},
        transactions: {},
        selections: {},
        starting: {},
        early: {},
        restored: {},
      });
    },
  }));
}

export const useExecutionStore = createExecutionStore();

export function getTabExecution(tabId: string): TabExecution {
  return useExecutionStore.getState().executions[tabId] ?? IDLE_EXECUTION;
}

export function getTabTransaction(tabId: string): TransactionState {
  return useExecutionStore.getState().transactions[tabId] ?? AUTO_COMMIT_IDLE;
}

export function useTabExecution(tabId: string): TabExecution {
  return useExecutionStore((state) => state.executions[tabId] ?? IDLE_EXECUTION);
}

export function useTabTransaction(tabId: string): TransactionState {
  return useExecutionStore((state) => state.transactions[tabId] ?? AUTO_COMMIT_IDLE);
}

export function useTabRunning(tabId: string): boolean {
  return useExecutionStore((state) => isActive((state.executions[tabId] ?? IDLE_EXECUTION).status));
}

/** Elapsed time of the tab's run in ms, refreshed ten times a second while it is in progress. */
export function useElapsedMs(tabId: string): number {
  const execution = useTabExecution(tabId);
  const active = isActive(execution.status);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setNow(performance.now());
    }, 100);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return liveElapsed(execution, active ? Math.max(now, execution.elapsedAt) : now);
}

/** Reads the tab's state from the backend after a remount (`getQueryTab`), once per tab. */
export async function restoreTab(tabId: string): Promise<void> {
  const store = useExecutionStore.getState();
  if (store.restored[tabId]) return;
  useExecutionStore.setState((state) => ({ restored: { ...state.restored, [tabId]: true } }));
  try {
    const info = await unwrap(ipc.commands.getQueryTab(tabId));
    useExecutionStore.setState((state) => ({
      transactions: { ...state.transactions, [tabId]: info.transaction },
      // A run that started meanwhile, or events already applied, are newer than this snapshot.
      executions:
        info.execution && !state.executions[tabId] && !state.starting[tabId]
          ? { ...state.executions, [tabId]: fromSnapshot(info.execution, performance.now()) }
          : state.executions,
    }));
  } catch (error) {
    console.warn('Could not restore the state of a query tab', error);
  }
}

let feed: (() => void) | undefined;

/** Follows the backend's execution and transaction events for the life of the app. */
export function startQueryFeed(): () => void {
  if (feed) return feed;
  const offProgress = ipc.events.subscribe('queryProgress', (event) => {
    useExecutionStore.getState().receive(event.tabId, event.executionId, event.delta);
  });
  const offFinished = ipc.events.subscribe('queryFinished', (event) => {
    useExecutionStore.getState().receive(event.tabId, event.executionId, event.delta);
  });
  const offTransaction = ipc.events.subscribe('transactionStateChanged', (event) => {
    useExecutionStore.getState().setTransaction(event.tabId, event.transaction);
  });
  feed = () => {
    offProgress();
    offFinished();
    offTransaction();
    feed = undefined;
  };
  return feed;
}
