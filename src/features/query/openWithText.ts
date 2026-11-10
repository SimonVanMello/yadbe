import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { getEditor } from './editorRegistry';
import { newQueryTabState, useQueryTabStore } from './queryTabStore';

interface OpenWithText {
  connectionId: string;
  /** `null`: the connection's own database. */
  database: string | null;
  text: string;
}

/**
 * Opens a new query tab on a connection with `text` already in the editor (the History panel's
 * "open in a new tab"). The caller connects. Returns the id of the tab.
 */
export function openQueryTabWithText({ connectionId, database, text }: OpenWithText): string {
  const tabId = useTabsStore.getState().openQueryTab(connectionId);
  // Before the first render of the tab, which would register it empty.
  useQueryTabStore.getState().ensure(tabId, {
    ...newQueryTabState(),
    content: text,
    selection: { anchor: text.length, head: text.length },
    database,
  });
  return tabId;
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
