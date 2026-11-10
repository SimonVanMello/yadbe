import type {
  CheckConstraint,
  ColumnInfo,
  DatabaseInfo,
  ForeignKey,
  IndexInfo,
  MetaNode,
  ObjectCount,
  ObjectInfo,
  ObjectKind,
  ObjectRef,
  SchemaInfo,
  TableDetails,
  TriggerInfo,
  YadbeError,
} from '../../ipc';
import { fuzzyMatch } from '../connections/fuzzy';
import { ROOT_NODE } from './explorerStore';

/** What a node's data is: not asked, on its way, failed, or there. */
export type Loadable<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; error: YadbeError }
  | { state: 'ready'; data: T };

/**
 * Where the tree reads its data. `fetch` says the node is open on screen: whoever implements
 * the source then makes sure the data gets loaded; without it the source only peeks at what is
 * already there.
 */
export interface MetaSource {
  databases(fetch: boolean): Loadable<DatabaseInfo[]>;
  schemas(database: string, fetch: boolean): Loadable<SchemaInfo[]>;
  counts(database: string, schema: string | null, fetch: boolean): Loadable<ObjectCount[]>;
  objects(
    database: string,
    schema: string | null,
    kind: ObjectKind,
    fetch: boolean,
  ): Loadable<ObjectInfo[]>;
  table(table: ObjectRef, kind: ObjectKind, fetch: boolean): Loadable<TableDetails>;
}

/** Which levels the engine has (its capabilities), never its name. */
export interface ExplorerLevels {
  /** A server hosts several databases; otherwise the only one is not shown as a level. */
  databases: boolean;
  /** Schemas exist between the database and its objects. */
  schemas: boolean;
}

export type DetailGroup =
  'columns' | 'keys' | 'foreignKeys' | 'indexes' | 'constraints' | 'triggers';

/** What an empty or failed list was a list of. */
export type StatusSubject =
  'connecting' | 'databases' | 'schemas' | 'kinds' | 'objects' | 'details';

export type ExplorerBody =
  | { type: 'database'; database: DatabaseInfo }
  | { type: 'schema'; database: string; schema: SchemaInfo }
  | { type: 'kind'; database: string; schema: string | null; kind: ObjectKind; count: number }
  | { type: 'object'; ref: ObjectRef; object: ObjectInfo }
  | { type: 'detailGroup'; table: ObjectRef; group: DetailGroup; count: number }
  | { type: 'column'; table: ObjectRef; column: ColumnInfo }
  | { type: 'key'; table: ObjectRef; name: string | null; columns: string[]; primary: boolean }
  | { type: 'foreignKey'; table: ObjectRef; foreignKey: ForeignKey }
  | { type: 'index'; table: ObjectRef; index: IndexInfo }
  | { type: 'check'; table: ObjectRef; check: CheckConstraint }
  | { type: 'trigger'; table: ObjectRef; trigger: TriggerInfo }
  | {
      type: 'status';
      status: 'loading' | 'empty' | 'error';
      subject: StatusSubject;
      error: YadbeError | null;
      /** What the retry button refreshes. */
      refresh: MetaNode;
    };

export const DETAIL_GROUPS: readonly DetailGroup[] = [
  'columns',
  'keys',
  'foreignKeys',
  'indexes',
  'constraints',
  'triggers',
];

export const RELATION_KINDS: readonly ObjectKind[] = ['table', 'view', 'materializedView'];

export function isRelationKind(kind: ObjectKind): boolean {
  return RELATION_KINDS.includes(kind);
}

/** Identity of a node inside its connection; the expanded state is a set of these. */
export const nodeKeys = {
  root: ROOT_NODE,
  database: (database: string) => JSON.stringify(['d', database]),
  schema: (database: string, schema: string) => JSON.stringify(['s', database, schema]),
  kind: (database: string, schema: string | null, kind: ObjectKind) =>
    JSON.stringify(['k', database, schema, kind]),
  object: (database: string, schema: string | null, kind: ObjectKind, id: string) =>
    JSON.stringify(['t', database, schema, kind, id]),
  group: (table: ObjectRef, kind: ObjectKind, group: DetailGroup) =>
    JSON.stringify(['g', table.database, table.schema, kind, table.name, group]),
};

