import type { InvalidateQueryFilters } from '@tanstack/react-query';

import type { KvBytes, MetaNode, ObjectKind, ObjectRef } from '../../ipc';
import { kvKeys } from '../keyvalue/kvKeys';

/** What the explorer asks the backend, one request per node that lists its children. */
export type MetaRequest =
  | { type: 'databases' }
  | { type: 'schemas'; database: string }
  | { type: 'counts'; database: string; schema: string | null }
  | { type: 'objects'; database: string; schema: string | null; kind: ObjectKind }
  | { type: 'table'; table: ObjectRef; kind: ObjectKind }
  // The key-value family's explorer (`keyvalue/kvExplorerRows.ts`).
  | { type: 'kvDatabases' }
  | { type: 'kvScan'; database: number; pattern: string | null }
  | { type: 'kvLevel'; database: number; prefix: KvBytes; delimiter: string; limit: number };

type Key = readonly (string | number | null)[];

/**
 * Query keys nest like the backend's `MetaCache`, so that a `meta-refreshed` node maps to one
 * key prefix: `['meta', connection, 'db', database, 'schema', schema, …]`.
 */
export const metaKeys = {
  connection: (connectionId: string): Key => ['meta', connectionId],
  databases: (connectionId: string): Key => ['meta', connectionId, 'databases'],
  database: (connectionId: string, database: string): Key => ['meta', connectionId, 'db', database],
  schemas: (connectionId: string, database: string): Key => [
    ...metaKeys.database(connectionId, database),
    'schemas',
  ],
  schema: (connectionId: string, database: string, schema: string | null): Key => [
    ...metaKeys.database(connectionId, database),
    'schema',
    schema,
  ],
  counts: (connectionId: string, database: string, schema: string | null): Key => [
    ...metaKeys.schema(connectionId, database, schema),
    'counts',
  ],
  objects: (
    connectionId: string,
    database: string,
    schema: string | null,
    kind: ObjectKind,
  ): Key => [...metaKeys.schema(connectionId, database, schema), 'objects', kind],
  table: (connectionId: string, table: ObjectRef, kind: ObjectKind): Key => [
    ...metaKeys.schema(connectionId, table.database, table.schema),
    'table',
    kind,
    table.name,
  ],
};

export function requestKey(connectionId: string, request: MetaRequest): Key {
  switch (request.type) {
    case 'databases':
      return metaKeys.databases(connectionId);
    case 'schemas':
      return metaKeys.schemas(connectionId, request.database);
    case 'counts':
      return metaKeys.counts(connectionId, request.database, request.schema);
    case 'objects':
      return metaKeys.objects(connectionId, request.database, request.schema, request.kind);
    case 'table':
      return metaKeys.table(connectionId, request.table, request.kind);
    case 'kvDatabases':
      return kvKeys.databases(connectionId);
    case 'kvScan':
      return kvKeys.scan(connectionId, request.database, request.pattern);
    case 'kvLevel':
      return kvKeys.level(
        connectionId,
        request.database,
        request.prefix,
        request.delimiter,
        request.limit,
      );
  }
}

/**
 * The queries a refreshed node makes stale (mirror of the backend's `CacheData::invalidate`):
 * a node covers everything below it, and a level never drops the list that holds it.
 */
export function invalidationFilters(
  connectionId: string,
  node: MetaNode,
): InvalidateQueryFilters[] {
  switch (node.level) {
    case 'connection':
      return [{ queryKey: metaKeys.connection(connectionId) }];
    case 'database':
      return [{ queryKey: metaKeys.database(connectionId, node.database) }];
    case 'schema':
      return [{ queryKey: metaKeys.schema(connectionId, node.database, node.schema) }];
    case 'objects': {
      const schema = metaKeys.schema(connectionId, node.database, node.schema);
      return [
        { queryKey: [...schema, 'counts'] },
        { queryKey: [...schema, 'objects', node.kind] },
        { queryKey: [...schema, 'table', node.kind] },
      ];
    }
    case 'table': {
      const schema = metaKeys.schema(connectionId, node.table.database, node.table.schema);
      // The node does not say whether it is a table or a view: match on the name.
      return [
        {
          queryKey: [...schema, 'table'],
          predicate: (query) => query.queryKey[8] === node.table.name,
        },
      ];
    }
  }
}
