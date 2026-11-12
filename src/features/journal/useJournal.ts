import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type JournalEntry } from '../../ipc';
import { toJournalQuery, type JournalFilters } from './journalModel';

export const journalKeys = {
  /** Everything a `change-journal-changed` invalidates (an entry gets `revertedBy`). */
  all: ['journal'] as const,
  list: (filters: JournalFilters) => ['journal', 'list', toJournalQuery(filters)] as const,
  entry: (id: number) => ['journal', 'entry', id] as const,
  tables: (connectionId: string | null) => ['journal', 'tables', connectionId] as const,
};

interface JournalListPage {
  entries: JournalEntry[];
  next: number | null;
}

/** Entries of the next page are asked for when the list is this close to its last loaded one. */
export const JOURNAL_LOAD_MORE_MARGIN = 20;

export function useJournalList(filters: JournalFilters) {
  const query = useInfiniteQuery({
    queryKey: journalKeys.list(filters),
    queryFn: async ({ pageParam }): Promise<JournalListPage> => {
      const page = await unwrap(
        ipc.commands.searchChangeJournal({ ...toJournalQuery(filters), after: pageParam }),
      );
      return { entries: page.entries, next: page.next };
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
  });
  const entries = useMemo<JournalEntry[]>(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  return { query, entries };
}

/** The statements and inverse statements of an entry. */
export function useJournalDetail(id: number | null) {
  return useQuery({
    queryKey: journalKeys.entry(id ?? 0),
    queryFn: () => unwrap(ipc.commands.getChangeJournalEntry(id ?? 0)),
    enabled: id !== null,
  });
}

/** The tables with entries, for the table filter. */
export function useJournalTables(connectionId: string | null) {
  return useQuery({
    queryKey: journalKeys.tables(connectionId),
    queryFn: () => unwrap(ipc.commands.listChangeJournalTables(connectionId)),
    placeholderData: keepPreviousData,
  });
}

export function refreshJournal(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: journalKeys.all });
}
