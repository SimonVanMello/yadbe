import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, StreamLanguage } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { matchesAction, runAction, type ActionId } from '../../app/actions';
import { useT } from '../../i18n/useT';
import type { TextRange } from '../../ipc';
import { styleNonce } from '../../ui/cspNonce';
import { consoleCompletionExtension } from '../completion/consoleCompletion';
import { searchProvider } from '../completion/consoleProviders';
import { errorRange } from '../query/errorMarks';
import { sqlEditorTheme } from '../query/editorTheme';
import { getQueryTabState, useQueryTabStore } from '../query/queryTabStore';
import { consoleErrorOffset } from './consoleText';
import styles from './SearchConsole.module.css';
import { useSearchConsole } from './searchConsoleStore';

interface ConsoleState {
  /** On a request line: after the method. */
  afterMethod: boolean;
}

const METHOD = /^(GET|POST|PUT|DELETE|HEAD|PATCH)\b/i;

/**
 * Kibana's console syntax, coloured: the method and path of a request line, then JSON (keys,
 * strings, numbers, literals) and `#` / `//` comment lines. Colour only: the backend reads the
 * requests.
 */
const consoleSyntax = StreamLanguage.define<ConsoleState>({
  startState: () => ({ afterMethod: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.afterMethod = false;
      if (stream.match(/^\s*(#|\/\/).*/)) return 'comment';
      if (stream.match(METHOD)) {
        state.afterMethod = true;
        return 'keyword';
      }
    }
    if (stream.eatSpace()) return null;
    if (state.afterMethod) {
      stream.skipToEnd();
      return 'link';
    }
    const ch = stream.peek();
    if (ch === '"') {
      stream.next();
      let escaped = false;
      for (;;) {
        const next = stream.next();
        if (next === undefined) break;
        if (next === '"' && !escaped) break;
        escaped = !escaped && next === '\\';
      }
      // A string followed by a colon is a key.
      return stream.match(/^\s*:/, false) ? 'propertyName' : 'string';
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^(true|false|null)\b/)) return 'atom';
    stream.next();
    return null;
  },
});

const setErrorMark = StateEffect.define<TextRange | null>();
const errorMark = Decoration.mark({ class: 'cm-error-range' });

/** Where the answer shown says the request is wrong, underlined until the text changes. */
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = transaction.docChanged ? Decoration.none : marks;
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorMark)) continue;
      const range = effect.value;
      next =
        range === null || range.to > transaction.state.doc.length
          ? Decoration.none
          : Decoration.set([errorMark.range(range.from, range.to)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The app's run shortcuts (rebindable, F-121), ahead of CodeMirror's own keys. */
const CONSOLE_ACTIONS: readonly ActionId[] = ['query.run', 'query.runStatement', 'query.cancel'];

function actionKeys(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event) => {
        const id = CONSOLE_ACTIONS.find((action) => matchesAction(event, action));
        if (!id || !runAction(id)) return false;
        event.preventDefault();
        return true;
      },
    }),
  );
}

/**
 * The request editor of a search console. Like the SQL editor, it mirrors its text and
 * selection into `queryTabStore`, which is what runs, saves and restores the tab.
 */
export function SearchConsoleEditor({ tabId }: { tabId: string }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const label = t('search.console.editor');
  const { responses, selected, failure, sourceText } = useSearchConsole(tabId);
  const position = failure
    ? { line: failure.line + 1, column: 1 }
    : (responses[selected]?.errorPosition ?? null);
  const labelRef = useRef(label);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const stored = getQueryTabState(tabId);
    const nonce = styleNonce();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: stored.content,
        selection: {
          anchor: Math.min(stored.selection.anchor, stored.content.length),
          head: Math.min(stored.selection.head, stored.content.length),
        },
        extensions: [
          nonce === null ? [] : EditorView.cspNonce.of(nonce),
          actionKeys(),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          bracketMatching(),
          search({ top: true }),
          keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
          consoleSyntax,
          consoleCompletionExtension(searchProvider(tabId)),
          errorField,
          sqlEditorTheme,
          EditorView.contentAttributes.of({ 'aria-label': labelRef.current }),
          EditorView.updateListener.of((update) => {
            const state = useQueryTabStore.getState();
            if (update.docChanged) state.setContent(tabId, update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const { anchor, head } = update.state.selection.main;
              state.setSelection(tabId, { anchor, head });
            }
          }),
        ],
      }),
    });
    view.scrollDOM.scrollTop = stored.scrollTop;
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      useQueryTabStore
        .getState()
        .setScroll(tabId, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      view.destroy();
    };
  }, [tabId]);

  // The error of the answer shown, marked while the text is the one that ran.
  const line = position?.line ?? null;
  const column = position?.column ?? null;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    const offset =
      line !== null && column !== null && sourceText === text
        ? consoleErrorOffset(text, line, column)
        : null;
    view.dispatch({ effects: setErrorMark.of(offset === null ? null : errorRange(text, offset)) });
  }, [line, column, sourceText]);

  return <div ref={host} className={styles.editor} data-testid="search-console-editor" />;
}
