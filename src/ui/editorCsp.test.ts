import { closeBrackets } from '@codemirror/autocomplete';
import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { cspSafeEditor } from './editorCsp';

const views: EditorView[] = [];

function editor(doc: string, anchor: number, head: number, extra: Extension = []) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [cspSafeEditor(), extra],
    }),
  });
  views.push(view);
  return view;
}

/** What the browser fires before it edits the text itself; `true` when it may go on. */
function type(view: EditorView, data: string, init: InputEventInit = {}): boolean {
  const event = new InputEvent('beforeinput', {
    inputType: 'insertText',
    data,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  return view.contentDOM.dispatchEvent(event);
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

describe('typing over a selection under the CSP', () => {
  it('replaces the selection through the editor, never through the browser', () => {
    const view = editor('select 1 from t', 7, 8);
    const browserMayEdit = type(view, '2');
    expect(browserMayEdit).toBe(false);
    expect(view.state.doc.toString()).toBe('select 2 from t');
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 8 });
  });

  it('is a typed input: undo, completion and the other listeners see it as one', () => {
    let userEvent: string | undefined;
    const view = editor(
      'hello world',
      6,
      11,
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions)
          userEvent = tr.annotation(Transaction.userEvent) ?? userEvent;
      }),
    );
    type(view, 'x');
    expect(view.state.doc.toString()).toBe('hello x');
    expect(userEvent).toBe('input.type');
  });

  it('goes through the input handlers: a bracket wraps the selection', () => {
    const view = editor('a + b', 0, 5, closeBrackets());
    type(view, '(');
    expect(view.state.doc.toString()).toBe('(a + b)');
  });

  it('types over every range of a multiple selection', () => {
    const view = editor('ab ab', 0, 1, EditorState.allowMultipleSelections.of(true));
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(3, 4)]),
    });
    type(view, 'z');
    expect(view.state.doc.toString()).toBe('zb zb');
  });

  it('leaves the browser alone with nothing selected, while composing, or for other inputs', () => {
    const empty = editor('abc', 1, 1);
    expect(type(empty, 'x')).toBe(true);
    expect(empty.state.doc.toString()).toBe('abc');

    const composing = editor('abc', 0, 3);
    expect(type(composing, 'x', { isComposing: true })).toBe(true);
    expect(
      composing.contentDOM.dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'insertParagraph', cancelable: true }),
      ),
    ).toBe(true);
    expect(composing.state.doc.toString()).toBe('abc');

    const readOnly = editor('abc', 0, 3, EditorState.readOnly.of(true));
    expect(type(readOnly, 'x')).toBe(true);
    expect(readOnly.state.doc.toString()).toBe('abc');
  });
});
