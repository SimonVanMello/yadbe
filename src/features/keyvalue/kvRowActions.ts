import { queryClient } from '../../app/queryClient';
import { openKeyTab, rescan, scanMore } from './kvActions';
import type { KvRow } from './kvExplorerRows';
import { kvKeys } from './kvKeys';

/** What a double click or Enter does on a row of the key tree; `false` when nothing. */
export function openKvRow(row: KvRow): boolean {
  switch (row.type) {
    case 'kvKey':
      openKeyTab(row.connectionId, row.database, row.fullKey);
      return true;
    default:
      return false;
  }
}

/** F5 or retry on a row of the key tree. */
export function refreshKvRow(row: KvRow): void {
  switch (row.type) {
    case 'kvDatabase':
      void rescan(row.connectionId, row.database.index);
      return;
    case 'kvScan':
      // A failed or stopped scan goes on from where it was.
      if (row.status.state !== 'running') void scanMore(row.connectionId, row.status.database, 0);
      return;
    case 'kvStatus':
      void queryClient.invalidateQueries({
        queryKey:
          row.database === null
            ? kvKeys.databases(row.connectionId)
            : kvKeys.database(row.connectionId, row.database),
      });
      return;
    case 'kvNamespace':
    case 'kvKey':
    case 'kvMore':
    case 'kvPattern':
      void queryClient.invalidateQueries({
        queryKey: kvKeys.levels(row.connectionId, row.database),
      });
      return;
  }
}
