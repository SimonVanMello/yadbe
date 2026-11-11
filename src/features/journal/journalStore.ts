import { create } from 'zustand';

import type { ObjectRef } from '../../ipc';
import { useSidebarView } from '../sidebar/sidebarViewStore';
import { EMPTY_JOURNAL_FILTERS, type JournalFilters } from './journalModel';

interface JournalUiStore {
  filters: JournalFilters;
  selectedId: number | null;
  patchFilters: (patch: Partial<JournalFilters>) => void;
  resetFilters: () => void;
  select: (id: number | null) => void;
}

/** What the Journal view shows: kept while the sidebar is on another view. */
export const useJournalUi = create<JournalUiStore>()((set) => ({
  filters: EMPTY_JOURNAL_FILTERS,
  selectedId: null,
  patchFilters: (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch }, selectedId: null }));
  },
  resetFilters: () => {
    set({ filters: EMPTY_JOURNAL_FILTERS, selectedId: null });
  },
  select: (selectedId) => {
    set({ selectedId });
  },
}));

/** Shows the Journal view with one entry selected (the toast after an apply). */
export function showJournalEntry(id: number): void {
  useJournalUi.setState({ filters: EMPTY_JOURNAL_FILTERS, selectedId: id });
  useSidebarView.getState().setView('journal');
}

/** Shows the Journal view on the change sets of one table (a table tab's menu). */
export function showTableJournal(connectionId: string, table: ObjectRef): void {
  useJournalUi.setState({
    filters: { ...EMPTY_JOURNAL_FILTERS, connectionId, table },
    selectedId: null,
  });
  useSidebarView.getState().setView('journal');
}
