import { useQuery } from '@tanstack/react-query';

import { useConnectionState } from '../connections/connectionStore';
import { fetchDatabases } from '../explorer/metaApi';
import { metaKeys } from '../explorer/metaKeys';

/**
 * The databases a connection offers, for the toolbar's database switcher: the ones the user can
 * connect to, without the engine's own (templates…) unless one is the connection's current
 * database. `undefined` while loading, or when the list cannot be read (the switcher then only
 * offers its field to type a name). Reads only a connected connection, and shares the explorer's cache entry.
 */
export function useDatabaseList(connectionId: string | null): string[] | undefined {
  const connected = useConnectionState(connectionId) === 'connected';
  const query = useQuery({
    queryKey: metaKeys.databases(connectionId ?? ''),
    queryFn: ({ signal }) => fetchDatabases(connectionId ?? '', signal),
    enabled: connectionId !== null && connected,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    select: (data) =>
      data
        .filter((database) => database.accessible && (!database.system || database.current))
        .map((database) => database.name),
  });
  return query.data;
}
