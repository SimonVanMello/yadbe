import { isQueryTab, isTableTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc } from '../../ipc';
import { forgetCollectionTab } from './collectionActions';
import { useConsoleStore } from './consoleStore';

let started = false;

/**
 * Wires the document family's tabs into the shell, once per app launch: a closed collection or
 * console tab frees what the backend keeps for it (its results, a running operation).
 */
export function startDocumentFeature(): void {
  if (started) return;
  started = true;
  const tracked = (tabs: ReturnType<typeof useTabsStore.getState>['tabs']) =>
    new Set(tabs.filter((tab) => isTableTab(tab) || isQueryTab(tab)).map((tab) => tab.id));
  let known = tracked(useTabsStore.getState().tabs);
  useTabsStore.subscribe((state) => {
    const ids = tracked(state.tabs);
    for (const id of known) {
      if (ids.has(id)) continue;
      forgetCollectionTab(id);
      useConsoleStore.getState().remove(id);
      // Unknown to the backend unless it was a document tab: then nothing happens.
      void ipc.commands.mongoCloseTab(id).catch(() => undefined);
    }
    known = ids;
  });
}
