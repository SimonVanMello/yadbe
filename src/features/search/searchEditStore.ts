import { create } from 'zustand';

import type {
  SearchApplyOutcome,
  SearchChangeSet,
  SearchEditInfo,
  SearchEditPreview,
  SeqGuard,
  YadbeError,
} from '../../ipc';
import type { PendingDoc } from './searchEditModel';

/** The document edits of one index tab. */
export interface SearchEditTab {
  /** What the tab's target allows (`null` until read). */
  info: SearchEditInfo | null;
  pending: PendingDoc[];
}

/** The document editor (one at a time). */
export interface DocEditor {
  tabId: string;
  connectionId: string;
  /** `edit`: replaces the document; `create`: a new one (add, duplicate). */
  mode: 'edit' | 'create';
  index: string;
  /** Editing: the document's id; creating: the id typed (empty: the server picks one). */
  id: string;
  routing: string;
  text: string;
  /** The version the text was read at (editing). */
  guard: SeqGuard | null;
  /** The document changed since the page was read: the editor holds the current version. */
  changedSince: boolean;
  loading: boolean;
  error: YadbeError | null;
}

/** The apply dialog: the pending edits of a tab, or the revert of a journal entry. */
export interface SearchApplyDialog {
  source: { kind: 'tab'; tabId: string } | { kind: 'revert'; entryId: number };
  connectionId: string;
  changes: SearchChangeSet;
  status: 'loading' | 'ready' | 'applying' | 'done' | 'failed';
  preview: SearchEditPreview | null;
  outcome: SearchApplyOutcome | null;
  error: YadbeError | null;
}

const EMPTY: SearchEditTab = { info: null, pending: [] };

interface SearchEditStore {
  tabs: Readonly<Record<string, SearchEditTab>>;
  editor: DocEditor | null;
  dialog: SearchApplyDialog | null;
  patchTab: (tabId: string, patch: Partial<SearchEditTab>) => void;
  forget: (tabId: string) => void;
}

export const useSearchEditStore = create<SearchEditStore>()((set) => ({
  tabs: {},
  editor: null,
  dialog: null,
  patchTab: (tabId, patch) => {
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? EMPTY), ...patch } },
    }));
  },
  forget: (tabId) => {
    set((state) =>
      tabId in state.tabs
        ? { tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)) }
        : state,
    );
  },
}));

export function getSearchEditTab(tabId: string): SearchEditTab {
  return useSearchEditStore.getState().tabs[tabId] ?? EMPTY;
}

export function useSearchEditTab(tabId: string): SearchEditTab {
  return useSearchEditStore((state) => state.tabs[tabId] ?? EMPTY);
}

export function patchEditor(patch: Partial<DocEditor>): void {
  const editor = useSearchEditStore.getState().editor;
  if (editor) useSearchEditStore.setState({ editor: { ...editor, ...patch } });
}

export function patchApplyDialog(patch: Partial<SearchApplyDialog>): void {
  const dialog = useSearchEditStore.getState().dialog;
  if (dialog) useSearchEditStore.setState({ dialog: { ...dialog, ...patch } });
}
