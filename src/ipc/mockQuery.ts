import type {
  ColumnMeta,
  Engine,
  ExecutionDelta,
  ExecutionSnapshot,
  ExecutionStatus,
  PauseReason,
  QueryMessage,
  QueryTabInfo,
  ResultStatus,
  ResultSummary,
  ResultWindow,
  SavedConnection,
  ServerMessage,
  SessionInfo,
  TextPosition,
  TextRange,
  TransactionState,
  Value,
  ValueKind,
  WindowColumn,
  YadbeError,
} from './bindings';
import type { YadbeCommands } from './client';
import type { EventEmitter } from './emitter';
import type { MockHistoryRecord } from './mock/history';
import { mockErrors } from './mockErrors';
import { mockSplit, mockStatementAt } from './mockSplit';

/**
 * Query execution of the mock backend (M1-3 contract). The SQL decides what happens:
 *
 * - `generate_series(a, b)`: `b - a + 1` integers, streamed.
 * - a `huge` table: 1 000 000 rows × 5 columns, streamed; pauses at the row limit.
 * - `big_table` or `wide`: 100 000 rows × 50 columns of mixed kinds, generated lazily.
 * - `empty` or `where false`: the sample columns, no row.
 * - any other `FROM`: the sample `orders` result, 1 284 rows of every kind (NULLs, long
 *   cut text, arrays, a column of mixed kinds).
 * - a `SELECT` without `FROM`: one row of its literals.
 * - `pg_sleep(n)`, `sleep(n)`, `waitfor delay '00:00:n'`: waits n seconds, cancellable.
 * - `nowhere` / `missing_table`: "relation does not exist" with the error position; an
 *   unknown first word: a syntax error at that word.
 * - `raise notice '…'` and `print '…'`: notices.
 * - `insert` / `update` / `delete`: rows affected; `begin` / `commit` / `rollback`: the
 *   transaction status.
 *
 * On a read-only connection, anything but reads is refused before running, like the
 * backend's classifier.
 */

type QueryCommandName =
  | 'splitStatements'
  | 'statementAt'
  | 'executeQuery'
  | 'cancelQuery'
  | 'resumeResult'
  | 'fetchResultWindow'
  | 'fetchResultCell'
  | 'getQueryTab'
  | 'setTransactionMode'
  | 'commitTransaction'
  | 'rollbackTransaction'
  | 'closeQueryTab';

type QueryCommands = Pick<YadbeCommands, QueryCommandName>;

export interface MockQueryHost {
  events: EventEmitter;
  connection(id: string): SavedConnection | undefined;
  session(id: string): SessionInfo | undefined;
  logStatement(connectionId: string | null, connectionName: string, sql: string): void;
  /** A user statement ran, was refused or was cancelled (the history, F-100). */
  recordHistory?(statement: MockHistoryRecord): void;
}

/** A result as an export reads it. */
export interface MockResultSource {
  columns: ColumnMeta[];
  loaded: number;
  total: number;
  value(row: number, column: number): Value;
}

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MAX_WINDOW_ROWS = 2_000;
const CELL_PREVIEW_CHARS = 2_000;
/** Throttle of `query-progress`, like the backend. */
const PROGRESS_MS = 100;
/** Default time between two streamed batches. */
const DEFAULT_TICK_MS = 40;

/** A cell as stored: its kind and lossless text, `null` for SQL `NULL`. */
export type Cell = readonly [ValueKind, string] | null;

interface MockColumn {
  meta: ColumnMeta;
  cell(row: number): Cell;
}

interface MockResult {
  id: number;
  statementIndex: number;
  columns: MockColumn[];
  /** Rows the "server" would send. */
  total: number;
  /** Rows fetched so far. */
  rowCount: number;
  limitRows: number;
  limitBytes: number;
  rowBytes: number;
  status: ResultStatus;
  pausedBy: PauseReason | null;
  resume: ((mode: 'more' | 'all') => void) | null;
}

interface MockExecution {
  id: number;
  tabId: string;
  connectionId: string;
  database: string | null;
  engine: Engine;
  text: string;
  statements: TextRange[];
  startedAt: number;
  startedPerf: number;
  finishedPerf: number | null;
  /** Time spent paused at a result cap, and since when when it is paused now. */
  pausedTotal: number;
  pausedSince: number | null;
  status: ExecutionStatus;
  currentStatement: number | null;
  results: number[];
  messages: QueryMessage[];
  dirtyResults: Set<number>;
  sentMessages: number;
  lastEmit: number;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController;
  maxRows: number;
  maxBytes: number;
}

interface MockTab {
  id: string;
  transaction: TransactionState;
  connectionId: string | null;
  database: string | null;
  execution: MockExecution | null;
}

/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      resolve(true);
    }, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function position(text: string, offset: number): TextPosition {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return {
    offset,
    line: before.split('\n').length,
    column: offset - lastNewline,
  };
}

