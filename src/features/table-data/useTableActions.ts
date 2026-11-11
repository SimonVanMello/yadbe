import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { showObjectDdl } from '../objects/ddlActions';
import { pinOf } from '../objects/objectsModel';
import { usePinStore } from '../objects/pinStore';
import { showProperties } from '../objects/propertiesStore';
import { useFilterRequests } from './filterRequests';
import { goToReference, moveInTrail, openReferencingPanel, peekReference } from './fkNavigation';
import { openTableExport } from './tableExport';
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
  tableTabOf,
} from './tableActions';
import { getTableSession } from './tableSessionStore';

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
      'table.export': onTable(openTableExport),
      'table.showDdl': onTable((tabId) => {
        const tab = tableTabOf(tabId);
        if (tab)
          showObjectDdl(tab.connectionId, tab.table, getTableSession(tabId).info?.kind ?? 'table');
      }),
      'table.properties': onTable((tabId) => {
        const tab = tableTabOf(tabId);
        if (tab)
          showProperties(tab.connectionId, tab.table, getTableSession(tabId).info?.kind ?? 'table');
      }),
      'table.togglePin': onTable((tabId) => {
        const tab = tableTabOf(tabId);
        if (!tab) return;
        const kind = getTableSession(tabId).info?.kind ?? 'table';
        void usePinStore.getState().toggle(pinOf(tab.connectionId, tab.table, kind));
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
      'table.goToReference': onTable((tabId) => {
        void goToReference(tabId);
      }, 'grid'),
      'table.peekReference': onTable((tabId) => {
        void peekReference(tabId);
      }, 'grid'),
      'table.referencingRows': onTable(openReferencingPanel, 'grid'),
      // A text field keeps Alt+← / Alt+→ (a word left or right on macOS).
      'table.navigateBack': () => !typing() && moveInTrail(-1),
      'table.navigateForward': () => !typing() && moveInTrail(1),
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
