import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { useConnectionTransfer } from './connectionTransferStore';

/** Registers the palette actions that open the connection import and export dialogs. */
export function useConnectionTransferActions(): void {
  useEffect(
    () =>
      registerActions({
        'connection.import': () => {
          useConnectionTransfer.getState().openImport();
        },
        'connection.export': () => {
          useConnectionTransfer.getState().openExport();
        },
      }),
    [],
  );
}
