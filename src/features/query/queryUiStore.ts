import { create } from 'zustand';

import { loadUiSlice, saveUiSlice } from '../../app/backendPreferences';

/** Share of the query tab the results area takes, and how far it may move. */
export const DEFAULT_RESULTS_RATIO = 0.45;
export const MIN_RESULTS_RATIO = 0.12;
export const MAX_RESULTS_RATIO = 0.85;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RESULTS_RATIO;
  return Math.round(Math.min(MAX_RESULTS_RATIO, Math.max(MIN_RESULTS_RATIO, ratio)) * 1000) / 1000;
}

export interface QueryUiState {
  /** Share of the tab height for the results area, shared by every query tab and remembered. */
  resultsRatio: number;
  /**
   * Ask before running `UPDATE` / `DELETE` without `WHERE`, `TRUNCATE` and `DROP` (F-051).
   * On by default; a prod-tagged connection always asks, whatever this says. The preferences
   * screen (M2-8) will expose it.
   */
  confirmDangerous: boolean;
  /**
   * Suggest names while typing (F-043). Off, suggestions come only on `Ctrl+Space`. The
   * preferences screen (M2-8) will expose it.
   */
  completeAsYouType: boolean;
}

export const DEFAULT_QUERY_UI: QueryUiState = {
  resultsRatio: DEFAULT_RESULTS_RATIO,
  confirmDangerous: true,
  completeAsYouType: true,
};

/** Reads the saved slice; tolerant to old, partial or corrupted data. */
export function parseQueryUi(value: unknown): QueryUiState {
  if (typeof value !== 'object' || value === null) return DEFAULT_QUERY_UI;
  const ratio = 'resultsRatio' in value ? value.resultsRatio : undefined;
  const confirm = 'confirmDangerous' in value ? value.confirmDangerous : undefined;
  const complete = 'completeAsYouType' in value ? value.completeAsYouType : undefined;
  return {
    resultsRatio: typeof ratio === 'number' ? clampRatio(ratio) : DEFAULT_RESULTS_RATIO,
    confirmDangerous: typeof confirm === 'boolean' ? confirm : true,
    completeAsYouType: typeof complete === 'boolean' ? complete : true,
  };
}

interface QueryUiStore extends QueryUiState {
  setResultsRatio: (ratio: number) => void;
  setConfirmDangerous: (confirm: boolean) => void;
  setCompleteAsYouType: (complete: boolean) => void;
  hydrate: (saved: unknown) => void;
}

export const useQueryUiStore = create<QueryUiStore>()((set) => ({
  ...DEFAULT_QUERY_UI,
  setResultsRatio: (ratio) => {
    set({ resultsRatio: clampRatio(ratio) });
  },
  setConfirmDangerous: (confirmDangerous) => {
    set({ confirmDangerous });
  },
  setCompleteAsYouType: (completeAsYouType) => {
    set({ completeAsYouType });
  },
  hydrate: (saved) => {
    set(parseQueryUi(saved));
  },
}));

const SAVE_DELAY_MS = 300;

/** Restores the saved split and guard preference, then saves every change (debounced). */
export async function restoreAndPersistQueryUi(): Promise<() => void> {
  try {
    useQueryUiStore.getState().hydrate(await loadUiSlice('query'));
  } catch (error) {
    console.warn('Saved editor settings unavailable, using the defaults', error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useQueryUiStore.subscribe((state, previous) => {
    if (
      state.resultsRatio === previous.resultsRatio &&
      state.confirmDangerous === previous.confirmDangerous &&
      state.completeAsYouType === previous.completeAsYouType
    ) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { resultsRatio, confirmDangerous, completeAsYouType } = useQueryUiStore.getState();
      void saveUiSlice('query', { resultsRatio, confirmDangerous, completeAsYouType });
    }, SAVE_DELAY_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
