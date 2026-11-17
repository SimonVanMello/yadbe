import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers as lineNumberGutter,
  placeholder as placeholderText,
  type DecorationSet,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { cspSafeEditor } from '../../ui/editorCsp';
import { sqlEditorTheme } from '../query/editorTheme';
import styles from './JsonEditor.module.css';
import { jsonLanguage } from './jsonLanguage';

/** A position in the text, 1-based, as JSON parsers report it. */
export interface JsonPosition {
  line: number;
  column: number;
}

const setMark = StateEffect.define<{ from: number; to: number } | null>();
const mark = Decoration.mark({ class: 'cm-error-range' });

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = transaction.docChanged ? Decoration.none : marks;
    for (const effect of transaction.effects) {
      if (!effect.is(setMark)) continue;
      const range = effect.value;
      next =
        range === null || range.to > transaction.state.doc.length
          ? Decoration.none
          : Decoration.set([mark.range(range.from, range.to)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * One line only: a line break typed or pasted becomes a space. One character for one keeps
 * every position, so the selection of the transaction stays right.
 */
const oneLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes.push({ from, to, insert: inserted.sliceString(0).replace(/\n/g, ' ') });
  });
  return {
    changes,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});

interface JsonEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** The field's name, read by screen readers. */
  label: string;
  /** Put on the editable element (Field's `htmlFor`). */
  id?: string;
  /** A filter bar field: one line, Enter runs `onSubmit`, Tab leaves the field. */
  singleLine?: boolean;
  /** Enter in a single-line field. */
  onSubmit?: () => void;
  lineNumbers?: boolean;
  placeholder?: string;
  invalid?: boolean;
  /** Where the text stops being JSON, underlined. */
  error?: JsonPosition | null;
  autoFocus?: boolean;
  /** Sizes the multi-line box (its height); the box can be resized vertically. */
  className?: string;
  /** Attributes of the editable element (`data-field` for the end-to-end tests…). */
  contentAttributes?: Record<string, string>;
  'data-testid'?: string;
}

/**
 * A JSON field: coloured, `{` `[` `"` closed as they are typed (Backspace removes the pair),
 * Enter between brackets opens an indented block. Replaces a text area or a text input wherever
 * JSON is typed; the value stays plain text, read by the caller.
 */
export function JsonEditor({
  value,
  onChange,
  label,
  id,
  singleLine = false,
  onSubmit,
  lineNumbers = false,
  placeholder,
  invalid = false,
  error = null,
  autoFocus = false,
  className,
  contentAttributes,
  'data-testid': testId,
}: JsonEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  const submit = useRef(onSubmit);
  // Read once, when the editor is built; `value` keeps it in step afterwards.
  const start = useRef({ value, autoFocus, contentAttributes });
  useEffect(() => {
    change.current = onChange;
    submit.current = onSubmit;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const attributes: Record<string, string> = {
      ...start.current.contentAttributes,
      'aria-label': label,
    };
    if (id !== undefined) attributes.id = id;
    if (!singleLine) attributes['aria-multiline'] = 'true';
    const extensions: Extension[] = [
      cspSafeEditor(),
      history(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      jsonLanguage,
      markField,
      sqlEditorTheme,
      EditorView.contentAttributes.of(attributes),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) change.current(update.state.doc.toString());
      }),
    ];
    if (placeholder) extensions.push(placeholderText(placeholder));
    if (singleLine) {
      extensions.push(
        oneLine,
        Prec.highest(
          keymap.of([
            {
              key: 'Enter',
              run: () => {
                submit.current?.();
                return true;
              },
            },
          ]),
        ),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
      );
    } else {
      if (lineNumbers) extensions.push(lineNumberGutter());
      extensions.push(
        highlightActiveLine(),
        EditorState.tabSize.of(2),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      );
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: start.current.value, extensions }),
    });
    viewRef.current = view;
    if (start.current.autoFocus) view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [label, id, singleLine, lineNumbers, placeholder]);

  // A value set from outside (a restored tab, a type switch…) replaces the text.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: value.length },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let range: { from: number; to: number } | null = null;
    if (error) {
      const doc = view.state.doc;
      const line = doc.line(Math.max(1, Math.min(error.line, doc.lines)));
      const from = Math.min(line.from + Math.max(0, error.column - 1), doc.length);
      range = {
        from: Math.max(0, Math.min(from, doc.length - 1)),
        to: Math.min(from + 1, doc.length),
      };
      if (range.to <= range.from) range = null;
    }
    view.dispatch({ effects: setMark.of(range) });
  }, [error]);

  const classes = [styles.box, singleLine ? styles.single : styles.multi, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div ref={host} className={classes} aria-invalid={invalid || undefined} data-testid={testId} />
  );
}
