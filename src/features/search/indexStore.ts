import { create } from 'zustand';

import type { IndexPage, IndexQueryMode, IndexTabInfo, YadbeError } from '../../ipc';

/** How hits are shown: the grid of their fields, or the hits as documents. */
export type HitsView = 'grid' | 'documents';

/** The query fields of an index tab, as typed. */
export interface IndexQueryFields {
  mode: IndexQueryMode;
  /** Query DSL JSON, or a query string; empty: every document. */
  text: string;
  /** `_source` filtering: `a, b.*, -c`. */
  source: string;
  /** The field pages are sorted on; empty: index order (or score with a query). */
  sortField: string;
  descending: boolean;
}

export const EMPTY_INDEX_QUERY: IndexQueryFields = {
  mode: 'queryString',
  text: '',
  source: '',
  sortField: '',
  descending: false,
};
export const INDEX_PAGE_SIZES = [50, 100, 500, 1000] as const;
export const DEFAULT_INDEX_PAGE_SIZE = 100;

/** An index tab (F-080 for search): its target, query, page and counts. */
export interface IndexTabState {
  phase: 'idle' | 'opening' | 'ready' | 'error';
  info: IndexTabInfo | null;
  draft: IndexQueryFields;
  /** What the page shown was read with. */
  applied: IndexQueryFields;
  pageSize: number;
  page: IndexPage | null;
  loading: boolean;
  counting: boolean;
  /** Exact count of the applied query, once asked. */
  exactCount: number | null;
  error: YadbeError | null;
  view: HitsView;
}

export function newIndexTab(): IndexTabState {
  return {
    phase: 'idle',
    info: null,
    draft: EMPTY_INDEX_QUERY,
    applied: EMPTY_INDEX_QUERY,
    pageSize: DEFAULT_INDEX_PAGE_SIZE,
    page: null,
    loading: false,
    counting: false,
    exactCount: null,
    error: null,
    view: 'grid',
  };
}

interface IndexStore {
  tabs: Record<string, IndexTabState>;
  patch: (tabId: string, patch: Partial<IndexTabState>) => void;
  remove: (tabId: string) => void;
}

export const useIndexStore = create<IndexStore>((set) => ({
  tabs: {},
  patch: (tabId, patch) => {
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? newIndexTab()), ...patch } },
    }));
  },
  remove: (tabId) => {
    set((state) => {
      if (!(tabId in state.tabs)) return state;
      return {
        tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)),
      };
    });
  },
}));

const FRESH = newIndexTab();

export function getIndexTab(tabId: string): IndexTabState {
  return useIndexStore.getState().tabs[tabId] ?? FRESH;
}

export function useIndexTab(tabId: string): IndexTabState {
  return useIndexStore((state) => state.tabs[tabId] ?? FRESH);
}
