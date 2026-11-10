import type { CursorPosition, ExecuteScope } from '../../ipc';

/** What a run command asks for (F-041). */
export type RunMode =
  /** The selection when there is one, else the whole script: `Mod+Enter` and the Run button. */
  | 'auto'
  | 'all'
  | 'selection'
  /** The statement under the cursor: `Mod+Shift+Enter`. */
  | 'statement';

/** The selected range of an editor selection, `null` when the cursor is just placed. */
export function selectedRange(selection: CursorPosition): { from: number; to: number } | null {
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  return from === to ? null : { from, to };
}

/**
 * The scope to send to `executeQuery` for a run mode and the editor's selection, or `null` when
 * there is nothing to run (a `selection` run without selection, an empty script).
 */
export function scopeFor(
  mode: RunMode,
  selection: CursorPosition,
  text: string,
): ExecuteScope | null {
  if (text.trim() === '') return null;
  const range = selectedRange(selection);
  switch (mode) {
    case 'all':
      return { kind: 'all' };
    case 'selection':
      return range && text.slice(range.from, range.to).trim() !== ''
        ? { kind: 'range', ...range }
        : null;
    case 'statement':
      return { kind: 'statementAt', offset: Math.min(selection.head, text.length) };
    case 'auto':
      return range && text.slice(range.from, range.to).trim() !== ''
        ? { kind: 'range', ...range }
        : { kind: 'all' };
  }
}

/** The label the Run button shows: it says what pressing it runs. */
export function runLabelKey(selection: CursorPosition): 'toolbar.run' | 'toolbar.runSelection' {
  return selectedRange(selection) ? 'toolbar.runSelection' : 'toolbar.run';
}
