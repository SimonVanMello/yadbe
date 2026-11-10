import type { TextRange } from '../../ipc';

/**
 * What the rest of the app can ask of a mounted SQL editor: the Messages tab jumps to an error,
 * a run marks where its text started, opening a file replaces the text. Offsets passed in are
 * those of the text a run started with: the editor maps them through the edits made since.
 */
export interface EditorController {
  focus: () => void;
  jumpTo: (offset: number) => void;
  /** The text of a run is about to be sent: later edits are tracked from now on. */
  markRunStart: () => void;
  setErrors: (ranges: readonly TextRange[]) => void;
  /** Replaces the whole text (file opened or read again from disk). */
  replaceContent: (text: string) => void;
  /** Replaces the selection (an empty one is the cursor) with `text` and leaves the cursor after it. */
  insertAtCursor: (text: string) => void;
}

const editors = new Map<string, EditorController>();

/** Registers the editor of a tab while it is mounted; returns the function that removes it. */
export function registerEditor(tabId: string, controller: EditorController): () => void {
  editors.set(tabId, controller);
  return () => {
    if (editors.get(tabId) === controller) editors.delete(tabId);
  };
}

export function getEditor(tabId: string): EditorController | undefined {
  return editors.get(tabId);
}
