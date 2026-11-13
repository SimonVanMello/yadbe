import { isQueryTab, isTableTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc } from '../../ipc';
import { forgetCollectionTab } from './collectionActions';
import { dropTabDocEdits } from './docEditStore';
import { appendLiveMessages, useScriptStore } from './scriptStore';

let started = false;

/**
 * Wires the document family's tabs into the shell, once per app launch: a closed collection or
 * query tab frees what the backend keeps for it (its results, a running operation or script),
 * a script that meets a dangerous operation asks its tab for a confirmation, and what a running
 * script prints reaches its messages pane.
 */
export function startDocumentFeature(): void {
  if (started) return;
  started = true;
  ipc.events.subscribe('mongoScriptConfirm', ({ tabId, requestId, danger }) => {
    useScriptStore.getState().patch(tabId, { confirm: { requestId, danger } });
  });
  ipc.events.subscribe('mongoScriptOutput', ({ tabId, messages }) => {
    appendLiveMessages(tabId, messages);
  });
  const tracked = (tabs: ReturnType<typeof useTabsStore.getState>['tabs']) =>
    new Set(tabs.filter((tab) => isTableTab(tab) || isQueryTab(tab)).map((tab) => tab.id));
  let known = tracked(useTabsStore.getState().tabs);
  useTabsStore.subscribe((state) => {
    const ids = tracked(state.tabs);
    for (const id of known) {
      if (ids.has(id)) continue;
      forgetCollectionTab(id);
      dropTabDocEdits(id);
      useScriptStore.getState().remove(id);
      // Unknown to the backend unless it was a document tab: then nothing happens.
      void ipc.commands.mongoCloseTab(id).catch(() => undefined);
    }
    known = ids;
  });
}
