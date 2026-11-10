import { addCloseGuard, isTableTab, useTabsStore } from '../../app/tabs/tabsStore';
import { addWindowCloseGuard } from '../../app/windowCloseGuards';
import { useI18nStore } from '../../i18n/i18n';
import { ipc, type MetaNode, type ObjectRef } from '../../ipc';
import {
  confirmDiscard,
  forgetTableTab,
  openTable,
  relabelSources,
  tableTabOf,
} from './tableActions';
import { getTableSession, useTableSessionStore } from './tableSessionStore';
import { useTableTabStore, type TableTabState } from './tableTabStore';

/** Closed table tabs whose view (filter, sort, layout) comes back with "Reopen closed tab". */
const STASH_SIZE = 10;
const stash = new Map<string, TableTabState>();

function forget(tabId: string): void {
  const view = useTableTabStore.getState().tabs[tabId];
  if (view) {
    stash.delete(tabId);
    stash.set(tabId, view);
    for (const oldest of [...stash.keys()].slice(0, Math.max(0, stash.size - STASH_SIZE))) {
      stash.delete(oldest);
    }
  }
  useTableTabStore.getState().remove(tabId);
  forgetTableTab(tabId);
}

function sameTable(a: ObjectRef, b: ObjectRef): boolean {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

/** Whether refreshed metadata covers a table. */
function covers(node: MetaNode, table: ObjectRef): boolean {
  switch (node.level) {
    case 'connection':
      return true;
    case 'database':
      return node.database === table.database;
    case 'schema':
    case 'objects':
      return node.database === table.database && node.schema === table.schema;
    case 'table':
      return sameTable(node.table, table);
  }
}

let started = false;

/**
 * Wires table tabs into the shell, once per app launch: what happens when one closes, the
 * questions asked before pending changes are lost, and the backend events that concern them.
 */
export function startTableDataFeature(): void {
  if (started) return;
  started = true;

  let known = new Set(
    useTabsStore
      .getState()
      .tabs.filter(isTableTab)
      .map((tab) => tab.id),
  );
  useTabsStore.subscribe((state) => {
    const ids = new Set(state.tabs.filter(isTableTab).map((tab) => tab.id));
    for (const id of known) if (!ids.has(id)) forget(id);
    for (const id of ids) {
      if (known.has(id)) continue;
      useTableTabStore.getState().ensure(id, stash.get(id));
      stash.delete(id);
    }
    known = ids;
  });

  const hasPending = (ids: readonly string[]) =>
    ids.some((id) => getTableSession(id).pendingCount > 0);
  addCloseGuard((ids) => (hasPending(ids) ? confirmDiscard(ids, 'close') : true));
  addWindowCloseGuard({
    hasWork: () => hasPending(Object.keys(useTableSessionStore.getState().sessions)),
    confirm: () => confirmDiscard(Object.keys(useTableSessionStore.getState().sessions), 'close'),
  });

  // Changes applied from one tab: the others showing the table say their rows are old.
  ipc.events.subscribe('tableDataChanged', (event) => {
    for (const tab of useTabsStore.getState().tabs) {
      if (
        tab.id !== event.tabId &&
        isTableTab(tab) &&
        tab.connectionId === event.connectionId &&
        sameTable(tab.table, event.table) &&
        getTableSession(tab.id).phase === 'ready'
      ) {
        useTableSessionStore.getState().patch(tab.id, { stale: true });
      }
    }
  });

  // New metadata (refresh, DDL): the backend describes the table again from it.
  ipc.events.subscribe('metaRefreshed', (event) => {
    for (const tab of useTabsStore.getState().tabs) {
      if (
        isTableTab(tab) &&
        tab.connectionId === event.connectionId &&
        covers(event.node, tab.table) &&
        getTableSession(tab.id).phase === 'ready' &&
        tableTabOf(tab.id)
      ) {
        void openTable(tab.id);
      }
    }
  });

  useI18nStore.subscribe((state, previous) => {
    if (state.locale !== previous.locale) relabelSources();
  });
}
