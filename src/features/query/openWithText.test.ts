import { beforeEach, describe, expect, it } from 'vitest';

import { createTabsStore, useTabsStore } from '../../app/tabs/tabsStore';
import { registerEditor, type EditorController } from './editorRegistry';
import { insertIntoActiveEditor, openQueryTabWithText } from './openWithText';
import { useQueryTabStore } from './queryTabStore';

beforeEach(() => {
  const { tabs, activeTabId, closedTabs, lastOrdinal } = createTabsStore().getState();
  useTabsStore.setState({ tabs, activeTabId, closedTabs, lastOrdinal });
  useQueryTabStore.setState({ tabs: {} });
});

function controller(inserted: string[]): EditorController {
  return {
    focus: () => undefined,
    jumpTo: () => undefined,
    markRunStart: () => undefined,
    setErrors: () => undefined,
    replaceContent: () => undefined,
    insertAtCursor: (text) => {
      inserted.push(text);
    },
  };
}

describe('openQueryTabWithText', () => {
  it('opens an active tab on the connection with the text and database already set', () => {
    const tabId = openQueryTabWithText({
      connectionId: 'conn-1',
      database: 'sales',
      text: 'select 1',
    });
    const { tabs, activeTabId } = useTabsStore.getState();
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
    openQueryTabWithText({ connectionId: 'conn-1', database: null, text: '' });
    expect(insertIntoActiveEditor('select 1')).toBe(false);
  });

  it('hands the text to the editor of the active tab', () => {
    const inserted: string[] = [];
    const tabId = openQueryTabWithText({ connectionId: 'conn-1', database: null, text: '' });
    const unregister = registerEditor(tabId, controller(inserted));
    expect(insertIntoActiveEditor('select 2')).toBe(true);
    expect(inserted).toEqual(['select 2']);
    unregister();
  });
});
