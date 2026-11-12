import { create } from 'zustand';

import type { DdlTarget, KvBytes, ObjectRef } from '../../ipc';

/** A tab of the title bar. Query tabs are placeholders until the editor lands (M1-4). */
export interface ShellTab {
  id: string;
  /** `null` for a new tab (welcome screen). */
  connectionId: string | null;
  /** Number shown in the name of a query tab ("Query 3"); `0` for a welcome tab. */
  ordinal: number;
  /** Pinned tabs come first in the strip, in their own order; welcome tabs are never pinned. */
  pinned: boolean;
  /** Set for a table tab (F-080): the table or view whose rows it shows. */
  table?: ObjectRef;
  /**
   * Set for a DDL tab (F-024): the object whose definition it shows, read-only. Never saved: it
   * is a view of the server as it is, opened again from the explorer.
   */
  ddl?: DdlTarget;
  /**
   * Set for a tool tab: the activity monitor of the connection (F-140) or its EF Core migrations
   * timeline (F-143). Like a DDL tab it shows the server as it is now: never saved, opened again
   * from the menus.
   */
  tool?: ToolTarget;
}

/** What a tool tab shows. */
export type ToolTarget =
  | { type: 'activity' }
  | { type: 'migrations'; table: ObjectRef }
  /** A key of a key-value database, read in its viewer (M4-5). */
  | { type: 'kvKey'; database: number; key: KvBytes };

/** A tool tab: bound to a connection, showing the activity monitor or the migrations. */
export function isToolTab(
  tab: ShellTab,
): tab is ShellTab & { connectionId: string; tool: ToolTarget } {
  return tab.connectionId !== null && tab.tool !== undefined;
}

/** A table tab: bound to a connection and a table. */
export function isTableTab(
  tab: ShellTab,
): tab is ShellTab & { connectionId: string; table: ObjectRef } {
  return tab.connectionId !== null && tab.table !== undefined;
}

/** A DDL tab: bound to a connection, showing the definition of one object. */
export function isDdlTab(
  tab: ShellTab,
): tab is ShellTab & { connectionId: string; ddl: DdlTarget } {
  return tab.connectionId !== null && tab.ddl !== undefined;
}

/** A query tab: bound to a connection, with a SQL editor. */
export function isQueryTab(tab: ShellTab): tab is ShellTab & { connectionId: string } {
  return (
    tab.connectionId !== null &&
    tab.table === undefined &&
    tab.ddl === undefined &&
    tab.tool === undefined
  );
}

/** Shape written to the store and read back at startup. */
export interface SavedTabs {
  tabs: {
    id: string;
    connectionId: string | null;
    ordinal: number;
    pinned: boolean;
    table?: ObjectRef | null;
  }[];
  activeTabId: string | null;
}

/** A query tab closed in this session, for "Reopen closed tab". */
export interface ClosedTab {
  /** Its id, reused when it reopens so that what the editor kept for it comes back. */
  id: string;
  connectionId: string;
  ordinal: number;
  /** Position in the strip when it was closed. */
  index: number;
  pinned: boolean;
  table?: ObjectRef;
}

/** Closed tabs remembered for "Reopen closed tab" (session only, never saved). */
export const CLOSED_TABS_KEPT = 10;

/**
 * Asked before tabs close, to let a feature stop it (a transaction is open in one of them).
 * `true` closes, `false` keeps the tabs; a promise lets the feature ask the user first.
 */
export type CloseGuard = (ids: readonly string[]) => boolean | Promise<boolean>;

let closeGuard: CloseGuard | null = null;

export function setCloseGuard(guard: CloseGuard | null): void {
  closeGuard = guard;
}

const extraGuards = new Set<CloseGuard>();

/** Another feature's guard, asked after `setCloseGuard`'s one; returns what removes it. */
export function addCloseGuard(guard: CloseGuard): () => void {
  extraGuards.add(guard);
  return () => {
    extraGuards.delete(guard);
  };
}