export interface ExplorerNode {
  /** Node key; unique among the nodes of a connection. */
  id: string;
  body: ExplorerBody;
  expandable: boolean;
  /** `null`: the node was not listed (collapsed, or its data is not loaded). */
  children: ExplorerNode[] | null;
  /** Matched characters of the name, while filtering. */
  indices: number[];
}

export interface BuildContext {
  levels: ExplorerLevels;
  showSystem: boolean;
  expanded: ReadonlySet<string>;
  source: MetaSource;
  /** List the loaded nodes even where collapsed (the filter looks at all of them). */
  exhaustive: boolean;
}

function node(
  id: string,
  body: ExplorerBody,
  expandable: boolean,
  children: ExplorerNode[] | null = null,
): ExplorerNode {
  return { id, body, expandable, children, indices: [] };
}

/** A "loading", "empty" or "error" row under `parent`. */
export function statusNode(
  parent: string,
  kind: 'loading' | 'empty' | 'error',
  subject: StatusSubject,
  refresh: MetaNode,
  error: YadbeError | null = null,
): ExplorerNode {
  return node(`${parent}/status`, { type: 'status', status: kind, subject, error, refresh }, false);
}

/**
 * The children of an expandable node. Collapsed: none (unless the filter wants the loaded
 * ones). Expanded: a "loading", "error" or "empty" row, or the real children.
 */
function expandNode<T>(
  ctx: BuildContext,
  id: string,
  fetching: boolean,
  read: (fetch: boolean) => Loadable<T>,
  subject: StatusSubject,
  refresh: (error: YadbeError | null) => MetaNode,
  build: (data: T, fetching: boolean) => ExplorerNode[],
): ExplorerNode[] | null {
  const open = ctx.expanded.has(id);
  if (!open && !ctx.exhaustive) return null;
  const loadable = read(fetching && open);
  if (!open) return loadable.state === 'ready' ? build(loadable.data, false) : null;
  switch (loadable.state) {
    case 'idle':
    case 'loading':
      return [statusNode(id, 'loading', subject, refresh(null))];
    case 'error':
      return [statusNode(id, 'error', subject, refresh(loadable.error), loadable.error)];
    case 'ready': {
      const children = build(loadable.data, fetching);
      return children.length > 0 ? children : [statusNode(id, 'empty', subject, refresh(null))];
    }
  }
}

function tableChildren(
  ctx: BuildContext,
  ref: ObjectRef,
  kind: ObjectKind,
  details: TableDetails,
): ExplorerNode[] {
  const keys = [
    ...(details.primaryKey ? [{ ...details.primaryKey, primary: true }] : []),
    ...details.uniqueKeys.map((key) => ({ ...key, primary: false })),
  ];
  const items: Record<DetailGroup, ExplorerBody[]> = {
    columns: details.columns.map((column) => ({ type: 'column', table: ref, column })),
    keys: keys.map((key) => ({
      type: 'key',
      table: ref,
      name: key.name,
      columns: key.columns,
      primary: key.primary,
    })),
    foreignKeys: details.foreignKeys.map((foreignKey) => ({
      type: 'foreignKey',
      table: ref,
      foreignKey,
    })),
    indexes: details.indexes.map((index) => ({ type: 'index', table: ref, index })),
    constraints: details.checks.map((check) => ({ type: 'check', table: ref, check })),
    triggers: details.triggers.map((trigger) => ({ type: 'trigger', table: ref, trigger })),
  };
  const groups: ExplorerNode[] = [];
  for (const group of DETAIL_GROUPS) {
    const bodies = items[group];
    // An empty group is noise, except the columns: a table always has some.
    if (bodies.length === 0 && group !== 'columns') continue;
    const id = nodeKeys.group(ref, kind, group);
    const expanded = ctx.expanded.has(id);
    const children =
      expanded || ctx.exhaustive
        ? bodies.map((body, index) => node(`${id}/${String(index)}`, body, false))
        : null;
    groups.push(
      node(
        id,
        { type: 'detailGroup', table: ref, group, count: bodies.length },
        bodies.length > 0,
        children,
      ),
    );
  }
  return groups;
}

