import type {
  ColumnMeta,
  ConsoleBody,
  ConsoleResponse,
  DocumentResult,
  HttpMethod,
  IndexPage,
  IndexQuery,
  IndexTabInfo,
  LineRange,
  SearchConsoleOutcome,
  SearchDanger,
  SearchServer,
  ValueKind,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import type { Cell } from '../mockQuery';
import type { MockHistoryRecord } from './history';
import type { MockJournal } from './journal';
import { createMockSearchEdits } from './searchEdit';
import {
  MOCK_ALIASES,
  MOCK_DATA_STREAMS,
  MOCK_TEMPLATES,
  mockSearchIndices,
  resolveTarget,
  valueAt,
  type JsonObject,
  type JsonValue,
  type MockIndex,
} from './searchData';

/**
 * The search family's commands (`search_*`) on the mock Elasticsearch cluster, mirroring
 * `session::search`: explorer, index tab pages on a point in time, exact counts, and a console
 * that runs the requests the screens and tests need (`_search`, `_count`, `_cat/indices`,
 * `_mapping`, `GET /`, ES|QL, `DELETE /<index>`, `_delete_by_query`), with the gate's checks
 * (read-only, dangerous requests confirmed with their effect). A search whose body holds a
 * `script` runs for 5 s, so that a cancel can be tried.
 */

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

const SLOW_MS = 5000;
const TRACK_TOTAL = 10_000;

export const MOCK_SEARCH_SERVER: SearchServer = {
  product: 'elasticsearch',
  version: '9.1.0',
  clusterName: 'docker-cluster',
  features: {
    pointInTime: 'pit',
    shardDocSort: true,
    dataStreams: true,
    indexTemplates: true,
    esql: true,
  },
};

export interface MockSearchHost {
  session(connectionId: string): { readOnly: boolean } | null;
  latency(): number;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  recordHistory(entry: MockHistoryRecord): void;
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
  readTexts(resultId: number, offset: number, limit: number): string[] | null;
  connectionName(connectionId: string): string;
  journal: MockJournal;
}

interface Tab {
  results: number[];
  abort: AbortController | null;
}

interface Request {
  method: HttpMethod;
  path: string;
  body: string | null;
  line: number;
  endLine: number;
  bodyLines: number[];
}

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'];

/** Mirror of `db::search::console::parse_console`. */
export function parseMockConsole(text: string): Request[] | { line: number; error: YadbeError } {
  const requests: Request[] = [];
  let current: Request | null = null;
  let body: [number, string][] = [];
  const comment = (line: string) => /^\s*(#|\/\/)/.test(line);
  const finish = () => {
    if (!current) return;
    const ndjson = /(^|\/)_(bulk|msearch)(\/|\?|$)/.test(current.path);
    const kept = body.filter(([, t]) => !comment(t) && !(ndjson && t.trim() === ''));
    while (kept.length > 0 && kept.at(-1)?.[1].trim() === '') kept.pop();
    while (kept.length > 0 && kept[0]?.[1].trim() === '') kept.shift();
    const last = [...body].reverse().find(([, t]) => t.trim() !== '' && !comment(t));
    current.endLine = last ? last[0] : current.line;
    current.bodyLines = kept.map(([n]) => n);
    current.body =
      kept.length === 0 ? null : kept.map(([, t]) => t).join('\n') + (ndjson ? '\n' : '');
    requests.push(current);
  };
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(raw);
    const method = match ? METHODS.find((m) => m === match[1]?.toUpperCase()) : undefined;
    if (match && method) {
      finish();
      const path = match[2] ?? '/';
      current = {
        method,
        path: path.startsWith('/') ? path : `/${path}`,
        body: null,
        line: index,
        endLine: index,
        bodyLines: [],
      };
      body = [];
      continue;
    }
    if (current) body.push([index, raw]);
    else if (raw.trim() !== '' && !comment(raw)) {
      return {
        line: index,
        error: mockErrors.invalidArgument(
          `Line ${String(index + 1)} is not a request: a request starts with a method and a path, like GET /my-index/_search.`,
          `La ligne ${String(index + 1)} n'est pas une requête : une requête commence par une méthode et un chemin, comme GET /mon-index/_search.`,
        ),
      };
    }
  }
  finish();
  return requests;
}

function pick(requests: Request[], lines: LineRange | null): Request[] {
  if (!lines) return requests;
  const picked = requests.filter((r) => r.line <= lines.to && r.endLine >= lines.from);
  if (picked.length > 0 || lines.from !== lines.to) return picked;
  const before = requests.filter((r) => r.line <= lines.from).at(-1);
  return before ? [before] : [];
}

function segmentsOf(path: string): string[] {
  return (path.split('?')[0] ?? '')
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

const READ_POST = new Set([
  '_search',
  '_msearch',
  '_count',
  '_mget',
  '_explain',
  '_field_caps',
  '_validate',
  '_analyze',
  '_query',
  '_sql',
  '_pit',
  '_termvectors',
]);

/** Mirror of `db::search::classify::is_read` (the common cases). */
function isRead(method: HttpMethod, path: string): boolean {
  const segments = segmentsOf(path);
  if (method === 'GET' || method === 'HEAD') {
    return !segments.some((s) => ['_flush', '_refresh', '_forcemerge', '_cancel'].includes(s));
  }
  if (method === 'POST') {
    const api = segments.find((s) => s.startsWith('_'));
    return api !== undefined && READ_POST.has(api);
  }
  if (method === 'DELETE') return segments[0] === '_pit';
  return false;
}

function cellOf(value: JsonValue | undefined): Cell {
  if (value === undefined) return ['missing', ''];
  if (value === null) return null;
  if (typeof value === 'boolean') return ['bool', String(value)];
  if (typeof value === 'number')
    return Number.isInteger(value) ? ['int', String(value)] : ['float', String(value)];
  if (typeof value === 'string') return ['text', value];
  return ['json', JSON.stringify(value)];
}

function kindOf(value: JsonValue): ValueKind | null {
  const cell = cellOf(value);
  return cell === null ? null : cell[0];
}

/** `_source` flattened to dotted paths (mirror of `db::search::hits::flatten`). */
function flatten(source: JsonObject): [string, JsonValue][] {
  const out: [string, JsonValue][] = [];
  const walk = (prefix: string, value: JsonValue) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        for (const [key, child] of entries) walk(prefix ? `${prefix}.${key}` : key, child);
        return;
      }
    }
    out.push([prefix, value]);
  };
  for (const [key, value] of Object.entries(source)) walk(key, value);
  return out;
}

