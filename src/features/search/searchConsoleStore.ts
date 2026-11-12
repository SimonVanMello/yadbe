import { create } from 'zustand';

import type { ConsoleFailure, ConsoleResponse, YadbeError } from '../../ipc';

/** How a response is shown: its hits or table as a grid, as documents, or the JSON answer. */
export type ResponseView = 'grid' | 'documents' | 'json' | 'raw';

/** What a console tab of a search connection shows under its editor: its last run. */
export interface SearchConsoleState {
  running: boolean;
  /** The answers of the last run, in order; their lines are the editor's. */
  responses: ConsoleResponse[];
  /** The answer shown (index in `responses`). */
  selected: number;
  /** Requests the last run left unsent (a refusal, a cancel). */
  skipped: number;
  /** The text could not be read as requests. */
  failure: ConsoleFailure | null;
  /** A failure of the run itself (not connected…), not of one request. */
  error: YadbeError | null;
  view: ResponseView;
  /** Bumped by each run. */
  runId: number;
}

const EMPTY: SearchConsoleState = {
  running: false,
  responses: [],
  selected: 0,
  skipped: 0,
  failure: null,
  error: null,
  view: 'grid',
  runId: 0,
};

interface SearchConsoleStore {
  tabs: Readonly<Record<string, SearchConsoleState>>;
  update: (tabId: string, change: Partial<SearchConsoleState>) => void;
  forget: (tabId: string) => void;
}

export const useSearchConsoleStore = create<SearchConsoleStore>()((set) => ({
  tabs: {},
  update: (tabId, change) => {
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? EMPTY), ...change } },
    }));
  },
  forget: (tabId) => {
    set((state) =>
      tabId in state.tabs
        ? { tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)) }
        : state,
    );
  },
}));

export function useSearchConsole(tabId: string): SearchConsoleState {
  return useSearchConsoleStore((state) => state.tabs[tabId] ?? EMPTY);
}

export function getSearchConsole(tabId: string): SearchConsoleState {
  return useSearchConsoleStore.getState().tabs[tabId] ?? EMPTY;
}
