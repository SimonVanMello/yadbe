import type {
  Engine,
  ErrorCode,
  HistoryOutcome,
  HistoryPage,
  HistoryQuery,
  HistoryRow,
  HistoryScope,
  SavedConnection,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import type { EventEmitter } from '../emitter';
import { MOCK_CONNECTIONS } from '../mockData';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The history commands the mock implements. */
export type HistoryCommands = Pick<
  Commands,
  'searchHistory' | 'getHistoryEntry' | 'deleteHistoryEntry' | 'countHistory' | 'clearHistory'
>;

/** What the history mock needs from the rest of the mock backend. */
export interface HistoryDeps {
  events: EventEmitter;
  connection(id: string): SavedConnection | undefined;
}

/** A row with its numbers always set (the generated type allows `null` for `f64`). */
type Row = Omit<HistoryRow, 'id' | 'startedAt' | 'durationMs'> & {
  id: number;
  startedAt: number;
  durationMs: number;
};

/** A statement the mock query runner ran (or refused, or cancelled). */
export interface MockHistoryRecord {
  /** The editor tab it ran in (F-102). */
  tabId: string;
  connectionId: string;
  database: string | null;
  sql: string;
  /** Unix time in ms. */
  startedAt: number;
  durationMs: number;
  rows: number | null;
  outcome: HistoryOutcome;
  error: YadbeError | null;
}

const PAGE_SIZE = 500;
const PREVIEW_CHARS = 600;
const ERROR_PREVIEW_CHARS = 240;
/** Ids are `startedAt * ID_SLOTS + n`, like the backend's: the id order is the time order. */
const ID_SLOTS = 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Same bound as the backend (SPEC F-100). */
const MAX_ENTRIES = 50_000;
const EMIT_DEBOUNCE_MS = 250;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

/** A deterministic pseudo-random generator, so the seeded history is the same on every start. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Template {
  sql: string;
  rows: number | null;
  ms: [number, number];
}

const POSTGRES: Template[] = [
  {
    sql: "SELECT * FROM customers WHERE email ILIKE '%@example.com' ORDER BY created_at DESC LIMIT 100;",
    rows: 100,
    ms: [8, 60],
  },
  { sql: "SELECT count(*) FROM orders WHERE status = 'pending';", rows: 1, ms: [4, 40] },
  {
    sql: "SELECT o.id, o.total, c.name\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.created_at > now() - interval '7 days'\nORDER BY o.total DESC;",
    rows: 412,
    ms: [30, 240],
  },
  { sql: "UPDATE orders SET status = 'shipped' WHERE id = 48213;", rows: 1, ms: [2, 18] },
  {
    sql: 'SELECT p.name, sum(i.quantity) AS sold\nFROM order_items i\nJOIN products p ON p.id = i.product_id\nGROUP BY p.name\nORDER BY sold DESC\nLIMIT 20;',
    rows: 20,
    ms: [120, 900],
  },
  { sql: 'EXPLAIN ANALYZE SELECT * FROM invoices WHERE paid_at IS NULL;', rows: 9, ms: [12, 90] },
  { sql: 'DELETE FROM sessions WHERE expires_at < now();', rows: 1284, ms: [20, 300] },
  {
    sql: "INSERT INTO audit_log (actor, action, at) VALUES ('admin', 'login', now());",
    rows: 1,
    ms: [1, 9],
  },
  { sql: 'SELECT * FROM products WHERE stock < 5;', rows: 37, ms: [3, 25] },
  {
    sql: 'SELECT id, email, last_login FROM users WHERE last_login IS NULL;',
    rows: 58,
    ms: [5, 35],
  },
  {
    sql: 'CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);',
    rows: null,
    ms: [800, 4200],
  },
  { sql: 'SELECT pg_size_pretty(pg_database_size(current_database()));', rows: 1, ms: [1, 6] },
];

const MSSQL: Template[] = [
  { sql: 'SELECT TOP 100 * FROM dbo.Sales ORDER BY SaleDate DESC;', rows: 100, ms: [20, 120] },
  {
    sql: 'SELECT Region, SUM(Amount) AS Total FROM dbo.Sales GROUP BY Region;',
    rows: 8,
    ms: [60, 400],
  },
  { sql: 'EXEC sp_who2;', rows: 54, ms: [10, 70] },
  {
    sql: 'SELECT name, create_date FROM sys.tables ORDER BY create_date DESC;',
    rows: 42,
    ms: [4, 30],
  },
  {
    sql: "UPDATE dbo.Targets SET Goal = Goal * 1.05 WHERE Region = 'EMEA';",
    rows: 12,
    ms: [8, 60],
  },
];

const MYSQL: Template[] = [
  {
    sql: "SELECT ID, post_title, post_date FROM wp_posts WHERE post_status = 'publish' ORDER BY post_date DESC LIMIT 50;",
    rows: 50,
    ms: [5, 45],
  },
  {
    sql: "SELECT option_name, option_value FROM wp_options WHERE autoload = 'yes';",
    rows: 316,
    ms: [8, 70],
  },
  {
    sql: 'DELETE FROM wp_postmeta WHERE post_id NOT IN (SELECT ID FROM wp_posts);',
    rows: 903,
    ms: [40, 420],
  },
  { sql: 'SHOW TABLE STATUS;', rows: 12, ms: [3, 20] },
];

const SQLITE: Template[] = [
  { sql: 'SELECT * FROM notes ORDER BY updated_at DESC LIMIT 20;', rows: 20, ms: [1, 8] },
  { sql: 'PRAGMA table_info(notes);', rows: 5, ms: [1, 3] },
  { sql: "INSERT INTO notes (title, body) VALUES ('todo', 'buy milk');", rows: 1, ms: [1, 5] },
  { sql: 'SELECT count(*) FROM tags;', rows: 1, ms: [1, 4] },
];

const FAILURES: { sql: string; code: ErrorCode; message: string }[] = [
  {
    sql: 'SELECT * FROM custmers WHERE id = 1;',
    code: 'queryFailed',
    message: 'ERROR: relation "custmers" does not exist\nSQLSTATE 42P01',
  },
  {
    sql: 'SELECT id, nmae FROM products;',
    code: 'queryFailed',
    message: 'ERROR: column "nmae" does not exist\nSQLSTATE 42703',
  },
  {
    sql: 'INSERT INTO orders (id, customer_id) VALUES (1, 99999);',
    code: 'queryFailed',
    message:
      'ERROR: insert or update on table "orders" violates foreign key constraint "orders_customer_id_fkey"\nSQLSTATE 23503',
  },
];

interface Target {
  id: string;
  templates: Template[];
}

const TARGETS: Target[] = [
  { id: 'conn-shop-prod', templates: POSTGRES.filter((t) => /^(SELECT|EXPLAIN)/.test(t.sql)) },
  { id: 'conn-shop-staging', templates: POSTGRES },
  { id: 'conn-reporting', templates: MSSQL },
  { id: 'conn-local-pg', templates: POSTGRES },
  { id: 'conn-wordpress', templates: MYSQL },
  { id: 'conn-app-sqlite', templates: SQLITE },
];

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** In-memory history for `pnpm dev`, Playwright and Vitest (the backend's contract, F-100). */
export function createMockHistory(deps: HistoryDeps) {
  /** Oldest first, so appending a new statement keeps the order. */
  let entries: Row[] = [];
  let emitDelay = EMIT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSlot = 0;
  /** The editor tab each recorded entry ran in, by entry id (seeded entries ran in none). */
  const tabs = new Map<number, string>();

  function announce(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      deps.events.emit('historyChanged', {});
    }, emitDelay);
  }

  function idFor(startedAt: number): number {
    const base = startedAt * ID_SLOTS;
    const newest = entries.at(-1)?.id ?? 0;
    lastSlot = newest >= base && newest < base + ID_SLOTS ? lastSlot + 1 : 0;
    return Math.max(base + lastSlot, newest + 1);
  }

  function snapshot(
    connection: SavedConnection | undefined,
    id: string,
  ): { connectionId: string; connectionName: string; engine: Engine } {
    return {
      connectionId: id,
      connectionName: connection?.definition.name ?? id,
      engine: connection?.definition.engine ?? 'postgres',
    };
  }

  function seed(): void {
    entries = [];
    const rand = random(42);
    const now = Date.now();
    let at = now - 40 * DAY;
    const connections = new Map(MOCK_CONNECTIONS.map((c) => [c.id, c]));
    while (at < now - 10 * MINUTE) {
      // Busy at the office hours of the last days, sparse before.
      const recent = now - at < 3 * DAY;
      at += Math.round((recent ? 2 : 14) * MINUTE * (0.2 + rand() * 1.6));
      if (at >= now - 10 * MINUTE) break;
      const target = TARGETS[Math.floor(rand() * rand() * TARGETS.length)];
      if (!target) continue;
      const connection = connections.get(target.id);
      const failure = rand() < 0.07 ? FAILURES[Math.floor(rand() * FAILURES.length)] : undefined;
      const template = target.templates[Math.floor(rand() * target.templates.length)];
      if (!template) continue;
      const duration = template.ms[0] + rand() * (template.ms[1] - template.ms[0]);
      const base = {
        ...snapshot(connection, target.id),
        database: connection?.definition.database || null,
        startedAt: at,
        durationMs: Math.round(duration * 10) / 10,
      };
      const cancelled = !failure && rand() < 0.02;
      push({
        ...base,
        sql: failure?.sql ?? template.sql,
        rows: failure || cancelled ? null : template.rows,
        outcome: failure ? 'error' : cancelled ? 'cancelled' : 'ok',
        errorCode: failure ? failure.code : cancelled ? 'cancelled' : null,
        errorMessage: failure ? failure.message : cancelled ? 'Query cancelled.' : null,
      });
    }
    // The last statements of the day, one per outcome, so the panel opens on a varied list.
    const prod = snapshot(connections.get('conn-shop-prod'), 'conn-shop-prod');
    push({
      ...prod,
      database: 'shop',
      sql: 'DELETE FROM orders;',
      startedAt: now - 9 * MINUTE,
      durationMs: 0,
      rows: null,
      outcome: 'refused',
      errorCode: 'readOnlyViolation',
      errorMessage: 'This connection is read-only: the statement may change data.',
    });
    push({
      ...snapshot(connections.get('conn-shop-staging'), 'conn-shop-staging'),
      database: 'shop',
      sql: 'SELECT pg_sleep(30);',
      startedAt: now - 4 * MINUTE,
      durationMs: 2_410,
      rows: null,
      outcome: 'cancelled',
      errorCode: 'cancelled',
      errorMessage: 'Query cancelled.',
    });
    push({
      ...snapshot(connections.get('conn-shop-staging'), 'conn-shop-staging'),
      database: 'shop',
      sql: "SELECT o.id, c.nmae\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.status = 'pending';",
      startedAt: now - 90_000,
      durationMs: 6.2,
      rows: null,
      outcome: 'error',
      errorCode: 'queryFailed',
      errorMessage: 'ERROR: column c.nmae does not exist\nSQLSTATE 42703',
    });
  }

  /** Appends an entry newer than every one so far (the seed and recorded statements). */
  function push(entry: Omit<Row, 'id' | 'sqlTruncated'>): number {
    const id = idFor(entry.startedAt);
    entries.push({ ...entry, id, sqlTruncated: false });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
    return id;
  }

  /** `count` synthetic entries over the last year, for the 100k scroll and search checks. */
  function seedSynthetic(count: number): void {
    const rand = random(7);
    const now = Date.now();
    const span = 360 * DAY;
    const step = span / count;
    const all = [...POSTGRES, ...MSSQL, ...MYSQL, ...SQLITE];
    const ids = MOCK_CONNECTIONS.map((c) => c.id);
    entries = [];
    for (let i = 0; i < count; i++) {
      const template = all[Math.floor(rand() * all.length)];
      const id = ids[Math.floor(rand() * ids.length)];
      if (!template || !id) continue;
      const failed = rand() < 0.05;
      const startedAt = Math.round(now - span + i * step);
      entries.push({
        ...snapshot(
          MOCK_CONNECTIONS.find((c) => c.id === id),
          id,
        ),
        id: startedAt * ID_SLOTS + (i % ID_SLOTS),
        database: null,
        sql: `${template.sql} -- #${String(i)}`,
        sqlTruncated: false,
        startedAt,
        durationMs:
          Math.round((template.ms[0] + rand() * (template.ms[1] - template.ms[0])) * 10) / 10,
        rows: failed ? null : template.rows,
        outcome: failed ? 'error' : 'ok',
        errorCode: failed ? 'queryFailed' : null,
        errorMessage: failed ? 'ERROR: canceling statement due to statement timeout' : null,
      });
    }
  }

  const tokens = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);

  /** Like the backend's full-text search: every word of the query is the start of a word. */
  function matcher(text: string | null): ((sql: string) => boolean) | null {
    const needles = tokens(text ?? '').slice(0, 12);
    if (needles.length === 0) return null;
    return (sql) => {
      const haystack = tokens(sql);
      return needles.every((needle) => haystack.some((word) => word.startsWith(needle)));
    };
  }

  function inScope(entry: Row, scope: HistoryScope): boolean {
    return (
      (scope.connectionId === null || entry.connectionId === scope.connectionId) &&
      (scope.from === null || entry.startedAt >= scope.from) &&
      (scope.to === null || entry.startedAt < scope.to)
    );
  }

  function listRow(entry: Row): HistoryRow {
    const sqlTruncated = entry.sql.length > PREVIEW_CHARS;
    return {
      ...entry,
      sql: sqlTruncated ? entry.sql.slice(0, PREVIEW_CHARS) : entry.sql,
      sqlTruncated,
      errorMessage:
        entry.errorMessage === null ? null : cut(entry.errorMessage, ERROR_PREVIEW_CHARS),
    };
  }

  function search(query: HistoryQuery): HistoryPage {
    const limit = Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
    const matches = matcher(query.text);
    const rows: HistoryRow[] = [];
    let more = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;
      if (query.after !== null && entry.id >= query.after) continue;
      if (!inScope(entry, query)) continue;
      if (query.tabId != null && tabs.get(entry.id) !== query.tabId) continue;
      if (query.outcomes.length > 0 && !query.outcomes.includes(entry.outcome)) continue;
      if (query.minDurationMs !== null && entry.durationMs < query.minDurationMs) continue;
      if (matches && !matches(entry.sql)) continue;
      if (rows.length === limit) {
        more = true;
        break;
      }
      rows.push(listRow(entry));
    }
    return { rows, next: more ? (rows.at(-1)?.id ?? null) : null };
  }

  const commands: HistoryCommands = {
    searchHistory: (query) => ok(search(query)),

    getHistoryEntry: (id) => ok(entries.find((entry) => entry.id === id) ?? null),

    deleteHistoryEntry: (id) => {
      entries = entries.filter((entry) => entry.id !== id);
      announce();
      return ok(null);
    },

    countHistory: (scope) => ok(entries.filter((entry) => inScope(entry, scope)).length),

    clearHistory: (scope) => {
      const kept = entries.filter((entry) => !inScope(entry, scope));
      const removed = entries.length - kept.length;
      entries = kept;
      announce();
      return ok(removed);
    },
  };

  /** Records a statement run through the mock query runner, unless the connection opted out. */
  function record(statement: MockHistoryRecord): void {
    const connection = deps.connection(statement.connectionId);
    if (!connection?.definition.historyEnabled) return;
    const { error } = statement;
    const id = push({
      ...snapshot(connection, statement.connectionId),
      database: statement.database ?? (connection.definition.database || null),
      sql: statement.sql,
      startedAt: statement.startedAt,
      durationMs: Math.round(statement.durationMs * 10) / 10,
      rows: statement.rows,
      outcome: statement.outcome,
      errorCode: error?.code ?? null,
      errorMessage: error ? (error.detail ?? error.message.en) : null,
    });
    tabs.set(id, statement.tabId);
    announce();
  }

  function reset(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    emitDelay = EMIT_DEBOUNCE_MS;
    tabs.clear();
    seed();
  }

  seed();

  return {
    commands,
    record,
    reset,
    /** Replaces the history with `count` synthetic entries (100 000 for the scroll check). */
    seedSynthetic,
    /** Delay of the debounced `history-changed`, in ms (0 in unit tests). */
    setEmitDelay(ms: number): void {
      emitDelay = ms;
    },
    /** Entries held, whatever the filters. */
    size: (): number => entries.length,
  };
}
