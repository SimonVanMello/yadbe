import type {
  CollectionPage,
  CollectionQuery,
  ColumnMeta,
  DangerKind,
  DangerReport,
  DocDatabase,
  DocTopology,
  DocumentResult,
  FieldSample,
  FieldTypeCount,
  MongoScriptConfirm,
  MongoScriptOutput,
  SampledField,
  ScriptFailure,
  ScriptMessage,
  ScriptOutcome,
  ScriptRequest,
  ScriptResult,
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
import { parseMockScript } from './mongoshScript';

/**
 * The document family's commands (`mongo_*`) on the mock MongoDB server: explorer, collection
 * pages, counts, and a handful of mongosh statements for the query tab (`mongoshScript.ts`)
 * with the gate's checks (read-only, dangerous operations confirmed mid-script), mirroring
 * `session::document`. A filter is an equality on fields (dotted paths included); a
 * `$where` that sleeps runs for 5 s, so that a cancel can be tried.
 */

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

const SLOW_MS = 5000;
const CONSOLE_MAX = 5000;

export interface MockDocumentHost {
  session(connectionId: string): { readOnly: boolean; topology: DocTopology } | null;
  latency(): number;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  recordHistory(entry: MockHistoryRecord): void;
  /** Emits `mongo-script-confirm`. */
  confirm(request: MongoScriptConfirm): void;
  /** Emits `mongo-script-output`. */
  output(event: MongoScriptOutput): void;
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
  /** Texts of the one column of a stored result, `null` when it is gone. */
  readTexts(resultId: number, offset: number, limit: number): string[] | null;
}

interface Tab {
  results: number[];
  abort: AbortController | null;
  /** A script runs in the tab. */
  scripting: boolean;
  /** The confirmation the running script waits for. */
  confirm: { requestId: number; resolve: (accepted: boolean) => void } | null;
}

/** A fresh ObjectId's hex. */
function mockObjectId(): string {
  let hex = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  while (hex.length < 24) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
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
  let nextConfirm = 1;

  function tabOf(id: string): Tab {
    let tab = tabs.get(id);
    if (!tab) {
      tab = { results: [], abort: null, scripting: false, confirm: null };
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
    | 'mongoRunScript'
    | 'mongoScriptConfirm'
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
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
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
        topology: session.topology,
        capped: found.info.capped,
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
        ids: slice.map((d) => (d._id === undefined ? null : JSON.stringify(d._id))),
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
    async mongoRunScript(tabId, connectionId, request: ScriptRequest) {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const tab = tabOf(tabId);
      if (tab.scripting) return fail(mockErrors.executionRunning());
      tab.scripting = true;
      const { text, range } = request;
      const statements = parseMockScript(text, range?.from ?? 0, range?.to ?? text.length);
      const code = range ? text.slice(range.from, range.to) : text;
      const startedAt = Date.now();
      const started = performance.now();
      const abort = new AbortController();
      const cancelled = () => abort.signal.aborted;
      tab.abort?.abort();
      tab.abort = abort;
      let database = request.database;
      const messages: ScriptMessage[] = [];
      const say = (kind: ScriptMessage['kind'], message: string) => {
        messages.push({ kind, text: message, atMs: Math.round(performance.now() - started) });
      };
      // What was printed goes to the front before the next statement, as the backend hands it
      // over before each wait; the outcome carries every line again.
      let streamed = 0;
      const stream = () => {
        if (streamed < messages.length) {
          host.output({ tabId, messages: messages.slice(streamed) });
          streamed = messages.length;
        }
      };
      // Assigned in the closures below: typed wide so that the checks after them hold.
      let result = null as ScriptResult | null;
      let failure = null as ScriptFailure | null;
      let rows = null as number | null;
      const documentsResult = (docs: EjsonDocument[], cursor: boolean, single: boolean) => {
        rows = docs.length;
        result = {
          kind: 'documents',
          documents: store(tab, docs),
          cursor,
          single,
          truncated: false,
        };
      };
      const textResult = (value: string) => {
        result = { kind: 'text', text: value, truncated: false };
      };
      const confirm = (danger: DangerReport): Promise<boolean> =>
        new Promise((resolve) => {
          const requestId = nextConfirm++;
          tab.confirm = { requestId, resolve };
          host.confirm({ tabId, requestId, danger });
        });
      for (const { statement, position } of statements) {
        stream();
        const stop = (error: YadbeError) => {
          failure = { error, position };
        };
        if (cancelled()) {
          stop(mockErrors.cancelled());
          break;
        }
        const s = statement;
        if (s.kind === 'use') {
          database = s.database;
          say('shell', `switched to db ${database}`);
          textResult(`switched to db ${database}`);
        } else if (s.kind === 'show') {
          const names =
            s.what === 'dbs' || s.what === 'databases'
              ? [...data.keys()].sort()
              : s.what === 'collections' || s.what === 'tables'
                ? [...(data.get(database)?.keys() ?? [])].sort()
                : null;
          if (names === null) {
            stop(mockErrors.mongoshUnsupported(`show ${s.what}`));
            break;
          }
          say('shell', names.join('\n'));
          textResult(names.join('\n'));
        } else if (s.kind === 'print') {
          say('print', s.text);
        } else if (s.kind === 'sleep') {
          if (!(await sleep(s.ms, abort.signal))) {
            stop(mockErrors.cancelled());
            break;
          }
        } else if (s.kind === 'throw') {
          stop(mockErrors.scriptError(`Error: ${s.message}`));
          break;
        } else if (s.kind === 'value') {
          textResult(s.text);
        } else if (s.kind === 'runCommand') {
          host.logStatement(
            connectionId,
            `use ${database}; db.runCommand(${JSON.stringify(s.command)})`,
          );
          documentsResult([{ ok: { $numberDouble: '1.0' } }], false, true);
        } else if (s.kind === 'unsupported') {
          stop(mockErrors.mongoshUnsupported(s.method));
          break;
        } else if (s.kind === 'unknown') {
          stop(mockErrors.scriptError(`ReferenceError: the mock backend does not run “${s.text}”`));
          break;
        } else if (s.kind === 'find' || s.kind === 'count') {
          const slow = JSON.stringify(s.filter ?? {}).includes('sleep');
          if (!(await sleep(slow ? SLOW_MS : host.latency(), abort.signal))) {
            stop(mockErrors.cancelled());
            break;
          }
          const coll = data.get(database)?.get(s.collection);
          const matched = (coll?.documents ?? []).filter((d) => matches(d, s.filter));
          if (s.kind === 'count') {
            host.logStatement(
              connectionId,
              `use ${database}; db.getCollection(${JSON.stringify(s.collection)}).countDocuments(${JSON.stringify(s.filter ?? {})})`,
            );
            textResult(String(matched.length));
          } else {
            host.logStatement(
              connectionId,
              displayFind(
                database,
                s.collection,
                JSON.stringify(s.filter ?? {}),
                '',
                0,
                s.limit ?? 0,
              ),
            );
            if (s.one) {
              const first = matched[0];
              if (first) documentsResult([first], false, true);
              else textResult('null');
            } else {
              documentsResult(matched.slice(0, s.limit ?? CONSOLE_MAX), true, false);
            }
          }
        } else {
          // s.kind === 'write'
          if (session.readOnly) {
            const error = mockErrors.readOnlyViolation(s.method);
            host.logStatement(connectionId, `use ${database}; ${s.method}`, error);
            stop(error);
            break;
          }
          const coll = s.collection === null ? null : data.get(database)?.get(s.collection);
          const everything = s.filter === null || Object.keys(s.filter).length === 0;
          const kind: DangerKind | null =
            s.method === 'dropDatabase'
              ? 'dropDatabase'
              : s.method === 'drop'
                ? 'dropCollection'
                : s.method === 'deleteMany' && everything
                  ? 'deleteAll'
                  : s.method === 'updateMany' && everything
                    ? 'updateAll'
                    : null;
          if (kind) {
            const danger: DangerReport = {
              kind,
              command: s.method,
              database,
              collection: s.collection,
              documents: kind === 'dropDatabase' ? null : (coll?.documents.length ?? 0),
              collections: kind === 'dropDatabase' ? (data.get(database)?.size ?? 0) : null,
            };
            const answer = await Promise.race([
              confirm(danger),
              new Promise<boolean>((resolve) => {
                abort.signal.addEventListener('abort', () => {
                  resolve(false);
                });
              }),
            ]);
            tab.confirm = null;
            if (cancelled()) {
              stop(mockErrors.cancelled());
              break;
            }
            if (!answer) {
              stop(mockErrors.dangerDeclined(s.method));
              break;
            }
          }
          if (!(await sleep(host.latency(), abort.signal))) {
            stop(mockErrors.cancelled());
            break;
          }
          host.logStatement(
            connectionId,
            `use ${database}; db.getCollection(${JSON.stringify(s.collection ?? '')}).${s.method}(…)`,
          );
          let reply: EjsonDocument;
          if (s.method === 'dropDatabase') {
            data.delete(database);
            reply = { ok: { $numberInt: '1' } };
          } else if (s.method === 'drop') {
            if (s.collection !== null) data.get(database)?.delete(s.collection);
            textResult('true');
            continue;
          } else if (s.method.startsWith('insert')) {
            const docs = (Array.isArray(s.body) ? s.body : [s.body]).filter(
              (d): d is EjsonDocument => d !== null && typeof d === 'object' && !Array.isArray(d),
            );
            const ready = docs.map((d) =>
              '_id' in d ? d : { _id: { $oid: mockObjectId() }, ...d },
            );
            coll?.documents.push(...ready);
            reply =
              s.method === 'insertOne'
                ? { acknowledged: true, insertedId: ready[0]?._id ?? null }
                : {
                    acknowledged: true,
                    insertedIds: Object.fromEntries(
                      ready.map((d, i) => [String(i), d._id ?? null]),
                    ),
                  };
          } else if (s.method.startsWith('delete')) {
            const before = coll?.documents.length ?? 0;
            if (coll) {
              let removed = 0;
              coll.documents = coll.documents.filter((d) => {
                if (!matches(d, s.filter) || (s.method === 'deleteOne' && removed > 0)) return true;
                removed += 1;
                return false;
              });
            }
            reply = {
              acknowledged: true,
              deletedCount: { $numberInt: String(before - (coll?.documents.length ?? 0)) },
            };
          } else {
            const set =
              s.body !== null && typeof s.body === 'object' && !Array.isArray(s.body)
                ? s.body.$set
                : null;
            let matched = 0;
            for (const d of coll?.documents ?? []) {
              if (!matches(d, s.filter) || (s.method === 'updateOne' && matched > 0)) continue;
              matched += 1;
              if (
                set !== null &&
                set !== undefined &&
                typeof set === 'object' &&
                !Array.isArray(set)
              )
                Object.assign(d, set);
            }
            const n = { $numberInt: String(matched) };
            reply = {
              acknowledged: true,
              insertedId: null,
              matchedCount: n,
              modifiedCount: n,
              upsertedCount: { $numberInt: '0' },
            };
          }
          documentsResult([reply], false, true);
        }
      }
      if (tab.abort === abort) tab.abort = null;
      tab.scripting = false;
      const failed: ScriptFailure | null = failure;
      host.recordHistory({
        tabId,
        connectionId,
        database: request.database,
        sql: code,
        startedAt,
        durationMs: Date.now() - startedAt,
        rows: failed === null ? rows : null,
        outcome:
          failed === null
            ? 'ok'
            : failed.error.code === 'readOnlyViolation'
              ? 'refused'
              : failed.error.code === 'cancelled'
                ? 'cancelled'
                : 'error',
        error: failed?.error ?? null,
      });
      const outcome: ScriptOutcome = {
        result: failed === null ? result : null,
        messages,
        messagesTruncated: false,
        failure: failed,
        database,
        durationMs: Math.round(performance.now() - started),
      };
      return ok(outcome);
    },
    mongoScriptConfirm(tabId, requestId, accepted) {
      const tab = tabs.get(tabId);
      const pending = tab?.confirm;
      if (!tab || !pending || pending.requestId !== requestId) return ok(false);
      tab.confirm = null;
      pending.resolve(accepted);
      return ok(true);
    },
    mongoCancel(tabId) {
      const tab = tabs.get(tabId);
      tab?.abort?.abort();
      tab?.confirm?.resolve(false);
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
    /** A collection of the mock server, to change its documents (edits, M4-4). */
    collection(database: string, name: string): MockCollection | null {
      return data.get(database)?.get(name) ?? null;
    },
    reset(): void {
      data = mockDatabases();
      tabs.clear();
    },
  };
}
