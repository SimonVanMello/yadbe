import type {
  CollectionPage,
  CollectionQuery,
  ColumnMeta,
  CommandOutcome,
  DangerKind,
  DangerReport,
  DocDatabase,
  DocumentResult,
  FieldSample,
  FieldTypeCount,
  SampledField,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import type { Cell } from '../mockQuery';
import type { MockHistoryRecord } from './history';
import {
  bsonTypeOf,
  gridOf,
  mockDatabases,
  type Ejson,
  type EjsonDocument,
  type MockCollection,
} from './documentData';

/**
 * The document family's commands (`mongo_*`) on the mock MongoDB server: explorer, collection
 * pages, counts, the JSON console and its gate (read-only allow-list, dangerous commands),
 * mirroring `session::document`. A filter is an equality on fields (dotted paths included); a
 * `$where` that sleeps runs for 5 s, so that a cancel can be tried.
 */

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

/** The mirror of `classify::READ_COMMANDS`. */
const READ_COMMANDS = new Set([
  'aggregate',
  'buildinfo',
  'collstats',
  'connectionstatus',
  'count',
  'currentop',
  'datasize',
  'dbstats',
  'distinct',
  'explain',
  'find',
  'getmore',
  'hello',
  'hostinfo',
  'ismaster',
  'listcollections',
  'listdatabases',
  'listindexes',
  'ping',
  'serverstatus',
]);
const SLOW_MS = 5000;
const CONSOLE_MAX = 5000;

export interface MockDocumentHost {
  session(connectionId: string): { readOnly: boolean } | null;
  latency(): number;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  recordHistory(entry: MockHistoryRecord): void;
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
  /** Texts of the one column of a stored result, `null` when it is gone. */
  readTexts(resultId: number, offset: number, limit: number): string[] | null;
}

interface Tab {
  results: number[];
  abort: AbortController | null;
}

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

function parseObject(text: string, what: string): { [key: string]: Ejson } | null | YadbeError {
  if (text.trim() === '') return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return mockErrors.invalidArgument(
        `The ${what} must be a JSON object ({ … }).`,
        `Le champ ${what} doit être un objet JSON ({ … }).`,
      );
    }
    return value as { [key: string]: Ejson };
  } catch (error) {
    return {
      ...mockErrors.invalidArgument(
        `The ${what} is not valid JSON.`,
        `Le champ ${what} n'est pas du JSON valide.`,
      ),
      detail: error instanceof Error ? error.message : null,
    };
  }
}

function isError(value: unknown): value is YadbeError {
  return value !== null && typeof value === 'object' && 'code' in value && 'message' in value;
}

/** The value at a dotted path. */
function at(document: Ejson, path: string): Ejson | undefined {
  let current: Ejson | undefined = document;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Plain JSON of a value, whatever its Extended JSON form (`{"$numberInt":"3"}` → `3`). */
function plain(value: Ejson | undefined): unknown {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [key, body] = entries[0] ?? ['', null];
    if (key === '$numberInt' || key === '$numberLong' || key === '$numberDouble') {
      return Number(body);
    }
    if (key === '$numberDecimal' || key === '$oid') return body;
  }
  return JSON.stringify(value);
}

function matches(document: EjsonDocument, filter: { [key: string]: Ejson } | null): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, wanted]) => {
    if (key.startsWith('$')) return true;
    const value = at(document, key);
    return JSON.stringify(plain(value)) === JSON.stringify(plain(wanted));
  });
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function displayFind(
  database: string,
  collection: string,
  filter: string,
  sort: string,
  skip: number,
  limit: number,
): string {
  const parts = [
    `use ${database}; db.getCollection(${JSON.stringify(collection)}).find(${filter || '{}'})`,
  ];
  if (sort) parts.push(`.sort(${sort})`);
  if (skip) parts.push(`.skip(${String(skip)})`);
  parts.push(`.limit(${String(limit)})`);
  return parts.join('');
}

