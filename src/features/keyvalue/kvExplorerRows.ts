import type { KvBytes, KvDatabase, KvLevel, KvScanStatus, YadbeError } from '../../ipc';
import { fuzzyMatch } from '../connections/fuzzy';
import type { ConnectionSummary } from '../connections/model';
import type { Loadable } from '../explorer/explorerRows';
import { textBytes } from './kvBytes';
import { LEVEL_PAGE } from './kvTreeStore';

/**
 * Where the key-value tree reads its data. `fetch` says the node is open on screen: the source
 * then makes sure the data gets loaded (see `explorer/metaSource.ts`).
 */
export interface KvSource {
  databases(fetch: boolean): Loadable<KvDatabase[]>;
  scan(database: number, pattern: string | null, fetch: boolean): Loadable<KvScanStatus>;
  level(
    database: number,
    prefix: KvBytes,
    delimiter: string,
    limit: number,
    fetch: boolean,
  ): Loadable<KvLevel>;
}

export type KvRowBody =
  | { type: 'kvDatabase'; database: KvDatabase }
  /** The `MATCH` pattern of the database's scan, typed in the tree. */
  | { type: 'kvPattern'; database: number; pattern: string }
  | { type: 'kvNamespace'; database: number; name: KvBytes; prefix: KvBytes; keys: number }
  /** `fullKey`: the whole key (`name` is what follows the parent's prefix). */
  | { type: 'kvKey'; database: number; name: KvBytes; fullKey: KvBytes }
  /** More entries in the level than shown: "show more". */
  | { type: 'kvMore'; database: number; shown: number; total: number; levelNode: string }
  /** Where the database's scan stands, while it is not done. */
  | { type: 'kvScan'; status: KvScanStatus }
  | {
      type: 'kvStatus';
      status: 'loading' | 'empty' | 'error';
      subject: 'databases' | 'keys';
      error: YadbeError | null;
      database: number | null;
    };

export type KvRow = KvRowBody & {
  /** Unique in the whole sidebar. */
  key: string;
  connectionId: string;
  /** Node key inside the connection. */
  nodeKey: string;
  level: number;
  expandable: boolean;
  expanded: boolean;
  indices: readonly number[];
};

export const KV_ROW_TYPES: ReadonlySet<string> = new Set([
  'kvDatabase',
  'kvPattern',
  'kvNamespace',
  'kvKey',
  'kvMore',
  'kvScan',
  'kvStatus',
]);

export function isKvRow(row: { type: string }): row is KvRow {
  return KV_ROW_TYPES.has(row.type);
}

/** Node keys of the key-value tree; the expanded state is a set of these. */
export const kvNodeKeys = {
  database: (database: number) => JSON.stringify(['kvd', database]),
  namespace: (database: number, prefix: KvBytes) =>
    JSON.stringify(['kvn', database, prefix.base64 ?? prefix.text, prefix.base64 !== null]),
  /** The level under a database (its root) or a namespace. */
  level: (database: number, prefix: KvBytes) =>
    prefix.text === '' && prefix.base64 === null
      ? JSON.stringify(['kvd', database])
      : JSON.stringify(['kvn', database, prefix.base64 ?? prefix.text, prefix.base64 !== null]),
};

/** What the sidebar gives the key-value trees of its connections. */
export interface KvSidebarInput {
  sourceFor: (connectionId: string) => KvSource;
  /** The connection's key delimiter, else the preference's. */
  delimiterFor: (connection: ConnectionSummary) => string;
  patternOf: (connectionId: string, database: number) => string | null;
  typedPatternOf: (connectionId: string, database: number) => string;
  limitOf: (connectionId: string, node: string) => number;
}

export interface KvBuildInput {
  connectionId: string;
  /** Level of the first row (the connection's own level + 1). */
  level: number;
  expanded: ReadonlySet<string>;
  source: KvSource;
  delimiter: string;
  /** The pattern of each database's scan (`null`: every key). */
  patternOf: (database: number) => string | null;
  /** The text typed in each database's pattern row. */
  typedPatternOf: (database: number) => string;
  /** Entries shown per level (node key); absent: one page. */
  limitOf: (level: string) => number;
  /** Only a connection that is up loads anything. */
  fetching: boolean;
  /** The sidebar's search: keeps the loaded rows whose name matches, with their ancestors. */
  filter: string;
}

interface Node {
  id: string;
  body: KvRowBody;
  expandable: boolean;
  children: Node[] | null;
  indices: number[];
}

function node(
  id: string,
  body: KvRowBody,
  expandable = false,
  children: Node[] | null = null,
): Node {
  return { id, body, expandable, children, indices: [] };
}

function statusNode(
  parent: string,
  status: 'loading' | 'empty' | 'error',
  subject: 'databases' | 'keys',
  database: number | null,
  error: YadbeError | null = null,
): Node {
  return node(`${parent}/status`, { type: 'kvStatus', status, subject, error, database });
}

