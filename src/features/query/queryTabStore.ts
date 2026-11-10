import { create } from 'zustand';

import type { CursorPosition } from '../../ipc';

/**
 * The editor side of a query tab: what the user typed and where they were (F-044), the database
 * the tab runs in (F-046) and the `.sql` file it is bound to (F-045). The shell's `tabsStore`
 * keeps the tab itself (order, pinning, connection); this store holds what changes on every
 * keystroke, so the tab strip does not re-render while typing.
 */
export interface QueryTabState {
  content: string;
  /**
   * The text the tab had when it was last loaded from or saved to its file (`''` for a tab that
   * never was). `null`: unknown, because the tab was restored with unsaved changes: dirty until
   * saved.
   */
  savedContent: string | null;
  /** Hash of the file's text as last read or written, to notice external changes. */
  fileHash: string | null;
  selection: CursorPosition;
  scrollTop: number;
  scrollLeft: number;
  /** `null`: the connection's own database. */
  database: string | null;
  filePath: string | null;
}

export function newQueryTabState(): QueryTabState {
  return {
    content: '',
    savedContent: '',
    fileHash: null,
    selection: { anchor: 0, head: 0 },
    scrollTop: 0,
    scrollLeft: 0,
    database: null,
    filePath: null,
  };
}

/** Fast non-cryptographic hash (cyrb53), with the length: enough to tell two texts apart. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const mixed = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${mixed.toString(36)}-${text.length.toString(36)}`;
}

export function isDirty(state: QueryTabState): boolean {
  return state.savedContent === null || state.content !== state.savedContent;
}

/** File name of a path, for the tab title. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

interface QueryTabStore {
  tabs: Record<string, QueryTabState>;
  /** Registers a tab with its saved state, or empty. Does nothing when it already exists. */
  ensure: (tabId: string, initial?: QueryTabState) => void;
  /** Replaces every tab (startup restoration). */
  hydrate: (tabs: Record<string, QueryTabState>) => void;
  setContent: (tabId: string, content: string) => void;
  setSelection: (tabId: string, selection: CursorPosition) => void;
  setScroll: (tabId: string, top: number, left: number) => void;
  setDatabase: (tabId: string, database: string | null) => void;
  /** Binds the tab to a file whose text is `content` (open, or the file read again). */
  loadFile: (tabId: string, path: string, content: string) => void;
  /** The tab's text was written to `path` (save, save as). */
  markSaved: (tabId: string, path: string, content: string) => void;
  /** The user kept their text over a change of the file: that change is acknowledged. */
  setFileHash: (tabId: string, fileHash: string) => void;
  /** The file is gone or the user detached the tab from it: the tab keeps its text. */
  detachFile: (tabId: string) => void;
  remove: (tabId: string) => void;
}

function update(
  tabId: string,
  change: (state: QueryTabState) => QueryTabState | null,
): (store: QueryTabStore) => QueryTabStore | Partial<QueryTabStore> {
  return (store) => {
    const current = store.tabs[tabId] ?? newQueryTabState();
    const next = change(current);
    return next === null ? store : { tabs: { ...store.tabs, [tabId]: next } };
  };
}

export function createQueryTabStore() {
  return create<QueryTabStore>()((set) => ({
    tabs: {},

    ensure: (tabId, initial) => {
      set((store) =>
        tabId in store.tabs
          ? store
          : { tabs: { ...store.tabs, [tabId]: initial ?? newQueryTabState() } },
      );
    },

    hydrate: (tabs) => {
      set({ tabs });
    },

    setContent: (tabId, content) => {
      set(update(tabId, (state) => (state.content === content ? null : { ...state, content })));
    },

    setSelection: (tabId, selection) => {
      set(
        update(tabId, (state) =>
          state.selection.anchor === selection.anchor && state.selection.head === selection.head
            ? null
            : { ...state, selection },
        ),
      );
    },

    setScroll: (tabId, scrollTop, scrollLeft) => {
      set(
        update(tabId, (state) =>
          state.scrollTop === scrollTop && state.scrollLeft === scrollLeft
            ? null
            : { ...state, scrollTop, scrollLeft },
        ),
      );
    },

    setDatabase: (tabId, database) => {
      set(update(tabId, (state) => (state.database === database ? null : { ...state, database })));
    },

    loadFile: (tabId, filePath, content) => {
      set(
        update(tabId, (state) => ({
          ...state,
          content,
          savedContent: content,
          fileHash: hashText(content),
          filePath,
          selection: { anchor: 0, head: 0 },
          scrollTop: 0,
          scrollLeft: 0,
        })),
      );
    },

    markSaved: (tabId, filePath, content) => {
      set(
        update(tabId, (state) => ({
          ...state,
          filePath,
          savedContent: content,
          fileHash: hashText(content),
        })),
      );
    },

    setFileHash: (tabId, fileHash) => {
      set(update(tabId, (state) => ({ ...state, fileHash })));
    },

    detachFile: (tabId) => {
      set(
        update(tabId, (state) => ({ ...state, filePath: null, fileHash: null, savedContent: '' })),
      );
    },

    remove: (tabId) => {
      set((store) => {
        if (!(tabId in store.tabs)) return store;
        return {
          tabs: Object.fromEntries(Object.entries(store.tabs).filter(([id]) => id !== tabId)),
        };
      });
    },
  }));
}

export const useQueryTabStore = createQueryTabStore();

const EMPTY = newQueryTabState();

/** The editor state of a tab (empty for a tab that has none yet). */
export function getQueryTabState(tabId: string): QueryTabState {
  return useQueryTabStore.getState().tabs[tabId] ?? EMPTY;
}

export function useQueryTabState(tabId: string): QueryTabState {
  return useQueryTabStore((store) => store.tabs[tabId] ?? EMPTY);
}

export function useIsDirty(tabId: string): boolean {
  return useQueryTabStore((store) => {
    const state = store.tabs[tabId];
    return state !== undefined && isDirty(state);
  });
}

/** File name of the script a tab is bound to, `null` for a tab that has none. */
export function useTabFileName(tabId: string): string | null {
  return useQueryTabStore((store) => {
    const path = store.tabs[tabId]?.filePath;
    return path ? fileNameOf(path) : null;
  });
}
