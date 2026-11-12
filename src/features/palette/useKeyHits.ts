import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { ipc, unwrap } from '../../ipc';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { stateOf, useConnections, useSessions } from '../connections/connectionStore';
import { keyItem } from './familyObjectItems';
import type { ObjectItem } from './paletteItems';

const TYPING_PAUSE_MS = 150;
const MIN_CHARS = 2;
const KEYS_PER_CONNECTION = 20;
const NONE: ObjectItem[] = [];

/**
 * The keys of the connected key-value connections whose name contains `text`, among the keys the
 * backend already scanned (the explorer's scan of the connection's own database): the palette
 * never starts a scan, and nothing goes to the server. Asked once the typing pauses.
 */
export function useKeyHits(text: string, enabled: boolean): ObjectItem[] {
  const connections = useConnections();
  const sessions = useSessions((store) => store.sessions);
  const settled = useDebouncedValue(text, TYPING_PAUSE_MS);
  const wanted = enabled && settled.length >= MIN_CHARS;
  const connected = useMemo(
    () =>
      connections.filter(
        (connection) =>
          connection.family === 'keyValue' && stateOf(sessions[connection.id]) === 'connected',
      ),
    [connections, sessions],
  );
  const results = useQueries({
    queries: connected.map((connection) => {
      const database = Number.parseInt(connection.database, 10) || 0;
      return {
        queryKey: ['palette', 'kvKeys', connection.id, database, settled] as const,
        queryFn: () =>
          unwrap(ipc.commands.kvFindKeys(connection.id, database, settled, KEYS_PER_CONNECTION)),
        enabled: wanted,
        // Scanning goes on while the palette is open: ask again rather than keep a stale list.
        staleTime: 0,
      };
    }),
  });
  const stamp = results.map((result) => result.dataUpdatedAt).join();
  return useMemo(() => {
    if (!wanted) return NONE;
    return connected.flatMap((connection, index) => {
      const found = results[index]?.data;
      const database = Number.parseInt(connection.database, 10) || 0;
      return (found?.keys ?? []).map((key) =>
        keyItem(connection.id, connection.name, database, key),
      );
    });
    // `stamp` is the content of `results`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, connected, stamp]);
}
