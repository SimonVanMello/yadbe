import { create } from 'zustand';

/** `Mod+F` on a table tab: its filter bar opens a new condition (for the focused column). */
interface FilterRequests {
  /** Tab id → how many times a filter was asked for (a change opens the form). */
  requests: Record<string, number>;
  request: (tabId: string) => void;
}

export const useFilterRequests = create<FilterRequests>()((set) => ({
  requests: {},
  request: (tabId) => {
    set((state) => ({
      requests: { ...state.requests, [tabId]: (state.requests[tabId] ?? 0) + 1 },
    }));
  },
}));
