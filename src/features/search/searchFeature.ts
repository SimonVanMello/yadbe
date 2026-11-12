import { isQueryTab, isTableTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc } from '../../ipc';
import { forgetIndexTab } from './indexActions';
import { useSearchConsoleStore } from './searchConsoleStore';
import { forgetSearchEdits } from './searchEditActions';

let started = false;

/**
 * Wires the search family's tabs into the shell, once per app launch: a closed index or console
 * tab frees what the backend keeps for it (its results, its point in time, a running request).
 */
export function startSearchFeature(): void {
  if (started) return;
  started = true;
  const tracked = (tabs: ReturnType<typeof useTabsStore.getState>['tabs']) =>
    new Set(tabs.filter((tab) => isTableTab(tab) || isQueryTab(tab)).map((tab) => tab.id));
  let known = tracked(useTabsStore.getState().tabs);
  useTabsStore.subscribe((state) => {
    const ids = tracked(state.tabs);
    for (const id of known) {
      if (ids.has(id)) continue;
      forgetIndexTab(id);
      forgetSearchEdits(id);
      useSearchConsoleStore.getState().forget(id);
      // Unknown to the backend unless it was a search tab: then nothing happens.
      void ipc.commands.searchCloseTab(id).catch(() => undefined);
    }
    known = ids;
  });
}
