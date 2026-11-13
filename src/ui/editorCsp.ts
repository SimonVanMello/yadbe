import type { Extension, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { styleNonce } from './cspNonce';

/**
 * Types `event` over the selection through CodeMirror instead of the browser's own editing.
 * WebKit replaces selected text in a contenteditable by deleting it, then inserting the new
 * text with the deleted text's style, which it carries on a temporary element as a `style`
 * attribute. The app's CSP blocks that attribute (`style-src-attr`, nonces only), so each
 * keystroke over a selection raised a violation report, though CodeMirror redrew the line
 * right after and nothing showed. Here the browser does nothing: the text goes through the
 * editor's input handlers (bracket closing…) and lands as a normal typed input.
 *
 * Only plain typing over a non-empty selection is taken: a composition (IME, dead keys) and
 * every other input stay with the browser and CodeMirror, as do editors driven by an
 * EditContext (no DOM editing there).
 */
export function typeOverSelection(view: EditorView, event: InputEvent): boolean {
  if (event.inputType !== 'insertText' || event.data === null || event.data === '') return false;
  if (event.isComposing || view.composing || !event.cancelable) return false;
  if ((view.contentDOM as { editContext?: unknown }).editContext) return false;
  const { state } = view;
  if (state.readOnly || state.selection.ranges.every((range) => range.empty)) return false;
  event.preventDefault();
  const text = event.data;
  const { from, to } = state.selection.main;
  let typed: Transaction | null = null;
  const insert = () =>
    (typed ??= state.update(state.replaceSelection(text), {
      userEvent: 'input.type',
      scrollIntoView: true,
    }));
  const handled = state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, insert));
  if (!handled) view.dispatch(insert());
  return true;
}

/**
 * What every CodeMirror editor of the app needs under its CSP (`tauri build`: styles only with
 * the page's nonce, no style attributes): the nonce on the `<style>` tags CodeMirror injects,
 * and typing over a selection kept away from the browser's editing ({@link typeOverSelection}).
 */
export function cspSafeEditor(): Extension {
  const nonce = styleNonce();
  return [
    nonce === null ? [] : EditorView.cspNonce.of(nonce),
    EditorView.domEventHandlers({
      beforeinput: (event, view) => typeOverSelection(view, event),
    }),
  ];
}
