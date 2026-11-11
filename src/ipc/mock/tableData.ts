import type {
  ApplyOutcome,
  AppliedStatement,
  ChangeSet,
  ColumnInfo,
  ColumnMeta,
  ColumnReadOnlyReason,
  ConstraintViolation,
  CountMode,
  EditPreview,
  Engine,
  FilterOp,
  ObjectRef,
  PlannedChange,
  PlannedStatement,
  RefreshedRows,
  ResultWindow,
  SortKey,
  StatementFailure,
  TableColumn,
  TableDataInfo,
  TableDetails,
  TableFilter,
  TablePage,
  TablePageRequest,
  TableReadOnlyReason,
  TableRowCount,
  Value,
  ValueKind,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import type { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';
import type { Cell } from '../mockQuery';
import { mockSplit } from '../mockSplit';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The table data and edit commands the mock implements (M2-1, M2-2). */
export type TableDataCommands = Pick<
  Commands,
  | 'openTableData'
  | 'fetchTablePage'
  | 'countTableRows'
  | 'refreshTableRows'
  | 'cancelTableData'
  | 'closeTableData'
  | 'previewTableChanges'
  | 'applyTableChanges'
>;

export interface TableDataDeps {
  events: EventEmitter;
  /** A table's details and its database's enum types (see `MockMeta.relation`). */
  relation(
    connectionId: string,
    table: ObjectRef,
  ): { details: TableDetails; enums: Map<string, string[]> } | null;
  /** Engine and read-only flag of a connected session, `null` when it is not connected. */
  session(connectionId: string): { engine: Engine; readOnly: boolean } | null;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  /** Stores rows where `fetchResultWindow` reads them; returns the result id. */
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
}

const MAX_PAGE_ROWS = 50_000;
const PAGE_WINDOW_ROWS = 500;
const CELL_PREVIEW_CHARS = 2_000;
/** Rows a mock table holds at most (its estimate can be far larger). */
const MAX_MOCK_ROWS = 2_500;

/** How many rows a mock table holds. */
export function mockRowCount(details: TableDetails): number {
  return Math.min(Math.round(details.rowEstimate ?? 180), MAX_MOCK_ROWS);
}
const DEFAULT_LATENCY_MS = 120;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    if (ms === 0) {
      resolve(true);
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

// --- Values --------------------------------------------------------------------------------

/** The lossless text of a value (as in a window), `null` for NULL. */
export function mockValueText(value: Value): string | null {
  switch (value.kind) {
    case 'null':
      return null;
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'array':
      return JSON.stringify(value.value);
    default:
      return value.value;
  }
}

/** Deterministic pseudo-random number for a cell. */
function hash(row: number, col: number): number {
  let h = (row + 1) * 374_761_393 + (col + 1) * 668_265_263;
  h = (h ^ (h >>> 13)) * 1_274_126_177;
  return Math.abs(h ^ (h >>> 16));
}

const FIRST = [
  'Alice',
  'Bruno',
  'Chloé',
  'David',
  'Emma',
  'Farid',
  'Gaëlle',
  'Hugo',
  'Inès',
  'Jules',
];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Durand', 'Lefèvre', 'Moreau', 'Laurent', 'Simon'];
const CITIES = ['Paris', 'Lyon', 'Bruxelles', 'Genève', 'Montréal', 'Lille', 'Nantes'];
const COUNTRIES = ['FR', 'BE', 'CH', 'CA', 'DE', 'US'];
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function isoDate(days: number): string {
  const d = new Date(Date.UTC(2024, 0, 1) + days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoTimestamp(minutes: number): string {
  const d = new Date(Date.UTC(2025, 0, 1) + minutes * 60_000);
  return `${isoDate(Math.floor((d.getTime() - Date.UTC(2024, 0, 1)) / 86_400_000))} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function uuidOf(n: number): string {
  const hex = (v: number, width: number) => (v >>> 0).toString(16).padStart(width, '0');
  const a = hash(n, 91);
  const b = hash(n, 92);
  return `${hex(a, 8)}-${hex(b & 0xffff, 4)}-4${hex(b >>> 20, 3).slice(0, 3)}-8${hex(a & 0xfff, 3)}-${hex(n, 4)}${hex(hash(n, 93), 8)}`;
}

function scaleOf(typeName: string): number {
  const match = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(typeName);
  return match ? Number(match[1]) : 2;
}

/** A believable value for `column` in row `row` (`keyPart`: its rank in a composite key). */
function generate(
  column: ColumnInfo,
  col: number,
  row: number,
  keyPart: { index: number; size: number } | null,
  enums: Map<string, string[]>,
  engine: Engine,
): Cell {
  const h = hash(row, col);
  const name = column.name.toLowerCase();
  if (column.nullable && !column.primaryKey && h % 6 === 0) return null;
  const enumValues = enums.get(column.typeName);
  if (enumValues?.length) return ['text', enumValues[h % enumValues.length] ?? ''];
  const sqlite = engine === 'sqlite';
  switch (column.kind) {
    case 'int': {
      let n: number;
      if (keyPart && keyPart.size > 1) {
        n = keyPart.index === 0 ? Math.floor(row / 4) + 1 : (row % 4) + 1;
      } else if (column.identity || keyPart) {
        n = name === 'version' ? 20_240_101_000_000 + row : row + 1;
      } else if (name.endsWith('_id')) n = (h % 200) + 1;
      else if (name.includes('quantity') || name === 'line_no') n = (h % 20) + 1;
      else if (name === 'rating') n = (h % 5) + 1;
      else if (name === 'big') n = 9_007_199_254_740_000 + (h % 1000);
      else n = h % 5000;
      // 64-bit values beyond the safe integers cross as strings.
      return ['int', name === 'big' ? `92233720368547${pad(h % 10000, 5)}` : String(n)];
    }
    case 'decimal': {
      const scale = scaleOf(column.typeName);
      const value = ((h % 10_000_000) / 10 ** Math.min(scale, 6)).toFixed(scale);
      return [sqlite ? 'float' : 'decimal', value];
    }
    case 'float':
      if (h % 23 === 0) return ['float', 'NaN'];
      return ['float', String(Math.round((h % 100_000) / 7) / 100)];
    case 'bool':
      return sqlite ? ['int', h % 2 ? '1' : '0'] : ['bool', h % 2 ? 'true' : 'false'];
    case 'bytes': {
      const length = name === 'pdf' ? 1_100 : (h % 24) + 1;
      let hex = name === 'pdf' ? '255044462d312e370a' : '';
      for (let i = hex.length / 2; i < length; i++) {
        hex += (hash(row, i) % 256).toString(16).padStart(2, '0');
      }
      return ['bytes', hex];
    }
    case 'date':
      return [sqlite ? 'text' : 'date', isoDate(h % 700)];
    case 'time':
      return ['time', `${pad(h % 24)}:${pad(h % 60)}:${pad((h >> 3) % 60)}`];
    case 'timestamp':
      return [sqlite ? 'text' : 'timestamp', isoTimestamp(row * 37 + (h % 30))];
    case 'timestampTz':
      return ['timestampTz', `${isoTimestamp(row * 41 + (h % 50))}${h % 4 ? '' : '.250000'}+00`];
    case 'interval':
      return ['interval', `${h % 30} days ${pad(h % 24)}:${pad(h % 60)}:00`];
    case 'uuid':
      return ['uuid', uuidOf(row * 13 + col)];
    case 'json':
      return [
        'json',
        JSON.stringify({ color: WORDS[h % WORDS.length], size: h % 50, tags: [row % 3, row % 5] }),
      ];
    case 'array': {
      const items: Value[] = [0, 1, 2].slice(0, (h % 3) + 1).map((i) => ({
        kind: 'text',
        value: WORDS[(h + i) % WORDS.length] ?? 'x',
      }));
      return ['array', JSON.stringify(items)];
    }
    case 'other':
      // Domains over text (`shop.email`) read like their base type.
      if (name.includes('email')) return ['other', `user${row}@example.com`];
      return [
        'other',
        name.includes('ip') || name === 'address'
          ? `10.0.${h % 256}.${row % 256}`
          : `(${h % 10},${row % 10})`,
      ];
    case 'text': {
      if (column.nullable && h % 11 === 0) return ['text', ''];
      const first = FIRST[h % FIRST.length] ?? 'Alice';
      const last = LAST[(h >> 4) % LAST.length] ?? 'Martin';
      let text: string;
      if (name.includes('email')) text = `${first}.${last}${row}@example.com`.toLowerCase();
      else if (name === 'full_name' || name === 'name' || name.includes('author'))
        text = `${first} ${last}`;
      else if (name === 'sku') text = `SKU-${pad(row + 1, 5)}`;
      else if (name.includes('code'))
        text = name.includes('country')
          ? (COUNTRIES[h % COUNTRIES.length] ?? 'FR')
          : `C${pad(row + 1, 4)}`;
      else if (name === 'currency') text = h % 3 ? 'EUR' : 'USD';
      else if (name === 'slug' || name === 'login' || name === 'key' || name === 'token')
        text = `${name}-${row + 1}`;
      else if (name === 'city') text = CITIES[h % CITIES.length] ?? 'Paris';
      else if (name.includes('phone'))
        text = `+33 6 ${pad(h % 100)} ${pad(row % 100)} ${pad((h >> 2) % 100)} ${pad((h >> 5) % 100)}`;
      else if (name === 'path') text = `/products/${(h % 400) + 1}`;
      else if (name.includes('hash'))
        text = `pbkdf2_sha256$600000$${uuidOf(row).replace(/-/g, '')}`;
      else if (name === 'body' || name === 'description' || name === 'note')
        text = `${WORDS[h % WORDS.length] ?? ''} ${WORDS[(h >> 3) % WORDS.length] ?? ''}, row ${row + 1}.`;
      else text = `${column.name} ${row + 1}`;
      return ['text', text];
    }
  }
}

// --- Editability ---------------------------------------------------------------------------

export function rowIdentity(details: TableDetails): string[] | null {
  if (details.kind !== 'table') return null;
  if (details.primaryKey) return details.primaryKey.columns;
  const notNull = (c: string) => details.columns.find((col) => col.name === c)?.nullable === false;
  return details.uniqueKeys.find((key) => key.columns.every(notNull))?.columns ?? null;
}

function columnReason(column: ColumnInfo, tableReadOnly: boolean): ColumnReadOnlyReason | null {
  if (tableReadOnly) return 'table';
  if (column.generated) return 'generated';
  if (column.identity === 'always') return 'identity';
  const type = column.typeName.toLowerCase();
  if (type === 'rowversion' || type === 'timestamp') return 'rowVersion';
  if (type === 'sql_variant' || type === 'geography' || type === 'hierarchyid')
    return 'unsupportedType';
  return null;
}

export function info(
  details: TableDetails,
  enums: Map<string, string[]>,
  readOnlyConnection: boolean,
): TableDataInfo {
  const identity = rowIdentity(details);
  const reasons: TableReadOnlyReason[] = [];
  if (details.kind !== 'table') reasons.push('view');
  else if (!identity) reasons.push('noRowIdentity');
  if (readOnlyConnection) reasons.push('readOnlyConnection');
  const columns: TableColumn[] = details.columns.map((c) => ({
    name: c.name,
    typeName: c.typeName,
    kind: c.kind,
    nullable: c.nullable,
    default: c.default,
    optionalOnInsert:
      c.nullable || c.default !== null || c.identity !== null || c.generated !== null,
    primaryKey: c.primaryKey,
    readOnlyReason: columnReason(c, reasons.length > 0),
    enumValues: enums.get(c.typeName) ?? null,
  }));
  return {
    table: details.table,
    kind: details.kind,
    columns,
    rowIdentity: identity,
    readOnlyReasons: reasons,
    defaultOrder: (identity ?? []).map((column) => ({ column, direction: 'asc' })),
    rowEstimate: details.rowEstimate,
    foreignKeys: details.foreignKeys,
  };
}

// --- SQL text (what the backend would log and preview) --------------------------------------

export function quote(engine: Engine, ident: string): string {
  switch (engine) {
    case 'mssql':
      return `[${ident.replace(/]/g, ']]')}]`;
    case 'mysql':
      return `\`${ident.replace(/`/g, '``')}\``;
    default:
      return `"${ident.replace(/"/g, '""')}"`;
  }
}

export function qualified(engine: Engine, table: ObjectRef): string {
  return table.schema === null
    ? quote(engine, table.name)
    : `${quote(engine, table.schema)}.${quote(engine, table.name)}`;
}

/** A value written as a literal, for reading only (mirror of the dialects' `literal`). */
export function mockLiteral(engine: Engine, value: Value): string {
  const text = (s: string) => `'${s.replace(/'/g, "''")}'`;
  switch (value.kind) {
    case 'null':
      return 'NULL';
    case 'bool':
      return engine === 'postgres' ? (value.value ? 'TRUE' : 'FALSE') : value.value ? '1' : '0';
    case 'int':
    case 'decimal':
    case 'float':
      return /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(value.value) ? value.value : text(value.value);
    case 'bytes':
      if (engine === 'mssql') return `0x${value.value.toUpperCase()}`;
      if (engine === 'sqlite') return `X'${value.value.toUpperCase()}'`;
      return text(`\\x${value.value}`);
    case 'array':
      return text(`{${value.value.map((v) => mockValueText(v) ?? 'NULL').join(',')}}`);
    default:
      return engine === 'mssql' ? `N${text(value.value)}` : text(value.value);
  }
}

// --- Filtering and sorting ------------------------------------------------------------------

const NUMERIC: ValueKind[] = ['int', 'decimal', 'float'];

export function compare(kind: ValueKind, a: string, b: string): number {
  if (NUMERIC.includes(kind)) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

type RowTest = (row: readonly Cell[]) => boolean;

function conditionTest(
  op: FilterOp,
  col: number,
  kind: ValueKind,
  values: (string | null)[],
): RowTest {
  const text = (row: readonly Cell[]) => row[col]?.[1] ?? null;
  const cmp = (row: readonly Cell[], v: string | null, check: (n: number) => boolean) => {
    const t = text(row);
    return t !== null && v !== null && check(compare(kind, t, v));
  };
  const [first = null, second = null] = values;
  const lower = (first ?? '').toLowerCase();
  switch (op) {
    case 'eq':
      return (row) => cmp(row, first, (n) => n === 0);
    case 'ne':
      return (row) => cmp(row, first, (n) => n !== 0);
    case 'lt':
      return (row) => cmp(row, first, (n) => n < 0);
    case 'le':
      return (row) => cmp(row, first, (n) => n <= 0);
    case 'gt':
      return (row) => cmp(row, first, (n) => n > 0);
    case 'ge':
      return (row) => cmp(row, first, (n) => n >= 0);
    case 'contains':
      return (row) => (text(row) ?? '').toLowerCase().includes(lower) && text(row) !== null;
    case 'startsWith':
      return (row) => text(row)?.toLowerCase().startsWith(lower) ?? false;
    case 'endsWith':
      return (row) => text(row)?.toLowerCase().endsWith(lower) ?? false;
    case 'in':
      return (row) => values.some((v) => cmp(row, v, (n) => n === 0));
    case 'isNull':
      return (row) => text(row) === null;
    case 'isNotNull':
      return (row) => text(row) !== null;
    case 'between':
      return (row) => cmp(row, first, (n) => n >= 0) && cmp(row, second, (n) => n <= 0);
  }
}

const ARITY: Record<FilterOp, [number, number]> = {
  eq: [1, 1],
  ne: [1, 1],
  lt: [1, 1],
  le: [1, 1],
  gt: [1, 1],
  ge: [1, 1],
  contains: [1, 1],
  startsWith: [1, 1],
  endsWith: [1, 1],
  in: [1, Infinity],
  isNull: [0, 0],
  isNotNull: [0, 0],
  between: [2, 2],
};

const SQL_OPS: Record<FilterOp, string> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
  contains: 'LIKE',
  startsWith: 'LIKE',
  endsWith: 'LIKE',
  in: 'IN',
  isNull: 'IS NULL',
  isNotNull: 'IS NOT NULL',
  between: 'BETWEEN',
};

/**
 * The tiny subset of SQL the mock understands in a raw `WHERE`: `col op literal`,
 * `col IS [NOT] NULL`, joined with `AND`. Anything else fails like an engine would.
 */
function rawTest(engine: Engine, raw: string, columns: TableColumn[]): RowTest | YadbeError {
  // A `;` outside strings also counts: T-SQL needs none between statements of a batch.
  const unquoted = raw.replace(/'(?:[^']|'')*'/g, "''");
  if (mockSplit(engine, raw).length > 1 || unquoted.includes(';')) {
    return mockErrors.invalidArgument(
      'The WHERE condition holds more than one statement.',
      "La condition WHERE contient plus d'une instruction.",
    );
  }
  const tests: RowTest[] = [];
  for (const part of raw.split(/\s+and\s+/i)) {
    const match =
      /^\s*(?:"([^"]+)"|\[([^\]]+)\]|(\w+))\s*(=|<>|!=|<=|>=|<|>|like|ilike|is\s+null|is\s+not\s+null)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false)?\s*$/i.exec(
        part,
      );
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!match || !name) {
      return mockErrors.queryFailed(
        `ERROR: syntax error at or near "${part.trim().split(/\s+/)[0] ?? ''}"\nSQLSTATE 42601`,
      );
    }
    const col = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    const column = columns[col];
    if (!column)
      return mockErrors.queryFailed(`ERROR: column "${name}" does not exist\nSQLSTATE 42703`);
    const op = (match[4] ?? '').toLowerCase().replace(/\s+/g, ' ');
    const literal = match[5] ?? null;
    const value = literal?.startsWith("'") ? literal.slice(1, -1).replace(/''/g, "'") : literal;
    if (op === 'is null') tests.push(conditionTest('isNull', col, column.kind, []));
    else if (op === 'is not null') tests.push(conditionTest('isNotNull', col, column.kind, []));
    else if (op === 'like' || op === 'ilike') {
      const pattern = new RegExp(
        `^${(value ?? '')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
          .replace(/_/g, '.')}$`,
        op === 'ilike' ? 'i' : '',
      );
      tests.push((row) => pattern.test(row[col]?.[1] ?? '\u0000'));
    } else {
      const map: Record<string, FilterOp> = {
        '=': 'eq',
        '<>': 'ne',
        '!=': 'ne',
        '<': 'lt',
        '<=': 'le',
        '>': 'gt',
        '>=': 'ge',
      };
      tests.push(conditionTest(map[op] ?? 'eq', col, column.kind, [value]));
    }
  }
  return (row) => tests.every((t) => t(row));
}