const col = (name: string, typeName: string, kind: ValueKind, cell: (r: number) => Cell) => ({
  meta: { name, typeName, kind },
  cell,
});

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function timestamp(row: number, zone: boolean): string {
  const base = Date.UTC(2026, 0, 1) + row * 3_607_000;
  const d = new Date(base);
  const text = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return zone ? `${text}+00` : text;
}

function uuid(row: number): string {
  const hex = (row * 2_654_435_761).toString(16).padStart(12, '0').slice(-12);
  return `5f0c${pad(row % 100)}a1-7b2e-4c3d-9e8f-${hex}`;
}

const NAMES = ['Ana', 'Bruno', 'Chloé', 'Dmitri', 'Eun-ji', 'Farah', 'Gus', 'Hélène', 'Ines'];

function sampleColumns(): MockColumn[] {
  return [
    col('id', 'int8', 'int', (r) => ['int', String(9_000_000_000 + r)]),
    col('customer', 'text', 'text', (r) =>
      r % 11 === 3 ? null : ['text', NAMES[r % NAMES.length] ?? 'Ana'],
    ),
    col('email', 'varchar', 'text', (r) =>
      r % 13 === 5 ? ['text', ''] : ['text', `user${r}@example.com`],
    ),
    col('total', 'numeric', 'decimal', (r) => [
      'decimal',
      (((r * 1_297) % 100_000) / 100).toFixed(2),
    ]),
    col('quantity', 'int4', 'int', (r) => ['int', String((r % 9) + 1)]),
    col('ratio', 'float8', 'float', (r) => ['float', String(r / 7)]),
    col('paid', 'bool', 'bool', (r) => (r % 17 === 0 ? null : ['bool', String(r % 3 !== 0)])),
    col('created_at', 'timestamptz', 'timestampTz', (r) => ['timestampTz', timestamp(r, true)]),
    col('ship_date', 'date', 'date', (r) => ['date', timestamp(r + 48, false).slice(0, 10)]),
    col('ref', 'uuid', 'uuid', (r) => ['uuid', uuid(r)]),
    col('payload', 'jsonb', 'json', (r) => [
      'json',
      `{"items": ${r % 5}, "price": 12345678901234567890.25, "note": "n${r}"}`,
    ]),
    col('tags', '_text', 'array', (r) => [
      'array',
      JSON.stringify([
        { kind: 'text', value: `t${r % 4}` },
        r % 2 ? { kind: 'null' } : { kind: 'text', value: 'new' },
      ]),
    ]),
    col('notes', 'text', 'text', (r) =>
      r % 50 === 7 ? ['text', `Long note ${r}: ${'lorem ipsum '.repeat(300)}`] : ['text', '  '],
    ),
    col('misc', '', 'other', (r) => {
      if (r % 3 === 0) return ['int', String(r)];
      if (r % 3 === 1) return ['text', `v${r}`];
      return ['float', String(r + 0.5)];
    }),
    col('blob', 'bytea', 'bytes', (r) => ['bytes', (r * 48_879).toString(16).padStart(8, '0')]),
  ];
}

const WIDE_KINDS: [string, ValueKind][] = [
  ['int8', 'int'],
  ['text', 'text'],
  ['numeric', 'decimal'],
  ['float8', 'float'],
  ['bool', 'bool'],
  ['timestamp', 'timestamp'],
  ['date', 'date'],
  ['uuid', 'uuid'],
  ['jsonb', 'json'],
  ['varchar', 'text'],
];

function wideColumns(count: number): MockColumn[] {
  return Array.from({ length: count }, (_, c) => {
    const [typeName, kind] = WIDE_KINDS[c % WIDE_KINDS.length] ?? ['text', 'text'];
    return col(`col_${pad(c + 1)}`, typeName, kind, (r): Cell => {
      if ((r + c) % 29 === 0) return null;
      switch (kind) {
        case 'int':
          return ['int', String(r * 50 + c)];
        case 'decimal':
          return ['decimal', `${r}.${pad(c)}`];
        case 'float':
          return ['float', String((r + 1) / (c + 1))];
        case 'bool':
          return ['bool', String((r + c) % 2 === 0)];
        case 'timestamp':
          return ['timestamp', timestamp(r + c, false)];
        case 'date':
          return ['date', timestamp(r * 24 + c, false).slice(0, 10)];
        case 'uuid':
          return ['uuid', uuid(r * 50 + c)];
        case 'json':
          return ['json', `{"r": ${r}, "c": ${c}}`];
        default:
          return ['text', `r${r}c${c}`];
      }
    });
  });
}

function hugeColumns(): MockColumn[] {
  return [
    col('id', 'int8', 'int', (r) => ['int', String(r + 1)]),
    col('value', 'float8', 'float', (r) => ['float', String(Math.sin(r))]),
    col('label', 'text', 'text', (r) => ['text', `row ${r + 1}`]),
    col('bucket', 'int4', 'int', (r) => ['int', String(r % 1000)]),
    col('created_at', 'timestamp', 'timestamp', (r) => ['timestamp', timestamp(r, false)]),
  ];
}

