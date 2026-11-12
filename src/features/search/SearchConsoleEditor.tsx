import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, StreamLanguage } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { matchesAction, runAction, type ActionId } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { styleNonce } from '../../ui/cspNonce';
import { sqlEditorTheme } from '../query/editorTheme';
import { getQueryTabState, useQueryTabStore } from '../query/queryTabStore';
import styles from './SearchConsole.module.css';

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
  const label = t('search.console.editor');
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
    return () => {
      useQueryTabStore
        .getState()
        .setScroll(tabId, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      view.destroy();
    };
  }, [tabId]);

  return <div ref={host} className={styles.editor} data-testid="search-console-editor" />;
}
