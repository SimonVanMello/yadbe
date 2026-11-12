import { create } from 'zustand';

import type { KvBytes, KvConflict, KvEdit, KvEditDanger, KvPreview, YadbeError } from '../../ipc';

/** The pending edits of one key tab (M4-6). */
export interface KvTabEdits {
  connectionId: string;
  database: number;
  key: KvBytes;
  edits: KvEdit[];
  /** Moves after each apply: the tab reads its key again. */
  round: number;
}

/** Where the changes of the apply dialog come from. */
export type KvApplySource =
  { kind: 'tab'; tabId: string } | { kind: 'revert'; connectionId: string; entryId: number };

/** The apply dialog: preview, confirmation of dangers, conflicts. */
export interface KvApplyDialog {
  source: KvApplySource;
  connectionId: string;
  database: number;
  status: 'loading' | 'ready' | 'applying' | 'confirm' | 'conflicted' | 'failed';
  preview: KvPreview | null;
  error: YadbeError | null;
  dangers: KvEditDanger[];
  conflicts: KvConflict[];
  /** The edits the conflicts' indices refer to. */
  edits: KvEdit[];
}

interface KvEditStore {
  tabs: Record<string, KvTabEdits | undefined>;
  dialog: KvApplyDialog | null;
}

export const useKvEditStore = create<KvEditStore>()(() => ({ tabs: {}, dialog: null }));

export function tabEdits(tabId: string): KvTabEdits | undefined {
  return useKvEditStore.getState().tabs[tabId];
}

export function patchTab(tabId: string, patch: Partial<KvTabEdits>): void {
  useKvEditStore.setState((state) => {
    const current = state.tabs[tabId];
    if (!current) return state;
    return { tabs: { ...state.tabs, [tabId]: { ...current, ...patch } } };
  });
}

export function patchDialog(patch: Partial<KvApplyDialog>): void {
  useKvEditStore.setState((state) =>
    state.dialog ? { dialog: { ...state.dialog, ...patch } } : state,
  );
}

const NO_EDITS: KvEdit[] = [];

/** The pending edits of a key tab (an empty list before any). */
export function useTabEdits(tabId: string): KvEdit[] {
  return useKvEditStore((state) => state.tabs[tabId]?.edits ?? NO_EDITS);
}

export function useTabRound(tabId: string): number {
  return useKvEditStore((state) => state.tabs[tabId]?.round ?? 0);
}
