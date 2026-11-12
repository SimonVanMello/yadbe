import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useSidebarView } from '../sidebar/sidebarViewStore';
import { useHistoryUi } from './historyStore';

/** Registers the shortcut that shows the History view of the sidebar and focuses its search. */
export function useHistoryActions(): void {
  useEffect(
    () =>
      registerActions({
        // What ran in the active editor tab (F-102): the History view, narrowed to it.
        'view.tabHistory': () => {
          useHistoryUi.getState().patchFilters({ thisTab: true });
          useHistoryUi.getState().setFiltersOpen(true);
          useSidebarView.getState().setView('history');
          useLayoutStore.getState().setCollapsed('sidebar', false);
        },
        'view.history': () => {
          useSidebarView.getState().setView('history');
          useLayoutStore.getState().setCollapsed('sidebar', false);
          // After the panel is rendered (it is not mounted while another view shows).
          requestAnimationFrame(() => {
            document.querySelector<HTMLInputElement>('[data-history-search]')?.focus();
          });
        },
      }),
    [],
  );
}