/** One row of the literals of a `SELECT` without `FROM`. */
function literalColumns(sql: string): MockColumn[] {
  const list = sql.replace(/^\s*select\s+/i, '').replace(/;?\s*$/, '');
  return list.split(',').map((raw, index) => {
    const expr = raw.trim();
    const alias = /\s+as\s+("?)([\w ]+)\1$/i.exec(expr);
    const value = alias ? expr.slice(0, alias.index).trim() : expr;
    const name = alias?.[2] ?? (index === 0 ? '?column?' : `?column?${index}`);
    if (/^-?\d+$/.test(value)) return col(name, 'int4', 'int', () => ['int', value]);
    if (/^-?\d*\.\d+$/.test(value))
      return col(name, 'numeric', 'decimal', () => ['decimal', value]);
    if (/^'.*'$/.test(value)) {
      return col(name, 'text', 'text', () => ['text', value.slice(1, -1).replace(/''/g, "'")]);
    }
    if (/^(true|false)$/i.test(value)) {
      return col(name, 'bool', 'bool', () => ['bool', value.toLowerCase()]);
    }
    if (/^null$/i.test(value)) return col(name, 'text', 'text', () => null);
    if (/^now\(\)$/i.test(value)) {
      return col(name, 'timestamptz', 'timestampTz', () => ['timestampTz', timestamp(0, true)]);
    }
    return col(name, 'text', 'text', () => ['text', value]);
  });
}

function cellValue(cell: Cell): Value {
  if (!cell) return { kind: 'null' };
  const [kind, text] = cell;
  switch (kind) {
    case 'bool':
      return { kind, value: text === 'true' };
    case 'array':
      return { kind, value: JSON.parse(text) as Value[] };
    default:
      return { kind, value: text };
  }
}

const READ_VERBS = new Set([
  'select',
  'with',
  'values',
  'table',
  'show',
  'explain',
  'pragma',
  'describe',
  'desc',
  'begin',
  'start',
  'commit',
  'end',
  'rollback',
  'savepoint',
  'release',
  'fetch',
]);

const WRITE_WORDS =
  /\b(insert|update|delete|merge|into|truncate|create|drop|alter|grant|revoke|copy|call|do|vacuum|lock|nextval|setval|set_config|analyze|exec|execute)\b/i;

const KNOWN_VERBS = new Set([
  ...READ_VERBS,
  'insert',
  'update',
  'delete',
  'merge',
  'create',
  'drop',
  'alter',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'vacuum',
  'analyze',
  'set',
  'reset',
  'abort',
  'attach',
  'detach',
  'declare',
  'close',
  'listen',
  'notify',
  'lock',
  'comment',
  'refresh',
  'use',
  'exec',
  'execute',
  'print',
  'raise',
  'waitfor',
  'if',
]);

/** The words of a statement, comments and quoted text removed. */
function code(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
}

/** `null` when the statement only reads; else what to name in the refusal. */
function readOnlyRefusal(sql: string): string | null {
  const words = code(sql);
  const verb = /^\w+/.exec(words)?.[0]?.toLowerCase() ?? '';
  if (!READ_VERBS.has(verb)) return verb.toUpperCase();
  if (verb === 'pragma' && words.includes('=')) return 'PRAGMA';
  if (/\bread\s+write\b/i.test(words)) return verb.toUpperCase();
  const write = WRITE_WORDS.exec(words);
  if (write?.[1]) return write[1].toUpperCase();
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(words)) return 'FOR UPDATE';
  return null;
}

