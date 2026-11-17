import { insertNewlineAndIndent } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { JsonEditor } from './JsonEditor';

function viewOf(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor');
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('no editor');
  return view;
}

/** Types `text` a character at a time, the way key presses do: through the input handlers. */
function type(view: EditorView, text: string) {
  for (const char of text) typeChar(view, char);
}

function typeChar(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  const insert = () =>
    view.state.update({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.type',
    });
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, insert));
  if (!handled) view.dispatch(insert());
}

function Controlled({
  onChange,
  singleLine,
}: {
  onChange: (text: string) => void;
  singleLine?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <JsonEditor
      label="JSON"
      singleLine={singleLine}
      value={value}
      onChange={(text) => {
        setValue(text);
        onChange(text);
      }}
    />
  );
}

describe('JsonEditor', () => {
  it('closes braces, brackets and quotes as they are typed', () => {
    const onChange = vi.fn();
    const { container } = render(<Controlled onChange={onChange} />);
    const view = viewOf(container);
    type(view, '{');
    expect(view.state.doc.toString()).toBe('{}');
    type(view, '"');
    expect(view.state.doc.toString()).toBe('{""}');
    type(view, 'a');
    type(view, '"');
    expect(view.state.doc.toString()).toBe('{"a"}');
    type(view, ': [');
    expect(view.state.doc.toString()).toBe('{"a": []}');
    expect(onChange).toHaveBeenLastCalledWith('{"a": []}');
  });

  it('opens an indented block on Enter between braces', () => {
    const { container } = render(<Controlled onChange={vi.fn()} />);
    const view = viewOf(container);
    type(view, '{');
    insertNewlineAndIndent(view);
    expect(view.state.doc.toString()).toBe('{\n  \n}');
    type(view, '"a": {');
    insertNewlineAndIndent(view);
    expect(view.state.doc.toString()).toBe('{\n  "a": {\n    \n  }\n}');
  });

  it('keeps a single-line field on one line and submits on Enter', () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const { container } = render(
      <JsonEditor label="Filter" singleLine value="" onChange={onChange} onSubmit={onSubmit} />,
    );
    const view = viewOf(container);
    view.dispatch({ changes: { from: 0, insert: '{\n  "a": 1\n}' }, userEvent: 'input.paste' });
    expect(view.state.doc.toString()).toBe('{   "a": 1 }');
    expect(view.state.doc.lines).toBe(1);
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(view.state.doc.lines).toBe(1);
  });

  it('follows a value set from outside', () => {
    const { container, rerender } = render(
      <JsonEditor label="JSON" value='{"a": 1}' onChange={vi.fn()} />,
    );
    expect(viewOf(container).state.doc.toString()).toBe('{"a": 1}');
    rerender(<JsonEditor label="JSON" value='{"b": 2}' onChange={vi.fn()} />);
    expect(viewOf(container).state.doc.toString()).toBe('{"b": 2}');
  });

  it('labels the editable element and marks the field invalid', () => {
    const { container } = render(
      <JsonEditor
        label="Filter"
        id="f"
        singleLine
        invalid
        contentAttributes={{ 'data-field': 'filter' }}
        value=""
        onChange={vi.fn()}
      />,
    );
    const content = viewOf(container).contentDOM;
    expect(content.getAttribute('aria-label')).toBe('Filter');
    expect(content.id).toBe('f');
    expect(content.dataset.field).toBe('filter');
    expect(container.firstElementChild?.getAttribute('aria-invalid')).toBe('true');
  });
});
