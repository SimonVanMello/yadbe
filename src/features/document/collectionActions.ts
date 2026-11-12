import { showError } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type ObjectRef, type YadbeError } from '../../ipc';
import {
  getCollectionTab,
  useCollectionStore,
  type CollectionTabState,
  type QueryFields,
} from './collectionStore';

/** The collection tab `tabId` shows: its connection and its collection. */
function targetOf(tabId: string): { connectionId: string; table: ObjectRef } | null {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab?.connectionId && tab.table
    ? { connectionId: tab.connectionId, table: tab.table }
    : null;
}

function errorOf(error: unknown): YadbeError | null {
  return error instanceof YadbeIpcError ? error.error : null;
}

function patch(tabId: string, values: Partial<CollectionTabState>): void {
  useCollectionStore.getState().patch(tabId, values);
}

/** Reads page `page` of the applied query. Field errors stay in the tab, others are shown. */
export async function fetchPage(tabId: string, page: number): Promise<void> {
  const target = targetOf(tabId);
  if (!target) return;
  const state = getCollectionTab(tabId);
  patch(tabId, { loading: true, error: null });
  try {
    const result = await unwrap(
      ipc.commands.mongoFetchPage(
        tabId,
        target.connectionId,
        target.table.database,
        target.table.name,
        { ...state.applied, pageSize: state.pageSize },
        page,
      ),
    );
    patch(tabId, { page: result, loading: false });
  } catch (error) {
    const known = errorOf(error);
    patch(tabId, { loading: false, error: known });
    if (!known) showError(error);
  }
}

/** Opens the tab's collection (kind, estimated size), then reads its first page. */
export async function openCollection(tabId: string): Promise<void> {
  const target = targetOf(tabId);
  // Opened once: a second call while the first runs (a re-render) would only cancel it.
  if (!target || getCollectionTab(tabId).phase === 'opening') return;
  patch(tabId, { phase: 'opening', error: null });
  try {
    const info = await unwrap(
      ipc.commands.mongoOpenCollection(
        tabId,
        target.connectionId,
        target.table.database,
        target.table.name,
      ),
    );
    patch(tabId, { phase: 'ready', info, exactCount: null });
    await fetchPage(tabId, 0);
  } catch (error) {
    patch(tabId, { phase: 'error', error: errorOf(error) });
    if (!errorOf(error)) showError(error);
  }
}

/** Runs the query the fields hold, from its first page. */
export function applyQuery(tabId: string): Promise<void> {
  const { draft } = getCollectionTab(tabId);
  patch(tabId, { applied: { ...draft }, exactCount: null });
  return fetchPage(tabId, 0);
}

export function setDraft(tabId: string, fields: Partial<QueryFields>): void {
  patch(tabId, { draft: { ...getCollectionTab(tabId).draft, ...fields } });
}

export function setPageSize(tabId: string, pageSize: number): Promise<void> {
  patch(tabId, { pageSize });
  return fetchPage(tabId, 0);
}

/** Counts exactly the documents of the applied filter (cancellable). */
export async function countExactly(tabId: string): Promise<void> {
  const target = targetOf(tabId);
  if (!target) return;
  const { applied } = getCollectionTab(tabId);
  patch(tabId, { counting: true });
  try {
    const count = await unwrap(
      ipc.commands.mongoCountDocuments(
        tabId,
        target.connectionId,
        target.table.database,
        target.table.name,
        applied.filter,
      ),
    );
    patch(tabId, { counting: false, exactCount: count });
  } catch (error) {
    patch(tabId, { counting: false });
    if (errorOf(error)?.code !== 'cancelled') showError(error);
  }
}

/** Stops what the tab runs on the server (a page, a count). */
export function cancelCollection(tabId: string): void {
  void ipc.commands.mongoCancel(tabId).catch(showError);
}

export function forgetCollectionTab(tabId: string): void {
  useCollectionStore.getState().remove(tabId);
}
