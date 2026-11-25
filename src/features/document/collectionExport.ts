import { useTabsStore } from '../../app/tabs/tabsStore';
import { useExportStore } from '../export/exportStore';
import type { CollectionExportSource, KnownCount } from '../export/exportSources';
import { getCollectionTab, type CollectionTabState } from './collectionStore';
import { pendingCount } from './docEditModel';
import { tabDocEdits } from './docEditStore';

/** How many documents the applied query matches, as far as the tab knows. */
export function knownCollectionCount(state: CollectionTabState): KnownCount | null {
  if (state.exactCount !== null) return { value: state.exactCount, kind: 'exact' };
  const estimated = state.info?.estimatedCount;
  return estimated != null && state.applied.filter.trim() === ''
    ? { value: estimated, kind: 'estimated' }
    : null;
}

/** The export source of a collection tab: its collection under the query of the page shown. */
export function collectionExportSource(
  connectionId: string,
  database: string,
  collection: string,
  state: CollectionTabState,
  pending: boolean,
): CollectionExportSource {
  const { applied, page } = state;
  return {
    kind: 'collection',
    connectionId,
    database,
    collection,
    filter: applied.filter,
    projection: applied.projection,
    sort: applied.sort,
    count: knownCollectionCount(state),
    page: page
      ? { resultId: page.documents.result.resultId, documentsId: page.documents.documentsId }
      : null,
    filtered: applied.filter.trim() !== '',
    pending,
  };
}

/**
 * Opens the export dialog on a collection tab's collection (F-066, F-175): every document under
 * the tab's filter, projection and sort, read from the server in pages, not only the page shown.
 */
export function openCollectionExport(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.connectionId || !tab.table) return;
  const state = getCollectionTab(tabId);
  if (state.phase !== 'ready') return;
  useExportStore.getState().open({
    label: tab.table.name,
    connectionId: tab.connectionId,
    target: { schema: '', table: tab.table.name },
    source: collectionExportSource(
      tab.connectionId,
      tab.table.database,
      tab.table.name,
      state,
      pendingCount(tabDocEdits(tabId)) > 0,
    ),
  });
}