type Hit = JsonObject & { _source: JsonObject };

/** Mirror of `db::search::hits::hit_rows`. */
function hitGrid(
  hits: readonly Hit[],
  types: ReadonlyMap<string, string>,
): { columns: ColumnMeta[]; rows: Cell[][] } {
  const order = ['_index', '_id', '_score'];
  const kinds = new Map<string, Set<ValueKind>>();
  const cellsOf = (hit: Hit) => {
    const cells = new Map<string, JsonValue>();
    for (const meta of ['_index', '_id', '_score']) {
      const value = hit[meta];
      if (value !== undefined) cells.set(meta, value);
    }
    for (const [path, value] of flatten(hit._source)) if (!cells.has(path)) cells.set(path, value);
    return cells;
  };
  const all = hits.map(cellsOf);
  for (const cells of all) {
    for (const [path, value] of cells) {
      if (!order.includes(path)) order.push(path);
      const kind = kindOf(value);
      if (kind === null) continue;
      const seen = kinds.get(path) ?? new Set();
      seen.add(kind);
      kinds.set(path, seen);
    }
  }
  const columns = order.map((name): ColumnMeta => {
    const seen = [...(kinds.get(name) ?? [])];
    const kind: ValueKind =
      seen.length === 0
        ? 'text'
        : seen.length === 1
          ? (seen[0] ?? 'text')
          : seen.every((k) => k === 'int' || k === 'float')
            ? 'float'
            : 'json';
    return { name, typeName: types.get(name) ?? seen.join(' | '), kind };
  });
  const rows = all.map((cells) => order.map((name) => cellOf(cells.get(name))));
  return { columns, rows };
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

type Keep = (source: JsonObject) => boolean;

/** A value as text: scalars as written, the rest as JSON. */
function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

const equals =
  (path: string, expected: JsonValue): Keep =>
  (source) => {
    const value = valueAt(source, path);
    return Array.isArray(value)
      ? value.some((v) => textOf(v) === textOf(expected))
      : textOf(value) === textOf(expected);
  };

/** What a Query DSL object keeps: a `term` / `match` on one field; anything else keeps all. */
function dslMatcher(query: JsonValue | undefined): Keep {
  if (query === undefined || query === null || typeof query !== 'object' || Array.isArray(query)) {
    return () => true;
  }
  const [kind, spec] = Object.entries(query)[0] ?? ['match_all', {}];
  if (
    (kind === 'term' || kind === 'match') &&
    spec !== null &&
    typeof spec === 'object' &&
    !Array.isArray(spec)
  ) {
    const [field, value] = Object.entries(spec)[0] ?? ['', null];
    const expected =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value.value ?? value.query ?? null)
        : value;
    return equals(field, expected);
  }
  return () => true;
}

