import { create } from 'zustand';

/** What opens the save dialog of the library (F-050). */
export type SaveDialogRequest =
  | {
      /** A new saved query: from an editor, a history entry or a built-in snippet. */
      mode: 'create';
      sql: string;
      /** Name to start from; derived from the statement when absent. */
      name?: string;
      /** The connection the statement belongs to: the "on this connection" scope. */
      connectionId: string | null;
      database: string | null;
      folderId?: string | null;
      snippet?: boolean;
      trigger?: string;
      description?: string;
      /** The editor tab the whole text comes from: it becomes linked to the new query. */
      tabId?: string | null;
      /** Only the selected text of the tab is saved. */
      selectionOnly?: boolean;
    }
  | {
      /** Details of a saved query (name, folder, scope, tags, snippet, text). */
      mode: 'edit';
      queryId: string;
    };

interface SaveDialogStore {
  request: SaveDialogRequest | null;
  open: (request: SaveDialogRequest) => void;
  close: () => void;
}

export const useSaveDialog = create<SaveDialogStore>()((set) => ({
  request: null,
  open: (request) => {
    set({ request });
  },
  close: () => {
    set({ request: null });
  },
}));
