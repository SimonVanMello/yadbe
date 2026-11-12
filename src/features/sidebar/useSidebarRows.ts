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
import { pruneNodes, type ExplorerNode } from '../explorer/explorerRows';
import { usePinStore } from '../objects/pinStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { requestKey, type MetaRequest } from '../explorer/metaKeys';
import { createCacheSource, metaQuery } from '../explorer/metaSource';
import { createKvSource } from '../keyvalue/kvSource';
import { LEVEL_PAGE, patternOf, useKvTreeStore } from '../keyvalue/kvTreeStore';
import { usePreference } from '../preferences/preferenceStore';
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

interface CachedTree {
  nodes: ExplorerNode[];
  /** The requests its build recorded: observed as long as the tree is used. */
  recorded: Recorded[];
  /** The last filter applied and its result, to narrow from when the next one extends it. */
  last: { filter: string; nodes: ExplorerNode[] } | null;
}

/**
 * One built tree per connection, for as long as the data and the expanded nodes stay. A filter
 * that extends the previous one (the next keystroke) prunes the previous result rather than the
 * whole tree: what matches `abc` as a subsequence also matches `ab`, with all its ancestors.
 */
function createTreeCache() {
  const trees = new Map<string, CachedTree>();
  return {
    filtered(
      connectionId: string,
      filter: string,
      build: () => Pick<CachedTree, 'nodes' | 'recorded'>,
    ): { nodes: ExplorerNode[]; recorded: Recorded[] } {
      let tree = trees.get(connectionId);
      if (!tree) {
        tree = { ...build(), last: null };
        trees.set(connectionId, tree);
      }
      const from = tree.last && filter.startsWith(tree.last.filter) ? tree.last.nodes : tree.nodes;
      const nodes = tree.last?.filter === filter ? tree.last.nodes : pruneNodes(from, filter);
      tree.last = { filter, nodes };
      return { nodes, recorded: tree.recorded };
    },
  };
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
  const pins = usePinStore((store) => store.pins);
  const kvPatterns = useKvTreeStore((store) => store.patterns);
  const kvLimits = useKvTreeStore((store) => store.limits);
  const kvDelimiter = usePreference('keyValueDelimiter');
  const version = useSyncExternalStore(subscribeToMeta, getCacheVersion);
  const connections = list.data?.connections;
  const groups = list.data?.groups;

  const capabilities = useMemo(
    () => new Map<Engine, Capabilities>(engines.map((info) => [info.engine, info.capabilities])),
    [engines],
  );

  // The loaded trees used by the filter, built once per change of the data or of the expanded
  // nodes rather than once per keystroke, with the requests their build recorded.
  const trees = useMemo(
    () => createTreeCache(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connections, groups, capabilities, sessions, expanded, showSystem, version, pins],
  );

  const { rows, recorded } = useMemo(() => {
    const recorded = new Map<string, Recorded>();
    if (!connections || !groups) return { rows: [] as SidebarTreeRow[], recorded };
    const remember = (entry: Recorded) => {
      recorded.set(JSON.stringify(requestKey(entry.connectionId, entry.request)), entry);
    };
    // Where the requests of the tree being built go: the rows', or a cached tree's.
    let sink = remember;
    const rows = composeSidebarRows({
      connections,
      groups,
      query,
      capabilities,
      stateOf: (id) => stateOf(sessions[id]),
      expanded,
      showSystem,
      pins,
      sourceFor: (connectionId) =>
        createCacheSource(queryClient, connectionId, (id, request) => {
          sink({ connectionId: id, request });
        }),
      filteredTree: (connectionId, filter, build) => {
        const tree = trees.filtered(connectionId, filter, () => {
          const own: Recorded[] = [];
          sink = (entry) => own.push(entry);
          try {
            return { nodes: build(), recorded: own };
          } finally {
            sink = remember;
          }
        });
        tree.recorded.forEach(remember);
        return tree.nodes;
      },
      keyValue: {
        sourceFor: (connectionId) =>
          createKvSource(queryClient, connectionId, (id, request) => {
            sink({ connectionId: id, request });
          }),
        delimiterFor: (connection) => connection.definition.keyValue?.keyDelimiter ?? kvDelimiter,
        patternOf: (connectionId, database) => patternOf(kvPatterns, connectionId, database),
        typedPatternOf: (connectionId, database) => kvPatterns[connectionId]?.[database] ?? '',
        limitOf: (connectionId, node) => kvLimits[connectionId]?.[node] ?? LEVEL_PAGE,
      },
    });
    return { rows, recorded };
  }, [
    connections,
    groups,
    query,
    capabilities,
    sessions,
    expanded,
    showSystem,
    pins,
    trees,
    kvPatterns,
    kvLimits,
    kvDelimiter,
  ]);

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
      const current =
        (row.type === 'database' || row.type === 'kvDatabase') && row.database.current;
      if (!current) continue;
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
