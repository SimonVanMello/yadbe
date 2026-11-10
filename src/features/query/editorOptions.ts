import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLineGutter, lineNumbers } from '@codemirror/view';

import type { Engine } from '../../ipc';
import type { PreferenceValues } from '../preferences/preferenceSchema';
import { statementHighlighter } from './statementHighlighter';

export type EditorPreferences = Pick<
  PreferenceValues,
  'tabSize' | 'indentWithSpaces' | 'lineWrapping' | 'lineNumbers' | 'highlightStatement'
>;

/**
 * The editor behavior the preferences control (F-125), as one extension the editor swaps
 * through a compartment when a setting changes.
 */
export function editorOptions(prefs: EditorPreferences, getEngine: () => Engine): Extension {
  return [
    prefs.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    indentUnit.of(prefs.indentWithSpaces ? ' '.repeat(prefs.tabSize) : '\t'),
    EditorState.tabSize.of(prefs.tabSize),
    prefs.lineWrapping ? EditorView.lineWrapping : [],
    prefs.highlightStatement ? statementHighlighter(getEngine) : [],
  ];
}
