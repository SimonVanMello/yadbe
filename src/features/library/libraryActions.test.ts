import { beforeEach, describe, expect, it } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap } from '../../ipc';
import { MOCK_CONNECTIONS, MOCK_GROUPS } from '../../ipc/mockData';
import { mockBackend } from '../../ipc/mockClient';
import { useToastStore } from '../../ui/toastStore';
import { connectionKeys } from '../connections/connectionStore';
import { registerEditor, type EditorController } from '../query/editorRegistry';
import { getQueryTabState, useQueryTabStore } from '../query/queryTabStore';
import { insertSaved, openSaved, saveEditorToLibrary, updateSavedFromTab } from './libraryActions';
import { useSaveDialog } from './saveDialogStore';

const PG = 'conn-local-pg';

async function savedByName(name: string) {
  const { queries } = await unwrap(ipc.commands.listSavedQueries());
  const found = queries.find((query) => query.name === name);
  if (!found) throw new Error(`no seeded query named ${name}`);
  return found;
}

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  queryClient.clear();
  queryClient.setQueryData(connectionKeys.all, {
    connections: MOCK_CONNECTIONS,
    groups: MOCK_GROUPS,
  });
  const id = useTabsStore.getState().openQueryTab(PG);
  useTabsStore.setState((state) => ({
    tabs: state.tabs.filter((tab) => tab.id === id),
    activeTabId: id,
    closedTabs: [],
    lastOrdinal: 1,
  }));
  useQueryTabStore.setState({ tabs: {} });
  useSaveDialog.getState().close();
  useToastStore.setState({ toasts: [] });
});

describe('opening a saved query', () => {
  it('opens a new tab on the active connection holding its text, linked to the query', async () => {
    const query = await savedByName('Revenue per month');
    const before = selectActiveTab(useTabsStore.getState()).id;
    const tabId = await openSaved(query);
    expect(tabId).not.toBeNull();
    expect(tabId).not.toBe(before);
    expect(selectActiveTab(useTabsStore.getState())).toMatchObject({ id: tabId, connectionId: PG });
    const state = getQueryTabState(tabId ?? '');
    expect(state.content).toContain('date_trunc');
    expect(state.origin).toEqual({ queryId: query.id, baseline: state.content });
  });

  it('opens a query bound to a connection on that connection, whatever tab is active', async () => {
    const query = await savedByName('Stock below threshold');
    const tabId = await openSaved(query);
    expect(selectActiveTab(useTabsStore.getState())).toMatchObject({
      id: tabId,
      connectionId: 'conn-reporting',
    });
  });

  it('opens a snippet as what its fields resolve to, not linked to the template', async () => {
    const query = await savedByName('Last rows of a table');
    const tabId = await openSaved(query);
    const state = getQueryTabState(tabId ?? '');
    expect(state.content).toBe('SELECT *\nFROM table\nORDER BY id DESC\nLIMIT 50;');
    expect(state.origin).toBeNull();
  });

  it('says so when there is no connection to run it on', async () => {
    useTabsStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, connectionId: null })),
    }));
    const query = await savedByName('Revenue per month');
    expect(await openSaved(query)).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.variant).toBe('warning');
  });

  it('notes the use of the query', async () => {
    const query = await savedByName('Revenue per month');
    const before = query.lastUsedAt;
    await openSaved(query);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await savedByName('Revenue per month');
    expect(after.lastUsedAt).not.toBe(before);
  });
});

