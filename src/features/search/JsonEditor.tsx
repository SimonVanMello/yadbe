import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, StreamLanguage } from '@codemirror/language';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { styleNonce } from '../../ui/cspNonce';
import { sqlEditorTheme } from '../query/editorTheme';
import styles from './SearchEdit.module.css';

/** JSON, coloured: keys, strings, numbers, literals. Colour only. */
const jsonSyntax = StreamLanguage.define<null>({
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      for (;;) {
        const next = stream.next();
        if (next === undefined) break;
        if (next === '"' && !escaped) break;
        escaped = !escaped && next === '\\';
      }
      return stream.match(/^\s*:/, false) ? 'propertyName' : 'string';
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^(true|false|null)\b/)) return 'atom';
    stream.next();
    return null;
  },
});

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

interface JsonEditorProps {
  /** The text to start from (read when the editor mounts). */
  initial: string;
  onChange: (text: string) => void;
  label: string;
  /** Where the text stops being JSON (1-based), underlined. */
  error: { line: number; column: number } | null;
}

/** A JSON editor (a document's `_source`): line numbers, brackets, the error underlined. */
export function JsonEditor({ initial, onChange, label, error }: JsonEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  const start = useRef(initial);
  useEffect(() => {
    change.current = onChange;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const nonce = styleNonce();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: start.current,
        extensions: [
          nonce === null ? [] : EditorView.cspNonce.of(nonce),
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          jsonSyntax,
          markField,
          sqlEditorTheme,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [label]);

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

  return <div ref={host} className={styles.editor} data-testid="search-json-editor" />;
}
