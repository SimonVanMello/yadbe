import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { ipc, unwrap } from '../../ipc';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { libraryKeys } from '../library/useLibrary';

const TYPING_PAUSE_MS = 150;
const NONE: string[] = [];

/**
 * Ids of the saved queries whose text, description or tags match `text` (the backend's
 * words-as-prefixes search), best first, asked once the typing pauses. Under `libraryKeys.all`,
 * so that a change of the library makes it stale.
 */
export function useSavedHits(text: string, enabled: boolean) {
  const settled = useDebouncedValue(text, TYPING_PAUSE_MS);
  const active = enabled && settled.trim() !== '';
  const query = useQuery({
    queryKey: [...libraryKeys.all, 'palette', settled] as const,
    queryFn: () => unwrap(ipc.commands.searchSavedQueries(settled, null)),
    enabled: active,
    placeholderData: keepPreviousData,
  });
  return { ids: active ? (query.data ?? NONE) : NONE, loading: active && query.isFetching };
}