/** Every guard in turn; the first refusal keeps the tabs. */
function askGuards(ids: readonly string[]): boolean | Promise<boolean> {
  const guards = [...(closeGuard ? [closeGuard] : []), ...extraGuards];
  const ask = async (from: number): Promise<boolean> => {
    for (let i = from; i < guards.length; i++) {
      const guard = guards[i];
      if (guard && !(await guard(ids))) return false;
    }
    return true;
  };
  // Synchronous answers stay synchronous (tabs close in the same tick when nothing asks).
  for (const [index, guard] of guards.entries()) {
    const verdict = guard(ids);
    if (verdict === false) return false;
    if (verdict !== true) {
      // The last guard's answer is the answer (no extra wait for the tabs to close).
      if (index === guards.length - 1) return verdict;
      return verdict.then((allowed) => (allowed ? ask(index + 1) : false));
    }
  }
  return true;
}

interface TabsStore {
  tabs: ShellTab[];
  activeTabId: string;
  /** Last closed query tabs, most recent last. */
  closedTabs: ClosedTab[];
  /** Highest query number handed out so far. */
  lastOrdinal: number;
  /** Replaces every tab with the saved state (startup restoration). */
  hydrate: (saved: SavedTabs) => void;
  /** Opens a welcome tab at the end and activates it. Returns its id. */
  newTab: () => string;
  /** Opens a query tab bound to a connection at the end and activates it. Returns its id. */
  openQueryTab: (connectionId: string) => string;
  /**
   * Shows a table's rows: activates the tab already showing it, else opens a table tab (in the
   * active tab when it is still a welcome tab). Returns its id.
   */
  openTableTab: (connectionId: string, table: ObjectRef) => string;
  /** Shows an object's definition: activates the DDL tab already showing it, else opens one. */
  openDdlTab: (connectionId: string, target: DdlTarget) => string;
  /** Shows a tool: activates the tool tab already showing it, else opens one. */
  openToolTab: (connectionId: string, tool: ToolTarget) => string;
  /** An object was renamed: its table tabs and DDL tabs follow it. Returns the table tabs' ids. */
  renameObject: (connectionId: string, from: ObjectRef, to: ObjectRef) => string[];
  closeTab: (id: string) => void;
  /**
   * Closes several tabs at once, remembered so that reopening brings them back in place. The
   * active tab, if closed, gives way to `activateId` or else its nearest neighbor left open.
   */
  closeTabs: (ids: readonly string[], activateId?: string) => void;
  /** `closeTabs` without asking the close guard (the tabs' connection is gone). */
  closeTabsNow: (ids: readonly string[], activateId?: string) => void;
  /** Closes every unpinned tab but `id`. */
  closeOtherTabs: (id: string) => void;
  /** Closes the unpinned tabs after `id`. */
  closeTabsToRight: (id: string) => void;
  /** Closes every tab bound to a connection that was deleted, and forgets them. */
  closeConnectionTabs: (connectionId: string) => void;
  /** Reopens the most recently closed query tab, placed where it was. Returns its id. */
  reopenClosedTab: () => string | null;
  /** Pins or unpins a query tab: it moves to the end of the pinned tabs, or right after them. */
  setPinned: (id: string, pinned: boolean) => void;
  activate: (id: string) => void;
  /** `⌘1…8` select by position, `⌘9` always selects the last tab (browser convention). */
  activateIndex: (index: number) => void;
  /** Cycles through tabs (`⌃Tab` / `⌃⇧Tab`). */
  activateRelative: (delta: number) => void;
  /** Moves a tab within its group: pinned tabs stay before the others. */
  moveTab: (id: string, toIndex: number) => void;
  /** Binds a welcome tab to a connection, which makes it a query tab. */
  setConnection: (id: string, connectionId: string) => void;
}

let counter = 0;
function newTabId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function pinnedCount(tabs: readonly ShellTab[]): number {
  return tabs.filter((tab) => tab.pinned).length;
}

/** Pinned tabs first, each group in its order (a save from before pinning, or a corrupted one). */
function pinnedFirst(tabs: ShellTab[]): ShellTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

/** Indexes `tab` may take in `tabs` (which holds it): its group's range. */
function groupRange(tabs: readonly ShellTab[], tab: ShellTab): [number, number] {
  const pinned = pinnedCount(tabs);
  return tab.pinned ? [0, pinned - 1] : [pinned, tabs.length - 1];
}

