import type {
  ExecutionDelta,
  ExecutionSnapshot,
  ExecutionStarted,
  ExecutionStatus,
  QueryMessage,
  ResultSummary,
  TextRange,
  YadbeError,
} from '../../ipc';

/**
 * What a query tab knows of its latest execution. Built from `executeQuery`'s answer, then from
 * the deltas of `query-progress` / `query-finished`, or from `getQueryTab` after a remount.
 */
export interface TabExecution {
  /** `null` before the first run of the tab. */
  executionId: number | null;
  status: ExecutionStatus | 'idle';
  connectionId: string | null;
  database: string | null;
  /** The statements that run, in order: `statementIndex` of results and messages indexes them. */
  statements: TextRange[];
  /**
   * The editor text the ranges and error positions refer to; `null` when restored after a
   * remount (the backend does not hand the text back).
   */
  sourceText: string | null;
  /** Active milliseconds since the start (pauses at a result cap left out), as last reported. */
  elapsedMs: number;
  /** Milliseconds the run spent paused at a result cap, waiting for the user. */
  pausedMs: number;
  /** `performance.now()` when `elapsedMs` was reported, to tick it live between events. */
  elapsedAt: number;
  /** The statement running (or paused), `null` otherwise. */
  currentStatement: number | null;
  results: ResultSummary[];
  messages: QueryMessage[];
  /** Why `executeQuery` refused to start (not connected, transaction open…). */
  startError: YadbeError | null;
}

export const IDLE_EXECUTION: TabExecution = {
  executionId: null,
  status: 'idle',
  connectionId: null,
  database: null,
  statements: [],
  sourceText: null,
  elapsedMs: 0,
  pausedMs: 0,
  elapsedAt: 0,
  currentStatement: null,
  results: [],
  messages: [],
  startError: null,
};

/** Still working: the Cancel button is on and Run is off. */
export function isActive(status: TabExecution['status']): boolean {
  return status === 'connecting' || status === 'running' || status === 'paused';
}

/**
 * Run is on unless the server is busy. A run paused at its result cap does not block it: the
 * new run cancels the paused one, which holds no side effect to lose.
 */
export function canRun(status: TabExecution['status']): boolean {
  return !isActive(status) || status === 'paused';
}

export function isFinished(status: TabExecution['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function beginExecution(
  started: ExecutionStarted,
  context: { connectionId: string; database: string | null; sourceText: string },
  now: number,
): TabExecution {
  return {
    ...IDLE_EXECUTION,
    executionId: started.executionId,
    status: 'connecting',
    connectionId: context.connectionId,
    database: context.database,
    statements: started.statements,
    sourceText: context.sourceText,
    elapsedAt: now,
  };
}

/** An execution that could not start: shown in the results area as a failed run. */
export function failedToStart(
  error: YadbeError,
  context: { connectionId: string; database: string | null },
  now: number,
): TabExecution {
  return {
    ...IDLE_EXECUTION,
    status: 'failed',
    connectionId: context.connectionId,
    database: context.database,
    elapsedAt: now,
    startError: error,
  };
}

export function fromSnapshot(snapshot: ExecutionSnapshot, now: number): TabExecution {
  return {
    executionId: snapshot.executionId,
    status: snapshot.status,
    connectionId: snapshot.connectionId,
    database: snapshot.database,
    statements: snapshot.statements,
    sourceText: null,
    elapsedMs: snapshot.elapsedMs,
    pausedMs: snapshot.pausedMs,
    elapsedAt: now,
    currentStatement: snapshot.currentStatement,
    results: snapshot.results,
    messages: snapshot.messages,
    startError: null,
  };
}

function mergeResults(current: ResultSummary[], changed: ResultSummary[]): ResultSummary[] {
  if (changed.length === 0) return current;
  const next = [...current];
  for (const result of changed) {
    const at = next.findIndex((known) => known.resultId === result.resultId);
    if (at === -1) next.push(result);
    else next[at] = result;
  }
  return next;
}

/**
 * Applies one event's delta. Returns `execution` itself when the event does not concern it: a
 * stale execution, a finished one (`query-finished` is always last) or an event older than what
 * a snapshot already holds.
 */
export function applyDelta(
  execution: TabExecution,
  executionId: number,
  delta: ExecutionDelta,
  now: number,
): TabExecution {
  if (execution.executionId !== executionId) return execution;
  if (isFinished(execution.status)) return execution;
  if (delta.elapsedMs < execution.elapsedMs) return execution;
  const lastSeq = execution.messages.at(-1)?.seq ?? -1;
  const added = delta.messages.filter((message) => message.seq > lastSeq);
  return {
    ...execution,
    status: delta.status,
    elapsedMs: delta.elapsedMs,
    pausedMs: delta.pausedMs,
    elapsedAt: now,
    currentStatement: delta.currentStatement,
    results: mergeResults(execution.results, delta.results),
    messages: added.length === 0 ? execution.messages : [...execution.messages, ...added],
  };
}

/**
 * The server is working on the run: the elapsed time ticks and a spinner shows. A run paused at
 * its result cap is waiting for the user, so its time stands still until it resumes.
 */
export function isWorking(status: TabExecution['status']): boolean {
  return status === 'connecting' || status === 'running';
}

/** Elapsed time to show: the backend's figure plus what passed since, while the run works. */
export function liveElapsed(execution: TabExecution, now: number): number {
  if (!isWorking(execution.status)) return execution.elapsedMs;
  return execution.elapsedMs + Math.max(0, now - execution.elapsedAt);
}

/** Tab to show first among the results area's sub-tabs for an execution. */
export type ResultsSelection = { kind: 'result'; resultId: number } | { kind: 'messages' };

/**
 * The sub-tab to show when the user has not picked one: the first result of a run that went
 * well, the messages when nothing returned rows or something went wrong.
 */
export function defaultSelection(execution: TabExecution): ResultsSelection {
  const first = execution.results[0];
  if (first && execution.status !== 'failed' && execution.status !== 'cancelled') {
    return { kind: 'result', resultId: first.resultId };
  }
  return { kind: 'messages' };
}

/** The user's pick if it still exists, else what the run suggests. */
export function effectiveSelection(
  picked: ResultsSelection | undefined,
  execution: TabExecution,
): ResultsSelection {
  if (picked?.kind === 'messages') return picked;
  if (picked?.kind === 'result') {
    if (execution.results.some((result) => result.resultId === picked.resultId)) return picked;
  }
  return defaultSelection(execution);
}

/** Counts shown in the summary line of the results area. */
export function summarizeExecution(execution: TabExecution): {
  statements: number;
  completed: number;
  errors: number;
} {
  let completed = 0;
  let errors = 0;
  for (const { body } of execution.messages) {
    if (body.kind === 'statementCompleted') completed += 1;
    else if (body.kind === 'error') errors += 1;
  }
  return { statements: execution.statements.length, completed, errors };
}
