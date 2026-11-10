import { InfiniteQueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { noteNewHistory } from './useHistory';

afterEach(() => {
  queryClient.clear();
});

/** A history list with `pages` pages loaded and observed, as the mounted panel keeps it. */
async function observedList(name: string, pages: number) {
  const queryKey = ['history', 'list', name];
  const reads: (number | null)[] = [];
  const options = {
    queryKey,
    queryFn: ({ pageParam }: { pageParam: number | null }) => {
      reads.push(pageParam);
      return Promise.resolve({ rows: [], next: (pageParam ?? 0) + 1 });
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last: { next: number }) => last.next,
  };
  await queryClient.infiniteQuery({ ...options, pages });
  const unsubscribe = new InfiniteQueryObserver(queryClient, {
    ...options,
    staleTime: Infinity,
  }).subscribe(() => undefined);
  reads.length = 0;
  return { queryKey, reads, unsubscribe };
}

describe('noteNewHistory (history-changed)', () => {
  it('reads a list on its first page again, and only marks a list scrolled deeper', async () => {
    const shallow = await observedList('shallow', 1);
    const deep = await observedList('deep', 3);
    await noteNewHistory();
    expect(shallow.reads).toEqual([null]);
    expect(queryClient.getQueryState(shallow.queryKey)?.isInvalidated).toBe(false);
    expect(deep.reads).toEqual([]);
    expect(queryClient.getQueryState(deep.queryKey)?.isInvalidated).toBe(true);
    shallow.unsubscribe();
    deep.unsubscribe();
  });
});
