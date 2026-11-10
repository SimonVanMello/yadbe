import { create } from 'zustand';

import { loadUiSlice, saveUiSlice } from '../backendPreferences';
import {
  DEFAULT_PANELS,
  clampPanelSize,
  parsePanels,
  type PanelId,
  type PanelState,
  type Panels,
} from './panels';

interface LayoutStore {
  panels: Panels;
  setPanel: (panel: PanelId, patch: Partial<PanelState>) => void;
  /** Collapses or expands a panel. */
  togglePanel: (panel: PanelId) => void;
  /** Shows or hides a panel, keeping its size. */
  setCollapsed: (panel: PanelId, collapsed: boolean) => void;
  /** Replaces the layout with the saved one. */
  hydrate: (saved: unknown) => void;
}

export const useLayoutStore = create<LayoutStore>()((set) => ({
  panels: DEFAULT_PANELS,
  setPanel: (panel, patch) => {
    set((state) => {
      const current = state.panels[panel];
      const size = patch.size === undefined ? current.size : clampPanelSize(panel, patch.size);
      return {
        panels: { ...state.panels, [panel]: { ...current, ...patch, size } },
      };
    });
  },
  togglePanel: (panel) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], collapsed: !state.panels[panel].collapsed },
      },
    }));
  },
  setCollapsed: (panel, collapsed) => {
    set((state) => ({
      panels: { ...state.panels, [panel]: { ...state.panels[panel], collapsed } },
    }));
  },
  hydrate: (saved) => {
    set({ panels: parsePanels(saved) });
  },
}));

const SAVE_DELAY_MS = 300;

/**
 * Restores the saved layout, then saves every change (debounced: the sizes change on every
 * pointer move while a panel is dragged). Returns the unsubscribe function.
 */
export async function restoreAndPersistLayout(): Promise<() => void> {
  try {
    useLayoutStore.getState().hydrate(await loadUiSlice('layout'));
  } catch (error) {
    console.warn('Saved layout unavailable, using the default one', error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useLayoutStore.subscribe((state, previous) => {
    if (state.panels === previous.panels) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void saveUiSlice('layout', useLayoutStore.getState().panels);
    }, SAVE_DELAY_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
