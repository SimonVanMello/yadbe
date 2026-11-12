import { startingWith, type ConsoleOption, type ConsoleSuggestions } from './consoleCompletion';

/**
 * Completion of the search console (Kibana's syntax: `GET /orders/_search` then a JSON body):
 * methods, endpoint paths with the names of the cluster, the top-level keys of a search body,
 * query types and the mapping's fields where the index is known.
 */

export const METHODS: readonly string[] = ['DELETE', 'GET', 'HEAD', 'POST', 'PUT'];

/** First segments that are not an index. */
const ROOT_ENDPOINTS: readonly string[] = [
  '_alias',
  '_aliases',
  '_analyze',
  '_bulk',
  '_cat',
  '_cluster',
  '_count',
  '_data_stream',
  '_field_caps',
  '_index_template',
  '_mapping',
  '_msearch',
  '_nodes',
  '_query',
  '_refresh',
  '_resolve',
  '_search',
  '_settings',
  '_sql',
  '_stats',
  '_tasks',
  '_template',
];

/** What follows an index, alias or data stream name. */
const INDEX_ENDPOINTS: readonly string[] = [
  '_alias',
  '_analyze',
  '_bulk',
  '_close',
  '_count',
  '_create',
  '_delete_by_query',
  '_doc',
  '_explain',
  '_field_caps',
  '_flush',
  '_mapping',
  '_msearch',
  '_open',
  '_refresh',
  '_search',
  '_settings',
  '_source',
  '_stats',
  '_update',
  '_update_by_query',
  '_validate/query',
];

const CAT_ENDPOINTS: readonly string[] = [
  'aliases',
  'allocation',
  'count',
  'health',
  'indices',
  'master',
  'nodes',
  'plugins',
  'segments',
  'shards',
  'tasks',
  'templates',
  'thread_pool',
];

const CLUSTER_ENDPOINTS: readonly string[] = [
  'allocation/explain',
  'health',
  'pending_tasks',
  'settings',
  'state',
  'stats',
];

const NODES_ENDPOINTS: readonly string[] = ['hot_threads', 'info', 'stats', 'usage'];

/** The keys of a `_search` body. */
const SEARCH_KEYS: readonly string[] = [
  '_source',
  'aggregations',
  'aggs',
  'collapse',
  'docvalue_fields',
  'explain',
  'fields',
  'from',
  'highlight',
  'knn',
  'min_score',
  'pit',
  'post_filter',
  'query',
  'rescore',
  'runtime_mappings',
  'search_after',
  'seq_no_primary_term',
  'size',
  'sort',
  'stored_fields',
  'suggest',
  'terminate_after',
  'timeout',
  'track_total_hits',
  'version',
];

const BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  _search: SEARCH_KEYS,
  _count: ['query'],
  _delete_by_query: ['max_docs', 'query', 'slice'],
  _update_by_query: ['max_docs', 'query', 'script', 'slice'],
  _update: ['doc', 'doc_as_upsert', 'script', 'upsert'],
  _explain: ['query'],
  _analyze: ['analyzer', 'field', 'filter', 'text', 'tokenizer'],
  _query: ['columnar', 'filter', 'params', 'query'],
  _sql: ['columnar', 'cursor', 'fetch_size', 'filter', 'params', 'query'],
};

const QUERY_TYPES: readonly string[] = [
  'bool',
  'boosting',
  'constant_score',
  'dis_max',
  'exists',
  'function_score',
  'fuzzy',
  'geo_distance',
  'ids',
  'knn',
  'match',
  'match_all',
  'match_none',
  'match_phrase',
  'match_phrase_prefix',
  'multi_match',
  'nested',
  'prefix',
  'query_string',
  'range',
  'regexp',
  'script_score',
  'simple_query_string',
  'term',
  'terms',
  'wildcard',
];

const BOOL_KEYS: readonly string[] = [
  'filter',
  'minimum_should_match',
  'must',
  'must_not',
  'should',
];

/** Queries whose object is `{ "<field>": … }`. */
const FIELD_QUERIES = new Set([
  'fuzzy',
  'match',
  'match_bool_prefix',
  'match_phrase',
  'match_phrase_prefix',
  'prefix',
  'range',
  'regexp',
  'term',
  'terms',
  'wildcard',
]);

/** Keys whose object holds queries. */
const QUERY_HOLDERS = new Set(['filter', 'must', 'must_not', 'post_filter', 'query', 'should']);

const AGG_TYPES: readonly string[] = [
  'aggs',
  'avg',
  'cardinality',
  'date_histogram',
  'extended_stats',
  'filter',
  'filters',
  'histogram',
  'max',
  'min',
  'percentiles',
  'range',
  'stats',
  'sum',
  'terms',
  'top_hits',
  'value_count',
];

/** The aggregations that take a field. */
const FIELD_AGGS = new Set([
  'avg',
  'cardinality',
  'date_histogram',
  'extended_stats',
  'histogram',
  'max',
  'min',
  'percentiles',
  'range',
  'stats',
  'sum',
  'terms',
  'value_count',
]);

