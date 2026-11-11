import { openConnectionTab, selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { getEditor } from './editorRegistry';
import { newQueryTabState, useQueryTabStore, type SavedOrigin } from './queryTabStore';

/** Where a new query tab starts. */
export interface QueryTabTarget {
  connectionId: string;
  /** Database the tab runs in; `null` or absent: the connection's own. */
  database?: string | null;
  /** SQL the editor opens with (a "Script as" result, a history entry…). */
  initialText?: string | null;
  /**
   * `true` (default): the active tab is reused when it is still a welcome tab (the explorer's
   * "New query" and "Script as"). `false`: always a new tab (the History panel's "open in a
   * new tab").
   */
  reuseWelcomeTab?: boolean;
  /** The saved query the text comes from (F-050): the tab can update it. */
  origin?: SavedOrigin | null;
}

/**
 * Opens a query tab on a connection, aimed at a database and holding some SQL. The editor state
 * is seeded before the tab first renders, so the editor mounts with the text and the cursor at
 * its end. The caller connects. Returns the id of the tab.
 */
export function openQueryTab(target: QueryTabTarget): string {
  const id =
    target.reuseWelcomeTab === false
      ? useTabsStore.getState().openQueryTab(target.connectionId)
      : openConnectionTab(target.connectionId);
  const content = target.initialText ?? '';
  useQueryTabStore.getState().ensure(id, {
    ...newQueryTabState(),
    content,
    selection: { anchor: content.length, head: content.length },
    database: target.database ?? null,
    origin: target.origin ?? null,
  });
  return id;
}

/**
 * Inserts `text` at the cursor of the active query tab's editor. `false` when there is none
 * (a welcome tab, or an editor that is not mounted).
 */
export function insertIntoActiveEditor(text: string): boolean {
  const tab = selectActiveTab(useTabsStore.getState());
  const editor = tab.connectionId === null ? undefined : getEditor(tab.id);
  if (!editor) return false;
  editor.insertAtCursor(text);
  return true;
}
