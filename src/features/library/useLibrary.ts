import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryClient } from '../../app/queryClient';
import {
  ipc,
  unwrap,
  type SavedQuery,
  type SavedQueryLibrary,
  type SnippetDefinition,
} from '../../ipc';
import { EMPTY_LIBRARY, type Library } from './libraryModel';

export const libraryKeys = {
  /** Everything the library caches: what a `saved-queries-changed` invalidates. */
  all: ['library'] as const,
  list: ['library', 'list'] as const,
  search: (text: string, connectionId: string | null) =>
    ['library', 'search', text, connectionId] as const,
  entry: (id: string) => ['library', 'entry', id] as const,
  snippets: ['library', 'snippets'] as const,
};

/** The folders and queries; texts are cut to a preview (`sqlTruncated`). */
export function useSavedLibrary() {
  const query = useQuery({
    queryKey: libraryKeys.list,
    queryFn: () => unwrap(ipc.commands.listSavedQueries()),
  });
  const library = useMemo<Library>(() => query.data ?? EMPTY_LIBRARY, [query.data]);
  return { query, library };
}

/** The statements already in the library (whole ones): what a history star shows as saved. */
export function useSavedSqlSet(): ReadonlySet<string> {
  const { library } = useSavedLibrary();
  return useMemo(
    () => new Set(library.queries.filter((query) => !query.sqlTruncated).map((q) => q.sql.trim())),
    [library.queries],
  );
}

/** Ids of the queries whose name, text, description or tags match `text`, best first. */
export function useSavedSearch(text: string, connectionId: string | null) {
  const trimmed = text.trim();
  const query = useQuery({
    queryKey: libraryKeys.search(trimmed, connectionId),
    queryFn: () => unwrap(ipc.commands.searchSavedQueries(trimmed, connectionId)),
    enabled: trimmed !== '',
    placeholderData: keepPreviousData,
  });
  const ids = useMemo(
    () => (trimmed === '' || query.data === undefined ? null : new Set(query.data)),
    [trimmed, query.data],
  );
  return { query, ids, ordered: query.data };
}

/** A query with its whole statement (the list holds a preview). */
export function useSavedQuery(id: string | null) {
  return useQuery({
    queryKey: libraryKeys.entry(id ?? ''),
    queryFn: () => unwrap(ipc.commands.getSavedQuery(id ?? '')),
    enabled: id !== null,
  });
}

/** A query with its whole statement, read now (null once deleted). */
export function fetchSavedQuery(id: string): Promise<SavedQuery | null> {
  return queryClient.query({
    queryKey: libraryKeys.entry(id),
    queryFn: () => unwrap(ipc.commands.getSavedQuery(id)),
    staleTime: 0,
  });
}

/** The snippets, kept until the library changes: the editor asks on every completion. */
export function fetchSnippets(): Promise<SnippetDefinition[]> {
  return queryClient.query({
    queryKey: libraryKeys.snippets,
    queryFn: () => unwrap(ipc.commands.listSnippets()),
    staleTime: Infinity,
  });
}

/** The library as last read, for code outside React. */
export function currentLibrary(): Library {
  return queryClient.getQueryData<SavedQueryLibrary>(libraryKeys.list) ?? EMPTY_LIBRARY;
}

export function refreshLibrary(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: libraryKeys.all });
}
