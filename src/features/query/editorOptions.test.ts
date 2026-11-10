import { getIndentUnit } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { editorOptions, type EditorPreferences } from './editorOptions';

const base: EditorPreferences = {
  tabSize: 2,
  indentWithSpaces: true,
  lineWrapping: false,
  lineNumbers: true,
  highlightStatement: false,
};

function stateWith(prefs: Partial<EditorPreferences>) {
  return EditorState.create({
    doc: 'select 1',
    extensions: editorOptions({ ...base, ...prefs }, () => 'postgres'),
  });
}

describe('the editor options of the preferences', () => {
  it('sets the tab width and indents with that many spaces', () => {
    const state = stateWith({ tabSize: 4 });
    expect(state.tabSize).toBe(4);
    expect(getIndentUnit(state)).toBe(4);
    expect(state.facet(EditorState.tabSize)).toBe(4);
  });

  it('indents with a tab character when spaces are off', () => {
    const state = stateWith({ indentWithSpaces: false, tabSize: 8 });
    expect(state.tabSize).toBe(8);
    expect(getIndentUnit(state)).toBe(8);
  });

  it('wraps lines only when asked to', () => {
    const wrapped = (prefs: Partial<EditorPreferences>) =>
      new EditorView({ state: stateWith(prefs) }).contentDOM.classList.contains('cm-lineWrapping');
    expect(wrapped({ lineWrapping: true })).toBe(true);
    expect(wrapped({ lineWrapping: false })).toBe(false);
  });

  it('adds the gutter only with line numbers on', () => {
    const gutters = (prefs: Partial<EditorPreferences>) =>
      new EditorView({ state: stateWith(prefs) }).dom.querySelectorAll('.cm-lineNumbers').length;
    expect(gutters({ lineNumbers: true })).toBe(1);
    expect(gutters({ lineNumbers: false })).toBe(0);
  });
});
