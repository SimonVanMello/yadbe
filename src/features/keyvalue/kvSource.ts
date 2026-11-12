import type { QueryClient } from '@tanstack/react-query';

import type { Loadable } from '../explorer/explorerRows';
import { requestKey, type MetaRequest } from '../explorer/metaKeys';
import { asLoadable } from '../explorer/metaSource';
import type { KvSource } from './kvExplorerRows';

/**
 * The key-value tree's view of the query cache, like `createCacheSource` for SQL: every request
 * made with `fetch` is recorded, so the sidebar observes (and so loads) the open nodes only.
 */
export function createKvSource(
  client: QueryClient,
  connectionId: string,
  record: (connectionId: string, request: MetaRequest) => void,
): KvSource {
  const read = <T>(request: MetaRequest, fetch: boolean): Loadable<T> => {
    if (fetch) record(connectionId, request);
    return asLoadable(client.getQueryState<T>(requestKey(connectionId, request)), fetch);
  };
  return {
    databases: (fetch) => read({ type: 'kvDatabases' }, fetch),
    scan: (database, pattern, fetch) => read({ type: 'kvScan', database, pattern }, fetch),
    level: (database, prefix, delimiter, limit, fetch) =>
      read({ type: 'kvLevel', database, prefix, delimiter, limit }, fetch),
  };
}
