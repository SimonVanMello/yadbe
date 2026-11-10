import { create } from 'zustand';

import { EMPTY_FILTERS, type HistoryFilters } from './historyModel';

interface HistoryUiStore {
  filters: HistoryFilters;
  /** The filter fields (everything but the search box) are unfolded. */
  filtersOpen: boolean;
  selectedId: number | null;
  patchFilters: (patch: Partial<HistoryFilters>) => void;
  resetFilters: () => void;
  setFiltersOpen: (open: boolean) => void;
  select: (id: number | null) => void;
}

/** What the History panel shows: kept while the sidebar is on another view. */
export const useHistoryUi = create<HistoryUiStore>()((set) => ({
  filters: EMPTY_FILTERS,
  filtersOpen: false,
  selectedId: null,
  patchFilters: (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch }, selectedId: null }));
  },
  resetFilters: () => {
    set({ filters: EMPTY_FILTERS, selectedId: null });
  },
  setFiltersOpen: (filtersOpen) => {
    set({ filtersOpen });
  },
  select: (selectedId) => {
    set({ selectedId });
  },
}));
