import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useYadbeEvent } from '../../ipc/useYadbeEvent';
import { useSidebarView } from '../sidebar/sidebarViewStore';
import { activeTableTabId, tableTabOf } from '../table-data/tableActions';
import { showTableJournal } from './journalStore';
import { refreshJournal } from './useJournal';

/**
 * Wires the change journal into the shell (F-090): its sidebar view, the change sets of the
 * active table tab, and the refresh of what is cached when the journal changes.
 */
export function useJournalActions(): void {
  useYadbeEvent('changeJournalChanged', () => {
    void refreshJournal();
  });
  useEffect(
    () =>
      registerActions({
        'view.journal': () => {
          useSidebarView.getState().setView('journal');
          useLayoutStore.getState().setCollapsed('sidebar', false);
          requestAnimationFrame(() => {
            document.querySelector<HTMLInputElement>('[data-journal-search]')?.focus();
          });
        },
        'table.journal': () => {
          const tabId = activeTableTabId();
          const tab = tabId === null ? null : tableTabOf(tabId);
          if (!tab) return false;
          showTableJournal(tab.connectionId, tab.table);
          useLayoutStore.getState().setCollapsed('sidebar', false);
          return true;
        },
      }),
    [],
  );
}
