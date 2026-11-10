import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { usePaletteStore } from './paletteStore';

/** Registers the shortcuts that open the palette: on everything, and on its actions (`>`). */
export function usePaletteActions(): void {
  useEffect(
    () =>
      registerActions({
        'palette.open': () => {
          usePaletteStore.getState().toggle();
        },
        'palette.commands': () => {
          usePaletteStore.getState().toggle('>');
        },
      }),
    [],
  );
}
