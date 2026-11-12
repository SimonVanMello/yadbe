import { useEffect } from 'react';

import { registerActions } from '../../app/actions';

/** Actions of the grid on screen that are routed to it. */
export type GridAction = 'result.rowDetail' | 'result.filter';

/** The grids that can answer: the ones mounted, normally the one on screen. */
const grids = new Set<(action: GridAction) => void>();

/** A grid listens for its actions; returns the function that stops it. */
export function onGridAction(handle: (action: GridAction) => void): () => void {
  grids.add(handle);
  return () => {
    grids.delete(handle);
  };
}

function route(action: GridAction): boolean {
  if (grids.size === 0) return false;
  for (const handle of grids) handle(action);
  return true;
}

/**
 * Registers the actions that act on the grid on screen (F-065, F-068): the row detail and the
 * filter of a result. They apply where a grid is mounted, nowhere else.
 */
export function useGridActions(): void {
  useEffect(
    () =>
      registerActions({
        'result.rowDetail': () => route('result.rowDetail'),
        'result.filter': () => route('result.filter'),
      }),
    [],
  );
}
