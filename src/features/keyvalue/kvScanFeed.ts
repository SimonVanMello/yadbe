import { queryClient } from '../../app/queryClient';
import { ipc, type KvScanStatus } from '../../ipc';
import { kvKeys } from './kvKeys';

/** Keys "load more" asks of a scan (its first stop is at 10 000 as well). */
export const SCAN_MORE = 10_000;

let started = false;

/**
 * Follows the key scans (`kv-scan-progress`): the tree shows each scan's state as it moves,
 * and the open levels of its database are read again when keys arrived, so the tree fills as
 * the batches come in.
 */
export function startKeyValueFeed(): void {
  if (started) return;
  started = true;
  ipc.events.subscribe('kvScanProgress', ({ connectionId, status }) => {
    const key = kvKeys.scan(connectionId, status.database, status.pattern);
    const previous = queryClient.getQueryData<KvScanStatus>(key);
    queryClient.setQueryData(key, status);
    const moved =
      previous === undefined ||
      previous.scanId !== status.scanId ||
      previous.version !== status.version;
    if (moved) {
      void queryClient.invalidateQueries({
        queryKey: kvKeys.levels(connectionId, status.database),
      });
    }
  });
}
