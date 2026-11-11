import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { activeTableTabId, tableTabOf } from '../table-data/tableActions';
import { openImport } from './importStore';

/** Registers what the import action does: the wizard on the table of the active table tab. */
export function useImportActions(): void {
  useEffect(
    () =>
      registerActions({
        'table.import': () => {
          const tabId = activeTableTabId();
          const tab = tabId === null ? null : tableTabOf(tabId);
          if (!tab) return false;
          openImport(tab.connectionId, tab.table);
          return true;
        },
      }),
    [],
  );
}