/** What an index tab's query keeps: `field:value` terms of a query string, or the DSL's. */
function matcher(query: IndexQuery): Keep | YadbeError {
  const text = query.text.trim();
  if (text === '') return () => true;
  if (query.mode === 'queryString') {
    const terms = text
      .split(/\s+AND\s+/i)
      .map((term) => /^([\w.@]+):"?([^"]*)"?$/.exec(term.trim()))
      .filter((m): m is RegExpExecArray => m !== null);
    if (terms.length === 0) {
      const needle = text.toLowerCase();
      return (source) => JSON.stringify(source).toLowerCase().includes(needle);
    }
    return (source) => terms.every((m) => equals(m[1] ?? '', m[2] ?? '')(source));
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (error) {
    return {
      ...mockErrors.invalidArgument(
        'The query is not valid JSON.',
        "La requête n'est pas du JSON valide.",
      ),
      detail: error instanceof Error ? error.message : null,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return mockErrors.invalidArgument(
      'The query is a JSON object of the Query DSL, like {"match": {"title": "yadbe"}}.',
      'La requête est un objet JSON du Query DSL, comme {"match": {"title": "yadbe"}}.',
    );
  }
  return dslMatcher('query' in parsed ? parsed.query : parsed);
}

export function createMockSearch(host: MockSearchHost) {
  let indices = mockSearchIndices();
  const tabs = new Map<string, Tab>();
  const edits = createMockSearchEdits({
    indices: () => indices,
    session: (connectionId) => host.session(connectionId),
    logStatement: (connectionId, sql, error) => {
      host.logStatement(connectionId, sql, error);
    },
    connectionName: (connectionId) => host.connectionName(connectionId),
    journal: host.journal,
  });

  function tabOf(tabId: string): Tab {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { results: [], abort: null };
      tabs.set(tabId, tab);
    }
    return tab;
  }

  async function wait(tab: Tab, ms: number): Promise<boolean> {
    tab.abort?.abort();
    const abort = new AbortController();
    tab.abort = abort;
    const done = await sleep(ms, abort.signal);
    if (tab.abort === abort) tab.abort = null;
    return done;
  }

  function storeHits(
    hits: readonly Hit[],
    types: ReadonlyMap<string, string>,
  ): { result: DocumentResult; ids: number[] } {
    const { columns, rows } = hitGrid(hits, types);
    const grid = host.storeRows(columns, rows);
    const whole = host.storeRows(
      [{ name: 'document', typeName: 'object', kind: 'json' }],
      hits.map((hit) => [['json', JSON.stringify(hit)]]),
    );
    return {
      ids: [grid, whole],
      result: {
        result: {
          resultId: grid,
          statementIndex: 0,
          columns,
          rowCount: hits.length,
          status: 'complete',
          pausedBy: null,
          bytes: hits.length * 260,
          truncated: false,
        },
        documentsId: whole,
        count: hits.length,
      },
    };
  }

  function hitsOf(
    index: MockIndex,
    keep: (source: JsonObject) => boolean,
    sort: { field: string; descending: boolean }[],
  ): Hit[] {
    const all: Hit[] = [];
    for (const { id, source, seq } of edits.docs(index)) {
      if (!keep(source)) continue;
      all.push({
        _index: index.name,
        _id: id,
        _score: sort.length > 0 ? null : 1,
        _seq_no: seq,
        _primary_term: 1,
        _source: source,
      });
    }
    if (sort.length > 0) {
      all.sort((a, b) => {
        for (const { field, descending } of sort) {
          const x = valueAt(a._source, field);
          const y = valueAt(b._source, field);
          const order = textOf(x).localeCompare(textOf(y), undefined, {
            numeric: true,
          });
          if (order !== 0) return descending ? -order : order;
        }
        return 0;
      });
    }
    return all;
  }

  function filterSource(hit: Hit, source: string): Hit {
    const fields = source
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    if (fields.length === 0) return hit;
    const includes = fields.filter((f) => !f.startsWith('-'));
    const excludes = fields.filter((f) => f.startsWith('-')).map((f) => f.slice(1).trim());
    const kept: JsonObject = {};
    for (const [key, value] of Object.entries(hit._source)) {
      const match = (p: string) => p === key || (p.endsWith('*') && key.startsWith(p.slice(0, -1)));
      if (includes.length > 0 && !includes.some(match)) continue;
      if (excludes.some(match)) continue;
      kept[key] = value;
    }
    return { ...hit, _source: kept };
  }

  function danger(
    index: MockIndex | null,
    method: HttpMethod,
    path: string,
    body: string | null,
    line: number,
  ): SearchDanger | null {
    const segments = segmentsOf(path);
    const target = segments[0] ?? '';
    if (method === 'DELETE' && segments.length === 1 && !target.startsWith('_')) {
      const names = [...indices.keys()].filter((name) =>
        target.endsWith('*') ? name.startsWith(target.slice(0, -1)) : name === target,
      );
      const docs = names.reduce((n, name) => n + (indices.get(name)?.count ?? 0), 0);
      return {
        line,
        request: `${method} ${path}`,
        kind: 'deleteIndex',
        effect:
          names.length === 0
            ? {
                en: `No index matches ${target} now.`,
                fr: `Aucun index ne correspond à ${target} actuellement.`,
              }
            : {
                en: `Deletes ${String(names.length)} index(es) and their ${docs.toLocaleString('en')} documents for good: ${names.join(', ')}.`,
                fr: `Supprime définitivement ${String(names.length)} index et leurs ${docs.toLocaleString('fr')} documents : ${names.join(', ')}.`,
              },
      };
    }
    if (method === 'POST' && segments[1] === '_delete_by_query' && index) {
      let query: JsonValue | undefined;
      try {
        query = body ? ((JSON.parse(body) as JsonObject).query ?? undefined) : undefined;
      } catch {
        query = undefined;
      }
      const count = hitsOf(index, dslMatcher(query), []).length;
      return {
        line,
        request: `${method} ${path}`,
        kind: 'deleteByQuery',
        effect: {
          en: `Deletes the ${count.toLocaleString('en')} documents of ${target} that match its query.`,
          fr: `Supprime les ${count.toLocaleString('fr')} documents de ${target} qui correspondent à sa requête.`,
        },
      };
    }
    return null;
  }

  function errorResponse(status: number, type: string, reason: string): JsonObject {
    return { error: { root_cause: [{ type, reason }], type, reason }, status };
  }

  /** The answer of the mock cluster to one request: status and body. */
  async function answer(
    tab: Tab,
    request: Request,
  ): Promise<{ status: number; body: JsonValue | string | null } | 'cancelled'> {
    const { method, path } = request;
    const segments = segmentsOf(path);
    let body: JsonObject = {};
    if (request.body !== null && !/_bulk|_msearch/.test(path)) {
      try {
        body = JSON.parse(request.body) as JsonObject;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected character';
        return {
          status: 400,
          body: errorResponse(400, 'x_content_parse_exception', `[2:5] ${message}`),
        };
      }
    }
    const slow = request.body?.includes('"script"') ?? false;
    if (!(await wait(tab, slow ? SLOW_MS : host.latency()))) return 'cancelled';
    if (segments.length === 0 && method === 'GET') {
      return {
        status: 200,
        body: {
          name: 'node-1',
          cluster_name: 'docker-cluster',
          version: { number: '9.1.0', build_flavor: 'default' },
          tagline: 'You Know, for Search',
        },
      };
    }
    if (segments[0] === '_cat' && segments[1] === 'indices') {
      const rows = [...indices.values()].map(
        (i) =>
          `${i.health.padEnd(6)} ${i.open ? 'open ' : 'close'} ${i.name.padEnd(34)} ${String(i.count).padStart(6)}`,
      );
      return { status: 200, body: rows.join('\n') + '\n' };
    }
    if (segments[0] === '_query' && method === 'POST') {
      const orders = indices.get('orders');
      const values: JsonValue[] = [];
      for (let i = 0; i < 5 && orders; i++) {
        const { source } = orders.doc(i);
        values.push([source.order_id ?? null, source.status ?? null, source.total ?? null]);
      }
      return {
        status: 200,
        body: {
          took: 3,
          columns: [
            { name: 'order_id', type: 'keyword' },
            { name: 'status', type: 'keyword' },
            { name: 'total', type: 'double' },
          ],
          values,
        },
      };
    }
    const target = segments[0] ?? '';
    const index = resolveTarget(indices, target);
    const api = segments[1];
    if (method === 'DELETE' && segments.length === 1 && !target.startsWith('_')) {
      const names = [...indices.keys()].filter((name) =>
        target.endsWith('*') ? name.startsWith(target.slice(0, -1)) : name === target,
      );
      if (names.length === 0)
        return {
          status: 404,
          body: errorResponse(404, 'index_not_found_exception', `no such index [${target}]`),
        };
      for (const name of names) indices.delete(name);
      return { status: 200, body: { acknowledged: true } };
    }
    if (!index) {
      return {
        status: 404,
        body: errorResponse(404, 'index_not_found_exception', `no such index [${target}]`),
      };
    }
    const query = body.query;
    if (api === '_mapping') {
      const properties: JsonObject = {};
      for (const field of index.fields) {
        if (!field.path.includes('.')) properties[field.path] = { type: field.typeName };
      }
      return { status: 200, body: { [index.name]: { mappings: { properties } } } };
    }
    const keep = dslMatcher(query);
    if (api === '_count') {
      return {
        status: 200,
        body: {
          count: hitsOf(index, keep, []).length,
          _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        },
      };
    }
    if (api === '_delete_by_query') {
      const deleted = hitsOf(index, keep, []).length;
      index.count -= deleted;
      return { status: 200, body: { took: 12, deleted, total: deleted, failures: [] } };
    }
    if (api === '_search') {
      const size = typeof body.size === 'number' ? body.size : 10;
      const hits = hitsOf(index, keep, []);
      const shown = hits.slice(0, size);
      const result: JsonObject = {
        took: 4,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: {
          total: {
            value: Math.min(hits.length, TRACK_TOTAL),
            relation: hits.length > TRACK_TOTAL ? 'gte' : 'eq',
          },
          max_score: 1,
          hits: shown,
        },
      };
      if (body.aggs && typeof body.aggs === 'object') {
        const buckets = new Map<string, number>();
        for (const hit of hits) {
          const key = textOf(
            valueAt(hit._source, 'status') ?? valueAt(hit._source, 'level') ?? 'other',
          );
          buckets.set(key, (buckets.get(key) ?? 0) + 1);
        }
        result.aggregations = {
          by_key: { buckets: [...buckets].map(([key, doc_count]) => ({ key, doc_count })) },
        };
      }
      return { status: 200, body: result };
    }
    return {
      status: 400,
      body: errorResponse(
        400,
        'illegal_argument_exception',
        `request [${method} ${path}] is not supported by the mock`,
      ),
    };
  }

  const commands: Pick<
    Commands,
    | 'searchListIndices'
    | 'searchListDataStreams'
    | 'searchListAliases'
    | 'searchListTemplates'
    | 'searchIndexDetails'
    | 'searchOpenIndex'
    | 'searchFetchPage'
    | 'searchCount'
    | 'searchConsoleRun'
    | 'searchCancel'
    | 'searchCloseTab'
    | 'searchFetchDocuments'
  > = {
    async searchListIndices(connectionId) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(
        connectionId,
        'GET /_cat/indices?format=json&bytes=b&expand_wildcards=all&h=index,health,status,docs.count,store.size,pri,rep',
      );
      return ok(
        [...indices.values()]
          .map((i) => ({
            name: i.name,
            health: i.health,
            open: i.open,
            docs: i.count,
            sizeBytes: i.count * 410,
            primaries: 1,
            replicas: 1,
            system: i.system,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
    async searchListDataStreams(connectionId) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(connectionId, 'GET /_data_stream');
      return ok(structuredClone(MOCK_DATA_STREAMS));
    },
    async searchListAliases(connectionId) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(connectionId, 'GET /_alias');
      return ok(structuredClone(MOCK_ALIASES));
    },
    async searchListTemplates(connectionId) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      host.logStatement(connectionId, 'GET /_index_template');
      return ok(structuredClone(MOCK_TEMPLATES));
    },
    async searchIndexDetails(connectionId, target) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      await new Promise((resolve) => setTimeout(resolve, host.latency()));
      const index = resolveTarget(indices, target);
      host.logStatement(connectionId, `GET /${target}/_mapping`);
      if (!index) return fail(mockErrors.objectNotFound(target));
      return ok({
        fields: structuredClone(index.fields),
        settings: structuredClone(index.settings),
        maxResultWindow: 10_000,
      });
    },
    async searchOpenIndex(tabId, connectionId, target) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const tab = tabOf(tabId);
      if (!(await wait(tab, host.latency()))) return fail(mockErrors.cancelled());
      const index = resolveTarget(indices, target);
      if (!index) return fail(mockErrors.objectNotFound(target));
      const info: IndexTabInfo = {
        target,
        details: {
          fields: structuredClone(index.fields),
          settings: structuredClone(index.settings),
          maxResultWindow: 10_000,
        },
        server: MOCK_SEARCH_SERVER,
        paging: 'pointInTime',
      };
      return ok(info);
    },
    async searchFetchPage(tabId, connectionId, target, query, page) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const tab = tabOf(tabId);
      const index = resolveTarget(indices, target);
      if (!index) return fail(mockErrors.objectNotFound(target));
      const keep = matcher(query);
      if ('code' in keep) return fail(keep);
      const started = Date.now();
      if (!(await wait(tab, host.latency()))) return fail(mockErrors.cancelled());
      const hits = hitsOf(index, keep, query.sort).map((hit) => filterSource(hit, query.source));
      const from = page * query.pageSize;
      const shown = hits.slice(from, from + query.pageSize);
      const types = new Map(index.fields.map((f) => [f.path, f.typeName]));
      host.freeResults(tab.results);
      const stored = storeHits(shown, types);
      tab.results = stored.ids;
      const request = `POST /_search\n${JSON.stringify({
        size: query.pageSize + 1,
        query:
          query.text.trim() === ''
            ? { match_all: {} }
            : query.mode === 'queryString'
              ? { query_string: { query: query.text } }
              : (JSON.parse(query.text) as JsonValue),
        sort:
          query.sort.length > 0
            ? query.sort.map((s) => ({ [s.field]: { order: s.descending ? 'desc' : 'asc' } }))
            : [{ _shard_doc: { order: 'asc' } }],
        track_total_hits: page === 0 ? TRACK_TOTAL : false,
        pit: { id: 'mock-pit', keep_alive: '5m' },
      })}`;
      host.logStatement(connectionId, request);
      const result: IndexPage = {
        documents: stored.result,
        page,
        hasMore: from + query.pageSize < hits.length,
        total: { value: Math.min(hits.length, TRACK_TOTAL), exact: hits.length <= TRACK_TOTAL },
        paging: 'pointInTime',
        window: null,
        request,
        tookMs: 4,
        durationMs: Date.now() - started,
      };
      return ok(result);
    },
    async searchCount(tabId, connectionId, target, query) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      const tab = tabOf(tabId);
      const index = resolveTarget(indices, target);
      if (!index) return fail(mockErrors.objectNotFound(target));
      const keep = matcher(query);
      if ('code' in keep) return fail(keep);
      if (!(await wait(tab, host.latency() * 2))) return fail(mockErrors.cancelled());
      host.logStatement(connectionId, `POST /${target}/_count`);
      return ok(hitsOf(index, keep, []).length);
    },
    async searchConsoleRun(tabId, connectionId, text, lines, confirmed) {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const parsed = parseMockConsole(text);
      if (!Array.isArray(parsed)) {
        const outcome: SearchConsoleOutcome = {
          kind: 'ran',
          responses: [],
          skipped: 0,
          failure: parsed,
        };
        return ok(outcome);
      }
      const picked = pick(parsed, lines);
      if (!confirmed) {
        const dangers = picked
          .filter((r) => !session.readOnly || isRead(r.method, r.path))
          .map((r) =>
            danger(
              resolveTarget(indices, segmentsOf(r.path)[0] ?? ''),
              r.method,
              r.path,
              r.body,
              r.line,
            ),
          )
          .filter((d): d is SearchDanger => d !== null);
        if (dangers.length > 0) return ok({ kind: 'needsConfirmation', dangers });
      }
      const tab = tabOf(tabId);
      host.freeResults(tab.results);
      tab.results = [];
      const responses: ConsoleResponse[] = [];
      let skipped = 0;
      for (const [position, request] of picked.entries()) {
        const started = Date.now();
        const sql =
          request.body === null
            ? `${request.method} ${request.path}`
            : `${request.method} ${request.path}\n${request.body.trimEnd()}`;
        const response: ConsoleResponse = {
          line: request.line,
          method: request.method,
          path: request.path,
          status: null,
          durationMs: 0,
          tookMs: null,
          shards: null,
          timedOut: false,
          error: null,
          errorPosition: null,
          body: { kind: 'empty' },
        };
        let stop = false;
        if (session.readOnly && !isRead(request.method, request.path)) {
          response.error = mockErrors.readOnlyViolation(`${request.method} ${request.path}`);
          stop = true;
        } else {
          const answered = await answer(tab, request);
          if (answered === 'cancelled') {
            response.error = mockErrors.cancelled();
            stop = true;
          } else {
            response.status = answered.status;
            const { body } = answered;
            if (typeof body === 'string') {
              response.body = { kind: 'text', text: body, truncated: false };
            } else if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
              const json = body;
              const raw = JSON.stringify(json);
              const document = host.storeRows(
                [{ name: 'document', typeName: 'object', kind: 'json' }],
                [[['json', raw]]],
              );
              tab.results.push(document);
              const hitsValue = (json.hits as JsonObject | undefined)?.hits;
              let hits: DocumentResult | null = null;
              if (Array.isArray(hitsValue)) {
                const stored = storeHits(hitsValue as Hit[], new Map());
                tab.results.push(...stored.ids);
                hits = stored.result;
              }
              let table = null;
              if (Array.isArray(json.columns) && Array.isArray(json.values)) {
                const columns = (json.columns as JsonObject[]).map((c): ColumnMeta => ({
                  name: textOf(c.name),
                  typeName: textOf(c.type),
                  kind: c.type === 'double' ? 'float' : c.type === 'long' ? 'int' : 'text',
                }));
                const rows = (json.values as JsonValue[][]).map((row) => row.map((v) => cellOf(v)));
                const id = host.storeRows(columns, rows);
                tab.results.push(id);
                table = {
                  resultId: id,
                  statementIndex: 0,
                  columns,
                  rowCount: rows.length,
                  status: 'complete' as const,
                  pausedBy: null,
                  bytes: rows.length * 40,
                  truncated: false,
                };
              }
              const total = (json.hits as JsonObject | undefined)?.total as JsonObject | undefined;
              const consoleBody: ConsoleBody = {
                kind: 'json',
                raw,
                truncated: false,
                documentId: document,
                hits,
                total: total
                  ? { value: Number(total.value), exact: total.relation !== 'gte' }
                  : null,
                table,
              };
              response.body = consoleBody;
              response.tookMs = typeof json.took === 'number' ? json.took : null;
              const shards = json._shards as JsonObject | undefined;
              if (shards) {
                response.shards = {
                  total: Number(shards.total),
                  successful: Number(shards.successful),
                  skipped: Number(shards.skipped),
                  failed: Number(shards.failed),
                };
              }
              const error = json.error as JsonObject | undefined;
              if (error) {
                const type = textOf(error.type);
                const reason = textOf(error.reason);
                response.error =
                  type === 'index_not_found_exception'
                    ? mockErrors.objectNotFound(segmentsOf(request.path)[0] ?? '')
                    : mockErrors.queryFailed(`HTTP ${String(answered.status)} ${type}: ${reason}`);
                const at = /^\[(\d+):(\d+)\]/.exec(reason);
                const bodyLine = at ? request.bodyLines[Number(at[1]) - 1] : undefined;
                if (at && bodyLine !== undefined) {
                  response.errorPosition = { line: bodyLine + 1, column: Number(at[2]) };
                }
              }
            }
          }
        }
        response.durationMs = Date.now() - started;
        host.recordHistory({
          tabId,
          connectionId,
          database: null,
          sql,
          startedAt: started,
          durationMs: response.durationMs,
          rows: response.body.kind === 'json' ? (response.body.hits?.count ?? null) : null,
          outcome:
            response.error === null
              ? 'ok'
              : response.error.code === 'readOnlyViolation'
                ? 'refused'
                : 'error',
          error: response.error,
        });
        responses.push(response);
        if (stop) {
          skipped = picked.length - position - 1;
          break;
        }
      }
      return ok({ kind: 'ran', responses, skipped, failure: null });
    },
    searchCancel(tabId) {
      tabs.get(tabId)?.abort?.abort();
      return ok(null);
    },
    searchCloseTab(tabId) {
      const tab = tabs.get(tabId);
      if (tab) {
        tab.abort?.abort();
        host.freeResults(tab.results);
        tabs.delete(tabId);
      }
      return ok(null);
    },
    searchFetchDocuments(documentsId, offset, limit) {
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
    commands: { ...commands, ...edits.commands },
    reset(): void {
      indices = mockSearchIndices();
      tabs.clear();
      edits.reset();
    },
  };
}