function objectNodes(
  ctx: BuildContext,
  database: string,
  schema: string | null,
  kind: ObjectKind,
  objects: ObjectInfo[],
  fetching: boolean,
): ExplorerNode[] {
  const nodes: ExplorerNode[] = [];
  for (const object of objects) {
    if (object.system && !ctx.showSystem) continue;
    const ref: ObjectRef = { database, schema, name: object.name };
    const id = nodeKeys.object(database, schema, kind, object.id);
    const relation = isRelationKind(kind);
    const children = relation
      ? expandNode(
          ctx,
          id,
          fetching,
          (fetch) => ctx.source.table(ref, kind, fetch),
          'details',
          (error) =>
            error?.code === 'objectNotFound'
              ? { level: 'objects', database, schema, kind }
              : { level: 'table', table: ref },
          (details) => tableChildren(ctx, ref, kind, details),
        )
      : null;
    nodes.push(node(id, { type: 'object', ref, object }, relation, children));
  }
  return nodes;
}

/** The object kinds of a schema (or of a database without schemas), with their counts. */
function kindNodes(
  ctx: BuildContext,
  database: string,
  schema: string | null,
  counts: ObjectCount[],
  fetching: boolean,
): ExplorerNode[] {
  return counts.map((entry) => {
    const id = nodeKeys.kind(database, schema, entry.kind);
    // Hidden system objects do not count.
    const count = ctx.showSystem ? entry.count : entry.count - entry.systemCount;
    const children =
      count > 0
        ? expandNode(
            ctx,
            id,
            fetching,
            (fetch) => ctx.source.objects(database, schema, entry.kind, fetch),
            'objects',
            () => ({ level: 'objects', database, schema, kind: entry.kind }),
            (objects, fetchingBelow) =>
              objectNodes(ctx, database, schema, entry.kind, objects, fetchingBelow),
          )
        : null;
    return node(
      id,
      { type: 'kind', database, schema, kind: entry.kind, count },
      count > 0,
      children,
    );
  });
}

/** What sits directly under a container that has kinds in it: the database or a schema. */
function schemaContent(
  ctx: BuildContext,
  parentId: string,
  database: string,
  schema: string | null,
  fetching: boolean,
): ExplorerNode[] | null {
  return expandNode(
    ctx,
    parentId,
    fetching,
    (fetch) => ctx.source.counts(database, schema, fetch),
    'kinds',
    () => ({ level: 'schema', database, schema }),
    (counts, fetchingBelow) => kindNodes(ctx, database, schema, counts, fetchingBelow),
  );
}

/** What sits under a database: schemas, or the kinds when the engine has no schemas. */
function databaseContent(
  ctx: BuildContext,
  parentId: string,
  database: string,
  fetching: boolean,
): ExplorerNode[] | null {
  if (!ctx.levels.schemas) return schemaContent(ctx, parentId, database, null, fetching);
  return expandNode(
    ctx,
    parentId,
    fetching,
    (fetch) => ctx.source.schemas(database, fetch),
    'schemas',
    () => ({ level: 'database', database }),
    (schemas, fetchingBelow) => {
      const nodes: ExplorerNode[] = [];
      for (const schema of schemas) {
        if (schema.system && !ctx.showSystem) continue;
        const id = nodeKeys.schema(database, schema.name);
        nodes.push(
          node(
            id,
            { type: 'schema', database, schema },
            true,
            schemaContent(ctx, id, database, schema.name, fetchingBelow),
          ),
        );
      }
      return nodes;
    },
  );
}

/**
 * The tree under an open connection row. `fetching`: the connection is up and its row open,
 * so the open nodes are loaded; otherwise only what is loaded already is shown.
 */