function levelNodes(
  input: KvBuildInput,
  database: number,
  prefix: KvBytes,
  parent: string,
): Node[] {
  const levelId = kvNodeKeys.level(database, prefix);
  const limit = input.limitOf(levelId);
  const loadable = input.source.level(database, prefix, input.delimiter, limit, input.fetching);
  switch (loadable.state) {
    case 'idle':
    case 'loading':
      return [statusNode(parent, 'loading', 'keys', database)];
    case 'error':
      return [statusNode(parent, 'error', 'keys', database, loadable.error)];
    case 'ready':
      break;
  }
  const { entries, total } = loadable.data;
  const nodes: Node[] = [];
  for (const entry of entries) {
    if (entry.type === 'namespace') {
      const id = kvNodeKeys.namespace(database, entry.prefix);
      const open = input.expanded.has(id);
      nodes.push(
        node(
          id,
          {
            type: 'kvNamespace',
            database,
            name: entry.name,
            prefix: entry.prefix,
            keys: entry.keys,
          },
          true,
          open ? levelNodes(input, database, entry.prefix, id) : null,
        ),
      );
    } else {
      nodes.push(
        node(JSON.stringify(['kvk', database, entry.key.base64 ?? entry.key.text]), {
          type: 'kvKey',
          database,
          name: entry.name,
          fullKey: entry.key,
        }),
      );
    }
  }
  if (total > entries.length) {
    nodes.push(
      node(`${levelId}/more`, {
        type: 'kvMore',
        database,
        shown: entries.length,
        total,
        levelNode: levelId,
      }),
    );
  }
  return nodes;
}

function databaseContent(input: KvBuildInput, database: number, id: string): Node[] {
  const pattern = input.patternOf(database);
  const children: Node[] = [
    node(`${id}/pattern`, {
      type: 'kvPattern',
      database,
      pattern: input.typedPatternOf(database),
    }),
  ];
  const scan = input.source.scan(database, pattern, input.fetching);
  switch (scan.state) {
    case 'idle':
    case 'loading':
      children.push(statusNode(id, 'loading', 'keys', database));
      return children;
    case 'error':
      children.push(statusNode(id, 'error', 'keys', database, scan.error));
      return children;
    case 'ready':
      break;
  }
  const status = scan.data;
  if (status.loaded === 0 && status.state === 'done') {
    children.push(statusNode(id, 'empty', 'keys', database));
    return children;
  }
  children.push(...levelNodes(input, database, textBytes(''), id));
  if (status.state !== 'done') {
    children.push(node(`${id}/scan`, { type: 'kvScan', status }));
  }
  return children;
}

function nameOf(body: KvRowBody): string | null {
  switch (body.type) {
    case 'kvNamespace':
    case 'kvKey':
      return body.name.text;
    default:
      return null;
  }
}

function prune(nodes: readonly Node[], query: string): Node[] {
  const kept: Node[] = [];
  for (const entry of nodes) {
    if (
      entry.body.type !== 'kvNamespace' &&
      entry.body.type !== 'kvKey' &&
      entry.body.type !== 'kvDatabase'
    ) {
      continue;
    }
    const name = nameOf(entry.body);
    const match = name === null ? null : fuzzyMatch(query, name);
    const children = entry.children ? prune(entry.children, query) : [];
    if (!match && children.length === 0) continue;
    kept.push({
      ...entry,
      indices: match?.indices ?? [],
      children: children.length > 0 ? children : null,
    });
  }
  return kept;
}

/**
 * The explorer of a key-value connection: its databases, each with a pattern row, the key tree
 * of its scan (namespaces by the delimiter, then keys, a page at a time) and the scan's state.
 */
export function kvExplorerRows(input: KvBuildInput): KvRow[] {
  const databases = input.source.databases(input.fetching);
  let nodes: Node[];
  switch (databases.state) {
    case 'idle':
    case 'loading':
      nodes = [statusNode('kv', 'loading', 'databases', null)];
      break;
    case 'error':
      nodes = [statusNode('kv', 'error', 'databases', null, databases.error)];
      break;
    case 'ready':
      nodes = databases.data.map((database) => {
        const id = kvNodeKeys.database(database.index);
        return node(
          id,
          { type: 'kvDatabase', database },
          true,
          input.expanded.has(id) ? databaseContent(input, database.index, id) : null,
        );
      });
      break;
  }
  const filter = input.filter.trim();
  const shown = filter === '' ? nodes : prune(nodes, filter);
  const rows: KvRow[] = [];
  const walk = (list: readonly Node[], level: number) => {
    for (const entry of list) {
      const expanded =
        entry.expandable &&
        entry.children !== null &&
        (filter !== '' || input.expanded.has(entry.id));
      rows.push({
        ...entry.body,
        key: `${input.connectionId}\u001f${entry.id}`,
        connectionId: input.connectionId,
        nodeKey: entry.id,
        level,
        expandable: entry.expandable,
        expanded,
        indices: entry.indices,
      });
      if (expanded && entry.children) walk(entry.children, level + 1);
    }
  };
  walk(shown, input.level);
  return rows;
}

/** The label of a row, for the type-ahead and the accessible name. */
export function kvRowName(row: KvRow): string {
  switch (row.type) {
    case 'kvDatabase':
      return `db${String(row.database.index)}`;
    case 'kvNamespace':
    case 'kvKey':
      return row.name.text;
    default:
      return '';
  }
}

export { LEVEL_PAGE };
