import { queryClient } from '../../app/queryClient';
import type { SavedConnection } from '../../ipc';
import { connectionKeys } from '../connections/connectionStore';
import { summarize, type ConnectionSummary } from '../connections/model';

/** Every saved connection, from the connections cache (empty while it loads). */
export function listConnections(): ConnectionSummary[] {
  const data = queryClient.getQueryData<{ connections: SavedConnection[] }>(connectionKeys.all);
  return data?.connections.map(summarize) ?? [];
}

/**
 * A saved connection by id, read from the connections cache: for code that runs outside React
 * (run, save and switch actions). `undefined` for `null`, an unknown id or while loading.
 */
export function findConnection(id: string | null): ConnectionSummary | undefined {
  if (id === null) return undefined;
  const data = queryClient.getQueryData<{ connections: SavedConnection[] }>(connectionKeys.all);
  const saved = data?.connections.find((connection) => connection.id === id);
  return saved ? summarize(saved) : undefined;
}
