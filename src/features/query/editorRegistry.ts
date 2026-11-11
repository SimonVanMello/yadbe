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
  /**
   * Replaces the selection with a snippet template (`${1:name}` tab stops) and starts it: `Tab`
   * moves between the fields (F-050).
   */
  insertSnippet: (template: string) => void;
  /**
   * Formats the selection, or the whole text without one (F-049): one edit, undone at once.
   * `false` when the text was already formatted.
   */
  format: (format: (text: string) => string) => boolean;
  /**
   * Acts on the object named at the cursor (F-052): `reveal` shows it in the explorer, `open`
   * its data in a table tab. Resolves `false` when nothing known is named there.
   */
  definitionAtCursor: (action: 'reveal' | 'open') => Promise<boolean>;
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
