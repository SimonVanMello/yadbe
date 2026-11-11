import { create } from 'zustand';

const COLLAPSED_KEY = 'yadbe.library.collapsed';

function loadCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Which folders are folded is a convenience: a blocked storage must not break the view.
  }
}

export type LibraryScope = 'all' | 'connection';

interface LibraryUiStore {
  /** What the filter field holds. */
  text: string;
  scope: LibraryScope;
  /** Folders the user folded (a new folder starts open). */
  collapsed: ReadonlySet<string>;
  /** The built-in snippets section is unfolded. */
  builtinOpen: boolean;
  /** Key of the row selected, `f:<id>` or `q:<id>` (`b:<trigger>` for a built-in). */
  selectedKey: string | null;
  /** Key of the row being renamed in place. */
  renamingKey: string | null;
  setText: (text: string) => void;
  setScope: (scope: LibraryScope) => void;
  setFolded: (folderId: string, folded: boolean) => void;
  setAllFolded: (folderIds: readonly string[], folded: boolean) => void;
  setBuiltinOpen: (open: boolean) => void;
  select: (key: string | null) => void;
  startRename: (key: string | null) => void;
}

/** What the Saved view shows: kept while the sidebar is on another view. */
export const useLibraryUi = create<LibraryUiStore>()((set) => ({
  text: '',
  scope: 'all',
  collapsed: loadCollapsed(),
  builtinOpen: false,
  selectedKey: null,
  renamingKey: null,
  setText: (text) => {
    set({ text });
  },
  setScope: (scope) => {
    set({ scope });
  },
  setFolded: (folderId, folded) => {
    set((state) => {
      const collapsed = new Set(state.collapsed);
      if (folded) collapsed.add(folderId);
      else collapsed.delete(folderId);
      saveCollapsed(collapsed);
      return { collapsed };
    });
  },
  setAllFolded: (folderIds, folded) => {
    set((state) => {
      const collapsed = new Set(state.collapsed);
      for (const id of folderIds) {
        if (folded) collapsed.add(id);
        else collapsed.delete(id);
      }
      saveCollapsed(collapsed);
      return { collapsed };
    });
  },
  setBuiltinOpen: (builtinOpen) => {
    set({ builtinOpen });
  },
  select: (selectedKey) => {
    set({ selectedKey });
  },
  startRename: (renamingKey) => {
    set({ renamingKey });
  },
}));