/** String values that are field names. */
const FIELD_VALUE_KEYS = new Set(['_source', 'excludes', 'field', 'fields', 'includes']);

/** Where in a search request the cursor is. */
export type SearchContext =
  | { kind: 'method'; from: number; prefix: string }
  | {
      kind: 'path';
      from: number;
      prefix: string;
      /** The segments before the one being typed. */
      segments: string[];
    }
  | {
      kind: 'key';
      from: number;
      prefix: string;
      quoted: boolean;
      /** The keys of the objects around the cursor, outermost first. */
      path: string[];
      endpoint: string | null;
      target: string | null;
    }
  | {
      kind: 'fieldValue';
      from: number;
      prefix: string;
      target: string | null;
    }
  | { kind: 'none' };

const REQUEST_LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\b\s*(\S*)/i;

interface JsonFrame {
  open: '[' | '{';
  key: string | null;
  expectKey: boolean;
}

interface JsonScan {
  stack: JsonFrame[];
  /** Inside a string at the end of the text: its quote and where its content starts. */
  string: { start: number } | null;
}

/** Walks a JSON body up to its end keeping the open brackets, the keys and the open string. */
function scanJson(text: string): JsonScan {
  const stack: JsonFrame[] = [];
  let i = 0;
  let last: string | null = null;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === '\\' ? 2 : 1;
      if (j >= text.length) return { stack, string: { start: i + 1 } };
      last = text.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') stack.push({ open: c, key: null, expectKey: c === '{' });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ':') {
      const frame = stack[stack.length - 1];
      if (frame?.open === '{') {
        frame.key = last;
        frame.expectKey = false;
      }
    } else if (c === ',') {
      const frame = stack[stack.length - 1];
      if (frame?.open === '{') {
        frame.expectKey = true;
        frame.key = null;
      }
    }
    i += 1;
  }
  return { stack, string: null };
}

/** `{` frames only: arrays are transparent (`must: [ { … } ]` reads as `must`). */
function objectKeys(stack: readonly JsonFrame[]): string[] {
  const objects = stack.filter((frame) => frame.open === '{');
  return objects.slice(0, -1).map((frame) => frame.key ?? '');
}

