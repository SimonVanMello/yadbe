import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { translate, useI18nStore } from '../../i18n/i18n';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { getCollectionTab } from '../document/collectionStore';
import { openResultExport } from '../grid/ResultFooter';
import { getIndexTab } from '../search/indexStore';
import { findConnection } from '../query/connectionLookup';
import { effectiveSelection } from '../query/executionModel';
import { getTabExecution, useExecutionStore } from '../query/executionStore';
import { activeQueryTabId } from '../query/queryActions';
import { activeTableTabId } from '../table-data/tableActions';
import { openTableExport } from '../table-data/tableExport';
import { useExportStore } from './exportStore';

/**
 * Opens the export dialog on the result shown in the active query tab (F-066), or on the
 * table of the active table tab.
 */
export function openExportForActiveTab(): void {
  const tableTabId = activeTableTabId();
  if (tableTabId !== null) {
    // A collection or an index tab shows documents: its page is a result, not a table.
    const tab = selectActiveTab(useTabsStore.getState());
    const family = findConnection(tab.connectionId)?.family;
    const documents =
      family === 'document'
        ? getCollectionTab(tableTabId).page?.documents
        : family === 'search'
          ? getIndexTab(tableTabId).page?.documents
          : undefined;
    if (documents && tab.table) {
      openResultExport(documents.result.resultId, documents.result, tab.table.name);
    } else if (family === 'sql' || family === undefined) {
      openTableExport(tableTabId);
    }
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
