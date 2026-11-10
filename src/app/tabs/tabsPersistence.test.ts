import { describe, expect, it } from 'vitest';

import type { SavedTab } from '../../ipc';
import { fromBackendTabs, toBackendTabs } from './tabsPersistence';

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
});
