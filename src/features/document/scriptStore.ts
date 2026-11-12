import { create } from 'zustand';

import type { DangerReport, ScriptOutcome, YadbeError } from '../../ipc';
import type { DocumentViewMode } from './collectionStore';

export type ScriptPane = 'result' | 'messages';

/** The query tab of a document connection: its last mongosh run. */
export interface ScriptTabState {
  running: boolean;
  /** `performance.now()` when the run started. */
  startedAt: number | null;
  outcome: ScriptOutcome | null;
  /** The run could not start (not connected, already running…). */
  error: YadbeError | null;
  /** A dangerous operation the script waits on, with what it would do. */
  confirm: { requestId: number; danger: DangerReport } | null;
  /** The editor text the last run was placed in: its error is marked only while it is unchanged. */
  sourceText: string | null;
  view: DocumentViewMode;
  pane: ScriptPane;
}

const FRESH: ScriptTabState = {
  running: false,
  startedAt: null,
  outcome: null,
  error: null,
  confirm: null,
  sourceText: null,
  view: 'documents',
  pane: 'result',
};

interface ScriptStore {
  tabs: Record<string, ScriptTabState>;
  patch: (tabId: string, patch: Partial<ScriptTabState>) => void;
  remove: (tabId: string) => void;
}

export const useScriptStore = create<ScriptStore>((set) => ({
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

export function getScriptTab(tabId: string): ScriptTabState {
  return useScriptStore.getState().tabs[tabId] ?? FRESH;
}

export function useScriptTab(tabId: string): ScriptTabState {
  return useScriptStore((state) => state.tabs[tabId] ?? FRESH);
}
