import { useQuery } from '@tanstack/react-query';

import type { DdlTarget } from '../../ipc';
import { useConnectionState } from '../connections/connectionStore';
import { fetchDdl } from './objectsApi';

export const ddlKeys = {
  connection: (connectionId: string) => ['ddl', connectionId] as const,
  target: (connectionId: string, target: DdlTarget) =>
    ['ddl', connectionId, JSON.stringify(target)] as const,
};

/**
 * The definition a DDL tab shows. The tab body and the toolbar read it through the same key, so
 * it is fetched once; it is dropped with the tab, and read again by "Reload" or when the
 * explorer's metadata is refreshed.
 */
export function useDdl(connectionId: string, target: DdlTarget) {
  const connected = useConnectionState(connectionId) === 'connected';
  return useQuery({
    queryKey: ddlKeys.target(connectionId, target),
    queryFn: ({ signal }) => fetchDdl(connectionId, target, signal),
    enabled: connected,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}
