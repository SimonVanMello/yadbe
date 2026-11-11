import type { SavedTab } from '../../ipc';
import { differsFromSaved, newQueryTabState, type QueryTabState } from './queryTabStore';

/** The store refuses a tab whose text is larger than this (`MAX_TAB_CONTENT_BYTES`). */
export const MAX_SAVED_CONTENT_BYTES = 8 * 1024 * 1024;

/** Whether the text fits what the app database accepts for one tab. */
export function fitsInStore(content: string): boolean {
  // A character takes at most 3 bytes in UTF-16 code units' UTF-8 form: no need to encode the
  // common case.
  if (content.length * 3 <= MAX_SAVED_CONTENT_BYTES) return true;
  return new TextEncoder().encode(content).length <= MAX_SAVED_CONTENT_BYTES;
}

/** What a query tab contributes to a `SavedTab`, besides the shell's fields. */
export type SavedEditor = Pick<SavedTab, 'content' | 'cursor' | 'database' | 'filePath'> & {
  /** Frontend-owned fields of `uiState` (the shell adds its own next to them). */
  ui: Record<string, unknown>;
};

export function editorToSaved(state: QueryTabState): SavedEditor {
  const fits = fitsInStore(state.content);
  if (!fits) console.warn('A query tab is too large to be saved with the session; saving it empty');
  return {
    content: fits ? state.content : '',
    cursor: fits ? state.selection : null,
    database: state.database,
    filePath: state.filePath,
    ui: {
      scroll: fits ? [state.scrollTop, state.scrollLeft] : [0, 0],
      ...(state.filePath === null
        ? {}
        : {
            fileHash: state.fileHash,
            // Unsaved changes of a file-bound tab: the saved text itself is the file's.
            dirty: state.savedContent === null || state.content !== state.savedContent,
          }),
      ...(state.origin === null
        ? {}
        : { origin: { id: state.origin.queryId, differs: differsFromSaved(state) } }),
    },
  };
}

function parseUi(uiState: string | null): Record<string, unknown> {
  if (!uiState) return {};
  try {
    const value: unknown = JSON.parse(uiState);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Reads a saved tab back; tolerant to a `uiState` written by something else. */
export function editorFromSaved(
  saved: Pick<SavedTab, 'content' | 'cursor' | 'database' | 'filePath' | 'uiState'>,
): QueryTabState {
  const ui = parseUi(saved.uiState);
  const scroll = Array.isArray(ui['scroll']) ? (ui['scroll'] as unknown[]) : [];
  const length = saved.content.length;
  const clamp = (offset: number) => Math.max(0, Math.min(length, Math.floor(offset)));
  const hash = ui['fileHash'];
  const bound = saved.filePath !== null;
  const origin = ui['origin'] as { id?: unknown; differs?: unknown } | null | undefined;
  return {
    ...newQueryTabState(),
    content: saved.content,
    // A tab restored from a file with unsaved changes has no baseline to compare with.
    savedContent: bound ? (ui['dirty'] === true ? null : saved.content) : '',
    fileHash: bound && typeof hash === 'string' ? hash : null,
    selection: saved.cursor
      ? { anchor: clamp(saved.cursor.anchor), head: clamp(saved.cursor.head) }
      : { anchor: 0, head: 0 },
    scrollTop: finite(scroll[0]),
    scrollLeft: finite(scroll[1]),
    database: saved.database,
    filePath: saved.filePath,
    // A tab saved with changes to its saved query has no baseline to compare with.
    origin:
      typeof origin?.id === 'string'
        ? { queryId: origin.id, baseline: origin.differs === true ? null : saved.content }
        : null,
  };
}
