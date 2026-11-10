import type { Range } from './gridMath';

/**
 * The visible columns, shared between the scroll path and the header. A store rather than
 * state of the grid: a horizontal scroll re-renders the header only, never the whole grid.
 */
export interface RangeStore {
  get: () => Range;
  set: (range: Range) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createRangeStore(): RangeStore {
  let current: Range = { start: 0, end: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (range) => {
      if (range.start === current.start && range.end === current.end) return;
      current = range;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