export function createMockQuery(host: MockQueryHost) {
  const tabs = new Map<string, MockTab>();
  const results = new Map<number, MockResult>();
  let tick = DEFAULT_TICK_MS;
  let nextExecution = 1;
  let nextResult = 1;

  function tabOf(id: string): MockTab {
    let tab = tabs.get(id);
    if (!tab) {
      tab = {
        id,
        transaction: { mode: 'autoCommit', status: 'idle' },
        connectionId: null,
        database: null,
        execution: null,
      };
      tabs.set(id, tab);
    }
    return tab;
  }

  function running(tab: MockTab): boolean {
    return (
      tab.execution !== null && !['succeeded', 'failed', 'cancelled'].includes(tab.execution.status)
    );
  }

  function setTransaction(tab: MockTab, status: TransactionState['status']): void {
    if (tab.transaction.status === status) return;
    tab.transaction = { ...tab.transaction, status };
    host.events.emit('transactionStateChanged', {
      tabId: tab.id,
      transaction: { ...tab.transaction },
    });
  }

  function summary(result: MockResult): ResultSummary {
    return {
      resultId: result.id,
      statementIndex: result.statementIndex,
      columns: result.columns.map((c) => ({ ...c.meta })),
      rowCount: result.rowCount,
      status: result.status,
      pausedBy: result.pausedBy,
      bytes: Math.min(result.rowCount * result.rowBytes, 0xffffffff),
    };
  }

  function pausedFor(exec: MockExecution): number {
    const now = exec.finishedPerf ?? performance.now();
    return exec.pausedTotal + (exec.pausedSince === null ? 0 : now - exec.pausedSince);
  }

  function elapsed(exec: MockExecution): number {
    return Math.round(
      (exec.finishedPerf ?? performance.now()) - exec.startedPerf - pausedFor(exec),
    );
  }

  function takeDelta(exec: MockExecution): ExecutionDelta {
    const delta: ExecutionDelta = {
      status: exec.status,
      elapsedMs: elapsed(exec),
      pausedMs: Math.round(pausedFor(exec)),
      currentStatement: exec.currentStatement,
      results: [...exec.dirtyResults].flatMap((id) => {
        const result = results.get(id);
        return result ? [summary(result)] : [];
      }),
      messages: exec.messages.slice(exec.sentMessages),
    };
    exec.dirtyResults.clear();
    exec.sentMessages = exec.messages.length;
    return delta;
  }

  function flush(exec: MockExecution): void {
    exec.timer = null;
    if (exec.finishedPerf !== null) return;
    exec.lastEmit = performance.now();
    host.events.emit('queryProgress', {
      tabId: exec.tabId,
      executionId: exec.id,
      delta: takeDelta(exec),
    });
  }

  /** Leading-edge throttle: the first change goes out at once, then one event per 100 ms. */
  function changed(exec: MockExecution): void {
    if (exec.finishedPerf !== null || exec.timer !== null) return;
    const wait = exec.lastEmit + PROGRESS_MS - performance.now();
    if (wait <= 0) flush(exec);
    else
      exec.timer = setTimeout(() => {
        flush(exec);
      }, wait);
  }

  function message(
    exec: MockExecution,
    statementIndex: number | null,
    body: QueryMessage['body'],
  ): void {
    exec.messages.push({
      seq: exec.messages.length,
      statementIndex,
      atMs: elapsed(exec),
      body,
    });
    changed(exec);
  }

  function serverError(
    exec: MockExecution,
    index: number,
    server: ServerMessage,
    offset: number | null,
  ): void {
    message(exec, index, {
      kind: 'error',
      error: mockErrors.queryFailed(
        `${server.severity}: ${server.message}\nSQLSTATE ${server.code ?? ''}`,
      ),
      server,
      position: offset === null ? null : position(exec.text, offset),
    });
  }

  function finish(exec: MockExecution, status: ExecutionStatus): void {
    exec.status = status;
    exec.currentStatement = null;
    if (exec.timer !== null) clearTimeout(exec.timer);
    exec.timer = null;
    const delta = takeDelta(exec);
    exec.finishedPerf = performance.now();
    delta.elapsedMs = elapsed(exec);
    host.events.emit('queryFinished', { tabId: exec.tabId, executionId: exec.id, delta });
  }

  function freeResults(tab: MockTab): void {
    for (const id of tab.execution?.results ?? []) results.delete(id);
  }

  /** Streams a result, pausing at the limits; `false` when cancelled. */
  async function stream(exec: MockExecution, result: MockResult): Promise<boolean> {
    const signal = exec.controller.signal;
    const batch = Math.max(
      500,
      Math.min(50_000, Math.floor(2_000_000 / (result.columns.length * 20))),
    );
    let first = true;
    while (result.rowCount < result.total) {
      if (!(await sleep(first ? tick / 2 : tick, signal))) return false;
      first = false;
      const byBytes = Math.floor(result.limitBytes / Math.max(1, result.rowBytes));
      const cap = Math.min(result.limitRows, byBytes);
      result.rowCount = Math.min(result.total, cap, result.rowCount + batch);
      exec.dirtyResults.add(result.id);
      changed(exec);
      if (result.rowCount >= cap && result.rowCount < result.total) {
        result.status = 'paused';
        result.pausedBy = cap === result.limitRows ? 'rowLimit' : 'memoryLimit';
        exec.status = 'paused';
        exec.pausedSince = performance.now();
        exec.dirtyResults.add(result.id);
        changed(exec);
        const pausedAt = performance.now();
        const mode = await new Promise<'more' | 'all' | null>((resolve) => {
          result.resume = resolve;
          signal.addEventListener('abort', () => {
            resolve(null);
          });
        });
        result.resume = null;
        exec.pausedTotal += performance.now() - pausedAt;
        exec.pausedSince = null;
        if (!mode) return false;
        if (mode === 'all') {
          result.limitRows = Infinity;
          result.limitBytes = Infinity;
        } else {
          result.limitRows += exec.maxRows;
          result.limitBytes += exec.maxBytes;
        }
        result.status = 'streaming';
        result.pausedBy = null;
        exec.status = 'running';
        exec.dirtyResults.add(result.id);
        changed(exec);
      }
    }
    return true;
  }

  function newResult(exec: MockExecution, index: number, columns: MockColumn[], total: number) {
    const result: MockResult = {
      id: nextResult++,
      statementIndex: index,
      columns,
      total,
      rowCount: 0,
      limitRows: exec.maxRows,
      limitBytes: exec.maxBytes,
      rowBytes: 32 + columns.length * 14,
      status: 'streaming',
      pausedBy: null,
      resume: null,
    };
    results.set(result.id, result);
    exec.results.push(result.id);
    exec.dirtyResults.add(result.id);
    changed(exec);
    return result;
  }

  type Outcome = 'ok' | 'error' | 'cancelled';

  async function runStatement(exec: MockExecution, tab: MockTab, index: number): Promise<Outcome> {
    const range = exec.statements[index];
    if (!range) return 'error';
    const sql = exec.text.slice(range.from, range.to);
    const words = code(sql);
    const lower = words.toLowerCase();
    const verb = /^\w+/.exec(lower)?.[0] ?? '';
    const started = performance.now();
    const pausedBefore = exec.pausedTotal;
    const signal = exec.controller.signal;
    const completed = (extra: { rowsAffected?: number; result?: MockResult }) => {
      message(exec, index, {
        kind: 'statementCompleted',
        durationMs:
          Math.round((performance.now() - started - (exec.pausedTotal - pausedBefore)) * 10) / 10,
        pausedMs: Math.round(exec.pausedTotal - pausedBefore),
        rowsAffected: extra.rowsAffected ?? null,
        rowsReturned: extra.result ? extra.result.rowCount : null,
        resultId: extra.result ? extra.result.id : null,
      });
    };
    const cancelled = (result?: MockResult): Outcome => {
      if (result) {
        result.status = 'cancelled';
        exec.dirtyResults.add(result.id);
      }
      message(exec, index, {
        kind: 'error',
        error: mockErrors.cancelled(),
        server: null,
        position: null,
      });
      return 'cancelled';
    };
    const failed = (): Outcome => {
      if (exec.engine === 'postgres' && tab.transaction.status === 'open') {
        setTransaction(tab, 'failed');
      }
      return 'error';
    };

    if (!(await sleep(tick / 4, signal))) return cancelled();

    if (
      tab.transaction.status === 'failed' &&
      !['rollback', 'abort', 'commit', 'end'].includes(verb)
    ) {
      serverError(
        exec,
        index,
        {
          severity: 'ERROR',
          code: '25P02',
          message:
            'current transaction is aborted, commands ignored until end of transaction block',
          detail: null,
          hint: null,
        },
        null,
      );
      return 'error';
    }

    if (!KNOWN_VERBS.has(verb)) {
      const word = /^\S+/.exec(sql.trimStart())?.[0] ?? sql;
      serverError(
        exec,
        index,
        {
          severity: 'ERROR',
          code: '42601',
          message: `syntax error at or near "${word}"`,
          detail: null,
          hint: null,
        },
        range.from + sql.length - sql.trimStart().length,
      );
      return failed();
    }

    const missing = /\b(nowhere|missing_table)\b/i.exec(sql);
    if (missing?.[1]) {
      serverError(
        exec,
        index,
        {
          severity: 'ERROR',
          code: '42P01',
          message: `relation "${missing[1]}" does not exist`,
          detail: null,
          hint: null,
        },
        range.from + missing.index,
      );
      return failed();
    }

    for (const notice of sql.matchAll(
      /\b(?:raise\s+(notice|warning|info)|print)\s+'((?:[^']|'')*)'/gi,
    )) {
      message(exec, index, {
        kind: 'notice',
        severity: (notice[1] ?? 'info').toUpperCase(),
        code: notice[1] ? '00000' : null,
        message: (notice[2] ?? '').replace(/''/g, "'"),
        detail: null,
        hint: null,
      });
    }

    if (verb === 'begin' || verb === 'start') {
      setTransaction(tab, 'open');
      completed({});
      return 'ok';
    }
    if (['commit', 'end', 'rollback', 'abort'].includes(verb) && !/\bto\b/.test(lower)) {
      setTransaction(tab, 'idle');
      completed({});
      return 'ok';
    }

    const pause = /\b(?:pg_sleep|sleep)\s*\(\s*([\d.]+)\s*\)|waitfor\s+delay\s+''/i.exec(words);
    if (pause) {
      const seconds = pause[1] ? Number(pause[1]) : Number(/(\d+)'/.exec(sql)?.[1] ?? '1');
      if (!(await sleep(seconds * 1000, signal))) return cancelled();
      if (verb === 'select') {
        const result = newResult(
          exec,
          index,
          [col('pg_sleep', 'void', 'other', () => ['other', ''])],
          1,
        );
        result.rowCount = 1;
        result.status = 'complete';
        completed({ result });
      } else completed({});
      return 'ok';
    }

    if (verb === 'insert') {
      const tuples = /\bvalues\b/.test(lower) ? (lower.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1 : 3;
      completed({ rowsAffected: tuples });
      return 'ok';
    }
    if (verb === 'update' || verb === 'delete' || verb === 'merge') {
      completed({ rowsAffected: /\bwhere\b/.test(lower) ? 1 : 1284 });
      return 'ok';
    }

    if (['select', 'with', 'values', 'table', 'show', 'explain', 'pragma'].includes(verb)) {
      const series = /generate_series\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(lower);
      let columns: MockColumn[];
      let total: number;
      if (series) {
        const from = Number(series[1]);
        columns = [col('generate_series', 'int4', 'int', (r) => ['int', String(from + r)])];
        total = Math.max(0, Number(series[2]) - from + 1);
      } else if (/\bhuge\b/.test(lower)) {
        columns = hugeColumns();
        total = 1_000_000;
      } else if (/\b(big_table|wide)\b/.test(lower)) {
        columns = wideColumns(50);
        total = 100_000;
      } else if (verb === 'select' && !/\bfrom\b/.test(lower)) {
        columns = literalColumns(sql);
        total = 1;
      } else {
        columns = sampleColumns();
        total = /\bempty\b|\bwhere\s+false\b/.test(lower) ? 0 : 1284;
      }
      const result = newResult(exec, index, columns, total);
      if (!(await stream(exec, result))) return cancelled(result);
      result.status = 'complete';
      exec.dirtyResults.add(result.id);
      completed({ result });
      return 'ok';
    }

    completed({});
    return 'ok';
  }

  /** Hands a statement that ran (or was refused) to the history, with what its messages say. */
  function recordStatement(
    exec: MockExecution,
    index: number,
    startedAt: number,
    durationMs: number,
    outcome: Outcome | 'refused',
    refusal: YadbeError | null = null,
  ): void {
    const range = exec.statements[index];
    if (!range) return;
    const own = exec.messages.filter((m) => m.statementIndex === index);
    const failure = own.find((m) => m.body.kind === 'error')?.body;
    const completed = own.find((m) => m.body.kind === 'statementCompleted')?.body;
    const error = refusal ?? (failure?.kind === 'error' ? failure.error : null);
    const status =
      outcome === 'refused' || outcome === 'cancelled' ? outcome : error ? 'error' : 'ok';
    host.recordHistory?.({
      connectionId: exec.connectionId,
      database: exec.database,
      sql: exec.text.slice(range.from, range.to),
      startedAt,
      durationMs,
      rows:
        completed?.kind === 'statementCompleted'
          ? (completed.rowsReturned ?? completed.rowsAffected)
          : null,
      outcome: status,
      error: status === 'cancelled' ? (error ?? mockErrors.cancelled()) : error,
    });
  }

  async function run(exec: MockExecution, tab: MockTab, conn: SavedConnection): Promise<void> {
    const signal = exec.controller.signal;
    if (exec.status === 'connecting') {
      if (!(await sleep(tick * 3, signal))) {
        finish(exec, 'cancelled');
        return;
      }
      host.logStatement(
        conn.id,
        conn.definition.name,
        conn.definition.engine === 'sqlite' ? 'SELECT sqlite_version()' : 'SHOW server_version',
      );
      tab.connectionId = exec.connectionId;
      tab.database = exec.database;
      exec.status = 'running';
      changed(exec);
    }
    if (conn.definition.readOnly) {
      for (const [index, range] of exec.statements.entries()) {
        const refusal = readOnlyRefusal(exec.text.slice(range.from, range.to));
        if (refusal !== null) {
          const error = mockErrors.readOnlyViolation(refusal);
          message(exec, index, {
            kind: 'error',
            error,
            server: null,
            position: position(exec.text, range.from),
          });
          recordStatement(exec, index, Date.now(), 0, 'refused', error);
          finish(exec, 'failed');
          return;
        }
      }
    }
    for (const index of exec.statements.keys()) {
      exec.currentStatement = index;
      changed(exec);
      if (tab.transaction.mode === 'manual' && tab.transaction.status === 'idle') {
        host.logStatement(conn.id, conn.definition.name, 'BEGIN');
        setTransaction(tab, 'open');
      }
      const startedAt = Date.now();
      const startedPerf = performance.now();
      const outcome = await runStatement(exec, tab, index);
      recordStatement(exec, index, startedAt, performance.now() - startedPerf, outcome);
      if (outcome !== 'ok') {
        finish(exec, outcome === 'cancelled' ? 'cancelled' : 'failed');
        return;
      }
    }
    finish(exec, 'succeeded');
  }

  function snapshot(exec: MockExecution): ExecutionSnapshot {
    return {
      executionId: exec.id,
      connectionId: exec.connectionId,
      database: exec.database,
      statements: exec.statements.map((r) => ({ ...r })),
      startedAt: exec.startedAt,
      status: exec.status,
      elapsedMs: elapsed(exec),
      pausedMs: Math.round(pausedFor(exec)),
      currentStatement: exec.currentStatement,
      results: exec.results.flatMap((id) => {
        const result = results.get(id);
        return result ? [summary(result)] : [];
      }),
      messages: structuredClone(exec.messages),
    };
  }

  function info(tab: MockTab): QueryTabInfo {
    return {
      tabId: tab.id,
      transaction: { ...tab.transaction },
      connectionId: tab.connectionId,
      database: tab.database,
      execution: tab.execution ? snapshot(tab.execution) : null,
    };
  }

  function endTransaction(tabId: string, sql: 'COMMIT' | 'ROLLBACK'): Result<TransactionState> {
    const tab = tabs.get(tabId);
    if (!tab) return ok({ mode: 'autoCommit', status: 'idle' });
    if (running(tab)) return fail(mockErrors.executionRunning());
    if (tab.transaction.status !== 'idle' && tab.connectionId !== null) {
      const conn = host.connection(tab.connectionId);
      host.logStatement(tab.connectionId, conn?.definition.name ?? '', sql);
      setTransaction(tab, 'idle');
    }
    return ok({ ...tab.transaction });
  }

  function closeTab(tab: MockTab): void {
    tab.execution?.controller.abort();
    freeResults(tab);
    tabs.delete(tab.id);
  }

  /** A closed or lost connection takes the tabs' own connections (and transactions) along. */
  host.events.subscribe('connectionStateChanged', ({ session }) => {
    if (session.state !== 'closed' && session.state !== 'lost') return;
    for (const tab of tabs.values()) {
      if (tab.connectionId !== session.connectionId) continue;
      tab.execution?.controller.abort();
      tab.connectionId = null;
      tab.database = null;
      setTransaction(tab, 'idle');
    }
  });

  const commands: QueryCommands = {
    splitStatements: (engine, text) =>
      ok(mockSplit(engine, text).map(({ from, to }) => ({ from, to }))),

    statementAt: (engine, text, offset) => {
      const found = mockStatementAt(engine, text, offset);
      return ok(found ? { from: found.from, to: found.to } : null);
    },

    executeQuery: (request) => {
      const conn = host.connection(request.connectionId);
      if (!conn) return fail(mockErrors.connectionNotFound(request.connectionId));
      if (host.session(request.connectionId)?.state !== 'connected') {
        return fail(mockErrors.notConnected());
      }
      const tab = tabOf(request.tabId);
      if (running(tab)) return fail(mockErrors.executionRunning());
      const engine = conn.definition.engine;
      const database = engine === 'sqlite' ? null : request.database;
      const sameTarget = tab.connectionId === request.connectionId && tab.database === database;
      if (!sameTarget && tab.transaction.status !== 'idle') {
        return fail(mockErrors.transactionOpen());
      }
      let statements: TextRange[];
      const { scope, text } = request;
      if (scope.kind === 'all') statements = mockSplit(engine, text);
      else if (scope.kind === 'range') {
        statements = mockSplit(engine, text.slice(scope.from, scope.to)).map((st) => ({
          from: st.from + scope.from,
          to: st.to + scope.from,
        }));
      } else {
        const found = mockStatementAt(engine, text, scope.offset);
        statements = found ? [found] : [];
      }
      statements = statements.map(({ from, to }) => ({ from, to }));
      if (statements.length === 0) {
        return fail(
          mockErrors.invalidArgument(
            'There is no statement to run.',
            "Il n'y a aucune instruction à exécuter.",
          ),
        );
      }
      freeResults(tab);
      if (!sameTarget) {
        tab.connectionId = null;
        tab.database = null;
      }
      const exec: MockExecution = {
        id: nextExecution++,
        tabId: tab.id,
        connectionId: request.connectionId,
        database,
        engine,
        text,
        statements,
        startedAt: Date.now(),
        startedPerf: performance.now(),
        finishedPerf: null,
        pausedTotal: 0,
        pausedSince: null,
        status: sameTarget ? 'running' : 'connecting',
        currentStatement: null,
        results: [],
        messages: [],
        dirtyResults: new Set(),
        sentMessages: 0,
        lastEmit: 0,
        timer: null,
        controller: new AbortController(),
        maxRows: request.limits?.maxRows ?? DEFAULT_MAX_ROWS,
        maxBytes: request.limits?.maxBytes ?? DEFAULT_MAX_BYTES,
      };
      tab.execution = exec;
      void run(exec, tab, conn);
      return ok({ executionId: exec.id, statements: statements.map((r) => ({ ...r })) });
    },

    cancelQuery: (tabId) => {
      const tab = tabs.get(tabId);
      if (tab && running(tab)) tab.execution?.controller.abort();
      return ok(null);
    },

    resumeResult: (resultId, mode) => {
      const result = results.get(resultId);
      if (!result) return fail(mockErrors.resultNotFound(resultId));
      result.resume?.(mode);
      return ok(null);
    },

    fetchResultWindow: (resultId, offset, limit) => {
      const result = results.get(resultId);
      if (!result) return fail(mockErrors.resultNotFound(resultId));
      if (limit > MAX_WINDOW_ROWS) {
        return fail(
          mockErrors.invalidArgument(
            `A window has at most ${MAX_WINDOW_ROWS} rows.`,
            `Une fenêtre compte au plus ${MAX_WINDOW_ROWS} lignes.`,
          ),
        );
      }
      const start = Math.min(offset, result.rowCount);
      const count = Math.max(0, Math.min(limit, result.rowCount - start));
      const columns: WindowColumn[] = result.columns.map((column) => {
        const values: (string | null)[] = [];
        const kinds: ValueKind[] = [];
        const truncated: number[] = [];
        let mixed = false;
        for (let i = 0; i < count; i++) {
          const cell = column.cell(start + i);
          if (!cell) {
            values.push(null);
            kinds.push(column.meta.kind);
            continue;
          }
          const [kind, text] = cell;
          if (kind !== column.meta.kind) mixed = true;
          kinds.push(kind);
          if (text.length > CELL_PREVIEW_CHARS) {
            truncated.push(i);
            values.push(text.slice(0, CELL_PREVIEW_CHARS));
          } else values.push(text);
        }
        return { values, kinds: mixed ? kinds : null, truncated };
      });
      const window: ResultWindow = { resultId, offset: start, rowCount: count, columns };
      return ok(window);
    },

    fetchResultCell: (resultId, row, column) => {
      const result = results.get(resultId);
      if (!result) return fail(mockErrors.resultNotFound(resultId));
      const target = result.columns[column];
      if (!target || row >= result.rowCount) {
        return fail(
          mockErrors.invalidArgument(
            'This cell is outside the result.',
            'Cette cellule est hors du résultat.',
          ),
        );
      }
      return ok(cellValue(target.cell(row)));
    },

    getQueryTab: (tabId) => ok(info(tabs.get(tabId) ?? tabOf(tabId))),

    setTransactionMode: (tabId, mode) => {
      const tab = tabOf(tabId);
      if (running(tab)) return fail(mockErrors.executionRunning());
      if (tab.transaction.status !== 'idle') return fail(mockErrors.transactionOpen());
      if (tab.transaction.mode !== mode) {
        tab.transaction = { ...tab.transaction, mode };
        host.events.emit('transactionStateChanged', {
          tabId,
          transaction: { ...tab.transaction },
        });
      }
      return ok({ ...tab.transaction });
    },

    commitTransaction: (tabId) => endTransaction(tabId, 'COMMIT'),

    rollbackTransaction: (tabId) => endTransaction(tabId, 'ROLLBACK'),

    closeQueryTab: (tabId) => {
      const tab = tabs.get(tabId);
      if (tab) closeTab(tab);
      return ok(null);
    },
  };

  return {
    commands,
    /**
     * What an export reads (M2-7): the columns, the rows loaded so far and every row the
     * "server" would send, which a result paused at its limit does not hold.
     */
    resultSource(resultId: number): MockResultSource | undefined {
      const result = results.get(resultId);
      if (!result) return undefined;
      return {
        columns: result.columns.map((column) => column.meta),
        loaded: result.rowCount,
        total: result.total,
        value: (row, column) => cellValue(result.columns[column]?.cell(row) ?? null),
      };
    },
    /**
     * Stores finished rows (table pages, M2-1) where `fetchResultWindow` / `fetchResultCell`
     * read them, like the backend's shared result store; returns the result id.
     */
    storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number {
      const data = rows.map((row) => [...row]);
      const result: MockResult = {
        id: nextResult++,
        statementIndex: 0,
        columns: columns.map((meta, c) => ({ meta, cell: (row) => data[row]?.[c] ?? null })),
        total: data.length,
        rowCount: data.length,
        limitRows: DEFAULT_MAX_ROWS,
        limitBytes: DEFAULT_MAX_BYTES,
        rowBytes: 32 + columns.length * 14,
        status: 'complete',
        pausedBy: null,
        resume: null,
      };
      results.set(result.id, result);
      return result.id;
    },
    freeResults(ids: readonly number[]): void {
      for (const id of ids) results.delete(id);
    },
    /** Time between two streamed batches, in ms (0 in unit tests). */
    setTick(ms: number): void {
      tick = ms;
    },
    reset(): void {
      for (const tab of [...tabs.values()]) closeTab(tab);
      results.clear();
      tick = DEFAULT_TICK_MS;
      nextExecution = 1;
      nextResult = 1;
    },
  };
}
