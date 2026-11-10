import { beforeEach, describe, expect, it } from 'vitest';

import { openQueryTabWith, selectActiveTab, useTabsStore } from './tabsStore';

beforeEach(() => {
  const id = useTabsStore.getState().newTab();
  useTabsStore.setState((state) => ({
    tabs: state.tabs.filter((tab) => tab.id === id),
    activeTabId: id,
    closedTabs: [],
    lastOrdinal: 0,
  }));
});

describe('openQueryTabWith (the explorer opens tabs through it)', () => {
  it('turns the active welcome tab into a query tab aimed at a database, holding the text', () => {
    const id = openQueryTabWith({
      connectionId: 'c1',
      database: 'shop',
      initialText: 'SELECT 1;',
    });
    const tab = selectActiveTab(useTabsStore.getState());
    expect(tab).toMatchObject({
      id,
      connectionId: 'c1',
      database: 'shop',
      initialText: 'SELECT 1;',
    });
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it('opens a new tab when the active one already is a query tab', () => {
    useTabsStore.getState().openQueryTab('c1');
    const id = openQueryTabWith({ connectionId: 'c1', database: null });
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs).toHaveLength(3);
    expect(activeTabId).toBe(id);
    expect(selectActiveTab(useTabsStore.getState())).toMatchObject({
      database: null,
      initialText: null,
    });
  });
});
