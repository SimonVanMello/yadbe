import { create } from 'zustand';

import { loadUiSlice, saveUiSlice } from '../../app/backendPreferences';
import type { PauseReason, ResultStatus, SortKey, TableFilter } from '../../ipc';
import {
  DEFAULT_EXPORT_PREFS,
  parseExportPrefs,
  type ExportGridRange,
  type ExportPrefs,
} from './exportOptions';

/** A query result on screen. */
export interface ResultExportSource {
  kind: 'result';
  resultId: number;
  rowCount: number;
  status: ResultStatus;
  pausedBy: PauseReason | null;
}

/** Every row of a table tab's table under the tab's filter and sort, read from the server. */
export interface TableExportSource {
  kind: 'table';
  tabId: string;
  filter: TableFilter;
  sort: SortKey[];
  /** The tab has changes not applied yet: the file holds the stored rows, not them. */
  pending: boolean;
}

/** What the export dialog needs to know of what it exports. */
export interface ExportDialogRequest {
  /** Used for the default file name and the dialog's accessible context. */
  label: string;
  /** Connection the rows come from: its environment is shown in the dialog. */
  connectionId?: string | null;
  source: ResultExportSource | TableExportSource;
}

interface ExportStore {
  prefs: ExportPrefs;
  setPrefs: (change: (prefs: ExportPrefs) => ExportPrefs) => void;
  hydrate: (saved: unknown) => void;
  /** The dialog, `null` when closed. */
  request: ExportDialogRequest | null;
  open: (request: ExportDialogRequest) => void;
  close: () => void;
  /** The selection of each result grid on screen, as an export range. */
  ranges: Record<number, ExportGridRange | null>;
  setRange: (resultId: number, range: ExportGridRange | null) => void;
  forgetRange: (resultId: number) => void;
}

export const useExportStore = create<ExportStore>()((set) => ({
  prefs: DEFAULT_EXPORT_PREFS,
  setPrefs: (change) => {
    set((state) => ({ prefs: change(state.prefs) }));
  },
  hydrate: (saved) => {
    set({ prefs: parseExportPrefs(saved) });
  },
  request: null,
  open: (request) => {
    set({ request });
  },
  close: () => {
    set({ request: null });
  },
  ranges: {},
  setRange: (resultId, range) => {
    set((state) => {
      const current = state.ranges[resultId] ?? null;
      const same =
        current === range ||
        (current !== null &&
          range !== null &&
          current.rowFrom === range.rowFrom &&
          current.rowTo === range.rowTo &&
          current.columns.length === range.columns.length &&
          current.columns.every((column, i) => column === range.columns[i]));
      return same ? state : { ranges: { ...state.ranges, [resultId]: range } };
    });
  },
  forgetRange: (resultId) => {
    set((state) => {
      const rest = { ...state.ranges };
      Reflect.deleteProperty(rest, resultId);
      return { ranges: rest };
    });
  },
}));

const SAVE_DELAY_MS = 300;

/** Restores the last-used options, then saves every change (debounced). */
export async function restoreAndPersistExportPrefs(): Promise<() => void> {
  try {
    useExportStore.getState().hydrate(await loadUiSlice('export'));
  } catch (error) {
    console.warn('Saved export options unavailable, using the defaults', error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useExportStore.subscribe((state, previous) => {
    if (state.prefs === previous.prefs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void saveUiSlice('export', useExportStore.getState().prefs);
    }, SAVE_DELAY_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
