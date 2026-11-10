import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { queryClient } from '../../app/queryClient';
import type { Capabilities, Engine } from '../../ipc';
import {
  stateOf,
  useConnectionList,
  useEngines,
  useSessions,
} from '../connections/connectionStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { requestKey, type MetaRequest } from '../explorer/metaKeys';
import { createCacheSource, metaQuery } from '../explorer/metaSource';
import { composeSidebarRows, type SidebarTreeRow } from './sidebarRows';

let cacheVersion = 0;

/** Ticks whenever a metadata query changes, so the rows are built again from the cache. */
function subscribeToMeta(onChange: () => void): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    const [scope] = event.query.queryKey as readonly unknown[];
    if (event.type === 'updated' && scope === 'meta') {
      cacheVersion += 1;
      onChange();
    }
  });
}

const getCacheVersion = () => cacheVersion;

interface Recorded {
  connectionId: string;
  request: MetaRequest;
}

/**
 * The rows of the sidebar: connections and their explorer trees (F-020). The tree is a pure
 * function of the expanded nodes and of the query cache; the nodes that are open and not loaded
 * yet are recorded while it is built, and observed right after, which loads them.
 */
export function useSidebarRows(query: string): SidebarTreeRow[] {
  const list = useConnectionList();
  const { engines } = useEngines();
  const sessions = useSessions((store) => store.sessions);
  const expanded = useExplorerStore((store) => store.expanded);
  const showSystem = useExplorerStore((store) => store.showSystem);
  const version = useSyncExternalStore(subscribeToMeta, getCacheVersion);
  const connections = list.data?.connections;
  const groups = list.data?.groups;

  const capabilities = useMemo(
    () => new Map<Engine, Capabilities>(engines.map((info) => [info.engine, info.capabilities])),
    [engines],
  );

  const { rows, recorded } = useMemo(() => {
    const recorded = new Map<string, Recorded>();
    if (!connections || !groups) return { rows: [] as SidebarTreeRow[], recorded };
    const rows = composeSidebarRows({
      connections,
      groups,
      query,
      capabilities,
      stateOf: (id) => stateOf(sessions[id]),
      expanded,
      showSystem,
      sourceFor: (connectionId) =>
        createCacheSource(queryClient, connectionId, (id, request) => {
          recorded.set(JSON.stringify(requestKey(id, request)), { connectionId: id, request });
        }),
    });
    return { rows, recorded };
    // `version` is not read in the body: the cache changed, the rows must be built again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, groups, query, capabilities, sessions, expanded, showSystem, version]);

  // Observing a query loads it, and unobserving it (node collapsed, filter typed) cancels it.
  useQueries({
    queries: [...recorded.values()].map(({ connectionId, request }) =>
      metaQuery(connectionId, request),
    ),
    combine: () => null,
  });

  // A connection that just came up opens down to its database, once.
  useEffect(() => {
    if (!connections) return;
    for (const connection of connections) {
      if (stateOf(sessions[connection.id]) !== 'connected') continue;
      useExplorerStore.getState().seed(connection.id);
    }
  }, [connections, sessions]);

  const databaseSeeds = useMemo(() => {
    const seeds: { connectionId: string; node: string }[] = [];
    for (const row of rows) {
      if (row.type !== 'database' || !row.database.current) continue;
      seeds.push({ connectionId: row.connectionId, node: row.nodeKey });
    }
    return seeds;
  }, [rows]);
  useEffect(() => {
    for (const { connectionId, node } of databaseSeeds) {
      useExplorerStore.getState().seedDatabase(connectionId, node);
    }
  }, [databaseSeeds]);

  return rows;
}
