import { useEffect } from 'react';

import { registerActions } from '../../app/actions';

/** The grids that can show a row detail (F-068): the ones mounted, normally the one on screen. */
const grids = new Set<() => void>();

/** A grid listens for the row detail action; returns the function that stops it. */
export function onRowDetailAction(toggle: () => void): () => void {
  grids.add(toggle);
  return () => {
    grids.delete(toggle);
  };
}

/** Registers `result.rowDetail`: it applies where a grid is on screen, nowhere else. */
export function useRowDetailAction(): void {
  useEffect(
    () =>
      registerActions({
        'result.rowDetail': () => {
          if (grids.size === 0) return false;
          for (const toggle of grids) toggle();
          return true;
        },
      }),
    [],
  );
}