/** The closed query tabs to remember, rightmost first: reopening brings the leftmost back first. */
function remember(
  stack: readonly ClosedTab[],
  tabs: readonly ShellTab[],
  ids: ReadonlySet<string>,
): ClosedTab[] {
  const closed: ClosedTab[] = [];
  tabs.forEach((tab, index) => {
    if (
      ids.has(tab.id) &&
      tab.connectionId !== null &&
      tab.ddl === undefined &&
      tab.tool === undefined
    ) {
      closed.unshift({
        id: tab.id,
        connectionId: tab.connectionId,
        ordinal: tab.ordinal,
        index,
        pinned: tab.pinned,
        ...(tab.table ? { table: tab.table } : {}),
      });
    }
  });
  return [...stack, ...closed].slice(-CLOSED_TABS_KEPT);
}

function welcomeTab(): ShellTab {
  return { id: newTabId(), connectionId: null, ordinal: 0, pinned: false };
}

export function createTabsStore() {
  const initial = welcomeTab();
  return create<TabsStore>()((set, get) => ({
    tabs: [initial],
    activeTabId: initial.id,
    closedTabs: [],
    lastOrdinal: 0,

    hydrate: (saved) => {
      const seen = new Set<string>();
      const tabs: ShellTab[] = [];
      for (const tab of saved.tabs) {
        const id = tab.id || newTabId();
        if (seen.has(id)) continue;
        seen.add(id);
        tabs.push({
          id,
          connectionId: tab.connectionId,
          ordinal: tab.connectionId === null ? 0 : tab.ordinal,
          pinned: tab.connectionId !== null && tab.pinned,
          ...(tab.table && tab.connectionId !== null ? { table: tab.table } : {}),
        });
      }
      if (tabs.length === 0) return;
      const ordered = pinnedFirst(tabs);
      const active = ordered.find((tab) => tab.id === saved.activeTabId) ?? ordered[0];
      set({
        tabs: ordered,
        activeTabId: active?.id ?? get().activeTabId,
        lastOrdinal: Math.max(get().lastOrdinal, ...tabs.map((tab) => tab.ordinal)),
      });
    },

    newTab: () => {
      const tab = welcomeTab();
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      return tab.id;
    },

    openQueryTab: (connectionId) => {
      const ordinal = get().lastOrdinal + 1;
      const tab: ShellTab = { id: newTabId(), connectionId, ordinal, pinned: false };
      set((state) => ({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        lastOrdinal: ordinal,
      }));
      return tab.id;
    },

    openTableTab: (connectionId, table) => {
      const { tabs, activeTabId } = get();
      const same = (other: ObjectRef | undefined) =>
        !!other &&
        other.database === table.database &&
        other.schema === table.schema &&
        other.name === table.name;
      const open = tabs.find((tab) => tab.connectionId === connectionId && same(tab.table));
      if (open) {
        set({ activeTabId: open.id });
        return open.id;
      }
      const active = tabs.find((tab) => tab.id === activeTabId);
      if (active && active.connectionId === null) {
        set({
          tabs: tabs.map((tab) => (tab.id === active.id ? { ...tab, connectionId, table } : tab)),
        });
        return active.id;
      }
      const tab: ShellTab = { id: newTabId(), connectionId, ordinal: 0, pinned: false, table };
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      return tab.id;
    },

    openDdlTab: (connectionId, target) => {
      const { tabs } = get();
      const key = JSON.stringify(target);
      const open = tabs.find(
        (tab) =>
          tab.connectionId === connectionId &&
          tab.ddl !== undefined &&
          JSON.stringify(tab.ddl) === key,
      );
      if (open) {
        set({ activeTabId: open.id });
        return open.id;
      }
      const tab: ShellTab = {
        id: newTabId(),
        connectionId,
        ordinal: 0,
        pinned: false,
        ddl: target,
      };
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      return tab.id;
    },

    openToolTab: (connectionId, tool) => {
      const { tabs } = get();
      const key = JSON.stringify(tool);
      const open = tabs.find(
        (tab) =>
          tab.connectionId === connectionId &&
          tab.tool !== undefined &&
          JSON.stringify(tab.tool) === key,
      );
      if (open) {
        set({ activeTabId: open.id });
        return open.id;
      }
      const tab: ShellTab = { id: newTabId(), connectionId, ordinal: 0, pinned: false, tool };
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      return tab.id;
    },

    renameObject: (connectionId, from, to) => {
      const same = (other: ObjectRef) =>
        other.database === from.database &&
        other.schema === from.schema &&
        other.name === from.name;
      const moved: string[] = [];
      const tabs = get().tabs.map((tab): ShellTab => {
        if (tab.connectionId !== connectionId) return tab;
        if (tab.table && same(tab.table)) {
          moved.push(tab.id);
          return { ...tab, table: { ...tab.table, name: to.name } };
        }
        const { ddl } = tab;
        if (ddl?.type === 'object' && same(ddl.object)) {
          return { ...tab, ddl: { ...ddl, object: { ...ddl.object, name: to.name }, id: to.name } };
        }
        if ((ddl?.type === 'trigger' || ddl?.type === 'index') && same(ddl.table)) {
          return { ...tab, ddl: { ...ddl, table: { ...ddl.table, name: to.name } } };
        }
        return tab;
      });
      set({ tabs });
      return moved;
    },

    closeTab: (id) => {
      get().closeTabs([id]);
    },

    closeTabs: (ids, activateId) => {
      const verdict = askGuards(ids);
      if (verdict === true) get().closeTabsNow(ids, activateId);
      else if (verdict !== false) {
        void verdict.then((allowed) => {
          if (allowed) get().closeTabsNow(ids, activateId);
        });
      }
    },

    closeTabsNow: (ids, activateId) => {
      const { tabs, activeTabId, closedTabs } = get();
      const closing = new Set(ids.filter((id) => tabs.some((tab) => tab.id === id)));
      if (closing.size === 0) return;
      const remembered = remember(closedTabs, tabs, closing);
      const remaining = tabs.filter((tab) => !closing.has(tab.id));
      if (remaining.length === 0) {
        // The window always keeps a tab: closing the last one leaves a welcome screen.
        const tab = welcomeTab();
        set({ tabs: [tab], activeTabId: tab.id, closedTabs: remembered });
        return;
      }
      let nextActive = activeTabId;
      if (closing.has(activeTabId) && activateId !== undefined && !closing.has(activateId)) {
        nextActive = activateId;
      } else if (closing.has(activeTabId)) {
        // The nearest tab left open: to the right first, then to the left.
        const index = tabs.findIndex((tab) => tab.id === activeTabId);
        const right = tabs.slice(index + 1).find((tab) => !closing.has(tab.id));
        const left = tabs
          .slice(0, index)
          .reverse()
          .find((tab) => !closing.has(tab.id));
        nextActive = (right ?? left ?? remaining[0])?.id ?? activeTabId;
      }
      set({ tabs: remaining, activeTabId: nextActive, closedTabs: remembered });
    },

    closeOtherTabs: (id) => {
      const { tabs } = get();
      if (!tabs.some((tab) => tab.id === id)) return;
      const closing = tabs.filter((tab) => tab.id !== id && !tab.pinned).map((tab) => tab.id);
      get().closeTabs(closing, id);
    },

    closeTabsToRight: (id) => {
      const { tabs } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const closing = tabs.slice(index + 1).filter((tab) => !tab.pinned);
      get().closeTabs(
        closing.map((tab) => tab.id),
        id,
      );
    },

    closeConnectionTabs: (connectionId) => {
      const ids = get()
        .tabs.filter((tab) => tab.connectionId === connectionId)
        .map((tab) => tab.id);
      // The connection is gone, and with it every transaction: nothing to ask.
      get().closeTabsNow(ids);
      set((state) => ({
        closedTabs: state.closedTabs.filter((closed) => closed.connectionId !== connectionId),
      }));
    },

    reopenClosedTab: () => {
      const { closedTabs, tabs } = get();
      const closed = closedTabs.at(-1);
      if (!closed) return null;
      const tab: ShellTab = {
        id: tabs.some((open) => open.id === closed.id) ? newTabId() : closed.id,
        connectionId: closed.connectionId,
        ordinal: closed.ordinal,
        pinned: closed.pinned,
        ...(closed.table ? { table: closed.table } : {}),
      };
      const pinned = pinnedCount(tabs);
      const [first, last] = closed.pinned ? [0, pinned] : [pinned, tabs.length];
      const index = closed.index >= first && closed.index <= last ? closed.index : last;
      const next = [...tabs];
      next.splice(index, 0, tab);
      set({ tabs: next, activeTabId: tab.id, closedTabs: closedTabs.slice(0, -1) });
      return tab.id;
    },

    setPinned: (id, pinned) => {
      const { tabs } = get();
      const tab = tabs.find((t) => t.id === id);
      if (!tab || tab.connectionId === null || tab.pinned === pinned) return;
      const others = tabs.filter((t) => t.id !== id);
      const next = [...others];
      // Pinning: after the pinned tabs. Unpinning: first of the unpinned ones.
      next.splice(pinnedCount(others), 0, { ...tab, pinned });
      set({ tabs: next });
    },

    activate: (id) => {
      if (get().tabs.some((tab) => tab.id === id)) set({ activeTabId: id });
    },

    activateIndex: (index) => {
      const { tabs } = get();
      const tab = index >= 8 ? tabs.at(-1) : tabs[index];
      if (tab) set({ activeTabId: tab.id });
    },

    activateRelative: (delta) => {
      const { tabs, activeTabId } = get();
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (next) set({ activeTabId: next.id });
    },

    moveTab: (id, toIndex) => {
      const { tabs } = get();
      const from = tabs.findIndex((tab) => tab.id === id);
      const tab = tabs[from];
      if (!tab) return;
      const [first, last] = groupRange(tabs, tab);
      const to = Math.max(first, Math.min(last, toIndex));
      if (from === to) return;
      const next = tabs.filter((t) => t.id !== id);
      next.splice(to, 0, tab);
      set({ tabs: next });
    },

    setConnection: (id, connectionId) => {
      const { tabs, lastOrdinal } = get();
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      // A welcome tab becoming a query tab gets the next number; a rebound one keeps its own.
      const ordinal = tab.ordinal || lastOrdinal + 1;
      set({
        tabs: tabs.map((t) => (t.id === id ? { ...t, connectionId, ordinal } : t)),
        lastOrdinal: Math.max(lastOrdinal, ordinal),
      });
    },
  }));
}

