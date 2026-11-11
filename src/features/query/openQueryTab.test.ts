import { beforeEach, describe, expect, it } from 'vitest';

import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { registerEditor, type EditorController } from './editorRegistry';
import { insertIntoActiveEditor, openQueryTab } from './openQueryTab';
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

function controller(inserted: string[]): EditorController {
  return {
    focus: () => undefined,
    jumpTo: () => undefined,
    markRunStart: () => undefined,
    setErrors: () => undefined,
    replaceContent: () => undefined,
    insertSnippet: () => undefined,
    insertAtCursor: (text) => {
      inserted.push(text);
    },
  };
}

describe('openQueryTab without reusing the welcome tab (the History panel)', () => {
  it('opens a new active tab on the connection with the text and database already set', () => {
    const tabId = openQueryTab({
      connectionId: 'conn-1',
      database: 'sales',
      initialText: 'select 1',
      reuseWelcomeTab: false,
    });
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs).toHaveLength(2);
    expect(activeTabId).toBe(tabId);
    expect(tabs.find((tab) => tab.id === tabId)?.connectionId).toBe('conn-1');
    const editor = useQueryTabStore.getState().tabs[tabId];
    expect(editor).toMatchObject({ content: 'select 1', database: 'sales' });
    expect(editor?.selection).toEqual({ anchor: 8, head: 8 });
  });
});

describe('insertIntoActiveEditor', () => {
  it('does nothing on a tab without connection, or whose editor is not mounted', () => {
    expect(insertIntoActiveEditor('select 1')).toBe(false);
    openQueryTab({ connectionId: 'conn-1', reuseWelcomeTab: false });
    expect(insertIntoActiveEditor('select 1')).toBe(false);
  });

  it('hands the text to the editor of the active tab', () => {
    const inserted: string[] = [];
    const tabId = openQueryTab({ connectionId: 'conn-1', reuseWelcomeTab: false });
    const unregister = registerEditor(tabId, controller(inserted));
    expect(insertIntoActiveEditor('select 2')).toBe(true);
    expect(inserted).toEqual(['select 2']);
    unregister();
  });
});