// --- The mock --------------------------------------------------------------------------------

interface MockTable {
  rows: Cell[][];
}

interface MockTab {
  connectionId: string;
  engine: Engine;
  readOnly: boolean;
  details: TableDetails;
  info: TableDataInfo;
  /** Results this tab owns (its page, refreshed and inserted rows). */
  results: number[];
  controller: AbortController | null;
}

function tableKey(connectionId: string, table: ObjectRef): string {
  return JSON.stringify([connectionId, table.database, table.schema, table.name]);
}

function keyText(key: Value[]): (string | null)[] {
  return key.map(mockValueText);
}

/** Table data half of the mock backend: generated rows, filters, counts and edits. */
export function createMockTableData(deps: TableDataDeps) {
  let latency = DEFAULT_LATENCY_MS;
  const tables = new Map<string, MockTable>();
  const tabs = new Map<string, MockTab>();

  function rowsOf(tab: MockTab): MockTable {
    return tableRows(tab.connectionId, tab.engine, tab.details);
  }

  /** The rows of a table, generated on first use (foreign key values reference real rows). */
  function tableRows(connectionId: string, engine: Engine, details: TableDetails): MockTable {
    const key = tableKey(connectionId, details.table);
    let table = tables.get(key);
    if (!table) {
      const enums =
        deps.relation(connectionId, details.table)?.enums ?? new Map<string, string[]>();
      const count = mockRowCount(details);
      const identity = rowIdentity(details) ?? [];
      const references = foreignKeyCells(connectionId, engine, details);
      const rows: Cell[][] = [];
      for (let r = 0; r < count; r++) {
        const linked = references(r);
        rows.push(
          details.columns.map((column, c) => {
            if (linked.has(c)) return linked.get(c) ?? null;
            const index = identity.indexOf(column.name);
            const keyPart = index >= 0 ? { index, size: identity.length } : null;
            return generate(column, c, r, keyPart, enums, engine);
          }),
        );
      }
      table = { rows };
      tables.set(key, table);
    }
    return table;
  }

  /**
   * The cells of a row's foreign key columns: the key of a row the referenced table holds, or
   * NULL now and then for a nullable key. Composite keys first, so that a column shared with a
   * single-column key stays consistent with both. Keys over the table's own row identity keep
   * their generated values (unique). Values come from the referenced rows when they exist,
   * else from the seeds those rows will be generated from (no recursion through the tables).
   */
  function foreignKeyCells(
    connectionId: string,
    engine: Engine,
    details: TableDetails,
  ): (row: number) => Map<number, Cell> {
    const own = rowIdentity(details) ?? [];
    const selfKey = tableKey(connectionId, details.table);
    const keys = [...details.foreignKeys]
      .sort((a, b) => b.columns.length - a.columns.length)
      .filter((fk) => !fk.columns.some((name) => own.includes(name)))
      .flatMap((fk) => {
        const target = deps.relation(connectionId, fk.referencedTable);
        if (!target) return [];
        const targetKey = tableKey(connectionId, target.details.table);
        const rows = tables.get(targetKey)?.rows ?? null;
        const identity = rowIdentity(target.details) ?? [];
        const pairs = fk.columns.map((name, i) => {
          const col = details.columns.findIndex((c) => c.name === name);
          const refName = fk.referencedColumns[i] ?? '';
          const refCol = target.details.columns.findIndex((c) => c.name === refName);
          return { col, refCol, keyIndex: identity.indexOf(refName) };
        });
        if (pairs.some((p) => p.col < 0 || p.refCol < 0)) return [];
        const self = targetKey === selfKey;
        return [{ target, identity, pairs, rows, self, count: mockRowCount(target.details) }];
      });
    return (row) => {
      const cells = new Map<number, Cell>();
      for (const { target, identity, pairs, rows, self, count } of keys) {
        const first = pairs[0];
        if (!first || count === 0 || pairs.some((p) => cells.has(p.col))) continue;
        const nullable = pairs.some((p) => details.columns[p.col]?.nullable);
        const h = hash(row, first.col + 101);
        if (nullable && h % 7 === 0) {
          // NULL in one column is enough to reference nothing; the others stay free.
          for (const p of pairs) if (details.columns[p.col]?.nullable) cells.set(p.col, null);
          continue;
        }
        // A self-reference points to an earlier row (a tree, not a cycle).
        const span = self ? Math.min(count, row) : (rows?.length ?? count);
        if (span === 0) {
          for (const p of pairs) if (details.columns[p.col]?.nullable) cells.set(p.col, null);
          continue;
        }
        const refRow = h % span;
        for (const p of pairs) {
          const refColumn = target.details.columns[p.refCol];
          if (!refColumn) continue;
          const keyPart = p.keyIndex >= 0 ? { index: p.keyIndex, size: identity.length } : null;
          const stored = rows?.[refRow];
          cells.set(
            p.col,
            stored
              ? (stored[p.refCol] ?? null)
              : generate(refColumn, p.refCol, refRow, keyPart, target.enums, engine),
          );
        }
      }
      return cells;
    };
  }

  function columnsMeta(tab: MockTab): ColumnMeta[] {
    return tab.info.columns.map((c) => ({ name: c.name, typeName: c.typeName, kind: c.kind }));
  }

  function tabOf(tabId: string): MockTab | YadbeError {
    const tab = tabs.get(tabId);
    if (!tab) {
      return mockErrors.invalidArgument(
        'This table tab is not open.',
        "Cet onglet de table n'est pas ouvert.",
      );
    }
    if (!deps.session(tab.connectionId)) return mockErrors.notConnected();
    return tab;
  }

  function isError(value: unknown): value is YadbeError {
    return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
  }

  /** Waits for the simulated server; `false` when cancelled. */
  async function serverTime(tab: MockTab): Promise<boolean> {
    tab.controller?.abort();
    const controller = new AbortController();
    tab.controller = controller;
    const done = await sleep(latency, controller.signal);
    if (tab.controller === controller) tab.controller = null;
    return done;
  }

  /** The first rows as a result window, per-cell kinds only where they differ. */
  function pageWindow(
    tab: MockTab,
    resultId: number,
    rows: readonly (readonly Cell[])[],
  ): ResultWindow {
    const count = Math.min(rows.length, PAGE_WINDOW_ROWS);
    const columns = tab.info.columns.map((column, c) => {
      const values: (string | null)[] = [];
      const kinds: ValueKind[] = [];
      const truncated: number[] = [];
      let mixed = false;
      for (let i = 0; i < count; i++) {
        const cell = rows[i]?.[c] ?? null;
        if (!cell) {
          values.push(null);
          kinds.push(column.kind);
          continue;
        }
        const [kind, text] = cell;
        if (kind !== column.kind) mixed = true;
        kinds.push(kind);
        if (text.length > CELL_PREVIEW_CHARS) {
          truncated.push(i);
          values.push(text.slice(0, CELL_PREVIEW_CHARS));
        } else values.push(text);
      }
      return { values, kinds: mixed ? kinds : null, truncated };
    });
    return { resultId, offset: 0, rowCount: count, columns };
  }

  function store(tab: MockTab, rows: readonly (readonly Cell[])[]): number {
    const id = deps.storeRows(columnsMeta(tab), rows);
    tab.results.push(id);
    return id;
  }

  function freeAll(tab: MockTab): void {
    deps.freeResults(tab.results);
    tab.results = [];
  }

  function validateFilter(tab: MockTab, filter: TableFilter): RowTest | YadbeError {
    const tests: RowTest[] = [];
    for (const condition of filter.conditions) {
      const col = tab.info.columns.findIndex((c) => c.name === condition.column);
      const column = tab.info.columns[col];
      if (!column) return unknownColumn(condition.column);
      const [min, max] = ARITY[condition.op];
      if (condition.values.length < min || condition.values.length > max) {
        return mockErrors.invalidArgument(
          `The filter on "${condition.column}" has the wrong number of values.`,
          `Le filtre sur « ${condition.column} » n'a pas le bon nombre de valeurs.`,
        );
      }
      tests.push(
        conditionTest(condition.op, col, column.kind, condition.values.map(mockValueText)),
      );
    }
    const raw = filter.rawWhere?.trim();
    if (raw) {
      // Like the backend's classifier: on a read-only connection, a write keyword is refused.
      const write = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|exec)\b/i.exec(
        raw.replace(/'(?:[^']|'')*'/g, "''"),
      );
      if (tab.readOnly && write) return mockErrors.readOnlyViolation(write[1]?.toUpperCase() ?? '');
      const test = rawTest(tab.engine, raw, tab.info.columns);
      if (isError(test)) return test;
      tests.push(test);
    }
    return (row) => tests.every((t) => t(row));
  }

  function unknownColumn(name: string): YadbeError {
    return mockErrors.invalidArgument(
      `The table has no column "${name}".`,
      `La table n'a pas de colonne « ${name} ».`,
    );
  }

  function whereSql(tab: MockTab, filter: TableFilter): string {
    const parts = filter.conditions.map((c) => {
      const column = quote(tab.engine, c.column);
      const values = c.values.map((v) => mockLiteral(tab.engine, v));
      switch (c.op) {
        case 'isNull':
        case 'isNotNull':
          return `${column} ${SQL_OPS[c.op]}`;
        case 'between':
          return `${column} BETWEEN ${values[0] ?? ''} AND ${values[1] ?? ''}`;
        case 'in':
          return `${column} IN (${values.join(', ')})`;
        case 'contains':
        case 'startsWith':
        case 'endsWith': {
          const text = (mockValueText(c.values[0] ?? { kind: 'null' }) ?? '').replace(
            /[\\%_[]/g,
            '\\$&',
          );
          const pattern =
            c.op === 'contains' ? `%${text}%` : c.op === 'startsWith' ? `${text}%` : `%${text}`;
          const like = tab.engine === 'postgres' ? 'ILIKE' : 'LIKE';
          const cast =
            tab.engine === 'mssql' ? 'nvarchar(max)' : tab.engine === 'sqlite' ? 'TEXT' : 'text';
          return `CAST(${column} AS ${cast}) ${like} ${mockLiteral(tab.engine, { kind: 'text', value: pattern })} ESCAPE '\\'`;
        }
        default:
          return `${column} ${SQL_OPS[c.op]} ${values[0] ?? ''}`;
      }
    });
    const raw = filter.rawWhere?.trim();
    if (raw) parts.push(`(${raw})`);
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  function order(tab: MockTab, sort: SortKey[]): SortKey[] | YadbeError {
    for (const key of sort) {
      if (!tab.info.columns.some((c) => c.name === key.column)) return unknownColumn(key.column);
    }
    const keys = sort.length ? [...sort] : [...tab.info.defaultOrder];
    for (const column of tab.info.rowIdentity ?? []) {
      if (!keys.some((k) => k.column === column)) keys.push({ column, direction: 'asc' });
    }
    return keys;
  }

  function sorted(tab: MockTab, rows: Cell[][], keys: SortKey[]): Cell[][] {
    const indexed = keys.map((k) => ({
      col: tab.info.columns.findIndex((c) => c.name === k.column),
      dir: k.direction === 'asc' ? 1 : -1,
    }));
    return [...rows].sort((a, b) => {
      for (const { col, dir } of indexed) {
        const x = a[col]?.[1] ?? null;
        const y = b[col]?.[1] ?? null;
        if (x === y) continue;
        // PostgreSQL's default: NULLs last ascending, first descending.
        if (x === null) return dir;
        if (y === null) return -dir;
        const n = compare(tab.info.columns[col]?.kind ?? 'text', x, y);
        if (n !== 0) return n * dir;
      }
      return 0;
    });
  }

  function selectSql(
    tab: MockTab,
    filter: TableFilter,
    keys: SortKey[],
    offset: number,
    limit: number,
  ): string {
    const columns = tab.info.columns.map((c) => quote(tab.engine, c.name)).join(', ');
    const orderBy = keys
      .map((k) => `${quote(tab.engine, k.column)} ${k.direction.toUpperCase()}`)
      .join(', ');
    const from = qualified(tab.engine, tab.details.table);
    if (tab.engine === 'mssql') {
      return `SELECT ${columns} FROM ${from}${whereSql(tab, filter)} ORDER BY ${orderBy || '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY`;
    }
    return `SELECT ${columns} FROM ${from}${whereSql(tab, filter)}${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${limit + 1} OFFSET ${offset}`;
  }

  function keyWhere(tab: MockTab, key: Value[]): string {
    return (tab.info.rowIdentity ?? [])
      .map(
        (column, i) =>
          `${quote(tab.engine, column)} = ${mockLiteral(tab.engine, key[i] ?? { kind: 'null' })}`,
      )
      .join(' AND ');
  }

  function findRows(tab: MockTab, rows: Cell[][], key: Value[]): number[] {
    const identity = tab.info.rowIdentity ?? [];
    const cols = identity.map((name) => tab.info.columns.findIndex((c) => c.name === name));
    const texts = keyText(key);
    const found: number[] = [];
    rows.forEach((row, r) => {
      const kinds = cols.map((c) => tab.info.columns[c]?.kind ?? 'text');
      if (
        cols.every((c, i) => {
          const cell = row[c]?.[1] ?? null;
          const want = texts[i] ?? null;
          return cell !== null && want !== null && compare(kinds[i] ?? 'text', cell, want) === 0;
        })
      )
        found.push(r);
    });
    return found;
  }

  function describeKey(tab: MockTab, key: Value[]): string {
    return (tab.info.rowIdentity ?? [])
      .map((column, i) => `${column} = ${mockValueText(key[i] ?? { kind: 'null' }) ?? 'NULL'}`)
      .join(', ');
  }

  // --- Plans --------------------------------------------------------------------------------

  interface Planned {
    statement: PlannedStatement;
    run: (rows: Cell[][], inserted: Cell[][]) => StatementFailure | number;
  }

  function editable(tab: MockTab, write: boolean): YadbeError | null {
    if (write && tab.readOnly) return mockErrors.readOnlyViolation('UPDATE');
    if (tab.info.readOnlyReasons.includes('view')) {
      return mockErrors.tableNotEditable(
        'A view cannot be edited from its rows.',
        'Une vue ne peut pas être modifiée depuis ses lignes.',
      );
    }
    if (tab.info.readOnlyReasons.includes('noRowIdentity')) {
      return mockErrors.tableNotEditable(
        'This table has neither a primary key nor a unique key on non-null columns: its rows cannot be told apart.',
        "Cette table n'a ni clé primaire ni clé unique sur des colonnes non nulles : ses lignes ne peuvent pas être distinguées.",
      );
    }
    return null;
  }

  function writableColumn(tab: MockTab, name: string): number | YadbeError {
    const index = tab.info.columns.findIndex((c) => c.name === name);
    const column = tab.info.columns[index];
    if (!column) return unknownColumn(name);
    if (column.readOnlyReason) {
      return mockErrors.invalidArgument(
        `The column "${name}" cannot be written.`,
        `La colonne « ${name} » ne peut pas être modifiée.`,
      );
    }
    return index;
  }

  /** The engine's conversion of a value for its column (`invalidValue` when it fails). */
  function convert(tab: MockTab, col: number, value: Value): Cell | YadbeError {
    const column = tab.info.columns[col];
    const text = mockValueText(value);
    if (!column || text === null) return null;
    const bad = (type: string) =>
      mockErrors.invalidValue(
        `ERROR: invalid input syntax for type ${type}: "${text}"\nSQLSTATE 22P02`,
      );
    switch (column.kind) {
      case 'int':
        return /^-?\d+$/.test(text.trim()) ? ['int', text.trim()] : bad(column.typeName);
      case 'decimal': {
        if (!/^-?\d+(\.\d+)?$/.test(text.trim())) return bad(column.typeName);
        return ['decimal', Number(text).toFixed(scaleOf(column.typeName))];
      }
      case 'float':
        return /^(-?\d+(\.\d+)?(e[-+]?\d+)?|NaN|-?Infinity)$/i.test(text.trim())
          ? ['float', text.trim()]
          : bad(column.typeName);
      case 'bool':
        if (/^(true|t|1|yes)$/i.test(text))
          return tab.engine === 'sqlite' ? ['int', '1'] : ['bool', 'true'];
        if (/^(false|f|0|no)$/i.test(text))
          return tab.engine === 'sqlite' ? ['int', '0'] : ['bool', 'false'];
        return bad('boolean');
      case 'uuid':
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
          ? ['uuid', text.toLowerCase()]
          : bad('uuid');
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(text) ? ['date', text] : bad('date');
      case 'json':
        try {
          JSON.parse(text);
          return ['json', text];
        } catch {
          return bad('json');
        }
      default: {
        if (column.enumValues && !column.enumValues.includes(text)) {
          return mockErrors.invalidValue(
            `ERROR: invalid input value for enum ${column.typeName}: "${text}"\nSQLSTATE 22P02`,
          );
        }
        return [tab.engine === 'sqlite' ? 'text' : column.kind, text];
      }
    }
  }

  function failure(
    index: number,
    planned: PlannedStatement,
    error: YadbeError,
    extra: Partial<StatementFailure> = {},
  ): StatementFailure {
    return {
      statementIndex: index,
      change: planned.change,
      sql: planned.sql,
      error,
      server: error.detail
        ? { severity: 'ERROR', code: null, message: error.detail, detail: null, hint: null }
        : null,
      violation: null,
      rowsAffected: null,
      ...extra,
    };
  }

  /** Not-null and unique checks of a row after a change, like the engine's constraints. */
  function constraints(
    tab: MockTab,
    rows: Cell[][],
    row: Cell[],
    self: number,
  ): ConstraintViolation | null {
    const columns = tab.info.columns;
    for (const [c, column] of columns.entries()) {
      if (!column.nullable && row[c] === null && !tab.details.columns[c]?.generated) {
        return { kind: 'notNull', name: null, column: column.name };
      }
    }
    const keys = [
      ...(tab.details.primaryKey ? [tab.details.primaryKey] : []),
      ...tab.details.uniqueKeys,
    ];
    for (const key of keys) {
      const cols = key.columns.map((name) => columns.findIndex((c) => c.name === name));
      if (cols.some((c) => row[c] === null)) continue;
      const clash = rows.some(
        (other, r) => r !== self && cols.every((c) => other[c]?.[1] === row[c]?.[1]),
      );
      if (clash)
        return {
          kind: 'unique',
          name: key.name,
          column: key.columns.length === 1 ? (key.columns[0] ?? null) : null,
        };
    }
    return null;
  }

  function defaultCell(tab: MockTab, rows: Cell[][], col: number): Cell {
    const column = tab.details.columns[col];
    if (!column) return null;
    if (column.identity || column.default?.startsWith('nextval')) {
      const max = rows.reduce((m, r) => Math.max(m, Number(r[col]?.[1] ?? 0)), 0);
      return ['int', String(max + 1)];
    }
    const def = column.default;
    if (def === null) return null;
    if (/now\(\)|current_timestamp/i.test(def)) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      return column.kind === 'timestampTz'
        ? ['timestampTz', `${now}+00`]
        : [tab.engine === 'sqlite' ? 'text' : 'timestamp', now];
    }
    if (/current_date/i.test(def)) return ['date', new Date().toISOString().slice(0, 10)];
    if (/gen_random_uuid|newid/i.test(def)) return ['uuid', uuidOf(rows.length + 7)];
    const literal = /^'((?:[^']|'')*)'/.exec(def);
    if (literal) return [column.kind, (literal[1] ?? '').replace(/''/g, "'")];
    if (def === 'true' || def === 'false')
      return tab.engine === 'sqlite' ? ['int', def === 'true' ? '1' : '0'] : ['bool', def];
    return [column.kind === 'bool' && tab.engine === 'sqlite' ? 'int' : column.kind, def];
  }

  /** Computed columns, after a change (`(a + b)` expressions only). */
  function compute(tab: MockTab, row: Cell[]): void {
    tab.details.columns.forEach((column, c) => {
      const match = /^\(?\s*(\w+)\s*\+\s*(\w+)\s*\)?$/.exec(column.generated?.expression ?? '');
      if (!match) return;
      const a = row[tab.details.columns.findIndex((x) => x.name === match[1])];
      const b = row[tab.details.columns.findIndex((x) => x.name === match[2])];
      row[c] =
        a && b
          ? [column.kind, (Number(a[1]) + Number(b[1])).toFixed(scaleOf(column.typeName))]
          : null;
    });
  }

  function plan(tab: MockTab, changes: ChangeSet): Planned[] | YadbeError {
    const identity = tab.info.rowIdentity ?? [];
    const from = qualified(tab.engine, tab.details.table);
    const checkKey = (key: Value[]) =>
      key.length === identity.length
        ? null
        : mockErrors.invalidArgument(
            `A row key needs ${identity.length} values.`,
            `Une clé de ligne demande ${identity.length} valeurs.`,
          );
    if (!changes.updates.length && !changes.inserts.length && !changes.deletes.length) {
      return mockErrors.invalidArgument('There is nothing to apply.', "Il n'y a rien à appliquer.");
    }
    const planned: Planned[] = [];
    const deleted = new Set<string>();
    changes.deletes.forEach((key, index) => {
      deleted.add(JSON.stringify(keyText(key)));
      const change: PlannedChange = { kind: 'delete', key, delete: index };
      const statement = { change, sql: `DELETE FROM ${from} WHERE ${keyWhere(tab, key)}` };
      planned.push({
        statement,
        run: (rows) => {
          const found = findRows(tab, rows, key);
          if (found.length !== 1) return oneRow(tab, planned.length, statement, key, found.length);
          rows.splice(found[0] ?? 0, 1);
          return 1;
        },
      });
    });
    for (const key of [...changes.deletes, ...changes.updates.map((u) => u.key)]) {
      const bad = checkKey(key);
      if (bad) return bad;
    }
    // Updates, merged per row in the order rows first appear.
    const rows = new Map<string, { key: Value[]; updates: number[]; values: Map<number, Value> }>();
    for (const [index, update] of changes.updates.entries()) {
      const id = JSON.stringify(keyText(update.key));
      if (deleted.has(id)) continue;
      const col = writableColumn(tab, update.column);
      if (isError(col)) return col;
      const entry = rows.get(id) ?? {
        key: update.key,
        updates: [],
        values: new Map<number, Value>(),
      };
      entry.updates.push(index);
      entry.values.set(col, update.value);
      rows.set(id, entry);
    }
    for (const entry of rows.values()) {
      const sets = [...entry.values].map(
        ([c, v]) =>
          `${quote(tab.engine, tab.info.columns[c]?.name ?? '')} = ${mockLiteral(tab.engine, v)}`,
      );
      const change: PlannedChange = { kind: 'update', key: entry.key, updates: entry.updates };
      const statement = {
        change,
        sql: `UPDATE ${from} SET ${sets.join(', ')} WHERE ${keyWhere(tab, entry.key)}`,
      };
      const position = planned.length;
      planned.push({
        statement,
        run: (data) => {
          const found = findRows(tab, data, entry.key);
          if (found.length !== 1) return oneRow(tab, position, statement, entry.key, found.length);
          const r = found[0] ?? 0;
          const row = [...(data[r] ?? [])];
          for (const [c, value] of entry.values) {
            const cell = convert(tab, c, value);
            if (isError(cell)) return failure(position, statement, cell);
            row[c] = cell;
          }
          compute(tab, row);
          const violation = constraints(tab, data, row, r);
          if (violation)
            return failure(position, statement, mockErrors.constraintViolation(violation), {
              violation,
            });
          data[r] = row;
          return 1;
        },
      });
    }
    const returning = tab.info.columns.map((c) => quote(tab.engine, c.name));
    for (const [index, insert] of changes.inserts.entries()) {
      const values = new Map<number, Value>();
      for (const { column, value } of insert.values) {
        const col = writableColumn(tab, column);
        if (isError(col)) return col;
        values.set(col, value);
      }
      const names = [...values.keys()].map((c) =>
        quote(tab.engine, tab.info.columns[c]?.name ?? ''),
      );
      const literals = [...values.values()].map((v) => mockLiteral(tab.engine, v));
      const body = values.size
        ? `(${names.join(', ')}) VALUES (${literals.join(', ')})`
        : 'DEFAULT VALUES';
      const sql =
        tab.engine === 'mssql'
          ? `INSERT INTO ${from} ${values.size ? `(${names.join(', ')}) ` : ''}OUTPUT ${returning.map((c) => `INSERTED.${c}`).join(', ')} ${values.size ? `VALUES (${literals.join(', ')})` : 'DEFAULT VALUES'}`
          : `INSERT INTO ${from} ${body} RETURNING ${returning.join(', ')}`;
      const statement = { change: { kind: 'insert', insert: index } as PlannedChange, sql };
      const position = planned.length;
      planned.push({
        statement,
        run: (data, inserted) => {
          const row: Cell[] = tab.info.columns.map((_, c) => {
            const value = values.get(c);
            return value === undefined ? defaultCell(tab, data, c) : null;
          });
          for (const [c, value] of values) {
            const cell = convert(tab, c, value);
            if (isError(cell)) return failure(position, statement, cell);
            row[c] = cell;
          }
          compute(tab, row);
          const violation = constraints(tab, data, row, -1);
          if (violation)
            return failure(position, statement, mockErrors.constraintViolation(violation), {
              violation,
            });
          data.push(row);
          inserted[index] = row;
          return 1;
        },
      });
    }
    return planned;
  }

  function oneRow(
    tab: MockTab,
    index: number,
    statement: PlannedStatement,
    key: Value[],
    count: number,
  ): StatementFailure {
    const row = describeKey(tab, key);
    const error = count === 0 ? mockErrors.rowNotFound(row) : mockErrors.rowNotUnique(row, count);
    return { ...failure(index, statement, error), server: null, rowsAffected: count };
  }

  function script(tab: MockTab, statements: PlannedStatement[]): string {
    const begin = tab.engine === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN';
    return [begin, ...statements.map((s) => s.sql), 'COMMIT'].map((s) => `${s};`).join('\n');
  }

  const commands: TableDataCommands = {
    openTableData: (tabId, connectionId, table) => {
      const session = deps.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const relation = deps.relation(connectionId, table);
      if (!relation) {
        return fail({
          code: 'objectNotFound',
          message: {
            en: `"${table.name}" no longer exists. Refresh the explorer to see the current objects.`,
            fr: `« ${table.name} » n'existe plus. Actualisez l'explorateur pour voir les objets actuels.`,
          },
          action: null,
          detail: null,
        });
      }
      const previous = tabs.get(tabId);
      if (previous) {
        previous.controller?.abort();
        freeAll(previous);
      }
      const tab: MockTab = {
        connectionId,
        engine: session.engine,
        readOnly: session.readOnly,
        details: relation.details,
        info: info(relation.details, relation.enums, session.readOnly),
        results: [],
        controller: null,
      };
      tabs.set(tabId, tab);
      return ok(structuredClone(tab.info));
    },

    fetchTablePage: async (tabId, request: TablePageRequest) => {
      const tab = tabOf(tabId);
      if (isError(tab)) return fail(tab);
      if (request.limit < 1 || request.limit > MAX_PAGE_ROWS) {
        return fail(
          mockErrors.invalidArgument(
            `A page has 1 to ${MAX_PAGE_ROWS} rows.`,
            `Une page compte de 1 à ${MAX_PAGE_ROWS} lignes.`,
          ),
        );
      }
      const test = validateFilter(tab, request.filter);
      if (isError(test)) return fail(test);
      const keys = order(tab, request.sort);
      if (isError(keys)) return fail(keys);
      const sql = selectSql(tab, request.filter, keys, request.offset, request.limit);
      const started = performance.now();
      if (!(await serverTime(tab))) {
        deps.logStatement(tab.connectionId, sql, mockErrors.cancelled());
        return fail(mockErrors.cancelled());
      }
      const matching = sorted(tab, rowsOf(tab).rows.filter(test), keys);
      const rows = matching.slice(request.offset, request.offset + request.limit);
      deps.logStatement(tab.connectionId, sql);
      freeAll(tab);
      const resultId = store(tab, rows);
      const page: TablePage = {
        resultId,
        columns: columnsMeta(tab),
        offset: request.offset,
        rowCount: rows.length,
        hasMore: matching.length > request.offset + request.limit,
        window: pageWindow(tab, resultId, rows),
        order: keys,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      };
      return ok(page);
    },

    countTableRows: async (tabId, filter, mode: CountMode) => {
      const tab = tabOf(tabId);
      if (isError(tab)) return fail(tab);
      const test = validateFilter(tab, filter);
      if (isError(test)) return fail(test);
      const started = performance.now();
      const filtered = filter.conditions.length > 0 || !!filter.rawWhere?.trim();
      const from = qualified(tab.engine, tab.details.table);
      const count = tab.engine === 'mssql' ? 'COUNT_BIG(*)' : 'COUNT(*)';
      const sql =
        mode === 'exact'
          ? `SELECT ${count} FROM ${from}${whereSql(tab, filter)}`
          : tab.engine === 'postgres'
            ? filtered
              ? `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${from}${whereSql(tab, filter)}`
              : `SELECT reltuples FROM pg_class WHERE oid = '${from.replace(/'/g, "''")}'::regclass`
            : `SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(N'${from}') AND p.index_id IN (0, 1)`;
      if (mode === 'estimate' && tab.engine === 'sqlite') {
        return ok({ mode, count: null, filtered: false, durationMs: 0 });
      }
      if (!(await serverTime(tab))) {
        deps.logStatement(tab.connectionId, sql, mockErrors.cancelled());
        return fail(mockErrors.cancelled());
      }
      deps.logStatement(tab.connectionId, sql);
      const exact = rowsOf(tab).rows.filter(test).length;
      const durationMs = Math.round((performance.now() - started) * 10) / 10;
      const result: TableRowCount =
        mode === 'exact'
          ? { mode, count: exact, filtered: true, durationMs }
          : tab.engine === 'postgres'
            ? { mode, count: Math.round(exact * 1.04) + 3, filtered: true, durationMs }
            : { mode, count: rowsOf(tab).rows.length, filtered: !filtered, durationMs };
      return ok(result);
    },

    refreshTableRows: async (tabId, keys) => {
      const tab = tabOf(tabId);
      if (isError(tab)) return fail(tab);
      if (!tab.info.rowIdentity) return fail(editable(tab, false) ?? mockErrors.cancelled());
      for (const key of keys) {
        if (key.length !== tab.info.rowIdentity.length) {
          return fail(
            mockErrors.invalidArgument(
              `A row key needs ${tab.info.rowIdentity.length} values.`,
              `Une clé de ligne demande ${tab.info.rowIdentity.length} valeurs.`,
            ),
          );
        }
      }
      if (!(await serverTime(tab))) return fail(mockErrors.cancelled());
      const data = rowsOf(tab).rows;
      const found: Cell[][] = [];
      const positions = keys.map((key) => {
        const [r] = findRows(tab, data, key);
        const row = r === undefined ? undefined : data[r];
        if (!row) return null;
        found.push(row);
        return found.length - 1;
      });
      if (keys.length) {
        const columns = tab.info.columns.map((c) => quote(tab.engine, c.name)).join(', ');
        const where = keys.map((key) => `(${keyWhere(tab, key)})`).join(' OR ');
        deps.logStatement(
          tab.connectionId,
          `SELECT ${columns} FROM ${qualified(tab.engine, tab.details.table)} WHERE ${where}`,
        );
      }
      const result: RefreshedRows = {
        window: pageWindow(tab, store(tab, found), found),
        positions,
      };
      return ok(result);
    },

    cancelTableData: (tabId) => {
      tabs.get(tabId)?.controller?.abort();
      return ok(null);
    },

    closeTableData: (tabId) => {
      const tab = tabs.get(tabId);
      if (tab) {
        tab.controller?.abort();
        freeAll(tab);
        tabs.delete(tabId);
      }
      return ok(null);
    },

    previewTableChanges: (tabId, changes) => {
      const tab = tabOf(tabId);
      if (isError(tab)) return fail(tab);
      const refused = editable(tab, false);
      if (refused) return fail(refused);
      const planned = plan(tab, changes);
      if (isError(planned)) return fail(planned);
      const statements = planned.map((p) => p.statement);
      const preview: EditPreview = { statements, script: script(tab, statements) };
      return ok(structuredClone(preview));
    },

    applyTableChanges: async (tabId, changes) => {
      const tab = tabOf(tabId);
      if (isError(tab)) return fail(tab);
      const refused = editable(tab, true);
      if (refused) return fail(refused);
      const planned = plan(tab, changes);
      if (isError(planned)) return fail(planned);
      const started = performance.now();
      if (!(await serverTime(tab))) return fail(mockErrors.cancelled());
      const table = rowsOf(tab);
      const working = table.rows.map((row) => [...row]);
      const inserted: Cell[][] = [];
      const applied: AppliedStatement[] = [];
      deps.logStatement(tab.connectionId, tab.engine === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN');
      for (const [index, step] of planned.entries()) {
        const outcome = step.run(working, inserted);
        if (typeof outcome !== 'number') {
          const failed = { ...outcome, statementIndex: index };
          deps.logStatement(tab.connectionId, step.statement.sql, failed.error);
          deps.logStatement(tab.connectionId, 'ROLLBACK');
          const result: ApplyOutcome = { status: 'rolledBack', failure: failed };
          return ok(structuredClone(result));
        }
        deps.logStatement(tab.connectionId, step.statement.sql);
        applied.push({ change: step.statement.change, rowsAffected: outcome, durationMs: 0.4 });
      }
      deps.logStatement(tab.connectionId, 'COMMIT');
      table.rows = working;
      const rows: Cell[][] = [];
      const positions = changes.inserts.map((_, i) => {
        const row = inserted[i];
        if (!row) return null;
        rows.push(row);
        return rows.length - 1;
      });
      const resultId = store(tab, rows);
      const outcome: ApplyOutcome = {
        status: 'applied',
        statements: applied,
        inserted: { window: pageWindow(tab, resultId, rows), positions },
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      };
      const counts = { updated: 0, inserted: 0, deleted: 0 };
      for (const s of applied) {
        if (s.change.kind === 'update') counts.updated++;
        else if (s.change.kind === 'insert') counts.inserted++;
        else counts.deleted++;
      }
      deps.events.emit('tableDataChanged', {
        connectionId: tab.connectionId,
        table: structuredClone(tab.details.table),
        tabId,
        ...counts,
      });
      return ok(structuredClone(outcome));
    },
  };

  return {
    commands,
    /** Time a statement takes on the simulated server, in ms (0 in unit tests). */
    setLatency(ms: number): void {
      latency = ms;
    },
    /**
     * Deletes a row "behind the app's back" (another session), so that the next update or
     * delete of it fails the one-row check (`rowNotFound`). Returns whether it existed.
     */
    /**
     * Every row of a table tab's table under a filter and sort, for a table export (the
     * backend reads it in pages, each one logged; here, one statement).
     */
    exportRows(
      tabId: string,
      filter: TableFilter,
      sort: SortKey[],
    ): { columns: ColumnMeta[]; rows: Cell[][] } | YadbeError {
      const tab = tabOf(tabId);
      if (isError(tab)) return tab;
      const test = validateFilter(tab, filter);
      if (isError(test)) return test;
      const keys = order(tab, sort);
      if (isError(keys)) return keys;
      const rows = sorted(tab, rowsOf(tab).rows.filter(test), keys);
      deps.logStatement(tab.connectionId, selectSql(tab, filter, keys, 0, rows.length));
      return { columns: columnsMeta(tab), rows };
    },
    /**
     * The rows of any table of a connected session (generated on first use, shared with the
     * table tabs), for the foreign key lookups.
     */
    rowsFor(
      connectionId: string,
      table: ObjectRef,
    ): { engine: Engine; details: TableDetails; info: TableDataInfo; rows: Cell[][] } | null {
      const session = deps.session(connectionId);
      const relation = deps.relation(connectionId, table);
      if (!session || !relation) return null;
      return {
        engine: session.engine,
        details: relation.details,
        info: info(relation.details, relation.enums, session.readOnly),
        rows: tableRows(connectionId, session.engine, relation.details).rows,
      };
    },
    /** The connection, engine and table of an open table tab. */
    tabTarget(
      tabId: string,
    ): { connectionId: string; engine: Engine; readOnly: boolean; table: ObjectRef } | YadbeError {
      const tab = tabOf(tabId);
      if (isError(tab)) return tab;
      return {
        connectionId: tab.connectionId,
        engine: tab.engine,
        readOnly: tab.readOnly,
        table: tab.details.table,
      };
    },
    deleteRowElsewhere(connectionId: string, table: ObjectRef, key: Value[]): boolean {
      const tab = [...tabs.values()].find(
        (t) => tableKey(t.connectionId, t.details.table) === tableKey(connectionId, table),
      );
      if (!tab) return false;
      const data = rowsOf(tab);
      const [r] = findRows(tab, data.rows, key);
      if (r === undefined) return false;
      data.rows.splice(r, 1);
      return true;
    },
    reset(): void {
      for (const tab of tabs.values()) tab.controller?.abort();
      tabs.clear();
      tables.clear();
      latency = DEFAULT_LATENCY_MS;
    },
  };
}

export type MockTableData = ReturnType<typeof createMockTableData>;
