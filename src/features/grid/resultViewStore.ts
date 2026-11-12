import { create } from 'zustand';

import {
  EMPTY_VIEW,
  nextSort,
  operatorsFor,
  type ResultCondition,
  type ResultViewState,
} from './resultViewModel';
import type { ValueKind } from '../../ipc';

interface ResultViewStore {
  /** The sort and filter of each result (by result id) while the app runs. */
  views: Readonly<Record<number, ResultViewState>>;
  /**
   * Results whose rows the backend shows sorted or filtered right now: the request is answered
   * (an edit of the result waits for the view to be gone, F-087).
   */
  applied: Readonly<Record<number, true>>;
  setApplied: (resultId: number, applied: boolean) => void;
  sortBy: (resultId: number, dataCol: number, additive: boolean) => void;
  /** A new condition; the first one is the quick filter on every column. */
  addCondition: (resultId: number, column: number | null) => void;
  updateCondition: (
    resultId: number,
    id: number,
    change: Partial<Omit<ResultCondition, 'id'>>,
    kindOf: (column: number | null) => ValueKind | null,
  ) => void;
  removeCondition: (resultId: number, id: number) => void;
  setMatchCase: (resultId: number, matchCase: boolean) => void;
  setBar: (resultId: number, open: boolean) => void;
  /** Drops every sort key and condition. */
  clear: (resultId: number) => void;
}

let nextId = 1;

function patch(
  views: Readonly<Record<number, ResultViewState>>,
  resultId: number,
  change: Partial<ResultViewState>,
): Record<number, ResultViewState> {
  return { ...views, [resultId]: { ...(views[resultId] ?? EMPTY_VIEW), ...change } };
}

export const useResultViewStore = create<ResultViewStore>()((set) => ({
  views: {},
  applied: {},
  setApplied: (resultId, applied) => {
    set((state) => {
      if ((state.applied[resultId] === true) === applied) return state;
      if (applied) return { applied: { ...state.applied, [resultId]: true } };
      return {
        applied: Object.fromEntries(
          Object.entries(state.applied).filter(([id]) => Number(id) !== resultId),
        ),
      };
    });
  },
  sortBy: (resultId, dataCol, additive) => {
    set(({ views }) => ({
      views: patch(views, resultId, {
        sort: nextSort(getResultViewOf(views, resultId).sort, dataCol, additive),
      }),
    }));
  },
  addCondition: (resultId, column) => {
    set(({ views }) => {
      const current = getResultViewOf(views, resultId);
      const condition: ResultCondition = { id: nextId++, column, op: 'contains', value: '' };
      return {
        views: patch(views, resultId, {
          conditions: [...current.conditions, condition],
          barOpen: true,
        }),
      };
    });
  },
  updateCondition: (resultId, id, change, kindOf) => {
    set(({ views }) => {
      const current = getResultViewOf(views, resultId);
      const conditions = current.conditions.map((condition) => {
        if (condition.id !== id) return condition;
        const next = { ...condition, ...change };
        // A column that does not take the operator moves it to the first that fits.
        const fits = operatorsFor(kindOf(next.column));
        return fits.includes(next.op) ? next : { ...next, op: fits[0] ?? 'contains' };
      });
      return { views: patch(views, resultId, { conditions }) };
    });
  },
  removeCondition: (resultId, id) => {
    set(({ views }) => ({
      views: patch(views, resultId, {
        conditions: getResultViewOf(views, resultId).conditions.filter((c) => c.id !== id),
      }),
    }));
  },
  setMatchCase: (resultId, matchCase) => {
    set(({ views }) => ({ views: patch(views, resultId, { matchCase }) }));
  },
  setBar: (resultId, open) => {
    set(({ views }) => ({ views: patch(views, resultId, { barOpen: open }) }));
  },
  clear: (resultId) => {
    set(({ views }) => ({ views: patch(views, resultId, { sort: [], conditions: [] }) }));
  },
}));

function getResultViewOf(
  views: Readonly<Record<number, ResultViewState>>,
  resultId: number,
): ResultViewState {
  return views[resultId] ?? EMPTY_VIEW;
}

/** Shows the filter bar of a result with a first condition ready to type in, or hides it. */
export function toggleFilterBar(resultId: number): void {
  const store = useResultViewStore.getState();
  const view = getResultViewOf(store.views, resultId);
  store.setBar(resultId, !view.barOpen);
  if (!view.barOpen && view.conditions.length === 0) store.addCondition(resultId, null);
}
