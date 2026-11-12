import { showError } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type IndexQuery, type YadbeError } from '../../ipc';
import {
  getIndexTab,
  useIndexStore,
  type IndexQueryFields,
  type IndexTabState,
} from './indexStore';

/** The index tab `tabId` shows: its connection and its index (data stream, alias). */
function targetOf(tabId: string): { connectionId: string; target: string } | null {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab?.connectionId && tab.table
    ? { connectionId: tab.connectionId, target: tab.table.name }
    : null;
}

function errorOf(error: unknown): YadbeError | null {
  return error instanceof YadbeIpcError ? error.error : null;
}

function patch(tabId: string, values: Partial<IndexTabState>): void {
  useIndexStore.getState().patch(tabId, values);
}

/** The query the backend takes from the fields. */
export function indexQueryOf(fields: IndexQueryFields, pageSize: number): IndexQuery {
  return {
    mode: fields.mode,
    text: fields.text,
    source: fields.source,
    sort:
      fields.sortField === '' ? [] : [{ field: fields.sortField, descending: fields.descending }],
    pageSize,
  };
}

/** Reads page `page` of the applied query. Query errors stay in the tab, others are shown. */
export async function fetchIndexPage(tabId: string, page: number): Promise<void> {
  const target = targetOf(tabId);
  if (!target) return;
  const state = getIndexTab(tabId);
  patch(tabId, { loading: true, error: null });
  try {
    const result = await unwrap(
      ipc.commands.searchFetchPage(
        tabId,
        target.connectionId,
        target.target,
        indexQueryOf(state.applied, state.pageSize),
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

/** Opens the tab's index (fields, settings, paging), then reads its first page. */
export async function openIndex(tabId: string): Promise<void> {
  const target = targetOf(tabId);
  // Opened once: a second call while the first runs (a re-render) would only cancel it.
  if (!target || getIndexTab(tabId).phase === 'opening') return;
  patch(tabId, { phase: 'opening', error: null });
  try {
    const info = await unwrap(
      ipc.commands.searchOpenIndex(tabId, target.connectionId, target.target),
    );
    patch(tabId, { phase: 'ready', info, exactCount: null });
    await fetchIndexPage(tabId, 0);
  } catch (error) {
    patch(tabId, { phase: 'error', error: errorOf(error) });
    if (!errorOf(error)) showError(error);
  }
}

/** Runs the query the fields hold, from its first page. */
export function applyIndexQuery(tabId: string): Promise<void> {
  const { draft } = getIndexTab(tabId);
  patch(tabId, { applied: { ...draft }, exactCount: null });
  return fetchIndexPage(tabId, 0);
}

export function setIndexDraft(tabId: string, fields: Partial<IndexQueryFields>): void {
  patch(tabId, { draft: { ...getIndexTab(tabId).draft, ...fields } });
}

export function setIndexPageSize(tabId: string, pageSize: number): Promise<void> {
  patch(tabId, { pageSize });
  return fetchIndexPage(tabId, 0);
}

/** Counts exactly the documents of the applied query (`_count`, cancellable). */
export async function countIndexExactly(tabId: string): Promise<void> {
  const target = targetOf(tabId);
  if (!target) return;
  const { applied, pageSize } = getIndexTab(tabId);
  patch(tabId, { counting: true });
  try {
    const count = await unwrap(
      ipc.commands.searchCount(
        tabId,
        target.connectionId,
        target.target,
        indexQueryOf(applied, pageSize),
      ),
    );
    patch(tabId, { counting: false, exactCount: count });
  } catch (error) {
    patch(tabId, { counting: false });
    if (errorOf(error)?.code !== 'cancelled') showError(error);
  }
}

/** Stops what the tab runs on the server (a page, a count). */
export function cancelIndex(tabId: string): void {
  void ipc.commands.searchCancel(tabId).catch(showError);
}

export function forgetIndexTab(tabId: string): void {
  useIndexStore.getState().remove(tabId);
}
