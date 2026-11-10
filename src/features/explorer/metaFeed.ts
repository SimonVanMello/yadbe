import { queryClient } from '../../app/queryClient';
import { ipc, type MetaNode } from '../../ipc';
import { stateOf, useSessions } from '../connections/connectionStore';
import { invalidationFilters, metaKeys } from './metaKeys';

/** Marks what a refreshed node covers as stale: the nodes on screen read it again, only those. */
export async function invalidateMeta(connectionId: string, node: MetaNode): Promise<void> {
  await Promise.all(
    invalidationFilters(connectionId, node).map((filters) =>
      queryClient.invalidateQueries(filters),
    ),
  );
}

let feed = false;

/** Follows the backend: refreshed nodes, and connections that went away. Runs once per launch. */
export function startMetaFeed(): void {
  if (feed) return;
  feed = true;
  ipc.events.subscribe('metaRefreshed', ({ connectionId, node }) => {
    void invalidateMeta(connectionId, node);
  });
  // The backend empties its cache with the session; so does the front.
  useSessions.subscribe((state, previous) => {
    for (const connectionId of Object.keys(previous.sessions)) {
      if (stateOf(state.sessions[connectionId]) === 'disconnected') {
        void queryClient.cancelQueries({ queryKey: metaKeys.connection(connectionId) });
        queryClient.removeQueries({ queryKey: metaKeys.connection(connectionId) });
      }
    }
  });
}
