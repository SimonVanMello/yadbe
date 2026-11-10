import { create } from 'zustand';

/** Where the cursor of a query tab's editor is, for the status bar (SPEC §4: `Ln 3, Col 12`). */
export interface EditorCursor {
  /** 1-based. */
  line: number;
  /** 1-based, in characters from the start of the line. */
  column: number;
  /** Characters selected by the main selection; 0 for a plain cursor. */
  selected: number;
}

interface EditorCursorState {
  cursors: Record<string, EditorCursor>;
  set: (tabId: string, cursor: EditorCursor) => void;
  forget: (tabId: string) => void;
}

/**
 * Kept apart from the persisted query tab state: it changes on every keystroke and only the
 * status bar reads it. The editor writes it on each selection or document change.
 */
export const useEditorCursorStore = create<EditorCursorState>()((set) => ({
  cursors: {},
  set: (tabId, cursor) => {
    set((state) => {
      const current = state.cursors[tabId];
      if (
        current?.line === cursor.line &&
        current.column === cursor.column &&
        current.selected === cursor.selected
      ) {
        return state;
      }
      return { cursors: { ...state.cursors, [tabId]: cursor } };
    });
  },
  forget: (tabId) => {
    set((state) => {
      if (!(tabId in state.cursors)) return state;
      return {
        cursors: Object.fromEntries(Object.entries(state.cursors).filter(([id]) => id !== tabId)),
      };
    });
  },
}));
