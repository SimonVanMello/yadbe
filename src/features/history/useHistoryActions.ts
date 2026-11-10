import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useSidebarView } from '../sidebar/sidebarViewStore';

/** Registers the shortcut that shows the History view of the sidebar and focuses its search. */
export function useHistoryActions(): void {
  useEffect(
    () =>
      registerActions({
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
