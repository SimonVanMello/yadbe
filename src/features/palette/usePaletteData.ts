import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { registeredActions } from '../../app/actions';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import {
  stateOf,
  useConnectionState,
  useConnections,
  useSessions,
} from '../connections/connectionStore';
import { useCatalogs, type CatalogTarget } from '../explorer/catalogCache';
import { fetchDatabases } from '../explorer/metaApi';
import { metaKeys } from '../explorer/metaKeys';
import { useTabRunning, useTabTransaction } from '../query/executionStore';
import { fileNameOf, useQueryTabStore } from '../query/queryTabStore';
import type { ActionContext } from './actionAvailability';
import { createSearcher } from './matcher';
import { buildObjectItems } from './objectItems';
import { parseQuery } from './paletteItems';
import { buildResults, type PaletteSources } from './paletteResults';
import {
  buildActionItems,
  buildConnectionItems,
  buildHistoryItems,
  buildTabItems,
  type TabEntry,
} from './paletteSources';
import { usePaletteStore } from './paletteStore';
import { useHistoryHits } from './useHistoryHits';

/** Longest text the history is searched with in the mixed list: shorter ones match everything. */
const HISTORY_MIN_CHARS = 3;

/**
 * The databases whose objects the palette searches: the one each connected connection was opened
 * on, and any other a query tab of it works in.
 */
function useCatalogTargets(enabled: boolean): { targets: CatalogTarget[]; loading: boolean } {
  const connections = useConnections();
  const sessions = useSessions((store) => store.sessions);
  const tabs = useTabsStore((store) => store.tabs);
  const tabStates = useQueryTabStore((store) => store.tabs);
  const connected = useMemo(
    () => connections.filter((connection) => stateOf(sessions[connection.id]) === 'connected'),
    [connections, sessions],
  );
  // Shares its cache with the explorer's root level.
  const databases = useQueries({
    queries: connected.map((connection) => ({
      queryKey: metaKeys.databases(connection.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchDatabases(connection.id, signal),
      staleTime: Infinity,
      gcTime: 10 * 60_000,
      enabled,
    })),
  });

  const targets: CatalogTarget[] = [];
  connected.forEach((connection, index) => {
    const names = new Set<string>();
    const list = databases[index]?.data;
    const current = list?.find((database) => database.current) ?? list?.[0];
    if (current) names.add(current.name);
    for (const tab of tabs) {
      const database = tab.connectionId === connection.id ? tabStates[tab.id]?.database : null;
      if (database) names.add(database);
    }
    for (const database of names) targets.push({ connectionId: connection.id, database });
  });
  const key = targets.map((t) => `${t.connectionId}\u001f${t.database}`).join('\u001e');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content of `targets`
  const stable = useMemo(() => targets, [key]);
  return { targets: stable, loading: enabled && databases.some((result) => result.isPending) };
}

/** Everything the palette lists, searched and grouped for what is typed. */
export function usePaletteData(raw: string) {
  const t = useT();
  const { mode, text } = useMemo(() => parseQuery(raw), [raw]);
  const recents = usePaletteStore((store) => store.recents);

  const connections = useConnections();
  const sessions = useSessions((store) => store.sessions);
  const tabs = useTabsStore((store) => store.tabs);
  const closedTabs = useTabsStore((store) => store.closedTabs.length);
  const activeTab = useTabsStore(selectActiveTab);
  const tabStates = useQueryTabStore((store) => store.tabs);
  const running = useTabRunning(activeTab.id);
  const transaction = useTabTransaction(activeTab.id);
  const activeState = useConnectionState(activeTab.connectionId);

  const wantsObjects = mode === 'all' || mode === 'object';
  const { targets, loading: loadingDatabases } = useCatalogTargets(wantsObjects);
  const { catalogs, loading: loadingCatalogs } = useCatalogs(targets, wantsObjects);
  const loadingObjects = loadingDatabases || loadingCatalogs;
  const names = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection.name])),
    [connections],
  );
  const objects = useMemo(() => buildObjectItems(catalogs, names), [catalogs, names]);
  const objectSearcher = useMemo(() => createSearcher(objects), [objects]);

  const historyWanted = mode === 'history' || (mode === 'all' && text.length >= HISTORY_MIN_CHARS);
  const history = useHistoryHits(text, historyWanted);
  const historyItems = useMemo(
    () => (historyWanted ? buildHistoryItems(history.entries) : []),
    [historyWanted, history.entries],
  );

  const context: ActionContext = {
    queryTab: activeTab.connectionId !== null,
    connected: activeState === 'connected',
    running,
    transactionOpen: transaction.status !== 'idle',
    tabCount: tabs.length,
    closedTabCount: closedTabs,
    registered: useMemo(() => registeredActions(), []),
  };
  const contextKey = [
    context.queryTab,
    context.connected,
    context.running,
    context.transactionOpen,
    context.tabCount,
    context.closedTabCount,
  ].join();
  const actions = useMemo(
    () => buildActionItems(t, context),
    // `contextKey` is the content of `context`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, contextKey],
  );
  const connectionItems = useMemo(
    () => buildConnectionItems(connections, (id) => stateOf(sessions[id])),
    [connections, sessions],
  );
  const tabItems = useMemo(() => {
    const entries: TabEntry[] = tabs.map((tab) => {
      const filePath = tabStates[tab.id]?.filePath;
      const connection = connections.find((candidate) => candidate.id === tab.connectionId);
      return {
        tab,
        name:
          tab.connectionId === null
            ? t('tab.new')
            : filePath
              ? fileNameOf(filePath)
              : t('tab.query', { number: tab.ordinal }),
        connectionName: connection?.name ?? null,
      };
    });
    return buildTabItems(entries, activeTab.id);
  }, [tabs, tabStates, connections, activeTab.id, t]);

  // One searcher per list, kept while the list is: typing narrows from the previous keystroke.
  const sources = useMemo<PaletteSources>(
    () => ({
      actions,
      connections: connectionItems,
      tabs: tabItems,
      objects,
      history: historyItems,
      searchers: {
        actions: createSearcher(actions),
        connections: createSearcher(connectionItems),
        tabs: createSearcher(tabItems),
        objects: objectSearcher,
      },
    }),
    [actions, connectionItems, tabItems, objects, objectSearcher, historyItems],
  );

  const results = useMemo(
    () => buildResults(sources, mode, text, recents),
    [sources, mode, text, recents],
  );
  return {
    mode,
    text,
    results,
    loading: loadingObjects || history.loading,
    loadingObjects,
    hasObjects: objects.length > 0,
    connectedCount: targets.length,
  };
}
