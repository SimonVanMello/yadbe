import type { KvBytes } from '../../ipc';
import { bytesId } from './kvBytes';

type Key = readonly (string | number | null)[];

/**
 * Query keys of the key-value explorer. They live under the connection's `meta` key, so a
 * refresh of the connection reads them again and the sidebar rebuilds when they change.
 */
export const kvKeys = {
  all: (connectionId: string): Key => ['meta', connectionId, 'kv'],
  databases: (connectionId: string): Key => ['meta', connectionId, 'kv', 'databases'],
  database: (connectionId: string, database: number): Key => [
    'meta',
    connectionId,
    'kv',
    'db',
    database,
  ],
  scan: (connectionId: string, database: number, pattern: string | null): Key => [
    ...kvKeys.database(connectionId, database),
    'scan',
    pattern,
  ],
  levels: (connectionId: string, database: number): Key => [
    ...kvKeys.database(connectionId, database),
    'level',
  ],
  level: (
    connectionId: string,
    database: number,
    prefix: KvBytes,
    delimiter: string,
    limit: number,
  ): Key => [...kvKeys.levels(connectionId, database), delimiter, bytesId(prefix), limit],
  /** Not under `meta`: a summary arriving does not rebuild the tree. */
  summary: (connectionId: string, database: number, key: KvBytes): Key => [
    'kvSummary',
    connectionId,
    database,
    bytesId(key),
  ],
};
