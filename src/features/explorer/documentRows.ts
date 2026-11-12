import type {
  DocCollection,
  DocDatabase,
  DocIndex,
  FieldSample,
  MetaNode,
  SampledField,
} from '../../ipc';
import {
  expandNode,
  explorerNode,
  statusNode,
  type ExplorerNode,
  type Loadable,
} from './explorerRows';
import { ROOT_NODE } from './explorerStore';

/**
 * The explorer of a document connection (MongoDB): databases → collections, views and time
 * series → their sampled fields and their indexes. Same tree machinery as the SQL explorer
 * (`explorerRows.ts`): lazy, cached in the query cache, virtualized by the sidebar.
 */

/** What the document explorer reads, one request per node that lists its children. */
export interface DocumentSource {
  databases(fetch: boolean): Loadable<DocDatabase[]>;
  collections(database: string, fetch: boolean): Loadable<DocCollection[]>;
  indexes(database: string, collection: string, fetch: boolean): Loadable<DocIndex[]>;
  fields(database: string, collection: string, fetch: boolean): Loadable<FieldSample>;
}

export type DocumentGroup = 'fields' | 'indexes';

export type DocumentBody =
  | { type: 'docDatabase'; database: DocDatabase; current: boolean }
  | { type: 'docCollection'; database: string; collection: DocCollection }
  | {
      type: 'docGroup';
      database: string;
      collection: string;
      group: DocumentGroup;
      /** Fields or indexes listed. */
      count: number;
      /** Documents the fields were sampled from (fields only). */
      sampled: number | null;
    }
  | { type: 'docField'; database: string; collection: string; field: SampledField; sampled: number }
  | { type: 'docIndex'; database: string; collection: string; index: DocIndex };

export const documentKeys = {
  database: (database: string) => JSON.stringify(['dd', database]),
  collection: (database: string, collection: string) =>
    JSON.stringify(['dc', database, collection]),
  group: (database: string, collection: string, group: DocumentGroup) =>
    JSON.stringify(['dg', database, collection, group]),
};

export interface DocumentBuildContext {
  source: DocumentSource;
  expanded: ReadonlySet<string>;
  exhaustive: boolean;
  showSystem: boolean;
  /** The database the connection names: shown first and opened once. */
  current: string;
}

/** The backend node a refresh of a collection drops (fields and indexes). */
export function collectionNode(database: string, collection: string): MetaNode {
  return { level: 'table', table: { database, schema: null, name: collection } };
}

function groupNodes(
  ctx: DocumentBuildContext,
  database: string,
  collection: DocCollection,
  fetching: boolean,
): ExplorerNode[] {
  const name = collection.name;
  const refresh = () => collectionNode(database, name);
  const nodes: ExplorerNode[] = [];
  const fieldsId = documentKeys.group(database, name, 'fields');
  const fields = ctx.source.fields(database, name, fetching && ctx.expanded.has(fieldsId));
  const fieldChildren = expandNode(
    ctx,
    fieldsId,
    fetching,
    (fetch) => ctx.source.fields(database, name, fetch),
    'details',
    refresh,
    (sample) =>
      sample.fields.map((field) =>
        explorerNode(
          `${fieldsId}/${field.path}`,
          { type: 'docField', database, collection: name, field, sampled: sample.sampled },
          false,
        ),
      ),
  );
  nodes.push(
    explorerNode(
      fieldsId,
      {
        type: 'docGroup',
        database,
        collection: name,
        group: 'fields',
        count: fields.state === 'ready' ? fields.data.fields.length : 0,
        sampled: fields.state === 'ready' ? fields.data.sampled : null,
      },
      true,
      fieldChildren,
    ),
  );
  // Views and time series have no indexes of their own.
  if (collection.kind === 'collection') {
    const indexesId = documentKeys.group(database, name, 'indexes');
    const indexes = ctx.source.indexes(database, name, false);
    nodes.push(
      explorerNode(
        indexesId,
        {
          type: 'docGroup',
          database,
          collection: name,
          group: 'indexes',
          count: indexes.state === 'ready' ? indexes.data.length : 0,
          sampled: null,
        },
        true,
        expandNode(
          ctx,
          indexesId,
          fetching,
          (fetch) => ctx.source.indexes(database, name, fetch),
          'details',
          refresh,
          (list) =>
            list.map((index) =>
              explorerNode(
                `${indexesId}/${index.name}`,
                { type: 'docIndex', database, collection: name, index },
                false,
              ),
            ),
        ),
      ),
    );
  }
  return nodes;
}

function collectionNodes(
  ctx: DocumentBuildContext,
  database: string,
  collections: DocCollection[],
  fetching: boolean,
): ExplorerNode[] {
  const nodes: ExplorerNode[] = [];
  for (const collection of collections) {
    if (collection.system && !ctx.showSystem) continue;
    const id = documentKeys.collection(database, collection.name);
    const open = ctx.expanded.has(id) || ctx.exhaustive;
    nodes.push(
      explorerNode(
        id,
        { type: 'docCollection', database, collection },
        true,
        open ? groupNodes(ctx, database, collection, fetching && ctx.expanded.has(id)) : null,
      ),
    );
  }
  return nodes;
}

/** The tree under an open document connection. */
export function buildDocumentNodes(ctx: DocumentBuildContext, fetching: boolean): ExplorerNode[] {
  const databases = ctx.source.databases(fetching);
  const refresh = (): MetaNode => ({ level: 'connection' });
  switch (databases.state) {
    case 'idle':
    case 'loading':
      return [statusNode(ROOT_NODE, 'loading', 'databases', refresh())];
    case 'error':
      return [statusNode(ROOT_NODE, 'error', 'databases', refresh(), databases.error)];
    case 'ready':
      break;
  }
  const nodes: ExplorerNode[] = [];
  const ordered = [...databases.data].sort(
    (a, b) => Number(b.name === ctx.current) - Number(a.name === ctx.current),
  );
  for (const database of ordered) {
    if (database.system && !ctx.showSystem && database.name !== ctx.current) continue;
    const id = documentKeys.database(database.name);
    nodes.push(
      explorerNode(
        id,
        { type: 'docDatabase', database, current: database.name === ctx.current },
        true,
        expandNode(
          ctx,
          id,
          fetching,
          (fetch) => ctx.source.collections(database.name, fetch),
          'objects',
          () => ({ level: 'database', database: database.name }),
          (collections, below) => collectionNodes(ctx, database.name, collections, below),
        ),
      ),
    );
  }
  return nodes.length > 0 ? nodes : [statusNode(ROOT_NODE, 'empty', 'databases', refresh())];
}

/** The name a document row is filtered and announced by. */
export function documentNameOf(body: DocumentBody): string | null {
  switch (body.type) {
    case 'docDatabase':
      return body.database.name;
    case 'docCollection':
      return body.collection.name;
    case 'docField':
      return body.field.path;
    case 'docIndex':
      return body.index.name;
    case 'docGroup':
      return null;
  }
}

/** The backend node a document row's refresh drops. */
export function documentNodeOf(body: DocumentBody): MetaNode {
  switch (body.type) {
    case 'docDatabase':
      return { level: 'database', database: body.database.name };
    case 'docCollection':
    case 'docGroup':
    case 'docField':
    case 'docIndex':
      return collectionNode(
        body.database,
        body.type === 'docCollection' ? body.collection.name : body.collection,
      );
  }
}

/** A rare type gets the share of documents where a field is that type. */
export function fieldShare(count: number, sampled: number): number {
  return sampled === 0 ? 0 : Math.round((count / sampled) * 100);
}
