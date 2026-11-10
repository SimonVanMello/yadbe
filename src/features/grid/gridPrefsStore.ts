import { create } from 'zustand';

interface GridPrefsState {
  /** "Copy as" includes the header row (shared by every grid; the preferences screen is M2-8). */
  copyHeaders: boolean;
  setCopyHeaders: (copyHeaders: boolean) => void;
}

export const useGridPrefs = create<GridPrefsState>()((set) => ({
  copyHeaders: true,
  setCopyHeaders: (copyHeaders) => {
    set({ copyHeaders });
  },
}));
