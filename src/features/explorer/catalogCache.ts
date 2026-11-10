import { useQueries, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { CompletionCatalog, MetaNode } from '../../ipc';
import { fetchCatalog } from './metaApi';

/** A database whose catalog is wanted. */
export interface CatalogTarget {
  connectionId: string;
  database: string;
}

/**
 * Catalogs live under their own key, not under `meta`: a 10 000-object catalog landing in the
 * cache must not make the explorer's tree rebuild itself, which listens to `meta` queries.
 */
export const catalogKeys = {
  connection: (connectionId: string) => ['catalog', connectionId] as const,
  database: (connectionId: string, database: string) =>
    ['catalog', connectionId, database] as const,
};

export function catalogQuery({ connectionId, database }: CatalogTarget) {
  return {
    queryKey: catalogKeys.database(connectionId, database),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchCatalog(connectionId, database, signal),
    // Until a refresh (`meta-refreshed`, see `invalidateCatalogs`) or the end of the session.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  };
}

export interface LoadedCatalog extends CatalogTarget {
  catalog: CompletionCatalog;
}

/**
 * The catalogs of `targets`, fetched while `enabled` (the palette is open) and cached after: a
 * second opening reads them back at once. `loading` while any is on its way.
 */
export function useCatalogs(targets: readonly CatalogTarget[], enabled: boolean) {
  // `combine` results are shared structurally: the same list while no catalog arrived, so that
  // what is built from it (an index of 10 000 objects) is not rebuilt on every render.
  const combine = useCallback(
    (results: UseQueryResult<CompletionCatalog>[]) => ({
      catalogs: targets.flatMap((target, index): LoadedCatalog[] => {
        const catalog = results[index]?.data;
        return catalog ? [{ ...target, catalog }] : [];
      }),
      loading: results.some((result) => result.isPending),
    }),
    [targets],
  );
  const { catalogs, loading } = useQueries({
    queries: targets.map((target) => ({ ...catalogQuery(target), enabled })),
    combine,
  });
  return { catalogs, loading: enabled && loading };
}

/** The database a refreshed node lives in; `null` for a whole connection. */
function databaseOfNode(node: MetaNode): string | null {
  switch (node.level) {
    case 'connection':
      return null;
    case 'table':
      return node.table.database;
    default:
      return node.database;
  }
}

/** Marks the catalogs a refreshed node covers as stale (any change below a database). */
export function invalidateCatalogs(client: QueryClient, connectionId: string, node: MetaNode) {
  const database = databaseOfNode(node);
  return client.invalidateQueries({
    queryKey:
      database === null
        ? catalogKeys.connection(connectionId)
        : catalogKeys.database(connectionId, database),
  });
}
