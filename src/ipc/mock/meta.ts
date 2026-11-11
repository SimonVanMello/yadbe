import type {
  CompletionCatalog,
  Engine,
  ErrorCode,
  MetaNode,
  MetaRefreshed,
  ObjectKind,
  ObjectRef,
  ScriptKind,
  TableDetails,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { MOCK_ENGINES } from '../mockData';
import {
  LARGE_CATALOG,
  MOCK_OBJECT_KINDS,
  postgresServer,
  sqliteFile,
  type LargeCatalogOptions,
  type MockDatabase,
  type MockSchema,
} from './metaCatalog';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The metadata commands the mock implements. */
export type MetaCommands = Pick<
  Commands,
  | 'listDatabases'
  | 'listSchemas'
  | 'listObjectCounts'
  | 'listObjects'
  | 'getTableDetails'
  | 'getCompletionCatalog'
  | 'refreshMeta'
  | 'cancelMetaRequest'
  | 'scriptTable'
>;

/** What the metadata mock needs from the rest of the mock backend. */
export interface MetaDeps {
  /** Engine and database of a connected session, or `null` when it is not connected. */
  session(connectionId: string): { engine: Engine; database: string } | null;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  emitRefreshed(payload: MetaRefreshed): void;
}

/** Time a node takes to load the first time, in ms. */
const DEFAULT_META_LATENCY_MS = 150;
const SCRIPT_SELECT_LIMIT = 1000;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

function error(code: ErrorCode, en: string, fr: string, detail: string | null = null): YadbeError {
  return { code, message: { en, fr }, action: null, detail };
}

export const metaErrors = {
  notConnected: (): YadbeError => ({
    ...error('notConnected', 'The connection is not open.', "La connexion n'est pas ouverte."),
    action: 'reconnect',
  }),
  objectNotFound: (what: string) =>
    error(
      'objectNotFound',
      `"${what}" no longer exists. Refresh the explorer to see the current objects.`,
      `« ${what} » n'existe plus. Actualisez l'explorateur pour voir les objets actuels.`,
    ),
  queryFailed: (detail: string) =>
    error(
      'queryFailed',
      'The database rejected the statement.',
      "La base de données a refusé l'instruction.",
      detail,
    ),
  invalidArgument: (en: string, fr: string) => error('invalidArgument', en, fr),
  cancelled: () => error('cancelled', 'Cancelled.', 'Annulé.'),
};

const clone = <T>(value: T): T => structuredClone(value);

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

/** A loaded node of the cache, as the backend's `MetaCache` keys it. */
type Loaded =
  | { node: 'databases' }
  | { node: 'schemas'; database: string }
  | { node: 'counts'; database: string; schema: string | null }
  | { node: 'objects'; database: string; schema: string | null; kind: ObjectKind }
  | { node: 'table'; database: string; schema: string | null; name: string; kind: ObjectKind }
  | { node: 'catalog'; database: string; system: boolean };

function loadedKey(l: Loaded): string {
  return JSON.stringify(l);
}

/** Whether `refresh(node)` drops the loaded entry `l` (mirror of `CacheData::invalidate`). */
function covers(node: MetaNode, l: Loaded): boolean {
  if (node.level === 'connection') return true;
  if (l.node === 'databases') return false;
  const database = node.level === 'table' ? node.table.database : node.database;
  if (l.database !== database) return false;
  switch (node.level) {
    case 'database':
      return true;
    case 'schema':
      return l.node === 'catalog' || (l.node !== 'schemas' && l.schema === node.schema);
    case 'objects':
      if (l.node === 'catalog') return true;
      if (l.node === 'counts') return l.schema === node.schema;
      if (l.node === 'objects' || l.node === 'table') {
        return l.schema === node.schema && l.kind === node.kind;
      }
      return false;
    case 'table':
      if (l.node === 'catalog') return true;
      return l.node === 'table' && l.schema === node.table.schema && l.name === node.table.name;
  }
}

function quoteFor(engine: Engine): (ident: string) => string {
  const [open, close] =
    engine === 'mssql' ? ['[', ']'] : engine === 'mysql' ? ['`', '`'] : ['"', '"'];
  return (ident) => `${open}${ident.split(close).join(close + close)}${close}`;
}

/** Mirror of `db::meta::qualified_name`. */
export function mockQualifiedName(engine: Engine, object: ObjectRef): string {
  const quote = quoteFor(engine);
  const caps = MOCK_ENGINES.find((e) => e.engine === engine)?.capabilities;
  const name = quote(object.name);
  if (caps?.schemas) return object.schema === null ? name : `${quote(object.schema)}.${name}`;
  if (caps?.multipleDatabases && object.database) return `${quote(object.database)}.${name}`;
  return name;
}

/** Mirror of `db::script::script`. */
export function mockScript(engine: Engine, table: TableDetails, kind: ScriptKind): string {
  const quote = quoteFor(engine);
  const name = mockQualifiedName(engine, table.table);
  const placeholder = (c: { name: string; typeName: string }) => `<${c.name}, ${c.typeName}>`;
  const insertable = table.columns.filter((c) => c.generated === null && c.identity !== 'always');
  const updatable = table.columns.filter((c) => c.generated === null && c.identity === null);
  const byName = (n: string) => table.columns.find((c) => c.name === n);
  let key = (table.primaryKey?.columns ?? []).map(byName).filter((c) => c !== undefined);
  if (key.length === 0) {
    for (const unique of table.uniqueKeys) {
      const columns = unique.columns.map(byName).filter((c) => c !== undefined);
      if (
        columns.length > 0 &&
        columns.length === unique.columns.length &&
        columns.every((c) => !c.nullable)
      ) {
        key = columns;
        break;
      }
    }
  }
  const where =
    key.length === 0
      ? 'WHERE <condition>'
      : `WHERE ${key.map((c) => `${quote(c.name)} = ${placeholder(c)}`).join('\n  AND ')}`;
  switch (kind) {
    case 'qualifiedName':
      return name;
    case 'select': {
      const columns =
        table.columns.length === 0
          ? '  *'
          : table.columns.map((c) => `  ${quote(c.name)}`).join(',\n');
      return engine === 'mssql'
        ? `SELECT TOP (${SCRIPT_SELECT_LIMIT})\n${columns}\nFROM ${name};`
        : `SELECT\n${columns}\nFROM ${name}\nLIMIT ${SCRIPT_SELECT_LIMIT};`;
    }
    case 'insert':
      if (insertable.length === 0) return `INSERT INTO ${name} DEFAULT VALUES;`;
      return `INSERT INTO ${name} (\n${insertable.map((c) => `  ${quote(c.name)}`).join(',\n')}\n) VALUES (\n${insertable.map((c) => `  ${placeholder(c)}`).join(',\n')}\n);`;
    case 'update': {
      let set = updatable.filter((c) => !key.some((k) => k.name === c.name));
      if (set.length === 0) set = updatable;
      return `UPDATE ${name}\nSET\n${set.map((c) => `  ${quote(c.name)} = ${placeholder(c)}`).join(',\n')}\n${where};`;
    }
    case 'delete':
      return `DELETE FROM ${name}\n${where};`;
  }
}

/** Metadata half of the mock backend: a believable catalog, lazy loading, cache, refresh. */
export function createMockMeta(deps: MetaDeps) {
  let latency = DEFAULT_META_LATENCY_MS;
  let large: LargeCatalogOptions | null = null;
  /** Catalog per connection, built on first use. */
  const servers = new Map<string, MockDatabase[]>();
  /** Loaded nodes per connection: a second read is served from the cache, instantly. */
  const loaded = new Map<string, Set<string>>();
  const requests = new Map<string, AbortController>();

  function server(connectionId: string, engine: Engine, database: string): MockDatabase[] {
    let databases = servers.get(connectionId);
    if (!databases) {
      databases = engine === 'sqlite' ? sqliteFile() : postgresServer(database, large);
      servers.set(connectionId, databases);
    }
    return databases;
  }

  /**
   * Runs `read` after the first-load latency (logging `sql` like the real cache would),
   * instantly when the node is cached. `requestId` makes it cancellable.
   */
  async function load<T>(
    requestId: string | null,
    connectionId: string,
    key: Loaded,
    sql: string,
    read: (databases: MockDatabase[], engine: Engine) => T | YadbeError,
  ): Result<T> {
    const session = deps.session(connectionId);
    if (!session) return fail(metaErrors.notConnected());
    const databases = server(connectionId, session.engine, session.database);
    const cache = loaded.get(connectionId) ?? new Set<string>();
    loaded.set(connectionId, cache);
    const id = loadedKey(key);
    if (!cache.has(id)) {
      const controller = new AbortController();
      if (requestId !== null) requests.set(requestId, controller);
      const done = latency === 0 || (await sleep(latency, controller.signal));
      if (requestId !== null) requests.delete(requestId);
      if (!done) return fail(metaErrors.cancelled());
      if (!deps.session(connectionId)) return fail(metaErrors.notConnected());
      const result = read(databases, session.engine);
      deps.logStatement(connectionId, sql, isError(result) ? result : null);
      if (isError(result)) return fail(result);
      cache.add(id);
      return ok(clone(result));
    }
    const result = read(databases, session.engine);
    return isError(result) ? fail(result) : ok(clone(result));
  }

  function isError(value: unknown): value is YadbeError {
    return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
  }

  function findDatabase(databases: MockDatabase[], name: string): MockDatabase | YadbeError {
    const db = databases.find((d) => d.info.name === name);
    if (!db) {
      return error(
        'unknownDatabase',
        `The database "${name}" does not exist on this server.`,
        `La base « ${name} » n'existe pas sur ce serveur.`,
      );
    }
    if (db.denied) return metaErrors.queryFailed(`FATAL: ${db.denied}\nSQLSTATE 42501`);
    return db;
  }

  function findSchema(
    databases: MockDatabase[],
    engine: Engine,
    database: string,
    schema: string | null,
  ): MockSchema | YadbeError {
    const hasSchemas = MOCK_ENGINES.find((e) => e.engine === engine)?.capabilities.schemas ?? false;
    if (hasSchemas !== (schema !== null)) {
      return hasSchemas
        ? metaErrors.invalidArgument(
            'This engine needs a schema name.',
            "Ce moteur a besoin d'un nom de schéma.",
          )
        : metaErrors.invalidArgument(
            'This engine has no schemas.',
            "Ce moteur n'a pas de schémas.",
          );
    }
    const db = findDatabase(databases, database);
    if (isError(db)) return db;
    const found = db.schemas.find((s) => (s.info?.name ?? null) === schema);
    return found ?? metaErrors.objectNotFound(schema ?? database);
  }

  const commands: MetaCommands = {
    listDatabases: (requestId, connectionId) =>
      load(
        requestId,
        connectionId,
        { node: 'databases' },
        'SELECT d.datname, … FROM pg_database d WHERE d.datallowconn ORDER BY d.datname',
        (databases) => databases.map((d) => d.info),
      ),

    listSchemas: (requestId, connectionId, database) =>
      load(
        requestId,
        connectionId,
        { node: 'schemas', database },
        'SELECT n.nspname, … FROM pg_namespace n WHERE … ORDER BY n.nspname',
        (databases) => {
          const db = findDatabase(databases, database);
          if (isError(db)) return db;
          return db.schemas.flatMap((s) => (s.info ? [s.info] : []));
        },
      ),

    listObjectCounts: (requestId, connectionId, database, schema) =>
      load(
        requestId,
        connectionId,
        { node: 'counts', database, schema },
        'SELECT kind, count(*), … FROM pg_class … UNION ALL … pg_proc … UNION ALL … pg_type …',
        (databases, engine) => {
          const found = findSchema(databases, engine, database, schema);
          if (isError(found)) return found;
          return (MOCK_OBJECT_KINDS[engine] ?? []).map((kind) => {
            const objects = found.objects.filter((o) => o.kind === kind);
            return {
              kind,
              count: objects.length,
              systemCount: objects.filter((o) => o.system).length,
            };
          });
        },
      ),

    listObjects: (requestId, connectionId, database, schema, kind) =>
      load(
        requestId,
        connectionId,
        { node: 'objects', database, schema, kind },
        `SELECT … FROM pg_catalog … WHERE n.nspname = $1 /* ${kind} */ ORDER BY 1`,
        (databases, engine) => {
          const found = findSchema(databases, engine, database, schema);
          if (isError(found)) return found;
          return found.objects.filter((o) => o.kind === kind);
        },
      ),

    getTableDetails: async (requestId, connectionId, table) => {
      const session = deps.session(connectionId);
      if (!session) return fail(metaErrors.notConnected());
      const databases = server(connectionId, session.engine, session.database);
      const found = findSchema(databases, session.engine, table.database, table.schema);
      const kind = isError(found) ? 'table' : (found.tables.get(table.name)?.kind ?? 'table');
      return load(
        requestId,
        connectionId,
        { node: 'table', database: table.database, schema: table.schema, name: table.name, kind },
        'SELECT a.attname, format_type(a.atttypid, a.atttypmod), … FROM pg_attribute a WHERE a.attrelid = $1 …',
        () => {
          if (isError(found)) return found;
          const details = found.tables.get(table.name);
          return details ?? metaErrors.objectNotFound(mockQualifiedName(session.engine, table));
        },
      );
    },

    getCompletionCatalog: (requestId, connectionId, database, includeSystem) =>
      load(
        requestId,
        connectionId,
        { node: 'catalog', database, system: includeSystem },
        'SELECT n.nspname, c.relname, array_agg(a.attname ORDER BY a.attnum), … GROUP BY …',
        (databases) => {
          const db = findDatabase(databases, database);
          if (isError(db)) return db;
          return completionCatalog(db, includeSystem);
        },
      ),

    refreshMeta: (connectionId, node) => {
      const cache = loaded.get(connectionId);
      if (cache) {
        for (const id of [...cache]) {
          if (covers(node, JSON.parse(id) as Loaded)) cache.delete(id);
        }
      }
      deps.emitRefreshed({ connectionId, node: clone(node), reason: 'refresh' });
      return ok(null);
    },

    cancelMetaRequest: (requestId) => {
      requests.get(requestId)?.abort();
      return ok(null);
    },

    scriptTable: async (connectionId, table, script) => {
      const session = deps.session(connectionId);
      if (!session) return fail(metaErrors.notConnected());
      if (script === 'qualifiedName') return ok(mockQualifiedName(session.engine, table));
      const details = await commands.getTableDetails(null, connectionId, table);
      if (details.status === 'error') return details;
      return ok(mockScript(session.engine, details.data, script));
    },
  };

  return {
    commands,
    /** The connection dropped and came back: the backend empties its cache and says so. */
    reconnected(connectionId: string): void {
      if (loaded.get(connectionId)?.size) {
        loaded.delete(connectionId);
        deps.emitRefreshed({ connectionId, node: { level: 'connection' }, reason: 'reconnected' });
      }
    },
    /**
     * The details of a table, view or materialized view and the enum types of its database,
     * straight from the catalog (no latency, no cache, nothing logged): the table data mock
     * reads them. `null` when the session is closed or the object unknown.
     */
    relation(
      connectionId: string,
      table: ObjectRef,
    ): { details: TableDetails; enums: Map<string, string[]> } | null {
      const session = deps.session(connectionId);
      if (!session) return null;
      const db = server(connectionId, session.engine, session.database).find(
        (d) => d.info.name === table.database,
      );
      const details = db?.schemas
        .find((s) => (s.info?.name ?? null) === table.schema)
        ?.tables.get(table.name);
      if (!db || !details) return null;
      const enums = new Map<string, string[]>();
      for (const schema of db.schemas) {
        for (const object of schema.objects) {
          if (object.detail.type === 'type' && object.detail.category === 'enum') {
            const values = object.detail.enumValues;
            enums.set(object.name, values);
            if (schema.info) enums.set(`${schema.info.name}.${object.name}`, values);
          }
        }
      }
      return { details: clone(details), enums };
    },
    /** Every table and view of a database, straight from the catalog (foreign key lookups). */
    tablesOf(connectionId: string, database: string): TableDetails[] | null {
      const session = deps.session(connectionId);
      if (!session) return null;
      const db = server(connectionId, session.engine, session.database).find(
        (d) => d.info.name === database,
      );
      return db ? db.schemas.flatMap((s) => [...s.tables.values()]).map((t) => clone(t)) : null;
    },
    /** The session closed: its cache goes with it. */
    forget(connectionId: string): void {
      loaded.delete(connectionId);
      servers.delete(connectionId);
    },
    /** Duration of a first load, in ms (0 in unit tests). */
    setLatency(ms: number): void {
      latency = ms;
    },
    /**
     * `large`: PostgreSQL connections opened from now on see a synthetic 10 000-object
     * database (or `options`), for performance tests; `shop`: the regular catalog.
     */
    setCatalog(kind: 'shop' | 'large', options: LargeCatalogOptions = LARGE_CATALOG): void {
      large = kind === 'large' ? options : null;
      servers.clear();
      loaded.clear();
    },
    reset(): void {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      latency = DEFAULT_META_LATENCY_MS;
      large = null;
      servers.clear();
      loaded.clear();
    },
  };
}

export type MockMeta = ReturnType<typeof createMockMeta>;

/** Mirror of the drivers' `completion_catalog`. */
function completionCatalog(db: MockDatabase, includeSystem: boolean): CompletionCatalog {
  const schemas = db.schemas.filter((s) => includeSystem || !s.info?.system);
  const catalog: CompletionCatalog = {
    database: db.info.name,
    schemas: schemas.flatMap((s) => (s.info ? [{ name: s.info.name, system: s.info.system }] : [])),
    searchPath: [...db.searchPath],
    typeNames: [],
    relations: [],
    routines: [],
    foreignKeys: [],
  };
  const types = new Map<string, number>();
  const intern = (name: string) => {
    let index = types.get(name);
    if (index === undefined) {
      index = catalog.typeNames.length;
      catalog.typeNames.push(name);
      types.set(name, index);
    }
    return index;
  };
  const relationIndex = new Map<string, number>();
  const key = (schema: string | null, name: string) => `${schema ?? ''}\u0000${name}`;
  schemas.forEach((schema, schemaIndex) => {
    const index = schema.info ? schemaIndex : null;
    for (const object of schema.objects) {
      if (object.system && !includeSystem) continue;
      if (object.kind === 'function' || object.kind === 'procedure') {
        if (object.detail.type === 'routine') {
          catalog.routines.push({
            schema: index,
            name: object.name,
            kind: object.kind,
            arguments: object.detail.arguments,
            returnType: object.detail.returnType,
          });
        }
        continue;
      }
      const details = schema.tables.get(object.name);
      if (!details) continue;
      relationIndex.set(key(schema.info?.name ?? null, object.name), catalog.relations.length);
      catalog.relations.push({
        schema: index,
        name: object.name,
        kind: object.kind,
        columns: details.columns.map((c) => c.name),
        columnTypes: details.columns.map((c) => intern(c.typeName)),
      });
    }
  });
  for (const schema of schemas) {
    for (const details of schema.tables.values()) {
      const from = relationIndex.get(key(details.table.schema, details.table.name));
      if (from === undefined) continue;
      for (const fk of details.foreignKeys) {
        const to = relationIndex.get(key(fk.referencedTable.schema, fk.referencedTable.name));
        const target = to === undefined ? undefined : catalog.relations[to];
        const source = catalog.relations[from];
        if (to === undefined || !target || !source) continue;
        catalog.foreignKeys.push({
          from,
          fromColumns: fk.columns.map((c) => source.columns.indexOf(c)),
          to,
          toColumns: fk.referencedColumns.map((c) => target.columns.indexOf(c)),
        });
      }
    }
  }
  return catalog;
}
