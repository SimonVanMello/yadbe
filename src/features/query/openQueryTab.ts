import { openConnectionTab } from '../../app/tabs/tabsStore';
import { newQueryTabState, useQueryTabStore } from './queryTabStore';

/** Where a new query tab starts. */
export interface QueryTabTarget {
  connectionId: string;
  /** Database the tab runs in; `null` or absent: the connection's own. */
  database?: string | null;
  /** SQL the editor opens with (a "Script as" result, say). */
  initialText?: string | null;
}

/**
 * Opens a query tab on a connection, aimed at a database and holding some SQL: in the active tab
 * when it is still a welcome tab, in a new one otherwise. The explorer uses it for "New query"
 * and "Script as". The editor state is seeded before the tab first renders, so the editor
 * mounts with the text and the cursor at its end.
 */
export function openQueryTab(target: QueryTabTarget): string {
  const id = openConnectionTab(target.connectionId);
  const content = target.initialText ?? '';
  useQueryTabStore.getState().ensure(id, {
    ...newQueryTabState(),
    content,
    selection: { anchor: content.length, head: content.length },
    database: target.database ?? null,
  });
  return id;
}
