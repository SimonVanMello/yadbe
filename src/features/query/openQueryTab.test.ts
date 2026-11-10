import { beforeEach, describe, expect, it } from 'vitest';

import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { openQueryTab } from './openQueryTab';
import { getQueryTabState, useQueryTabStore } from './queryTabStore';

beforeEach(() => {
  const id = useTabsStore.getState().newTab();
  useTabsStore.setState((state) => ({
    tabs: state.tabs.filter((tab) => tab.id === id),
    activeTabId: id,
    closedTabs: [],
    lastOrdinal: 0,
  }));
  useQueryTabStore.setState({ tabs: {} });
});

describe('openQueryTab (the explorer opens tabs through it)', () => {
  it('turns the active welcome tab into a query tab aimed at a database, holding the text', () => {
    const id = openQueryTab({ connectionId: 'c1', database: 'shop', initialText: 'SELECT 1;' });
    expect(selectActiveTab(useTabsStore.getState())).toMatchObject({ id, connectionId: 'c1' });
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(getQueryTabState(id)).toMatchObject({
      content: 'SELECT 1;',
      database: 'shop',
      selection: { anchor: 9, head: 9 },
    });
  });

  it('opens a new tab when the active one already is a query tab', () => {
    useTabsStore.getState().openQueryTab('c1');
    const id = openQueryTab({ connectionId: 'c1' });
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs).toHaveLength(3);
    expect(activeTabId).toBe(id);
    expect(getQueryTabState(id)).toMatchObject({ content: '', database: null });
  });
});
