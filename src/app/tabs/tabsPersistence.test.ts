import { describe, expect, it } from 'vitest';

import type { SavedTab } from '../../ipc';
import { fromBackendTabs, tablesFromBackendTabs, toBackendTabs } from './tabsPersistence';

const title = (ordinal: number) => `Query ${String(ordinal)}`;

function backendTab(patch: Partial<SavedTab>): SavedTab {
  return {
    id: 'a',
    kind: 'query',
    title: '',
    connectionId: null,
    database: null,
    content: '',
    cursor: null,
    pinned: false,
    filePath: null,
    table: null,
    uiState: null,
    ...patch,
  };
}

describe('saved tabs', () => {
  it('round-trips through the backend shape', () => {
    const saved = {
      tabs: [
        { id: 'a', connectionId: 'c1', ordinal: 2, pinned: true },
        { id: 'b', connectionId: null, ordinal: 0, pinned: false },
      ],
      activeTabId: 'a',
    };
    expect(fromBackendTabs(toBackendTabs(saved, title))).toEqual(saved);
  });

  it('saves a table tab with its table and view, never its pending changes', () => {
    const table = { database: 'shop', schema: 'shop', name: 'orders' };
    const saved = {
      tabs: [
        { id: 'q', connectionId: 'c1', ordinal: 1, pinned: false },
        { id: 't', connectionId: 'c1', ordinal: 0, pinned: true, table },
      ],
      activeTabId: 't',
    };
    const view = {
      filter: {
        chips: [{ column: 'status', op: 'eq' as const, values: ['paid'] }],
        rawWhere: 'total > 1',
      },
      sort: [{ column: 'id', direction: 'desc' as const }],
      pageSize: 1000,
      layout: { widths: { note: 240 }, order: ['note', 'id'] },
    };
    const backend = toBackendTabs(saved, title, {}, { t: view });
    const tab = backend.tabs[1];
    expect(tab).toMatchObject({
      kind: 'table',
      title: 'orders',
      database: 'shop',
      table: { schema: 'shop', name: 'orders' },
      content: '',
    });
    expect(fromBackendTabs(backend)).toEqual(saved);
    expect(tablesFromBackendTabs(backend)).toEqual({ t: view });
  });

  it('drops a table tab saved without its table', () => {
    const state = {
      tabs: [backendTab({ id: 't', kind: 'table', connectionId: 'c1', database: 'shop' })],
      activeTabId: 't',
    };
    expect(fromBackendTabs(state)).toBeNull();
  });

  it('names a query tab and leaves a welcome tab unnamed', () => {
    const backend = toBackendTabs(
      {
        tabs: [
          { id: 'a', connectionId: 'c1', ordinal: 3, pinned: false },
          { id: 'b', connectionId: null, ordinal: 0, pinned: false },
        ],
        activeTabId: null,
      },
      title,
    );
    expect(backend.tabs.map((tab) => [tab.title, tab.kind, tab.content])).toEqual([
      ['Query 3', 'query', ''],
      ['', 'query', ''],
    ]);
  });

  it('has nothing to restore for an empty save', () => {
    expect(fromBackendTabs({ tabs: [], activeTabId: null })).toBeNull();
  });

  it('ignores other kinds of tabs', () => {
    const state = { tabs: [backendTab({ kind: 'table' })], activeTabId: null };
    expect(fromBackendTabs(state)).toBeNull();
  });

  it('numbers a bound tab saved without a number, after the known ones, and survives bad state', () => {
    const restored = fromBackendTabs({
      tabs: [
        backendTab({ id: 'a', connectionId: 'c1', uiState: '{"ordinal":4}' }),
        backendTab({ id: 'b', connectionId: 'c1', uiState: 'nope' }),
        backendTab({ id: 'c', connectionId: 'c1', uiState: '{"ordinal":-1}' }),
        backendTab({ id: 'd', connectionId: null, uiState: '{"ordinal":9}' }),
      ],
      activeTabId: 'b',
    });
    expect(restored?.tabs.map((tab) => [tab.id, tab.ordinal])).toEqual([
      ['a', 4],
      ['b', 10],
      ['c', 11],
      ['d', 0],
    ]);
    expect(restored?.activeTabId).toBe('b');
  });

  it('saves a key tab as a table tab named after its key and restores it as a key tab', () => {
    const tool = { type: 'kvKey' as const, database: 2, key: { text: 'user:1', base64: null } };
    const saved = {
      tabs: [{ id: 'k', connectionId: 'c1', ordinal: 0, pinned: false, tool }],
      activeTabId: 'k',
    };
    const backend = toBackendTabs(saved, title);
    expect(backend.tabs[0]).toMatchObject({ kind: 'table', title: 'user:1', database: '2' });
    expect(fromBackendTabs(backend)).toEqual(saved);
    expect(tablesFromBackendTabs(backend)).toEqual({});
  });

  it('saves the query of a collection or index tab in the table tab state', () => {
    const table = { database: 'shop', schema: null, name: 'orders' };
    const family = {
      collection: {
        applied: { filter: '{"a":1}', projection: '', sort: '' },
        pageSize: 50,
        view: 'documents' as const,
      },
    };
    const backend = toBackendTabs(
      {
        tabs: [{ id: 't', connectionId: 'c1', ordinal: 0, pinned: false, table }],
        activeTabId: 't',
      },
      title,
      {},
      {},
      { t: family },
    );
    expect(JSON.parse(backend.tabs[0]?.uiState ?? '{}')).toMatchObject(family);
  });
});
