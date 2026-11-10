import { afterEach, describe, expect, it } from 'vitest';

import { isTextEntry } from './textEntry';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no element');
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isTextEntry', () => {
  it('is true for text inputs, textareas and selects', () => {
    expect(isTextEntry(mount('<input type="text">'))).toBe(true);
    expect(isTextEntry(mount('<input>'))).toBe(true);
    expect(isTextEntry(mount('<input type="search">'))).toBe(true);
    expect(isTextEntry(mount('<textarea></textarea>'))).toBe(true);
    expect(isTextEntry(mount('<select></select>'))).toBe(true);
  });

  it('is false for buttons and checkboxes', () => {
    expect(isTextEntry(mount('<input type="checkbox">'))).toBe(false);
    expect(isTextEntry(mount('<input type="radio">'))).toBe(false);
    expect(isTextEntry(mount('<button>ok</button>'))).toBe(false);
    expect(isTextEntry(mount('<div></div>'))).toBe(false);
  });

  it('is true inside a contenteditable or a CodeMirror editor', () => {
    const editable = mount('<div contenteditable="true"><span id="in">x</span></div>');
    expect(isTextEntry(editable.querySelector('#in'))).toBe(true);
    const cm = mount('<div class="cm-editor"><div class="cm-content"><div>line</div></div></div>');
    expect(isTextEntry(cm.querySelector('.cm-content > div'))).toBe(true);
  });

  it('is false for a non-element target', () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(window)).toBe(false);
  });
});