export const useTabsStore = createTabsStore();

export function toSavedTabs(state: Pick<TabsStore, 'tabs' | 'activeTabId'>): SavedTabs {
  return {
    tabs: state.tabs
      .filter((tab) => tab.ddl === undefined && tab.tool === undefined)
      .map((tab) => ({
        id: tab.id,
        connectionId: tab.connectionId,
        ordinal: tab.ordinal,
        pinned: tab.pinned,
        ...(tab.table ? { table: tab.table } : {}),
      })),
    activeTabId: state.activeTabId,
  };
}

export function selectActiveTab(state: Pick<TabsStore, 'tabs' | 'activeTabId'>): ShellTab {
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  if (!tab) throw new Error('The tab store always holds at least one tab');
  return tab;
}

/**
 * `⌘T` / "+": opens a welcome tab, unless the active tab already is one; then its search field
 * gets the focus instead of stacking empty tabs.
 */
export function openNewTab(): void {
  const store = useTabsStore.getState();
  if (selectActiveTab(store).connectionId === null) {
    document.querySelector<HTMLInputElement>('[data-welcome-search]')?.focus();
    return;
  }
  store.newTab();
}

/**
 * Opens a query tab on a connection: in the active tab when it is still a welcome tab, in a new
 * one otherwise.
 */
export function openConnectionTab(connectionId: string): string {
  const store = useTabsStore.getState();
  const active = selectActiveTab(store);
  if (active.connectionId === null) {
    store.setConnection(active.id, connectionId);
    return active.id;
  }
  return store.openQueryTab(connectionId);
}
