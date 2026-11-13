import { create } from 'zustand';

import type { DangerReport, ScriptMessage, ScriptOutcome, YadbeError } from '../../ipc';
import type { DocumentViewMode } from './collectionStore';

export type ScriptPane = 'result' | 'messages';

/** The query tab of a document connection: its last mongosh run. */
export interface ScriptTabState {
  running: boolean;
  /** `performance.now()` when the run started. */
  startedAt: number | null;
  outcome: ScriptOutcome | null;
  /** Lines the running script printed so far (`mongo-script-output`); the outcome replaces them. */
  live: readonly ScriptMessage[];
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
  live: [],
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

/**
 * Lines a running script printed: appended to the tab's live messages, and the messages pane
 * shown when the first ones arrive. Ignored once the run is over (the outcome has them all).
 */
export function appendLiveMessages(tabId: string, messages: readonly ScriptMessage[]): void {
  const tab = useScriptStore.getState().tabs[tabId];
  if (!tab?.running || messages.length === 0) return;
  useScriptStore.getState().patch(tabId, {
    live: [...tab.live, ...messages],
    ...(tab.live.length === 0 ? { pane: 'messages' as const } : {}),
  });
}

export function getScriptTab(tabId: string): ScriptTabState {
  return useScriptStore.getState().tabs[tabId] ?? FRESH;
}

export function useScriptTab(tabId: string): ScriptTabState {
  return useScriptStore((state) => state.tabs[tabId] ?? FRESH);
}
