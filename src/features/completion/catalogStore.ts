import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import { queryClient as sharedClient } from '../../app/queryClient';
import { ipc, unwrap, type CompletionCatalog, type MetaNode, type Unsubscribe } from '../../ipc';
import { fetchDatabases } from '../explorer/metaApi';
import { metaKeys } from '../explorer/metaKeys';
import { CatalogIndex } from './catalogIndex';

/**
 * The completion catalog of a (connection, database), loaded the first time an editor needs it,
 * shared by every tab on the same database, and indexed once. It lives in the query cache next
 * to the explorer's data (`['meta', connection, …]`), so a refresh of the whole connection or
 * its disconnection drops it with them; the `metaRefreshed` events below drop it for the finer
 * levels (the catalog covers everything of a database).
 */

const key = (connectionId: string, database: string) =>
  [...metaKeys.connection(connectionId), 'completion', database] as const;

const keyText = (connectionId: string, database: string) => `${connectionId}\u0000${database}`;

let counter = 0;

async function fetchCatalog(connectionId: string, database: string): Promise<CompletionCatalog> {
  counter += 1;
  const requestId = `completion-${Date.now().toString(36)}-${counter.toString(36)}`;
  // System objects come along (`information_schema.`, `pg_catalog.`…) and rank below the user's.
  return unwrap(ipc.commands.getCompletionCatalog(requestId, connectionId, database, true));
}

const indexes = new WeakMap<CompletionCatalog, CatalogIndex>();

function indexOf(catalog: CompletionCatalog): CatalogIndex {
  let index = indexes.get(catalog);
  if (!index) {
    index = new CatalogIndex(catalog).warm();
    indexes.set(catalog, index);
  }
  return index;
}

interface LoadingStore {
  loading: ReadonlySet<string>;
  set: (id: string, loading: boolean) => void;
}

/** Which catalogs are being read, for the editor's discreet "loading" indicator. */
const useLoadingStore = create<LoadingStore>()((set) => ({
  loading: new Set(),
  set: (id, loading) => {
    set((state) => {
      if (state.loading.has(id) === loading) return state;
      const next = new Set(state.loading);
      if (loading) next.add(id);
      else next.delete(id);
      return { loading: next };
    });
  },
}));

/** Whether a catalog of this connection is being read for the first time. */
export function useCatalogLoading(connectionId: string): boolean {
  const prefix = `${connectionId}\u0000`;
  return useLoadingStore((state) => {
    for (const id of state.loading) if (id.startsWith(prefix)) return true;
    return false;
  });
}

const FAILURE_BACKOFF_MS = 5000;
const failures = new Map<string, number>();
const pending = new Map<string, Promise<CatalogIndex | null>>();

export interface CatalogDeps {
  client: QueryClient;
  now: () => number;
}

const defaults: CatalogDeps = { client: sharedClient, now: () => Date.now() };

/** The indexed catalog if one is cached, even if it is out of date (it is refreshed meanwhile). */
export function peekCatalog(
  connectionId: string,
  database: string,
  deps: CatalogDeps = defaults,
): CatalogIndex | null {
  const data = deps.client.getQueryData<CompletionCatalog>(key(connectionId, database));
  return data ? indexOf(data) : null;
}

/** Whether what is cached was invalidated (a refresh happened since it was read). */
function isStale(connectionId: string, database: string, deps: CatalogDeps): boolean {
  return deps.client.getQueryState(key(connectionId, database))?.isInvalidated ?? false;
}

/** Whether the catalog is missing or was invalidated, so that `ensureCatalog` would read it. */
export function needsCatalog(
  connectionId: string,
  database: string,
  deps: CatalogDeps = defaults,
): boolean {
  return (
    peekCatalog(connectionId, database, deps) === null || isStale(connectionId, database, deps)
  );
}

/**
 * Loads the catalog if it is missing or out of date, once for all callers. Resolves to the
 * index, or `null` when it cannot be read (a failed read is not retried for a few seconds).
 */
export function ensureCatalog(
  connectionId: string,
  database: string,
  deps: CatalogDeps = defaults,
): Promise<CatalogIndex | null> {
  startCompletionFeed(deps);
  const id = keyText(connectionId, database);
  const cached = peekCatalog(connectionId, database, deps);
  if (cached && !isStale(connectionId, database, deps)) return Promise.resolve(cached);
  const running = pending.get(id);
  if (running) return running;
  const failedAt = failures.get(id);
  if (failedAt !== undefined && deps.now() - failedAt < FAILURE_BACKOFF_MS) {
    return Promise.resolve(cached);
  }
  useLoadingStore.getState().set(id, cached === null);
  const load = deps.client
    .query({
      queryKey: key(connectionId, database),
      queryFn: () => fetchCatalog(connectionId, database),
      staleTime: 0,
      gcTime: 30 * 60_000,
    })
    .then((catalog) => {
      failures.delete(id);
      return indexOf(catalog);
    })
    .catch((error: unknown) => {
      failures.set(id, deps.now());
      console.warn('The completion catalog could not be read', error);
      return cached;
    })
    .finally(() => {
      pending.delete(id);
      useLoadingStore.getState().set(id, false);
    });
  pending.set(id, load);
  return load;
}

/**
 * The database a tab's statements run in: its own, else its connection's, else (file engines)
 * the one the server calls current.
 */
export async function resolveDatabase(
  connectionId: string,
  tabDatabase: string | null,
  connectionDatabase: string,
  client: QueryClient = sharedClient,
): Promise<string | null> {
  const named = tabDatabase ?? connectionDatabase;
  if (named.trim() !== '') return named;
  try {
    const databases = await client.query({
      queryKey: metaKeys.databases(connectionId),
      queryFn: ({ signal }) => fetchDatabases(connectionId, signal),
      staleTime: Infinity,
    });
    return (databases.find((db) => db.current) ?? databases[0])?.name ?? null;
  } catch {
    return null;
  }
}

/** Drops the cached catalogs a refreshed node makes out of date. */
export function invalidateCatalogs(
  connectionId: string,
  node: MetaNode,
  deps: CatalogDeps = defaults,
): void {
  switch (node.level) {
    case 'connection':
      void deps.client.invalidateQueries({
        queryKey: [...metaKeys.connection(connectionId), 'completion'],
      });
      return;
    case 'table':
      void deps.client.invalidateQueries({ queryKey: key(connectionId, node.table.database) });
      return;
    default:
      void deps.client.invalidateQueries({ queryKey: key(connectionId, node.database) });
  }
}

let stopFeed: Unsubscribe | null = null;

/** Follows `metaRefreshed`: once per launch, started with the first catalog read. */
export function startCompletionFeed(deps: CatalogDeps = defaults): void {
  if (stopFeed) return;
  stopFeed = ipc.events.subscribe('metaRefreshed', ({ connectionId, node }) => {
    invalidateCatalogs(connectionId, node, deps);
  });
}

/** For tests: forgets in-flight reads and failures. */
export function resetCatalogStore(): void {
  pending.clear();
  failures.clear();
  useLoadingStore.setState({ loading: new Set() });
  stopFeed?.();
  stopFeed = null;
}
