import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type Engine } from '../../ipc';
import { stateOf, useSessions } from '../connections/connectionStore';
import { metaKeys } from '../explorer/metaKeys';
import { getQueryTabState } from '../query/queryTabStore';
import { useQueryUiStore } from '../query/queryUiStore';
import type { CompletionHost } from './completionSource';
import type { Quoting } from './identifierQuoting';

interface HostOptions {
  tabId: string;
  /** Read when asked: a tab can be moved to another connection. */
  connectionId: () => string;
  /** The connection's own database (empty for file engines). */
  connectionDatabase: () => string;
  engine: () => Engine;
  quoting: () => Quoting;
}

/**
 * What a query tab's editor tells its completion: where it runs (read when asked, so that a
 * switch of connection or database is followed), the engine's quoting, the preference.
 */
export function createCompletionHost(options: HostOptions): CompletionHost {
  const { tabId } = options;
  return {
    engine: options.engine,
    quoting: options.quoting,
    target: () => {
      const connectionId = options.connectionId();
      return {
        connectionId,
        database: getQueryTabState(tabId).database,
        connectionDatabase: options.connectionDatabase(),
        connected: stateOf(useSessions.getState().sessions[connectionId]) === 'connected',
      };
    },
    asYouType: () => useQueryUiStore.getState().completeAsYouType,
    // The explorer's own query: shared with the tree when it has read the table already.
    tableDetails: async (table, kind) => {
      try {
        const connectionId = options.connectionId();
        return await queryClient.query({
          queryKey: metaKeys.table(connectionId, table, kind),
          queryFn: () => unwrap(ipc.commands.getTableDetails(null, connectionId, table)),
          staleTime: Infinity,
          gcTime: 10 * 60_000,
        });
      } catch {
        return null;
      }
    },
  };
}
