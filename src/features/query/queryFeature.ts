import { setCloseGuard, useTabsStore } from '../../app/tabs/tabsStore';
import { addWindowCloseGuard } from '../../app/windowCloseGuards';
import { ipc } from '../../ipc';
import { forgetConsole } from '../keyvalue/kvConsoleActions';
import { forgetEditorState } from './SqlEditor';
import { confirmAbandonTransaction, hasOpenTransaction } from './queryActions';
import { useExecutionStore, startQueryFeed } from './executionStore';
import { useFileIssues } from './fileIssues';
import { useParameterStore } from './parameterStore';
import { usePlanStore } from './planStore';
import { useQueryTabStore, type QueryTabState } from './queryTabStore';

export { restoreAndPersistQueryUi } from './queryUiStore';

/** Closed tabs whose editor state is kept for "Reopen closed tab" (same as the tab strip's). */
const STASH_SIZE = 10;
const stash = new Map<string, QueryTabState>();

function forgetTab(tabId: string): void {
  const editor = useQueryTabStore.getState().tabs[tabId];
  if (editor) {
    stash.delete(tabId);
    stash.set(tabId, editor);
    for (const oldest of [...stash.keys()].slice(0, Math.max(0, stash.size - STASH_SIZE))) {
      stash.delete(oldest);
    }
  }
  useQueryTabStore.getState().remove(tabId);
  forgetEditorState(tabId);
  useExecutionStore.getState().forget(tabId);
  useFileIssues.getState().set(tabId, null);
  usePlanStore.getState().forget(tabId);
  useParameterStore.getState().forget(tabId);
  // Frees the tab's server connection and results; an open transaction is rolled back.
  void ipc.commands.closeQueryTab(tabId);
  forgetConsole(tabId);
}

let started = false;

/**
 * Wires the query tabs into the shell, once per app launch: execution events, what happens when
 * a tab closes (its connection and results are freed, its text kept for "Reopen closed tab"),
 * and the question asked before a tab or the window closes on an open transaction (F-047).
 */
export function startQueryFeature(): void {
  if (started) return;
  started = true;
  startQueryFeed();

  let known = new Set(useTabsStore.getState().tabs.map((tab) => tab.id));
  useTabsStore.subscribe((state) => {
    const ids = new Set(state.tabs.map((tab) => tab.id));
    for (const id of known) if (!ids.has(id)) forgetTab(id);
    for (const id of ids) {
      const kept = stash.get(id);
      if (!known.has(id) && kept) {
        useQueryTabStore.getState().ensure(id, kept);
        stash.delete(id);
      }
    }
    known = ids;
  });

  setCloseGuard((ids) =>
    ids.some(hasOpenTransaction) ? confirmAbandonTransaction(ids, 'close') : true,
  );
  addWindowCloseGuard({
    hasWork: () => useTabsStore.getState().tabs.some((tab) => hasOpenTransaction(tab.id)),
    confirm: () =>
      confirmAbandonTransaction(
        useTabsStore.getState().tabs.map((tab) => tab.id),
        'close',
      ),
  });
}
