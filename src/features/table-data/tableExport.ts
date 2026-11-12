import { useExportStore } from '../export/exportStore';
import { tableTabOf } from './tableActions';
import { toTableFilter } from './filterModel';
import { tableLabel } from './tableNames';
import { getTableSession } from './tableSessionStore';
import { isEmpty } from './pendingChanges';
import { getTableTabState } from './tableTabStore';

/**
 * Opens the export dialog on a table tab's table (F-066): every row under the tab's filter and
 * sort, read from the server in pages, not only the page on screen.
 */
export function openTableExport(tabId: string): void {
  const tab = tableTabOf(tabId);
  const { info, pending } = getTableSession(tabId);
  if (!tab || !info) return;
  const view = getTableTabState(tabId);
  useExportStore.getState().open({
    label: tableLabel(tab.table),
    connectionId: tab.connectionId,
    target: { schema: tab.table.schema ?? '', table: tab.table.name },
    source: {
      kind: 'table',
      tabId,
      filter: toTableFilter(view.filter, info.columns),
      sort: view.sort,
      pending: !isEmpty(pending),
    },
  });
}
