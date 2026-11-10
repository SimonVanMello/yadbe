const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * Whether `target` is somewhere the user types text, where ⌘Z / Ctrl+Z belong to the field's own
 * history: text inputs, textareas, selects, contenteditable (CodeMirror included).
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  // jsdom has no `isContentEditable`; a CodeMirror editor is also identified by its class.
  return target.closest('.cm-editor, [contenteditable]:not([contenteditable="false"])') !== null;
}
