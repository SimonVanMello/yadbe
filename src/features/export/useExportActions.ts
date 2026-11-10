import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { translate, useI18nStore } from '../../i18n/i18n';
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
    openTableExport(tableTabId);
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
    },
  });
}

/** Registers what the export shortcut does. */
export function useExportActions(): void {
  useEffect(() => registerActions({ 'result.export': openExportForActiveTab }), []);
}
