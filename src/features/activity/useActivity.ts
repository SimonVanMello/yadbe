import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useConnectionState } from '../connections/connectionStore';
import { fetchActivity } from './activityApi';

export const activityKeys = {
  connection: (connectionId: string) => ['activity', connectionId] as const,
};

/** How often the monitor reads again by itself, in ms; `null` for a manual refresh only. */
export type RefreshInterval = number | null;

/**
 * The activity of a connection's server. Read again every `interval` ms while the window is in
 * the foreground; the previous snapshot stays on screen while the next one is read, and a read
 * that is still on its way is cancelled on the server when the tab goes away. A failure keeps
 * the last good snapshot out of sight (the error replaces it): stale sessions to kill are
 * worse than none.
 */
export function useActivity(connectionId: string, interval: RefreshInterval) {
  const connected = useConnectionState(connectionId) === 'connected';
  return useQuery({
    queryKey: activityKeys.connection(connectionId),
    queryFn: ({ signal }) => fetchActivity(connectionId, signal),
    enabled: connected,
    // A failed read stops the timer: the error says what to fix, and "Retry" reads again.
    refetchInterval: (query) => (query.state.status === 'error' ? false : (interval ?? false)),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
