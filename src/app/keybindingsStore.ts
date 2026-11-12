import { create } from 'zustand';

import type { Overrides } from './keybindingsLogic';

interface KeybindingsState {
  overrides: Overrides;
  /** Binds `id` to `shortcut`; `null` leaves it without one. */
  set: (id: string, shortcut: string | null) => void;
  /** Several bindings at once (reassigning a shortcut unbinds its previous owners). */
  setMany: (changes: Readonly<Record<string, string | null>>) => void;
  /** Back to the default of `id`. */
  reset: (id: string) => void;
  resetAll: () => void;
  /** Replaces the overrides (restore at startup). */
  hydrate: (overrides: Overrides) => void;
}

/**
 * The shortcuts the user changed (F-121); everything else keeps its default of `actions.ts`.
 * Saved in the `keybindings` slice of the UI state by `restoreAndPersistKeybindings`.
 */
export const useKeybindingsStore = create<KeybindingsState>()((set) => ({
  overrides: {},
  set: (id, shortcut) => {
    set((state) => ({ overrides: { ...state.overrides, [id]: shortcut } }));
  },
  setMany: (changes) => {
    set((state) => ({ overrides: { ...state.overrides, ...changes } }));
  },
  reset: (id) => {
    set((state) => ({
      overrides: Object.fromEntries(Object.entries(state.overrides).filter(([key]) => key !== id)),
    }));
  },
  resetAll: () => {
    set({ overrides: {} });
  },
  hydrate: (overrides) => {
    set({ overrides });
  },
}));
