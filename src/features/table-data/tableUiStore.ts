import { create } from 'zustand';

import { loadUiSlice, saveUiSlice } from '../../app/backendPreferences';

/** Table tab preferences shared by every tab and remembered (`uiState`, slice `tableData`). */
export interface TableUiState {
  /**
   * Show the SQL before applying changes (F-085). On by default; a prod-tagged connection
   * always shows it, whatever this says. The preferences screen can expose it.
   */
  previewBeforeApply: boolean;
}

export const DEFAULT_TABLE_UI: TableUiState = { previewBeforeApply: true };

export function parseTableUi(value: unknown): TableUiState {
  if (typeof value !== 'object' || value === null) return DEFAULT_TABLE_UI;
  const preview = 'previewBeforeApply' in value ? value.previewBeforeApply : undefined;
  return { previewBeforeApply: typeof preview === 'boolean' ? preview : true };
}

interface TableUiStore extends TableUiState {
  setPreviewBeforeApply: (preview: boolean) => void;
  hydrate: (saved: unknown) => void;
}

export const useTableUiStore = create<TableUiStore>()((set) => ({
  ...DEFAULT_TABLE_UI,
  setPreviewBeforeApply: (previewBeforeApply) => {
    set({ previewBeforeApply });
  },
  hydrate: (saved) => {
    set(parseTableUi(saved));
  },
}));

/** Restores the saved preference, then saves every change. */
export async function restoreAndPersistTableUi(): Promise<() => void> {
  try {
    useTableUiStore.getState().hydrate(await loadUiSlice('tableData'));
  } catch (error) {
    console.warn('Saved table settings unavailable, using the defaults', error);
  }
  return useTableUiStore.subscribe((state, previous) => {
    if (state.previewBeforeApply === previous.previewBeforeApply) return;
    void saveUiSlice('tableData', { previewBeforeApply: state.previewBeforeApply });
  });
}
