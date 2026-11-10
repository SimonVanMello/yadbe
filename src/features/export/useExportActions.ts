import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { translate, useI18nStore } from '../../i18n/i18n';
import { effectiveSelection } from '../query/executionModel';
import { getTabExecution, useExecutionStore } from '../query/executionStore';
import { activeQueryTabId } from '../query/queryActions';
import { useExportStore } from './exportStore';

/** Opens the export dialog on the result shown in the active query tab (F-066). */
export function openExportForActiveTab(): void {
  const tabId = activeQueryTabId();
  if (tabId === null) return;
  const execution = getTabExecution(tabId);
  const selection = effectiveSelection(useExecutionStore.getState().selections[tabId], execution);
  if (selection.kind !== 'result') return;
  const result = execution.results.find((candidate) => candidate.resultId === selection.resultId);
  if (!result) return;
  useExportStore.getState().open({
    resultId: result.resultId,
    label: translate(useI18nStore.getState().locale, 'query.results.result', {
      number: execution.results.indexOf(result) + 1,
    }),
    connectionId: execution.connectionId,
    rowCount: result.rowCount,
    status: result.status,
    pausedBy: result.pausedBy,
  });
}

/** Registers what the export shortcut does. */
export function useExportActions(): void {
  useEffect(() => registerActions({ 'result.export': openExportForActiveTab }), []);
}
