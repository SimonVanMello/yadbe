import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type HistoryScope } from '../../ipc';
import { useNow } from '../../ui/useNow';
import {
  startOfDay,
  toBaseQuery,
  toEntry,
  type HistoryBaseQuery,
  type HistoryEntry,
  type HistoryFilters,
} from './historyModel';

export const historyKeys = {
  /** Every list and count: what a `history-changed` invalidates. */
  all: ['history'] as const,
  list: (query: HistoryBaseQuery) => ['history', 'list', query] as const,
  count: (scope: HistoryScope) => ['history', 'count', scope] as const,
  /** Entries never change once written: not under `all`. */
  entry: (id: number) => ['history-entry', id] as const,
};

interface HistoryPage {
  rows: HistoryEntry[];
  next: number | null;
}

/** Rows of the next page are asked for when the list is this close to its last loaded row. */
export const LOAD_MORE_MARGIN = 40;
/** How often the list notices that the day changed. */
const CLOCK_MS = 60_000;

export function useHistoryList(filters: HistoryFilters) {
  // The period bounds are whole days: the query only changes with the filters, or at midnight.
  const today = startOfDay(useNow(CLOCK_MS));
  const base = useMemo(() => toBaseQuery(filters, today), [filters, today]);
  const query = useInfiniteQuery({
    queryKey: historyKeys.list(base),
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      const page = await unwrap(ipc.commands.searchHistory({ ...base, after: pageParam }));
      return { rows: page.rows.map(toEntry), next: page.next };
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    // While a new search loads, the previous result stays up instead of flashing empty.
    placeholderData: keepPreviousData,
  });
  const entries = useMemo<HistoryEntry[]>(
    () => query.data?.pages.flatMap((page) => page.rows) ?? [],
    [query.data],
  );
  const key = historyKeys.list(base);
  /** Whether new statements were recorded since this list was loaded beyond its first page. */
  const behind =
    (query.data?.pages.length ?? 0) > 1 &&
    queryClient.getQueryState(key)?.isInvalidated === true &&
    !query.isFetching;
  /** Loads the first page again (with the new statements), dropping the older pages. */
  const catchUp = () => {
    queryClient.setQueryData<InfiniteData<HistoryPage, number | null>>(key, (data) =>
      data ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
    );
    return queryClient.refetchQueries({ queryKey: key, exact: true });
  };
  return { query, entries, behind, catchUp };
}

/** The whole statement and error of an entry (the list holds a truncated copy). */
export function useHistoryEntry(id: number | null) {
  return useQuery({
    queryKey: historyKeys.entry(id ?? 0),
    queryFn: async () => {
      const row = await unwrap(ipc.commands.getHistoryEntry(id));
      return row ? toEntry(row) : null;
    },
    enabled: id !== null,
    staleTime: Infinity,
  });
}

export function useHistoryCount(scope: HistoryScope) {
  return useQuery({
    queryKey: historyKeys.count(scope),
    queryFn: () => unwrap(ipc.commands.countHistory(scope)),
    placeholderData: keepPreviousData,
  });
}

export function refreshHistory(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: historyKeys.all });
}

/**
 * New statements were recorded (`history-changed`, after every run). Refetching an infinite list
 * reads every loaded page again, one after the other: a list scrolled thousands of entries deep
 * would do that after each run. Lists still on their first page are refetched at once; the
 * others are only marked, and catch up once scrolled back to the top (`catchUp`).
 */
export async function noteNewHistory(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: historyKeys.all, refetchType: 'none' });
  await queryClient.refetchQueries({
    queryKey: historyKeys.all,
    type: 'active',
    predicate: (query) => {
      const data = query.state.data as InfiniteData<HistoryPage> | undefined;
      return query.queryKey[1] !== 'list' || (data?.pages.length ?? 0) <= 1;
    },
  });
}
