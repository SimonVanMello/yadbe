import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { ipc, unwrap } from '../../ipc';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { toEntry, type HistoryEntry } from '../history/historyModel';
import { historyKeys } from '../history/useHistory';

/** Statements asked of the backend at most: the palette shows a few, or one list in `!` mode. */
const HISTORY_LIMIT = 50;
const TYPING_PAUSE_MS = 150;
const NONE: HistoryEntry[] = [];

/**
 * The statements of the history matching `text` (the backend's words-as-prefixes search), newest
 * first, asked once the typing pauses so that a keystroke never waits for the database. Under
 * `historyKeys.all`, so that a `history-changed` makes it stale like the History panel's lists.
 */
export function useHistoryHits(text: string, enabled: boolean) {
  const settled = useDebouncedValue(text, TYPING_PAUSE_MS);
  const query = useQuery({
    queryKey: [...historyKeys.all, 'palette', settled] as const,
    queryFn: async () => {
      const page = await unwrap(
        ipc.commands.searchHistory({
          text: settled === '' ? null : settled,
          connectionId: null,
          tabId: null,
          outcomes: [],
          from: null,
          to: null,
          minDurationMs: null,
          after: null,
          limit: HISTORY_LIMIT,
        }),
      );
      return page.rows.map(toEntry);
    },
    enabled,
    placeholderData: keepPreviousData,
  });
  return { entries: query.data ?? NONE, loading: enabled && query.isFetching };
}