describe('inserting a saved query', () => {
  function editorSpy() {
    const calls: { kind: string; text: string }[] = [];
    const controller: EditorController = {
      focus: () => undefined,
      jumpTo: () => undefined,
      markRunStart: () => undefined,
      setErrors: () => undefined,
      replaceContent: () => undefined,
      insertAtCursor: (text) => {
        calls.push({ kind: 'text', text });
      },
      format: () => false,
      definitionAtCursor: () => Promise.resolve(false),
      insertSnippet: (text) => {
        calls.push({ kind: 'snippet', text });
      },
    };
    const tab = selectActiveTab(useTabsStore.getState());
    return { calls, off: registerEditor(tab.id, controller) };
  }

  it('inserts the text of a plain query as it is', async () => {
    const { calls, off } = editorSpy();
    await insertSaved(await savedByName('Duplicate emails'));
    off();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('text');
    expect(calls[0]?.text).toContain('HAVING count(*) > 1');
  });

  it('starts a snippet session for a snippet, variables resolved, fields left to the editor', async () => {
    const { calls, off } = editorSpy();
    await insertSaved(await savedByName('Rows created today'));
    off();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('snippet');
    expect(calls[0]?.text).toMatch(/created_at >= '\d{4}-\d{2}-\d{2}'/);
    expect(calls[0]?.text).toContain('${1:table}');
  });

  it('tells the user when there is no editor to insert into', async () => {
    await insertSaved(await savedByName('Duplicate emails'));
    expect(useToastStore.getState().toasts.at(-1)?.variant).toBe('info');
  });
});

describe('saving from an editor', () => {
  it('opens the dialog with the selection, or the whole tab when nothing is selected', () => {
    const tab = selectActiveTab(useTabsStore.getState());
    useQueryTabStore.getState().ensure(tab.id, {
      ...getQueryTabState(tab.id),
      content: 'select 1;\nselect 2;',
      selection: { anchor: 10, head: 19 },
      database: 'shop',
    });
    expect(saveEditorToLibrary(tab.id)).toBe(true);
    expect(useSaveDialog.getState().request).toMatchObject({
      mode: 'create',
      sql: 'select 2;',
      selectionOnly: true,
      connectionId: PG,
      database: 'shop',
      tabId: tab.id,
    });
    useQueryTabStore.getState().setSelection(tab.id, { anchor: 3, head: 3 });
    saveEditorToLibrary(tab.id);
    expect(useSaveDialog.getState().request).toMatchObject({
      sql: 'select 1;\nselect 2;',
      selectionOnly: false,
    });
  });

  it('does not open the dialog for an empty editor, and says why', () => {
    const tab = selectActiveTab(useTabsStore.getState());
    useQueryTabStore.getState().ensure(tab.id, { ...getQueryTabState(tab.id), content: '  \n' });
    expect(saveEditorToLibrary(tab.id)).toBe(true);
    expect(useSaveDialog.getState().request).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('is not for a tab without a connection', () => {
    expect(saveEditorToLibrary('nope')).toBe(false);
  });
});

describe('updating the saved query of a tab', () => {
  it('writes the text over the query and the tab is in sync again', async () => {
    const query = await savedByName('Revenue per month');
    const tabId = (await openSaved(query)) ?? '';
    useQueryTabStore.getState().setContent(tabId, 'SELECT 1;');
    expect(await updateSavedFromTab(tabId)).toBe(true);
    const whole = await unwrap(ipc.commands.getSavedQuery(query.id));
    expect(whole?.sql).toBe('SELECT 1;');
    // Its other fields are untouched.
    expect(whole).toMatchObject({ name: query.name, tags: query.tags, folderId: query.folderId });
    expect(getQueryTabState(tabId).origin).toEqual({ queryId: query.id, baseline: 'SELECT 1;' });
  });

  it('reports a query deleted meanwhile and unlinks the tab', async () => {
    const query = await savedByName('Revenue per month');
    const tabId = (await openSaved(query)) ?? '';
    await unwrap(ipc.commands.deleteSavedQuery(query.id));
    await updateSavedFromTab(tabId);
    expect(getQueryTabState(tabId).origin).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.variant).toBe('warning');
  });

  it('does nothing for a tab that was not opened from a saved query', async () => {
    const tab = selectActiveTab(useTabsStore.getState());
    expect(await updateSavedFromTab(tab.id)).toBe(false);
  });
});
