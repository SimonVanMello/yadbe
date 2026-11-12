import { create } from 'zustand';

import type { DangerReport, DocumentResult, YadbeError } from '../../ipc';
import type { DocumentViewMode } from './collectionStore';

/** What the last command of a document console tab gave. */
export interface ConsoleOutcome {
  documents: DocumentResult;
  /** A cursor's documents, else the reply document. */
  cursor: boolean;
  /** The cursor had more documents than the console keeps. */
  truncated: boolean;
  durationMs: number | null;
}

export interface ConsoleTabState {
  running: boolean;
  outcome: ConsoleOutcome | null;
  error: YadbeError | null;
  /** A dangerous command waiting for the user's word, with what it would do. */
  confirm: { command: string; database: string; danger: DangerReport } | null;
  view: DocumentViewMode;
}

const FRESH: ConsoleTabState = {
  running: false,
  outcome: null,
  error: null,
  confirm: null,
  view: 'documents',
};

interface ConsoleStore {
  tabs: Record<string, ConsoleTabState>;
  patch: (tabId: string, patch: Partial<ConsoleTabState>) => void;
  remove: (tabId: string) => void;
}

export const useConsoleStore = create<ConsoleStore>((set) => ({
  tabs: {},
  patch: (tabId, patch) => {
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? FRESH), ...patch } },
    }));
  },
  remove: (tabId) => {
    set((state) => {
      if (!(tabId in state.tabs)) return state;
      return {
        tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)),
      };
    });
  },
}));

export function getConsoleTab(tabId: string): ConsoleTabState {
  return useConsoleStore.getState().tabs[tabId] ?? FRESH;
}

export function useConsoleTab(tabId: string): ConsoleTabState {
  return useConsoleStore((state) => state.tabs[tabId] ?? FRESH);
}
