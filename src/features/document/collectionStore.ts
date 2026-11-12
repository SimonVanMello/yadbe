import { create } from 'zustand';

import type { CollectionInfo, CollectionPage, YadbeError } from '../../ipc';

/** How a document result is shown: the grid of its top-level fields, or the documents. */
export type DocumentViewMode = 'grid' | 'documents';

/** The query fields of a collection tab, as typed (Extended JSON; empty: none). */
export interface QueryFields {
  filter: string;
  projection: string;
  sort: string;
}

export const EMPTY_QUERY: QueryFields = { filter: '', projection: '', sort: '' };
export const PAGE_SIZES = [50, 100, 500, 1000] as const;
export const DEFAULT_PAGE_SIZE = 100;

/** A collection tab (F-080 for documents): its collection, query, page and counts. */
export interface CollectionTabState {
  phase: 'idle' | 'opening' | 'ready' | 'error';
  info: CollectionInfo | null;
  /** What the fields hold now. */
  draft: QueryFields;
  /** What the page shown was read with. */
  applied: QueryFields;
  pageSize: number;
  page: CollectionPage | null;
  /** A page is being read. */
  loading: boolean;
  /** An exact count is running. */
  counting: boolean;
  /** Exact count of `applied.filter`, once asked. */
  exactCount: number | null;
  error: YadbeError | null;
  view: DocumentViewMode;
}

export function newCollectionTab(): CollectionTabState {
  return {
    phase: 'idle',
    info: null,
    draft: EMPTY_QUERY,
    applied: EMPTY_QUERY,
    pageSize: DEFAULT_PAGE_SIZE,
    page: null,
    loading: false,
    counting: false,
    exactCount: null,
    error: null,
    view: 'grid',
  };
}

interface CollectionStore {
  tabs: Record<string, CollectionTabState>;
  patch: (tabId: string, patch: Partial<CollectionTabState>) => void;
  remove: (tabId: string) => void;
}

export const useCollectionStore = create<CollectionStore>((set) => ({
  tabs: {},
  patch: (tabId, patch) => {
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? newCollectionTab()), ...patch } },
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

const FRESH = newCollectionTab();

export function getCollectionTab(tabId: string): CollectionTabState {
  return useCollectionStore.getState().tabs[tabId] ?? FRESH;
}

export function useCollectionTab(tabId: string): CollectionTabState {
  return useCollectionStore((state) => state.tabs[tabId] ?? FRESH);
}