export function createMockDocument(host: MockDocumentHost) {
  let data = mockDatabases();
  const tabs = new Map<string, Tab>();

  function tabOf(id: string): Tab {
    let tab = tabs.get(id);
    if (!tab) {
      tab = { results: [], abort: null };
      tabs.set(id, tab);
    }
    return tab;
  }

  function collectionOf(database: string, collection: string): MockCollection | YadbeError {
    const found = data.get(database)?.get(collection);
    return found ?? mockErrors.objectNotFound(`${database}.${collection}`);
  }

  /** Stores documents as the backend does: grid result + documents result. */
  function store(tab: Tab, documents: readonly EjsonDocument[]): DocumentResult {
    host.freeResults(tab.results);
    const { columns, rows } = gridOf(documents);
    const grid = host.storeRows(columns, rows);
    const whole = host.storeRows(
      [{ name: 'document', typeName: 'object', kind: 'json' }],
      documents.map((d) => [['json', JSON.stringify(d)]]),
    );
    tab.results = [grid, whole];
    return {
      result: {
        resultId: grid,
        statementIndex: 0,
        columns,
        rowCount: documents.length,
        status: 'complete',
        pausedBy: null,
        bytes: documents.length * 220,
        truncated: false,
      },
      documentsId: whole,
      count: documents.length,
    };
  }

  /** Waits like a server would; `false` when cancelled. Slow for a sleeping `$where`. */
  async function work(tab: Tab, slow: boolean): Promise<boolean> {
    tab.abort?.abort();
    const abort = new AbortController();
    tab.abort = abort;
    const done = await sleep(slow ? SLOW_MS : host.latency(), abort.signal);
    if (tab.abort === abort) tab.abort = null;
    return done;
  }

  function sorted(documents: EjsonDocument[], sort: { [key: string]: Ejson } | null) {
    const keys = Object.entries(sort ?? {});
    if (keys.length === 0) return documents;
    return [...documents].sort((a, b) => {
      for (const [key, direction] of keys) {
        const order = compare(plain(at(a, key)), plain(at(b, key)));
        if (order !== 0) return Number(plain(direction)) < 0 ? -order : order;
      }
      return 0;
    });
  }

  function project(document: EjsonDocument, projection: { [key: string]: Ejson } | null) {
    if (!projection) return document;
    const included = Object.entries(projection).filter(([, v]) => Number(plain(v)) !== 0);
    if (included.length === 0) return document;
    const out: EjsonDocument = {};
    if (projection._id === undefined || Number(plain(projection._id)) !== 0) {
      if ('_id' in document) out._id = document._id ?? null;
    }
    for (const [key] of included) {
      if (key in document) out[key] = document[key] ?? null;
    }
    return out;
  }

  function danger(
    name: string,
    command: { [key: string]: Ejson },
    database: string,
  ): DangerReport | null {
    const target = typeof command[name] === 'string' ? command[name] : null;
    const count = (collection: string | null) =>
      collection === null ? null : (data.get(database)?.get(collection)?.documents.length ?? 0);
    const report = (kind: DangerKind, verb: string): DangerReport => ({
      kind,
      command: verb,
      database,
      collection: target,
      documents: kind === 'dropDatabase' ? null : count(target),
      collections: kind === 'dropDatabase' ? (data.get(database)?.size ?? 0) : null,
    });
    const statements = (key: string) =>
      Array.isArray(command[key]) ? (command[key] as { [key: string]: Ejson }[]) : [];
    const all = (q: Ejson | undefined) =>
      q === undefined || (q !== null && typeof q === 'object' && Object.keys(q).length === 0);
    switch (name.toLowerCase()) {
      case 'drop':
        return report('dropCollection', 'drop');
      case 'dropdatabase':
        return report('dropDatabase', 'dropDatabase');
      case 'delete':
        return statements('deletes').some((d) => all(d.q) && Number(plain(d.limit)) === 0)
          ? report('deleteAll', 'deleteMany')
          : null;
      case 'update':
        return statements('updates').some((u) => all(u.q) && u.multi === true)
          ? report('updateAll', 'updateMany')
          : null;
      case 'dropindexes':
        return command.index === '*' ? report('dropAllIndexes', 'dropIndexes') : null;
      default:
        return null;
    }
  }

  function fieldSample(documents: readonly EjsonDocument[]): FieldSample {
    const stats = new Map<string, { present: number; types: Map<string, number>; order: number }>();
    const walk = (entries: [string, Ejson][], prefix: string, seen: Map<string, Set<string>>) => {
      for (const [key, value] of entries) {
        const path = prefix ? `${prefix}.${key}` : key;
        const type = bsonTypeOf(value);
        const types = seen.get(path) ?? new Set<string>();
        types.add(type);
        seen.set(path, types);
        if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
          walk(Object.entries(value), path, seen);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (
              bsonTypeOf(item) === 'object' &&
              item &&
              typeof item === 'object' &&
              !Array.isArray(item)
            ) {
              walk(Object.entries(item), path, seen);
            }
          }
        }
      }
    };
    for (const document of documents) {
      const seen = new Map<string, Set<string>>();
      walk(Object.entries(document), '', seen);
      for (const [path, types] of seen) {
        const entry = stats.get(path) ?? {
          present: 0,
          types: new Map<string, number>(),
          order: stats.size,
        };
        entry.present += 1;
        for (const type of types) entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
        stats.set(path, entry);
      }
    }
    // Parents before children, siblings in the order they first appear, `_id` first.
    const paths = [...stats.keys()];
    const children = (parent: string) =>
      paths
        .filter((p) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') === parent)
        .sort((a, b) =>
          a === '_id'
            ? -1
            : b === '_id'
              ? 1
              : (stats.get(a)?.order ?? 0) - (stats.get(b)?.order ?? 0),
        );
    const fields: SampledField[] = [];
    const visit = (parent: string) => {
      for (const path of children(parent)) {
        const entry = stats.get(path);
        if (!entry) continue;
        fields.push({
          path,
          name: path.split('.').at(-1) ?? path,
          depth: path.split('.').length - 1,
          present: entry.present,
          types: [...entry.types.entries()]
            .map(([type, count]) => ({ type, count }) as FieldTypeCount)
            .sort((a, b) => b.count - a.count),
        });
        visit(path);
      }
    };
    visit('');
    return { sampled: documents.length, fields, truncated: false };
  }

  const commands: Pick<
    Commands,
    | 'mongoListDatabases'
    | 'mongoListCollections'
    | 'mongoListIndexes'
    | 'mongoSampleFields'
    | 'mongoOpenCollection'
    | 'mongoFetchPage'
    | 'mongoCountDocuments'
    | 'mongoRunCommand'
    | 'mongoCancel'
    | 'mongoCloseTab'
    | 'mongoFetchDocuments'
  > = {
    async mongoListDatabases(connectionId) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(connectionId, 'use admin; db.adminCommand({"listDatabases":1})');
      const databases: DocDatabase[] = [...data.entries()]
        .map(([name, collections]) => ({
          name,
          sizeOnDisk: [...collections.values()].reduce(
            (n, c) => n + c.documents.length * 220,
            8192,
          ),
          empty: collections.size === 0,
          system: ['admin', 'config', 'local'].includes(name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return ok(databases);
    },
    async mongoListCollections(connectionId, database) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(connectionId, `use ${database}; db.getCollectionInfos({})`);
      const collections = [...(data.get(database)?.values() ?? [])].map((c) => ({ ...c.info }));
      return ok(collections.sort((a, b) => a.name.localeCompare(b.name)));
    },
    async mongoListIndexes(connectionId, database, collection) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const found = collectionOf(database, collection);
      if (isError(found)) return fail(found);
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(
        connectionId,
        `use ${database}; db.getCollection(${JSON.stringify(collection)}).getIndexes()`,
      );
      return ok(found.indexes.map((i) => ({ ...i })));
    },
    async mongoSampleFields(connectionId, database, collection, size) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const found = collectionOf(database, collection);
      if (isError(found)) return fail(found);
      const n = Math.min(Math.max(size ?? 200, 1), 1000);
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(
        connectionId,
        `use ${database}; db.getCollection(${JSON.stringify(collection)}).aggregate([{"$sample":{"size":${String(n)}}}])`,
      );
      return ok(fieldSample(found.documents.slice(0, n)));
    },
    async mongoOpenCollection(tabId, connectionId, database, collection) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const found = collectionOf(database, collection);
      if (isError(found)) return fail(found);
      tabOf(tabId);
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      const view = found.info.kind !== 'collection';
      if (!view) {
        host.logStatement(
          connectionId,
          `use ${database}; db.getCollection(${JSON.stringify(collection)}).estimatedDocumentCount()`,
        );
      }
      return ok({
        database,
        collection,
        kind: found.info.kind,
        estimatedCount: view ? null : found.documents.length,
        topology: 'replicaSet',
      });
    },
    async mongoFetchPage(tabId, connectionId, database, collection, query: CollectionQuery, page) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const found = collectionOf(database, collection);
      if (isError(found)) return fail(found);
      if (query.pageSize < 1 || query.pageSize > 1000) {
        return fail(
          mockErrors.invalidArgument(
            'A page holds 1 to 1000 documents.',
            'Une page contient de 1 à 1000 documents.',
          ),
        );
      }
      const filter = parseObject(query.filter, 'filter');
      const projection = parseObject(query.projection, 'projection');
      const sort = parseObject(query.sort, 'sort');
      for (const parsed of [filter, projection, sort]) if (isError(parsed)) return fail(parsed);
      const tab = tabOf(tabId);
      const started = performance.now();
      const slow = query.filter.includes('sleep');
      if (!(await work(tab, slow))) return fail(mockErrors.cancelled());
      const f = isError(filter) ? null : filter;
      const s = isError(sort) ? null : sort;
      const p = isError(projection) ? null : projection;
      const sortKeys = Object.keys(s ?? {});
      const keyset = sortKeys.length === 0 || (sortKeys.length === 1 && sortKeys[0] === '_id');
      const all = sorted(
        found.documents.filter((d) => matches(d, f)),
        s,
      );
      const skip = page * query.pageSize;
      const slice = all.slice(skip, skip + query.pageSize).map((d) => project(d, p));
      const command = displayFind(
        database,
        collection,
        query.filter,
        keyset && !query.sort ? '{"_id":1}' : query.sort,
        keyset ? 0 : skip,
        query.pageSize + 1,
      );
      host.logStatement(connectionId, command);
      const page_: CollectionPage = {
        documents: store(tab, slice),
        page,
        hasMore: skip + query.pageSize < all.length,
        keyset,
        command,
        durationMs: Math.round(performance.now() - started),
      };
      return ok(page_);
    },
    async mongoCountDocuments(tabId, connectionId, database, collection, filterText) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const found = collectionOf(database, collection);
      if (isError(found)) return fail(found);
      const filter = parseObject(filterText, 'filter');
      if (isError(filter)) return fail(filter);
      if (!(await work(tabOf(tabId), filterText.includes('sleep')))) {
        return fail(mockErrors.cancelled());
      }
      host.logStatement(
        connectionId,
        `use ${database}; db.getCollection(${JSON.stringify(collection)}).countDocuments(${filterText || '{}'})`,
      );
      return ok(found.documents.filter((d) => matches(d, filter)).length);
    },
    async mongoRunCommand(tabId, connectionId, database, text, confirmed) {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const parsed = parseObject(text, 'command');
      if (isError(parsed)) return fail(parsed);
      const name = parsed ? Object.keys(parsed)[0] : undefined;
      if (!parsed || name === undefined) {
        return fail(
          mockErrors.invalidArgument(
            'A command is a JSON object whose first key names it: { "find": "orders" }.',
            'Une commande est un objet JSON dont la première clé la nomme : { "find": "orders" }.',
          ),
        );
      }
      const startedAt = Date.now();
      const record = (rows: number | null, error: YadbeError | null) => {
        host.recordHistory({
          tabId,
          connectionId,
          database,
          sql: text,
          startedAt,
          durationMs: Date.now() - startedAt,
          rows,
          outcome:
            error === null
              ? 'ok'
              : error.code === 'readOnlyViolation'
                ? 'refused'
                : error.code === 'cancelled'
                  ? 'cancelled'
                  : 'error',
          error,
        });
      };
      const lower = name.toLowerCase();
      const pipeline = Array.isArray(parsed.pipeline) ? parsed.pipeline : [];
      const writesStage = pipeline.some(
        (stage) =>
          stage !== null &&
          typeof stage === 'object' &&
          !Array.isArray(stage) &&
          ('$out' in stage || '$merge' in stage),
      );
      const reads = READ_COMMANDS.has(lower) && !(lower === 'aggregate' && writesStage);
      if (session.readOnly && !reads) {
        const error = mockErrors.readOnlyViolation(name);
        record(null, error);
        return fail(error);
      }
      const report = danger(name, parsed, database);
      if (report && !confirmed) return ok<CommandOutcome>({ status: 'confirm', danger: report });
      const tab = tabOf(tabId);
      const started = performance.now();
      if (!(await work(tab, text.includes('sleep')))) {
        const error = mockErrors.cancelled();
        record(null, error);
        return fail(error);
      }
      const target = typeof parsed[name] === 'string' ? parsed[name] : '';
      const coll = data.get(database)?.get(target);
      let documents: EjsonDocument[];
      let cursor = false;
      let truncated = false;
      switch (lower) {
        case 'find':
        case 'aggregate': {
          if (!coll) {
            documents = [];
          } else {
            const filter = parsed.filter;
            const isFilter =
              filter !== null && typeof filter === 'object' && !Array.isArray(filter);
            const matched = coll.documents.filter((d) => matches(d, isFilter ? filter : null));
            const limit = Number(plain(parsed.limit)) || matched.length;
            documents = matched.slice(0, Math.min(limit, CONSOLE_MAX));
            truncated = matched.length > CONSOLE_MAX && limit > CONSOLE_MAX;
          }
          cursor = true;
          break;
        }
        case 'count':
          documents = [
            {
              n: { $numberInt: String(coll?.documents.length ?? 0) },
              ok: { $numberDouble: '1.0' },
            },
          ];
          break;
        case 'listcollections':
          documents = [...(data.get(database)?.values() ?? [])].map((c) => ({
            name: c.info.name,
            type: c.info.kind,
            options: {},
            info: { readOnly: false },
          }));
          cursor = true;
          break;
        case 'insert': {
          const docs = Array.isArray(parsed.documents) ? (parsed.documents as EjsonDocument[]) : [];
          coll?.documents.push(...docs);
          documents = [{ n: { $numberInt: String(docs.length) }, ok: { $numberDouble: '1.0' } }];
          break;
        }
        case 'delete': {
          const n = coll?.documents.length ?? 0;
          if (report && coll) coll.documents = [];
          documents = [{ n: { $numberInt: String(report ? n : 0) }, ok: { $numberDouble: '1.0' } }];
          break;
        }
        case 'drop':
          data.get(database)?.delete(target);
          documents = [
            {
              ns: `${database}.${target}`,
              nIndexesWas: { $numberInt: '1' },
              ok: { $numberDouble: '1.0' },
            },
          ];
          break;
        case 'dropdatabase':
          data.delete(database);
          documents = [{ ok: { $numberDouble: '1.0' } }];
          break;
        case 'ping':
        case 'hello':
        case 'buildinfo':
        case 'dbstats':
          documents = [{ ok: { $numberDouble: '1.0' }, version: '7.0.14', db: database }];
          break;
        default: {
          const error = mockErrors.queryFailed(
            `no such command: '${name}' (CommandNotFound, code 59)`,
          );
          record(null, error);
          return fail(error);
        }
      }
      record(cursor ? documents.length : null, null);
      return ok<CommandOutcome>({
        status: 'done',
        documents: store(tab, documents),
        cursor,
        truncated,
        durationMs: Math.round(performance.now() - started),
      });
    },
    mongoCancel(tabId) {
      tabs.get(tabId)?.abort?.abort();
      return ok(null);
    },
    mongoCloseTab(tabId) {
      const tab = tabs.get(tabId);
      if (tab) {
        tab.abort?.abort();
        host.freeResults(tab.results);
        tabs.delete(tabId);
      }
      return ok(null);
    },
    mongoFetchDocuments(documentsId, offset, limit) {
      if (limit > 500) {
        return fail(
          mockErrors.invalidArgument(
            'A window has at most 500 documents.',
            'Une fenêtre compte au plus 500 documents.',
          ),
        );
      }
      const texts = host.readTexts(documentsId, offset, limit);
      return texts ? ok(texts) : fail(mockErrors.resultNotFound(documentsId));
    },
  };

  return {
    commands,
    reset(): void {
      data = mockDatabases();
      tabs.clear();
    },
  };
}
