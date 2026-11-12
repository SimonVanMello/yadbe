import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLOSED_TABS_KEPT,
  createTabsStore,
  setCloseGuard,
  selectActiveTab,
  toSavedTabs,
  type SavedTabs,
} from './tabsStore';

let store: ReturnType<typeof createTabsStore>;
const state = () => store.getState();
const ids = () => state().tabs.map((tab) => tab.id);
const connections = () => state().tabs.map((tab) => tab.connectionId);

beforeEach(() => {
  store = createTabsStore();
});

describe('opening tabs', () => {
  it('starts with a single welcome tab', () => {
    expect(state().tabs).toHaveLength(1);
    expect(selectActiveTab(state()).connectionId).toBeNull();
  });

  it('opens welcome tabs and query tabs at the end and activates them', () => {
    const query = state().openQueryTab('c1');
    expect(state().activeTabId).toBe(query);
    const welcome = state().newTab();
    expect(state().activeTabId).toBe(welcome);
    expect(connections()).toEqual([null, 'c1', null]);
  });

  it('numbers query tabs in the order they open, never reusing a number', () => {
    state().openQueryTab('c1');
    const second = state().openQueryTab('c1');
    state().openQueryTab('c2');
    state().closeTab(second);
    state().openQueryTab('c1');
    expect(state().tabs.map((tab) => tab.ordinal)).toEqual([0, 1, 3, 4]);
  });

  it('turns a welcome tab into a query tab when it gets a connection', () => {
    const id = state().activeTabId;
    state().setConnection(id, 'c1');
    expect(selectActiveTab(state())).toMatchObject({ connectionId: 'c1', ordinal: 1 });
  });
});

describe('closing tabs', () => {
  it('activates the right neighbor, else the left one', () => {
    const a = state().openQueryTab('c1');
    const b = state().openQueryTab('c1');
    const c = state().openQueryTab('c1');
    state().activate(b);
    state().closeTab(b);
    expect(state().activeTabId).toBe(c);
    state().closeTab(c);
    expect(state().activeTabId).toBe(a);
  });

  it('keeps a welcome tab when the last one closes', () => {
    state().closeTab(state().activeTabId);
    expect(state().tabs).toHaveLength(1);
    expect(selectActiveTab(state()).connectionId).toBeNull();
  });

  it('closes the other and the right-hand tabs but never the pinned ones', () => {
    const a = state().openQueryTab('c1');
    const b = state().openQueryTab('c1');
    state().openQueryTab('c1');
    state().openQueryTab('c1');
    state().setPinned(a, true);
    state().closeOtherTabs(b);
    expect(ids()).toEqual([a, b]);
    state().closeTabsToRight(a);
    expect(ids()).toEqual([a]);
    expect(state().activeTabId).toBe(a);
  });

  it('closes every tab of a deleted connection and forgets them', () => {
    state().openQueryTab('c1');
    state().openQueryTab('c2');
    state().openQueryTab('c1');
    state().closeConnectionTabs('c1');
    expect(connections()).toEqual([null, 'c2']);
    expect(state().closedTabs).toEqual([]);
  });
});

describe('reopening closed tabs', () => {
  it('brings the last closed query tab back where it was, with its number', () => {
    state().openQueryTab('c1');
    const second = state().openQueryTab('c2');
    state().openQueryTab('c1');
    state().closeTab(second);
    const reopened = state().reopenClosedTab();
    expect(reopened).not.toBeNull();
    expect(connections()).toEqual([null, 'c1', 'c2', 'c1']);
    expect(selectActiveTab(state())).toMatchObject({ connectionId: 'c2', ordinal: 2 });
  });

  it('does not remember welcome tabs and caps the stack', () => {
    const welcome = state().newTab();
    state().closeTab(welcome);
    expect(state().reopenClosedTab()).toBeNull();
    for (let i = 0; i < CLOSED_TABS_KEPT + 3; i += 1) state().closeTab(state().openQueryTab('c1'));
    expect(state().closedTabs).toHaveLength(CLOSED_TABS_KEPT);
  });
});

describe('moving and pinning', () => {
  it('reorders tabs', () => {
    const a = state().openQueryTab('c1');
    const b = state().openQueryTab('c1');
    state().moveTab(b, 1);
    expect(ids().slice(1)).toEqual([b, a]);
  });

  it('keeps pinned tabs first and inside their own group', () => {
    const a = state().openQueryTab('c1');
    const b = state().openQueryTab('c1');
    state().setPinned(b, true);
    expect(ids().slice(0, 2)).toEqual([b, state().tabs[1]?.id]);
    state().moveTab(b, 5);
    expect(state().tabs[0]?.id).toBe(b);
    state().moveTab(a, 0);
    expect(state().tabs[0]?.id).toBe(b);
    state().setPinned(b, false);
    expect(state().tabs.some((tab) => tab.pinned)).toBe(false);
  });

  it('never pins a welcome tab', () => {
    state().setPinned(state().activeTabId, true);
    expect(state().tabs[0]?.pinned).toBe(false);
  });
});

describe('keyboard navigation', () => {
  it('selects by position, with 9 meaning the last tab', () => {
    const first = state().tabs[0]?.id;
    for (let i = 0; i < 10; i += 1) state().openQueryTab('c1');
    state().activateIndex(0);
    expect(state().activeTabId).toBe(first);
    state().activateIndex(8);
    expect(state().activeTabId).toBe(state().tabs.at(-1)?.id);
    state().activateIndex(2);
    expect(state().activeTabId).toBe(state().tabs[2]?.id);
  });

  it('cycles in both directions', () => {
    state().openQueryTab('c1');
    state().openQueryTab('c1');
    state().activateRelative(1);
    expect(state().activeTabId).toBe(state().tabs[0]?.id);
    state().activateRelative(-1);
    expect(state().activeTabId).toBe(state().tabs.at(-1)?.id);
  });
});

