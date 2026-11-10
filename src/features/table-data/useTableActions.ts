import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { useFilterRequests } from './filterRequests';
import {
  activeTableTabId,
  countRows,
  deleteSelectedRows,
  duplicateRows,
  flushEditor,
  goToPage,
  insertRow,
  openPreview,
  pasteText,
  refreshTable,
  requestApply,
  revertAll,
  revertSelectedCells,
  revertSelectedRows,
  setNullOnSelection,
} from './tableActions';

/** Focus in a text field (filter, WHERE, cell editor): its own keys win over grid actions. */
function typing(): boolean {
  const element = document.activeElement;
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/**
 * Registers what the table tab actions do (F-080 to F-085), on the active table tab. Each
 * returns `false` elsewhere, so a query tab keeps `Mod+S` for Save and a text field keeps its
 * own editing keys.
 */
export function useTableActions(): void {
  useEffect(() => {
    const onTable =
      (act: (tabId: string) => void, scope: 'tab' | 'grid' = 'tab') =>
      () => {
        const tabId = activeTableTabId();
        if (tabId === null || (scope === 'grid' && typing())) return false;
        act(tabId);
        return true;
      };
    return registerActions({
      'table.apply': onTable((tabId) => {
        void flushEditor(tabId).then(() => {
          requestApply(tabId);
        });
      }),
      'table.preview': onTable((tabId) => {
        void flushEditor(tabId).then(() => openPreview(tabId));
      }),
      'table.refresh': onTable((tabId) => {
        void refreshTable(tabId);
      }),
      'table.filter': onTable((tabId) => {
        useFilterRequests.getState().request(tabId);
      }),
      'table.nextPage': onTable((tabId) => {
        void goToPage(tabId, 'next');
      }),
      'table.previousPage': onTable((tabId) => {
        void goToPage(tabId, 'previous');
      }),
      'table.countExact': onTable((tabId) => {
        void countRows(tabId, 'exact');
      }),
      'table.revertAll': onTable((tabId) => {
        void revertAll(tabId);
      }),
      'table.insertRow': onTable(insertRow, 'grid'),
      'table.duplicateRows': onTable((tabId) => {
        void duplicateRows(tabId);
      }, 'grid'),
      'table.deleteRows': onTable((tabId) => {
        void deleteSelectedRows(tabId);
      }, 'grid'),
      'table.setNull': onTable((tabId) => {
        void setNullOnSelection(tabId);
      }, 'grid'),
      'table.revertCells': onTable(revertSelectedCells, 'grid'),
      'table.revertRows': onTable(revertSelectedRows, 'grid'),
      'table.pasteRows': onTable((tabId) => {
        navigator.clipboard
          .readText()
          .then((text) => pasteText(tabId, text, true))
          .catch((error: unknown) => {
            showError(error, {
              title: translate(useI18nStore.getState().locale, 'tableData.paste.unavailable'),
            });
          });
      }),
    });
  }, []);
}
