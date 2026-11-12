import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { showError } from '../../app/errors/presentError';
import { ipc, unwrap, type KvBytes, type KvScanStatus } from '../../ipc';
import { useExplorerStore } from '../explorer/explorerStore';
import { kvKeys } from './kvKeys';
import { kvNodeKeys } from './kvExplorerRows';
import { useKvTreeStore } from './kvTreeStore';
import { tr } from './kvText';

function report(error: unknown): void {
  showError(error, { title: tr('keyValue.error.title') });
}

/** The new state of a scan, where the tree reads it, and its levels read again. */
function applyScan(connectionId: string, status: KvScanStatus): void {
  queryClient.setQueryData(kvKeys.scan(connectionId, status.database, status.pattern), status);
}

/** Reads `count` more keys of a database's scan, or all of them. */
export async function scanMore(
  connectionId: string,
  database: number,
  count: number | null,
): Promise<void> {
  try {
    applyScan(connectionId, await unwrap(ipc.commands.kvScanMore(connectionId, database, count)));
  } catch (error) {
    report(error);
  }
}

export async function stopScan(connectionId: string, database: number): Promise<void> {
  try {
    applyScan(connectionId, await unwrap(ipc.commands.kvScanStop(connectionId, database)));
  } catch (error) {
    report(error);
  }
}

/** Scans a database again from the start (F5 on it): keys deleted since go away. */
export async function rescan(connectionId: string, database: number): Promise<void> {
  try {
    applyScan(connectionId, await unwrap(ipc.commands.kvScanRestart(connectionId, database)));
    await queryClient.invalidateQueries({ queryKey: kvKeys.levels(connectionId, database) });
    await queryClient.invalidateQueries({ queryKey: kvKeys.databases(connectionId) });
  } catch (error) {
    report(error);
  }
}

/** Shows the keys of a database that match `pattern` (`MATCH`): its scan starts again. */
export function setPattern(connectionId: string, database: number, pattern: string): void {
  useKvTreeStore.getState().setPattern(connectionId, database, pattern);
}

/** Shows one more page of a level. */
export function showMore(connectionId: string, levelNode: string): void {
  useKvTreeStore.getState().showMore(connectionId, levelNode);
}

/** Opens a key in its tab (one tab per key and database), or shows the one that has it. */
export function openKeyTab(connectionId: string, database: number, key: KvBytes): void {
  useTabsStore.getState().openToolTab(connectionId, { type: 'kvKey', database, key });
}

/** Opens a database in the explorer (the tree of its keys). */
export function revealDatabase(connectionId: string, database: number): void {
  useExplorerStore.getState().setExpanded(connectionId, kvNodeKeys.database(database), true);
}