/** What is being typed at `position` in the console's text. */
export function searchContext(text: string, position: number): SearchContext {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const lineBefore = text.slice(lineStart, position);
  const lines = text.slice(0, lineStart).split('\n');
  if (lineStart === 0) lines.length = 0;
  // The request the cursor belongs to, and the body typed since its line.
  let request: { method: string; path: string; bodyFrom: number } | null = null;
  let offset = 0;
  let depth = 0;
  for (const line of lines) {
    const found = depth === 0 ? REQUEST_LINE.exec(line) : null;
    if (found) {
      request = {
        method: (found[1] ?? '').toUpperCase(),
        path: found[2] ?? '',
        bodyFrom: offset + line.length + 1,
      };
      depth = 0;
    } else if (request) {
      const stack = scanJson(text.slice(request.bodyFrom, offset + line.length + 1)).stack;
      depth = stack.length;
    }
    offset += line.length + 1;
  }
  const bodyDepth = request ? scanJson(text.slice(request.bodyFrom, lineStart)).stack.length : 0;

  if (bodyDepth === 0) {
    const head = /^\s*([A-Za-z]*)$/.exec(lineBefore);
    if (head)
      return { kind: 'method', from: position - (head[1] ?? '').length, prefix: head[1] ?? '' };
    const path = /^\s*(?:GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S*)$/i.exec(lineBefore);
    if (path) {
      const typed = path[1] ?? '';
      if (typed.includes('?')) return { kind: 'none' };
      const parts = typed.replace(/^\//, '').split('/');
      const prefix = parts.pop() ?? '';
      return { kind: 'path', from: position - prefix.length, prefix, segments: parts };
    }
  }
  if (!request) return { kind: 'none' };

  const segments = request.path
    .replace(/\?.*$/, '')
    .split('/')
    .filter((part) => part !== '');
  const endpoint = [...segments].reverse().find((part) => part.startsWith('_')) ?? null;
  const first = segments[0];
  const target = first !== undefined && !first.startsWith('_') ? first : null;

  const body = text.slice(request.bodyFrom, position);
  const { stack, string } = scanJson(body);
  const frame = stack[stack.length - 1];
  if (!frame) return { kind: 'none' };
  if (string) {
    const typed = body.slice(string.start);
    const absolute = request.bodyFrom + string.start;
    if (frame.open === '{' && frame.expectKey) {
      return {
        kind: 'key',
        from: absolute,
        prefix: typed,
        quoted: true,
        path: objectKeys(stack),
        endpoint,
        target,
      };
    }
    const owner = frame.open === '{' ? frame.key : enclosingKey(stack);
    if (owner !== null && FIELD_VALUE_KEYS.has(owner)) {
      return { kind: 'fieldValue', from: absolute, prefix: typed, target };
    }
    return { kind: 'none' };
  }
  const word = /[A-Za-z_]*$/.exec(body)?.[0] ?? '';
  if (frame.open === '{' && frame.expectKey) {
    return {
      kind: 'key',
      from: position - word.length,
      prefix: word,
      quoted: false,
      path: objectKeys(stack),
      endpoint,
      target,
    };
  }
  return { kind: 'none' };
}

/** The key of the object holding the innermost array. */
function enclosingKey(stack: readonly JsonFrame[]): string | null {
  for (let i = stack.length - 2; i >= 0; i--) {
    const frame = stack[i];
    if (frame?.open === '{') return frame.key;
  }
  return null;
}

/** The metadata the options draw on; what is not cached is empty. */
export interface SearchData {
  /** Indices, aliases and data streams of the cluster. */
  targets: readonly string[];
  /** The mapping's fields of an index, alias or data stream; `null` when not read. */
  fields: (
    target: string,
  ) => readonly { path: string; typeName: string; sortable: boolean }[] | null;
}

const option = (
  label: string,
  type: string,
  extra: Partial<ConsoleOption> = {},
): ConsoleOption => ({
  label,
  type,
  ...extra,
});

function keyOptions(
  context: Extract<SearchContext, { kind: 'key' }>,
  data: SearchData,
): ConsoleOption[] {
  const { path, endpoint, target } = context;
  const names = (list: readonly string[], type = 'property') =>
    list.map((name) => option(name, type));
  const fields = (sortOnly = false) =>
    (target === null ? null : data.fields(target))
      ?.filter((field) => !sortOnly || field.sortable)
      .map((field) => option(field.path, 'property', { detail: field.typeName })) ?? [];

  if (path.length === 0) return names(endpoint === null ? [] : (BODY_KEYS[endpoint] ?? []));
  const last = path[path.length - 1] ?? '';
  const before = path[path.length - 2] ?? null;
  if (last === 'bool') return names(BOOL_KEYS);
  if (last === 'sort')
    return [...fields(true), option('_score', 'keyword'), option('_doc', 'keyword')];
  if (last === '_source') return names(['excludes', 'includes']);
  if (last === 'highlight') return names(['fields', 'post_tags', 'pre_tags']);
  if (last === 'fields' && before === 'highlight') return fields();
  if (last === 'aggs' || last === 'aggregations') return [];
  if (before === 'aggs' || before === 'aggregations') return names(AGG_TYPES, 'keyword');
  if (FIELD_AGGS.has(last) && (path.includes('aggs') || path.includes('aggregations'))) {
    return names(['field']);
  }
  if (FIELD_QUERIES.has(last)) return fields();
  if (last === 'exists') return names(['field']);
  if (QUERY_HOLDERS.has(last)) return names(QUERY_TYPES, 'keyword');
  return [];
}

/** The suggestions for a context. */
export function searchOptions(
  context: SearchContext,
  data: SearchData,
  to: number,
): ConsoleSuggestions | null {
  if (context.kind === 'none') return null;
  let options: ConsoleOption[] = [];
  switch (context.kind) {
    case 'method':
      options = METHODS.map((name) => option(name, 'keyword'));
      break;
    case 'path': {
      const [first, second] = context.segments;
      const names = (list: readonly string[], type: string) => list.map((n) => option(n, type));
      if (first === undefined) {
        options = [
          ...data.targets.map((name) => option(name, 'class', { boost: 1 })),
          ...names(ROOT_ENDPOINTS, 'keyword'),
        ];
      } else if (context.segments.length === 1) {
        if (first === '_cat') options = names(CAT_ENDPOINTS, 'keyword');
        else if (first === '_cluster') options = names(CLUSTER_ENDPOINTS, 'keyword');
        else if (first === '_nodes') options = names(NODES_ENDPOINTS, 'keyword');
        else if (first === '_data_stream' || first === '_alias') {
          options = data.targets.map((name) => option(name, 'class'));
        } else if (!first.startsWith('_')) options = names(INDEX_ENDPOINTS, 'keyword');
      } else if (second !== undefined && first === '_cat' && second === 'indices') {
        options = data.targets.map((name) => option(name, 'class'));
      }
      break;
    }
    case 'key':
      options = keyOptions(context, data);
      break;
    case 'fieldValue':
      options =
        (context.target === null ? null : data.fields(context.target))?.map((field) =>
          option(field.path, 'property', { detail: field.typeName }),
        ) ?? [];
      break;
  }
  if (context.kind === 'key' && !context.quoted) {
    options = options.map((o) => ({ ...o, apply: `"${o.label}"` }));
  }
  const found = startingWith(options, context.prefix);
  return found.length === 0 ? null : { from: context.from, to, options: found };
}

/** Suggestions for the console's text at `position`. */
export function searchSuggest(
  text: string,
  position: number,
  data: SearchData,
  explicit = false,
): ConsoleSuggestions | null {
  const context = searchContext(text, position);
  // A line that holds nothing yet is not worth a list until asked.
  if (context.kind === 'method' && context.prefix === '' && !explicit) return null;
  return searchOptions(context, data, position);
}
