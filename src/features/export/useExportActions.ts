import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { translate, useI18nStore } from '../../i18n/i18n';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { openCollectionExport } from '../document/collectionExport';
import { openIndexExport } from '../search/indexExport';
import { findConnection } from '../query/connectionLookup';
import { effectiveSelection } from '../query/executionModel';
import { getTabExecution, useExecutionStore } from '../query/executionStore';
import { activeQueryTabId } from '../query/queryActions';
import { activeTableTabId } from '../table-data/tableActions';
import { openTableExport } from '../table-data/tableExport';
import { useExportStore } from './exportStore';

/**
 * Opens the export dialog on the result shown in the active query tab (F-066), on the table of
 * the active table tab, or on the collection or index of a collection or index tab.
 */
export function openExportForActiveTab(): void {
  const tableTabId = activeTableTabId();
  if (tableTabId !== null) {
    // A collection or an index tab exports its collection or index under the tab's query.
    const tab = selectActiveTab(useTabsStore.getState());
    const family = findConnection(tab.connectionId)?.family;
    if (family === 'document') openCollectionExport(tableTabId);
    else if (family === 'search') openIndexExport(tableTabId);
    else if (family === 'sql' || family === undefined) openTableExport(tableTabId);
    return;
  }
  const tabId = activeQueryTabId();
  if (tabId === null) return;
  const execution = getTabExecution(tabId);
  const selection = effectiveSelection(useExecutionStore.getState().selections[tabId], execution);
  if (selection.kind !== 'result') return;
  const result = execution.results.find((candidate) => candidate.resultId === selection.resultId);
  if (!result) return;
  useExportStore.getState().open({
    label: translate(useI18nStore.getState().locale, 'query.results.result', {
      number: execution.results.indexOf(result) + 1,
    }),
    connectionId: execution.connectionId,
    source: {
      kind: 'result',
      resultId: result.resultId,
      rowCount: result.rowCount,
      status: result.status,
      pausedBy: result.pausedBy,
      truncated: result.truncated,
    },
  });
}

/** Registers what the export shortcut does. */
export function useExportActions(): void {
  useEffect(() => registerActions({ 'result.export': openExportForActiveTab }), []);
}
