import { create } from 'zustand';

import type { KvConsoleEntry, YadbeError } from '../../ipc';

/** What a console tab shows under its editor: its last run. */
export interface KvConsoleState {
  running: boolean;
  /** The commands of the last run, in order; their line numbers are the editor's. */
  entries: KvConsoleEntry[];
  /** Lines the last run left unrun (a failure or a stop). */
  skipped: number;
  /** The console's database after the last run (`SELECT` moves it); `null` before any. */
  database: number | null;
  /** A failure of the run itself (not connected…), not of one command. */
  error: YadbeError | null;
  /** Bumped by each run: the output scrolls back to the top. */
  runId: number;
}

const EMPTY: KvConsoleState = {
  running: false,
  entries: [],
  skipped: 0,
  database: null,
  error: null,
  runId: 0,
};

interface KvConsoleStore {
  tabs: Readonly<Record<string, KvConsoleState>>;
  update: (tabId: string, change: Partial<KvConsoleState>) => void;
  forget: (tabId: string) => void;
}

export const useKvConsoleStore = create<KvConsoleStore>()((set) => ({
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

export function useKvConsole(tabId: string): KvConsoleState {
  return useKvConsoleStore((state) => state.tabs[tabId] ?? EMPTY);
}

export function getKvConsole(tabId: string): KvConsoleState {
  return useKvConsoleStore.getState().tabs[tabId] ?? EMPTY;
}
