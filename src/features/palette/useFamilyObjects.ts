import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTabsStore } from '../../app/tabs/tabsStore';
import type {
  DocCollection,
  DocDatabase,
  SearchAlias,
  SearchDataStream,
  SearchIndexInfo,
} from '../../ipc';
import { stateOf, useConnections, useSessions } from '../connections/connectionStore';
import { fetchMeta } from '../explorer/metaApi';
import { requestKey, type MetaRequest } from '../explorer/metaKeys';
import { collectionItems, searchItems } from './familyObjectItems';
import type { ObjectItem } from './paletteItems';

const NONE: never[] = [];

function metaQuery(connectionId: string, request: MetaRequest, enabled: boolean) {
  return {
    queryKey: requestKey(connectionId, request),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchMeta(connectionId, request, signal),
    // Shared with the explorer: until a refresh or the end of the session.
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    enabled,
  };
}

function dataOf<T>(result: UseQueryResult | undefined): T | undefined {
  return result?.data as T | undefined;
}

/**
 * The collections, indices, data streams and aliases of the connected document and search
 * connections, for the palette's objects. Read through the explorer's own queries (same keys):
 * opening the palette after the explorer costs nothing. A document connection contributes the
 * collections of the database it was opened on and of those its collection tabs are on.
 */
export function useFamilyObjects(enabled: boolean): { items: ObjectItem[]; loading: boolean } {
  const connections = useConnections();
  const sessions = useSessions((store) => store.sessions);
  const tabs = useTabsStore((store) => store.tabs);

  const connected = useMemo(
    () =>
      connections.filter(
        (connection) =>
          (connection.family === 'document' || connection.family === 'search') &&
          stateOf(sessions[connection.id]) === 'connected',
      ),
    [connections, sessions],
  );
  const documents = connected.filter((connection) => connection.family === 'document');
  const searches = connected.filter((connection) => connection.family === 'search');

  const databaseResults = useQueries({
    queries: documents.map((connection) =>
      metaQuery(connection.id, { type: 'docDatabases' }, enabled),
    ),
  });
  // The databases to read: the connection's own, else the first user one, and the tabs'.
  const targets = documents.flatMap((connection, index) => {
    const list = dataOf<DocDatabase[]>(databaseResults[index]);
    const names = new Set<string>();
    if (connection.database !== '') names.add(connection.database);
    else {
      const first = list?.find((database) => !database.system && !database.empty);
      if (first) names.add(first.name);
    }
    for (const tab of tabs) {
      if (tab.connectionId === connection.id && tab.table) names.add(tab.table.database);
    }
    return [...names].map((database) => ({ connection, database }));
  });
  const collectionResults = useQueries({
    queries: targets.map(({ connection, database }) =>
      metaQuery(connection.id, { type: 'docCollections', database }, enabled),
    ),
  });

  const searchResults = useQueries({
    queries: searches.flatMap((connection) =>
      (['searchIndices', 'searchDataStreams', 'searchAliases'] as const).map((type) =>
        metaQuery(connection.id, { type }, enabled),
      ),
    ),
  });

  // Rebuilt only when a result changes: `dataUpdatedAt` is the content of the lists.
  const stamp = [...databaseResults, ...collectionResults, ...searchResults]
    .map((result) => result.dataUpdatedAt)
    .join();
  const items = useMemo(() => {
    const all: ObjectItem[] = [];
    targets.forEach(({ connection, database }, index) => {
      const list = dataOf<DocCollection[]>(collectionResults[index]) ?? NONE;
      all.push(...collectionItems(connection.id, connection.name, database, list));
    });
    searches.forEach((connection, index) => {
      const at = index * 3;
      all.push(
        ...searchItems(connection.id, connection.name, {
          indices: dataOf<SearchIndexInfo[]>(searchResults[at]) ?? NONE,
          dataStreams: dataOf<SearchDataStream[]>(searchResults[at + 1]) ?? NONE,
          aliases: dataOf<SearchAlias[]>(searchResults[at + 2]) ?? NONE,
        }),
      );
    });
    return all;
    // `stamp` is the content of the results; `targets` and `searches` follow `connected` and tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, targets.map((t) => `${t.connection.id}\u001f${t.database}`).join(), searches.length]);

  const loading =
    enabled &&
    [...databaseResults, ...collectionResults, ...searchResults].some((result) => result.isPending);
  return { items, loading };
}
