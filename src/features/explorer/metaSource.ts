import type { QueryClient, QueryState } from '@tanstack/react-query';

import { YadbeIpcError, type YadbeError } from '../../ipc';
import { fetchMeta } from './metaApi';
import { requestKey, type MetaRequest } from './metaKeys';
import type { DocumentSource } from './documentRows';
import type { Loadable, MetaSource } from './explorerRows';

/** The query behind one node: data stay cached until a refresh, the backend has its own cache. */
export function metaQuery(connectionId: string, request: MetaRequest) {
  return {
    queryKey: requestKey(connectionId, request),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchMeta(connectionId, request, signal),
    staleTime: Infinity,
    // A collapsed node keeps its data a while: opening it again is instant.
    gcTime: 10 * 60_000,
  };
}

const INTERNAL: YadbeError = {
  code: 'internal',
  message: { en: 'Unexpected error.', fr: 'Erreur inattendue.' },
  action: null,
  detail: null,
};

export function asLoadable<T>(state: QueryState<T> | undefined, fetch: boolean): Loadable<T> {
  if (state === undefined) return fetch ? { state: 'loading' } : { state: 'idle' };
  if (state.data !== undefined) return { state: 'ready', data: state.data };
  if (state.fetchStatus === 'fetching') return { state: 'loading' };
  if (state.status === 'error') {
    const error = state.error instanceof YadbeIpcError ? state.error.error : INTERNAL;
    return { state: 'error', error };
  }
  return { state: 'loading' };
}

/** The document explorer's reads, as the cache source names them. */
export interface DocumentReads {
  docDatabases: DocumentSource['databases'];
  docCollections: DocumentSource['collections'];
  docIndexes: DocumentSource['indexes'];
  docFields: DocumentSource['fields'];
}

/** The document explorer's view of a cache source. */
export function documentSourceOf(reads: DocumentReads): DocumentSource {
  return {
    databases: reads.docDatabases,
    collections: reads.docCollections,
    indexes: reads.docIndexes,
    fields: reads.docFields,
  };
}

/**
 * The tree's view of the query cache. Every request made with `fetch` is recorded, so that the
 * caller can observe (and so load) exactly the nodes that are open on screen.
 */
export function createCacheSource(
  client: QueryClient,
  connectionId: string,
  record: (connectionId: string, request: MetaRequest) => void,
): MetaSource & DocumentReads {
  // One pass over the connection's cached queries instead of one `getQueryState` per node,
  // which resolves the default options and hashes the key each time: a filtered tree reads every
  // loaded table (10 000 on a large schema). A source serves one build of the tree, during which
  // the cache does not change.
  let states: Map<string, QueryState> | null = null;
  const stateOf = (key: readonly unknown[]): QueryState | undefined => {
    if (states === null) {
      states = new Map();
      for (const query of client.getQueryCache().findAll({ queryKey: ['meta', connectionId] })) {
        states.set(JSON.stringify(query.queryKey), query.state);
      }
    }
    return states.get(JSON.stringify(key));
  };
  const read = <T>(request: MetaRequest, fetch: boolean): Loadable<T> => {
    if (fetch) record(connectionId, request);
    return asLoadable(
      stateOf(requestKey(connectionId, request)) as QueryState<T> | undefined,
      fetch,
    );
  };
  return {
    docDatabases: (fetch) => read({ type: 'docDatabases' }, fetch),
    docCollections: (database, fetch) => read({ type: 'docCollections', database }, fetch),
    docIndexes: (database, collection, fetch) =>
      read({ type: 'docIndexes', database, collection }, fetch),
    docFields: (database, collection, fetch) =>
      read({ type: 'docFields', database, collection }, fetch),
    databases: (fetch) => read({ type: 'databases' }, fetch),
    schemas: (database, fetch) => read({ type: 'schemas', database }, fetch),
    counts: (database, schema, fetch) => read({ type: 'counts', database, schema }, fetch),
    objects: (database, schema, kind, fetch) =>
      read({ type: 'objects', database, schema, kind }, fetch),
    table: (table, kind, fetch) => read({ type: 'table', table, kind }, fetch),
  };
}