export function buildNodes(ctx: BuildContext, fetching: boolean): ExplorerNode[] {
  const { source, levels } = ctx;
  const databases = source.databases(fetching);
  const refresh = (): MetaNode => ({ level: 'connection' });
  switch (databases.state) {
    case 'idle':
    case 'loading':
      return [statusNode(nodeKeys.root, 'loading', 'databases', refresh())];
    case 'error':
      return [statusNode(nodeKeys.root, 'error', 'databases', refresh(), databases.error)];
    case 'ready':
      break;
  }
  if (!levels.databases) {
    // The only database is not a level of its own: its content hangs off the connection.
    const only = databases.data.find((database) => database.current) ?? databases.data[0];
    if (!only) return [statusNode(nodeKeys.root, 'empty', 'databases', refresh())];
    const children = rootContent(ctx, only.name, fetching);
    return children.length > 0
      ? children
      : [statusNode(nodeKeys.root, 'empty', 'kinds', refresh())];
  }
  const nodes: ExplorerNode[] = [];
  for (const database of databases.data) {
    if (database.system && !ctx.showSystem) continue;
    const id = nodeKeys.database(database.name);
    const accessible = database.accessible;
    nodes.push(
      node(
        id,
        { type: 'database', database },
        accessible,
        accessible ? databaseContent(ctx, id, database.name, fetching) : null,
      ),
    );
  }
  return nodes.length > 0 ? nodes : [statusNode(nodeKeys.root, 'empty', 'databases', refresh())];
}

/** Content of a database that is not a level: always open, no node of its own. */
function rootContent(ctx: BuildContext, database: string, fetching: boolean): ExplorerNode[] {
  // The node key of the root stands for the database here, and it is open.
  const open: BuildContext = { ...ctx, expanded: new Set([...ctx.expanded, ROOT_NODE]) };
  return databaseContent(open, ROOT_NODE, database, fetching) ?? [];
}

// --- Filter ---------------------------------------------------------------------------------

function nameOf(body: ExplorerBody): string | null {
  switch (body.type) {
    case 'database':
      return body.database.name;
    case 'schema':
      return body.schema.name;
    case 'object':
      return body.object.name;
    case 'column':
      return body.column.name;
    case 'key':
      return body.name;
    case 'foreignKey':
      return body.foreignKey.name;
    case 'index':
      return body.index.name;
    case 'check':
      return body.check.name;
    case 'trigger':
      return body.trigger.name;
    default:
      return null;
  }
}

/**
 * Keeps the nodes whose name matches the query, and the ancestors of those (F-022). Groups
 * (kinds, columns…) have no name: they stay when something under them matches.
 */
export function pruneNodes(nodes: readonly ExplorerNode[], query: string): ExplorerNode[] {
  const kept: ExplorerNode[] = [];
  for (const entry of nodes) {
    if (entry.body.type === 'status') continue;
    const name = nameOf(entry.body);
    const match = name === null ? null : fuzzyMatch(query, name);
    const children = entry.children ? pruneNodes(entry.children, query) : [];
    if (!match && children.length === 0) continue;
    kept.push({ ...entry, indices: match?.indices ?? [], children });
  }
  return kept;
}

// --- Flat rows ------------------------------------------------------------------------------

type WithRowFields<T> = T & {
  /** Unique in the whole sidebar. */
  key: string;
  connectionId: string;
  /** Node key inside the connection; status rows have none that can be expanded. */
  nodeKey: string;
  /** ARIA level, 1-based, counted from the top of the sidebar. */
  level: number;
  expandable: boolean;
  expanded: boolean;
  indices: readonly number[];
};

export type ExplorerRow = WithRowFields<ExplorerBody>;

export interface FlattenOptions {
  connectionId: string;
  /** Level of the first row (the connection's own level + 1). */
  level: number;
  expanded: ReadonlySet<string>;
  /** Show every listed child, whatever the expanded state (filtering). */
  open: boolean;
}

/** Rows of the visible nodes, in tree order. */
export function flattenNodes(
  nodes: readonly ExplorerNode[],
  options: FlattenOptions,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const walk = (list: readonly ExplorerNode[], level: number) => {
    for (const entry of list) {
      const expanded =
        entry.expandable &&
        entry.children !== null &&
        (options.open || options.expanded.has(entry.id));
      rows.push({
        ...entry.body,
        key: `${options.connectionId}\u001f${entry.id}`,
        connectionId: options.connectionId,
        nodeKey: entry.id,
        level,
        expandable: entry.expandable,
        expanded,
        indices: entry.indices,
      });
      if (expanded && entry.children) walk(entry.children, level + 1);
    }
  };
  walk(nodes, options.level);
  return rows;
}

/** Label used by the type-ahead and the accessible name: the name of whatever the row shows. */
export function nameOfRow(row: ExplorerRow): string {
  return nameOf(row) ?? '';
}
