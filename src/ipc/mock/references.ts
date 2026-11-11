import type {
  ColumnMeta,
  Engine,
  ForeignKey,
  IncomingForeignKey,
  KeyValue,
  ObjectRef,
  ResultWindow,
  TableDataInfo,
  TableDetails,
  ValueKind,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import type { Cell } from '../mockQuery';
import { compare, mockLiteral, mockValueText, qualified, quote } from './tableData';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The foreign key navigation commands the mock implements (M3-2). */
export type ReferenceCommands = Pick<
  Commands,
  | 'getIncomingForeignKeys'
  | 'fetchReferencedRow'
  | 'countReferencingRows'
  | 'searchReferencedRows'
  | 'cancelReferenceLookup'
>;

export interface ReferenceDeps {
  /** Engine of a connected session, `null` when it is not connected. */
  session(connectionId: string): { engine: Engine } | null;
  /** Every table and view of a database (`MockMeta.tablesOf`). */
  tablesOf(connectionId: string, database: string): TableDetails[] | null;
  /** The rows of a table (`MockTableData.rowsFor`). */
  rowsFor(
    connectionId: string,
    table: ObjectRef,
  ): { engine: Engine; details: TableDetails; info: TableDataInfo; rows: Cell[][] } | null;
  /** The connection of a table tab (`MockTableData.tabTarget`). */
  tabTarget(tabId: string): { connectionId: string; engine: Engine; table: ObjectRef } | YadbeError;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
}

const DEFAULT_LATENCY_MS = 120;
const MAX_LOOKUP_ROWS = 500;
const MAX_COUNT_LIMIT = 100_000;
const KEPT_RESULTS = 16;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

function isError(value: unknown): value is YadbeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function sameTable(a: ObjectRef, b: ObjectRef): boolean {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

/** Rows as a result window (everything here is far below 500 rows). */
function windowOf(
  resultId: number,
  kinds: readonly ValueKind[],
  rows: readonly (readonly Cell[])[],
): ResultWindow {
  const columns = kinds.map((kind, c) => {
    const values = rows.map((row) => row[c]?.[1] ?? null);
    const cellKinds = rows.map((row) => row[c]?.[0] ?? kind);
    const mixed = cellKinds.some((k) => k !== kind);
    return { values, kinds: mixed ? cellKinds : null, truncated: [] };
  });
  return { resultId, offset: 0, rowCount: rows.length, columns };
}

function objectNotFound(name: string): YadbeError {
  return {
    code: 'objectNotFound',
    message: {
      en: `"${name}" no longer exists. Refresh the explorer to see the current objects.`,
      fr: `« ${name} » n'existe plus. Actualisez l'explorateur pour voir les objets actuels.`,
    },
    action: null,
    detail: null,
  };
}

/** Foreign key navigation half of the mock backend: incoming keys, peeks, counts, lookups. */
export function createMockReferences(deps: ReferenceDeps) {
  let latency = DEFAULT_LATENCY_MS;
  const requests = new Map<string, AbortController>();
  const kept = new Map<string, number[]>();

  /** Waits for the simulated server; `false` when the request was cancelled. */
  async function serverTime(requestId: string | null): Promise<boolean> {
    const controller = new AbortController();
    if (requestId !== null) requests.set(requestId, controller);
    const done = await new Promise<boolean>((resolve) => {
      if (latency === 0) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        resolve(true);
      }, latency);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (requestId !== null && requests.get(requestId) === controller) requests.delete(requestId);
    return done;
  }

  function keep(tabId: string, resultId: number): void {
    const ids = kept.get(tabId) ?? [];
    ids.push(resultId);
    const excess = ids.splice(0, Math.max(0, ids.length - KEPT_RESULTS));
    deps.freeResults(excess);
    kept.set(tabId, ids);
  }

  /** The referenced table of a tab's lookup, its rows, and the key checked against it. */
  function target(tabId: string, table: ObjectRef) {
    const tab = deps.tabTarget(tabId);
    if (isError(tab)) return tab;
    if (tab.table.database !== table.database) {
      return mockErrors.invalidArgument(
        "The table is in another database than the tab's.",
        "La table est dans une autre base que celle de l'onglet.",
      );
    }
    const found = deps.rowsFor(tab.connectionId, table);
    if (!found) return objectNotFound(qualified(tab.engine, table));
    return { ...found, connectionId: tab.connectionId };
  }

  function keyTest(
    info: TableDataInfo,
    key: readonly KeyValue[],
  ): ((row: readonly Cell[]) => boolean) | YadbeError {
    if (key.length === 0) {
      return mockErrors.invalidArgument(
        'A key needs at least one column.',
        'Une clé demande au moins une colonne.',
      );
    }
    const parts: { col: number; kind: ValueKind; text: string }[] = [];
    for (const part of key) {
      const col = info.columns.findIndex((c) => c.name === part.column);
      const column = info.columns[col];
      if (!column) {
        return mockErrors.invalidArgument(
          `The table has no column "${part.column}".`,
          `La table n'a pas de colonne « ${part.column} ».`,
        );
      }
      const text = mockValueText(part.value);
      if (text === null) {
        return mockErrors.invalidArgument(
          'A NULL value references no row.',
          'Une valeur NULL ne référence aucune ligne.',
        );
      }
      parts.push({ col, kind: column.kind, text });
    }
    return (row) =>
      parts.every(({ col, kind, text }) => {
        const cell = row[col]?.[1] ?? null;
        return cell !== null && compare(kind, cell, text) === 0;
      });
  }

  function whereKey(engine: Engine, key: readonly KeyValue[]): string {
    return key
      .map((part) => `${quote(engine, part.column)} = ${mockLiteral(engine, part.value)}`)
      .join(' AND ');
  }

  const commands: ReferenceCommands = {
    getIncomingForeignKeys: async (requestId, connectionId, table) => {
      const session = deps.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const sql =
        session.engine === 'sqlite'
          ? `SELECT t.name, f.id, f."from", f."to" FROM pragma_table_list t JOIN pragma_foreign_key_list(t.name, 'main') f WHERE f."table" = '${table.name.replace(/'/g, "''")}'`
          : `SELECT n.nspname, c.relname, con.conname, … FROM pg_constraint con … WHERE con.contype = 'f' AND rn.nspname = $1 AND rc.relname = $2`;
      if (!(await serverTime(requestId))) return fail(mockErrors.cancelled());
      deps.logStatement(connectionId, sql);
      if (session.engine === 'mysql') return ok({ supported: false, keys: [] });
      const tables = deps.tablesOf(connectionId, table.database) ?? [];
      const keys: IncomingForeignKey[] = tables.flatMap((details) =>
        details.foreignKeys
          .filter((fk: ForeignKey) => sameTable(fk.referencedTable, table))
          .map((fk) => ({ table: details.table, foreignKey: structuredClone(fk) })),
      );
      keys.sort(
        (a, b) =>
          (a.table.schema ?? '').localeCompare(b.table.schema ?? '') ||
          a.table.name.localeCompare(b.table.name) ||
          (a.foreignKey.name ?? '').localeCompare(b.foreignKey.name ?? ''),
      );
      return ok({ supported: true, keys });
    },

    fetchReferencedRow: async (tabId, requestId, table, key) => {
      const started = performance.now();
      const found = target(tabId, table);
      if (isError(found)) return fail(found);
      const test = keyTest(found.info, key);
      if (isError(test)) return fail(test);
      const columns = found.info.columns.map((c) => quote(found.engine, c.name)).join(', ');
      const limit = found.engine === 'mssql' ? 'TOP (2) ' : '';
      const sql = `SELECT ${limit}${columns} FROM ${qualified(found.engine, table)} WHERE ${whereKey(found.engine, key)}${found.engine === 'mssql' ? '' : ' LIMIT 2'}`;
      if (!(await serverTime(requestId))) {
        deps.logStatement(found.connectionId, sql, mockErrors.cancelled());
        return fail(mockErrors.cancelled());
      }
      deps.logStatement(found.connectionId, sql);
      const rows = found.rows.filter(test).slice(0, 2);
      const meta = found.info.columns.map((c) => ({
        name: c.name,
        typeName: c.typeName,
        kind: c.kind,
      }));
      const resultId = deps.storeRows(meta, rows);
      keep(tabId, resultId);
      return ok({
        columns: structuredClone(found.info.columns),
        window: windowOf(
          resultId,
          found.info.columns.map((c) => c.kind),
          rows,
        ),
        matches: rows.length,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
    },

    countReferencingRows: async (tabId, requestId, table, key, limit) => {
      const started = performance.now();
      if (limit < 1 || limit > MAX_COUNT_LIMIT) {
        return fail(
          mockErrors.invalidArgument(
            `A count stops at 1 to ${MAX_COUNT_LIMIT} rows.`,
            `Un comptage s'arrête entre 1 et ${MAX_COUNT_LIMIT} lignes.`,
          ),
        );
      }
      const found = target(tabId, table);
      if (isError(found)) return fail(found);
      const test = keyTest(found.info, key);
      if (isError(test)) return fail(test);
      const from = qualified(found.engine, table);
      const where = whereKey(found.engine, key);
      const sql =
        found.engine === 'mssql'
          ? `SELECT COUNT_BIG(*) FROM (SELECT TOP (${limit + 1}) 1 AS [one] FROM ${from} WHERE ${where}) [limited]`
          : `SELECT COUNT(*) FROM (SELECT 1 AS "one" FROM ${from} WHERE ${where} LIMIT ${limit + 1}) "limited"`;
      if (!(await serverTime(requestId))) {
        deps.logStatement(found.connectionId, sql, mockErrors.cancelled());
        return fail(mockErrors.cancelled());
      }
      deps.logStatement(found.connectionId, sql);
      const counted = found.rows.filter(test).length;
      return ok({
        count: Math.min(counted, limit),
        more: counted > limit,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
    },

    searchReferencedRows: async (tabId, requestId, request) => {
      const started = performance.now();
      if (request.limit < 1 || request.limit > MAX_LOOKUP_ROWS) {
        return fail(
          mockErrors.invalidArgument(
            `A lookup page has 1 to ${MAX_LOOKUP_ROWS} rows.`,
            `Une page de recherche compte de 1 à ${MAX_LOOKUP_ROWS} lignes.`,
          ),
        );
      }
      const found = target(tabId, request.table);
      if (isError(found)) return fail(found);
      if (request.keyColumns.length === 0) {
        return fail(
          mockErrors.invalidArgument(
            'A lookup needs the referenced key columns.',
            'Une recherche demande les colonnes de la clé référencée.',
          ),
        );
      }
      const indices: number[] = [];
      for (const name of [...request.keyColumns, ...request.displayColumns]) {
        const index = found.info.columns.findIndex((c) => c.name === name);
        if (index < 0) {
          return fail(
            mockErrors.invalidArgument(
              `The table has no column "${name}".`,
              `La table n'a pas de colonne « ${name} ».`,
            ),
          );
        }
        if (!indices.includes(index)) indices.push(index);
      }
      const search = request.search?.trim().toLowerCase() ?? '';
      const engine = found.engine;
      const selected = indices
        .map((i) => quote(engine, found.info.columns[i]?.name ?? ''))
        .join(', ');
      const like = engine === 'postgres' ? 'ILIKE' : 'LIKE';
      const pattern = mockLiteral(engine, {
        kind: 'text',
        value: `%${search.replace(/[\\%_[]/g, '\\$&')}%`,
      });
      const where = search
        ? ` WHERE ${indices
            .map(
              (i) =>
                `CAST(${quote(engine, found.info.columns[i]?.name ?? '')} AS ${engine === 'mssql' ? 'nvarchar(max)' : 'text'}) ${like} ${pattern} ESCAPE '\\'`,
            )
            .join(' OR ')}`
        : '';
      const order = request.keyColumns.map((c) => `${quote(engine, c)} ASC`).join(', ');
      const paging =
        engine === 'mssql'
          ? ` OFFSET ${request.offset} ROWS FETCH NEXT ${request.limit + 1} ROWS ONLY`
          : ` LIMIT ${request.limit + 1} OFFSET ${request.offset}`;
      const sql = `SELECT ${selected} FROM ${qualified(engine, request.table)}${where} ORDER BY ${order}${paging}`;
      if (!(await serverTime(requestId))) {
        deps.logStatement(found.connectionId, sql, mockErrors.cancelled());
        return fail(mockErrors.cancelled());
      }
      deps.logStatement(found.connectionId, sql);
      const keyCols = request.keyColumns.map((name) => {
        const col = found.info.columns.findIndex((c) => c.name === name);
        return { col, kind: found.info.columns[col]?.kind ?? 'text' };
      });
      const matching = found.rows
        .filter(
          (row) =>
            !search || indices.some((i) => (row[i]?.[1] ?? '').toLowerCase().includes(search)),
        )
        .sort((a, b) => {
          for (const { col, kind } of keyCols) {
            const n = compare(kind, a[col]?.[1] ?? '', b[col]?.[1] ?? '');
            if (n !== 0) return n;
          }
          return 0;
        });
      const page = matching
        .slice(request.offset, request.offset + request.limit)
        .map((row) => indices.map((i) => row[i] ?? null));
      const columns = indices.map((i) => {
        const c = found.info.columns[i];
        return { name: c?.name ?? '', typeName: c?.typeName ?? '', kind: c?.kind ?? 'text' };
      });
      const resultId = deps.storeRows(columns, page);
      keep(tabId, resultId);
      return ok({
        columns,
        window: windowOf(
          resultId,
          columns.map((c) => c.kind),
          page,
        ),
        offset: request.offset,
        hasMore: matching.length > request.offset + request.limit,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
    },

    cancelReferenceLookup: (requestId) => {
      requests.get(requestId)?.abort();
      return ok(null);
    },
  };

  return {
    commands,
    /** Time a lookup takes, in ms (0 in unit tests). */
    setLatency(ms: number): void {
      latency = ms;
    },
    /** The table tab closed: its lookup rows go. */
    close(tabId: string): void {
      deps.freeResults(kept.get(tabId) ?? []);
      kept.delete(tabId);
    },
    reset(): void {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      kept.clear();
      latency = DEFAULT_LATENCY_MS;
    },
  };
}

export type MockReferences = ReturnType<typeof createMockReferences>;
