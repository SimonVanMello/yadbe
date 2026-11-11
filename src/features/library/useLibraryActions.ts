import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useYadbeEvent } from '../../ipc/useYadbeEvent';
import { activeQueryTabId } from '../query/queryActions';
import { getQueryTabState } from '../query/queryTabStore';
import { useSidebarView } from '../sidebar/sidebarViewStore';
import { saveEditorToLibrary, updateSavedFromTab } from './libraryActions';
import { refreshLibrary } from './useLibrary';

/**
 * Wires the query library into the shell (F-050): the shortcut that shows the Saved view, the
 * actions of the editor, and the refresh of what is cached when the library changes.
 */
export function useLibraryActions(): void {
  useYadbeEvent('savedQueriesChanged', () => {
    void refreshLibrary();
  });
  useEffect(
    () =>
      registerActions({
        'view.library': () => {
          useSidebarView.getState().setView('library');
          useLayoutStore.getState().setCollapsed('sidebar', false);
          // After the panel is rendered (it is not mounted while another view shows).
          requestAnimationFrame(() => {
            document.querySelector<HTMLInputElement>('[data-library-search]')?.focus();
          });
        },
        // `false` outside a query tab, like the other editor actions.
        'query.saveToLibrary': () => {
          const tabId = activeQueryTabId();
          return tabId === null ? false : saveEditorToLibrary(tabId);
        },
        'query.updateSavedQuery': () => {
          const tabId = activeQueryTabId();
          if (tabId === null) return false;
          if (getQueryTabState(tabId).origin === null) return true;
          void updateSavedFromTab(tabId);
          return true;
        },
      }),
    [],
  );
}