describe('persistence', () => {
  it('round-trips through the saved shape', () => {
    state().openQueryTab('c1');
    const second = state().openQueryTab('c2');
    state().setPinned(second, true);
    const saved = toSavedTabs(state());

    const restored = createTabsStore();
    restored.getState().hydrate(saved);
    expect(toSavedTabs(restored.getState())).toEqual(saved);
    expect(restored.getState().lastOrdinal).toBe(2);
  });

  it('survives a corrupted save: duplicates, welcome pins, unknown active tab', () => {
    const saved: SavedTabs = {
      tabs: [
        { id: 'a', connectionId: null, ordinal: 4, pinned: true },
        { id: 'a', connectionId: 'c1', ordinal: 1, pinned: false },
        { id: 'b', connectionId: 'c1', ordinal: 2, pinned: true },
      ],
      activeTabId: 'zzz',
    };
    state().hydrate(saved);
    expect(state().tabs).toEqual([
      { id: 'b', connectionId: 'c1', ordinal: 2, pinned: true },
      { id: 'a', connectionId: null, ordinal: 0, pinned: false },
    ]);
    expect(state().activeTabId).toBe('b');
  });

  it('keeps the current tabs when the save is empty', () => {
    const before = ids();
    state().hydrate({ tabs: [], activeTabId: null });
    expect(ids()).toEqual(before);
  });
});

describe('the close guard', () => {
  afterEach(() => {
    setCloseGuard(null);
  });

  it('keeps the tabs when it says no, and closes them when it says yes', () => {
    const a = state().openQueryTab('c1');
    setCloseGuard(() => false);
    state().closeTab(a);
    expect(ids()).toContain(a);
    setCloseGuard(() => true);
    state().closeTab(a);
    expect(ids()).not.toContain(a);
  });

  it('is asked about every tab of a group close', () => {
    const asked: string[][] = [];
    const a = state().openQueryTab('c1');
    const b = state().openQueryTab('c1');
    setCloseGuard((closing) => {
      asked.push([...closing]);
      return true;
    });
    state().closeOtherTabs(a);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(b);
  });

  it('waits for the user when it answers later', async () => {
    const a = state().openQueryTab('c1');
    let answer: (allowed: boolean) => void = () => undefined;
    setCloseGuard(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    state().closeTab(a);
    expect(ids()).toContain(a);
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ids()).not.toContain(a);
  });

  it('does not stop the closing of tabs whose connection was deleted', () => {
    const a = state().openQueryTab('c1');
    setCloseGuard(() => false);
    state().closeConnectionTabs('c1');
    expect(ids()).not.toContain(a);
  });
});

describe('reopening a closed tab', () => {
  it('brings it back under its own id, so what the editor kept for it is found again', () => {
    const a = state().openQueryTab('c1');
    state().closeTab(a);
    expect(state().reopenClosedTab()).toBe(a);
  });

  it('takes a new id when the old one is in use', () => {
    const a = state().openQueryTab('c1');
    state().closeTab(a);
    state().hydrate({
      tabs: [{ id: a, connectionId: 'c2', ordinal: 5, pinned: false }],
      activeTabId: a,
    });
    const reopened = state().reopenClosedTab();
    expect(reopened).not.toBeNull();
    expect(reopened).not.toBe(a);
  });
});

describe('DDL tabs', () => {
  const ORDERS = { database: 'shop', schema: 'sales', name: 'orders' };
  const target = { type: 'object', object: ORDERS, kind: 'table', id: 'orders' } as const;

  it('open once per object, and open again from the same one', () => {
    const first = state().openDdlTab('c1', target);
    state().openQueryTab('c1');
    expect(state().openDdlTab('c1', { ...target })).toBe(first);
    expect(state().activeTabId).toBe(first);
    expect(state().tabs.filter((tab) => tab.ddl)).toHaveLength(1);
    // Another connection, or another object, is another tab.
    expect(state().openDdlTab('c2', target)).not.toBe(first);
    expect(state().openDdlTab('c1', { ...target, id: 'other' })).not.toBe(first);
  });

  it('are not query tabs, are not saved and are not brought back', () => {
    const ddl = state().openDdlTab('c1', target);
    const query = state().openQueryTab('c1');
    expect(toSavedTabs(state()).tabs.map((tab) => tab.id)).toEqual([state().tabs[0]?.id, query]);
    state().closeTab(ddl);
    expect(state().closedTabs).toEqual([]);
    expect(state().reopenClosedTab()).toBeNull();
  });

  it('follow a rename with the table tabs of the object', () => {
    const ddl = state().openDdlTab('c1', target);
    const trigger = state().openDdlTab('c1', { type: 'trigger', table: ORDERS, name: 'touch' });
    const rows = state().openTableTab('c1', ORDERS);
    const elsewhere = state().openTableTab('c2', ORDERS);
    const moved = state().renameObject('c1', ORDERS, { ...ORDERS, name: 'purchases' });
    expect(moved).toEqual([rows]);
    const tab = (id: string) => state().tabs.find((t) => t.id === id);
    expect(tab(rows)?.table?.name).toBe('purchases');
    expect(tab(ddl)?.ddl).toMatchObject({ object: { name: 'purchases' }, id: 'purchases' });
    expect(tab(trigger)?.ddl).toMatchObject({ table: { name: 'purchases' }, name: 'touch' });
    expect(tab(elsewhere)?.table?.name).toBe('orders');
  });
});
