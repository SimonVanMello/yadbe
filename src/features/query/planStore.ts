import { create } from 'zustand';

import type { ExplainResult, YadbeError } from '../../ipc';

/** A tab's explain (F-053): running, its plan, or why it failed. */
export type PlanState =
  | { status: 'running'; analyze: boolean; startedAt: number }
  | { status: 'done'; analyze: boolean; result: ExplainResult }
  | { status: 'failed'; analyze: boolean; error: YadbeError };

interface PlanStore {
  plans: Record<string, PlanState>;
  /** The results area shows the plan rather than the results. */
  showing: Record<string, boolean>;
  set: (tabId: string, plan: PlanState) => void;
  show: (tabId: string) => void;
  hide: (tabId: string) => void;
  forget: (tabId: string) => void;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

export const usePlanStore = create<PlanStore>()((set) => ({
  plans: {},
  showing: {},
  set: (tabId, plan) => {
    set((state) => ({
      plans: { ...state.plans, [tabId]: plan },
      showing: { ...state.showing, [tabId]: true },
    }));
  },
  show: (tabId) => {
    set((state) => (state.plans[tabId] ? { showing: { ...state.showing, [tabId]: true } } : state));
  },
  hide: (tabId) => {
    set((state) =>
      state.showing[tabId] ? { showing: { ...state.showing, [tabId]: false } } : state,
    );
  },
  forget: (tabId) => {
    set((state) => ({
      plans: without(state.plans, tabId),
      showing: without(state.showing, tabId),
    }));
  },
}));

export function useTabPlan(tabId: string): PlanState | undefined {
  return usePlanStore((state) => state.plans[tabId]);
}

export function useShowingPlan(tabId: string): boolean {
  return usePlanStore((state) => state.showing[tabId] === true && tabId in state.plans);
}

export function isExplaining(tabId: string): boolean {
  return usePlanStore.getState().plans[tabId]?.status === 'running';
}
