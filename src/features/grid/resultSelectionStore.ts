import { create } from 'zustand';

import type { SelectionAggregate } from '../../ipc';

/** Size of a grid selection: the block a copy would produce. */
export interface SelectionSize {
  rows: number;
  cols: number;
}

interface ResultSelectionState {
  /** The result grid whose selection was last reported, and that selection. */
  resultId: number | null;
  size: SelectionSize | null;
  /** What the selection adds up to (F-065); `null` while it is computed or without selection. */
  aggregate: SelectionAggregate | null;
  report: (resultId: number, size: SelectionSize | null) => void;
  reportAggregate: (resultId: number, aggregate: SelectionAggregate | null) => void;
  /** A grid unmounted: forget its selection if it is the one shown. */
  clear: (resultId: number) => void;
}

/** The selection of the result grid on screen, for the status bar. */
export const useResultSelectionStore = create<ResultSelectionState>()((set, get) => ({
  resultId: null,
  size: null,
  aggregate: null,
  report: (resultId, size) => {
    const current = get();
    if (
      current.resultId === resultId &&
      current.size?.rows === size?.rows &&
      current.size?.cols === size?.cols
    ) {
      return;
    }
    set({ resultId, size, aggregate: current.resultId === resultId ? current.aggregate : null });
  },
  reportAggregate: (resultId, aggregate) => {
    if (get().resultId === resultId) set({ aggregate });
  },
  clear: (resultId) => {
    if (get().resultId === resultId) set({ resultId: null, size: null, aggregate: null });
  },
}));
