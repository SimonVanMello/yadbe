import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ObjectRef } from '../../ipc';
import { useYadbeEvent } from '../../ipc/useYadbeEvent';
import { useConnectionState } from '../connections/connectionStore';
import { fetchMigrations } from './migrationsApi';

export const migrationKeys = {
  connection: (connectionId: string) => ['migrations', connectionId] as const,
  table: (connectionId: string, table: ObjectRef) =>
    ['migrations', connectionId, JSON.stringify(table)] as const,
};

/**
 * The migrations of a history table. Read once when the tab opens, again by "Refresh" and when
 * the explorer's metadata of the connection is refreshed (a migration ran in a query tab).
 */
export function useMigrations(connectionId: string, table: ObjectRef) {
  const client = useQueryClient();
  const connected = useConnectionState(connectionId) === 'connected';
  useYadbeEvent('metaRefreshed', (event) => {
    if (event.connectionId === connectionId) {
      void client.invalidateQueries({ queryKey: migrationKeys.connection(connectionId) });
    }
  });
  return useQuery({
    queryKey: migrationKeys.table(connectionId, table),
    queryFn: ({ signal }) => fetchMigrations(connectionId, table, signal),
    enabled: connected,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}
