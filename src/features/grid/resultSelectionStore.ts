import { create } from 'zustand';

/** Size of a grid selection: the block a copy would produce. */
export interface SelectionSize {
  rows: number;
  cols: number;
}

interface ResultSelectionState {
  /** The result grid whose selection was last reported, and that selection. */
  resultId: number | null;
  size: SelectionSize | null;
  report: (resultId: number, size: SelectionSize | null) => void;
  /** A grid unmounted: forget its selection if it is the one shown. */
  clear: (resultId: number) => void;
}

/** The selection of the result grid on screen, for the status bar. */
export const useResultSelectionStore = create<ResultSelectionState>()((set, get) => ({
  resultId: null,
  size: null,
  report: (resultId, size) => {
    const current = get();
    if (
      current.resultId === resultId &&
      current.size?.rows === size?.rows &&
      current.size?.cols === size?.cols
    ) {
      return;
    }
    set({ resultId, size });
  },
  clear: (resultId) => {
    if (get().resultId === resultId) set({ resultId: null, size: null });
  },
}));
