import { useTabsStore } from '../../app/tabs/tabsStore';
import { useExportStore } from '../export/exportStore';
import type { IndexExportSource, KnownCount } from '../export/exportSources';
import { indexQueryOf } from './indexActions';
import { getIndexTab, type IndexTabState } from './indexStore';
import { getSearchEditTab } from './searchEditStore';

/** How many hits the applied query has, as far as the tab knows. */
export function knownIndexCount(state: IndexTabState): KnownCount | null {
  if (state.exactCount !== null) return { value: state.exactCount, kind: 'exact' };
  const total = state.page?.total;
  return total && total.value !== null
    ? { value: total.value, kind: total.exact ? 'exact' : 'atLeast' }
    : null;
}

/** The export source of an index tab: its target under the query of the page shown. */
export function indexExportSource(
  connectionId: string,
  target: string,
  state: IndexTabState,
  pending: boolean,
): IndexExportSource {
  const { mode, text, source, sort } = indexQueryOf(state.applied, state.pageSize);
  const { page } = state;
  return {
    kind: 'index',
    connectionId,
    target,
    mode,
    text,
    source,
    sort,
    count: knownIndexCount(state),
    page: page
      ? { resultId: page.documents.result.resultId, documentsId: page.documents.documentsId }
      : null,
    filtered: text.trim() !== '',
    pending,
  };
}

/**
 * Opens the export dialog on an index tab's index (F-066, F-175): every hit of the tab's query,
 * `_source` filter and sort, read from the server in pages, not only the page shown.
 */
export function openIndexExport(tabId: string): void {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.connectionId || !tab.table) return;
  const state = getIndexTab(tabId);
  if (state.phase !== 'ready') return;
  useExportStore.getState().open({
    label: tab.table.name,
    connectionId: tab.connectionId,
    target: { schema: '', table: tab.table.name },
    source: indexExportSource(
      tab.connectionId,
      tab.table.name,
      state,
      getSearchEditTab(tabId).pending.length > 0,
    ),
  });
}
