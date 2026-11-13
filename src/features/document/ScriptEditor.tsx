import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput } from '@codemirror/language';
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
import { cspSafeEditor } from '../../ui/editorCsp';
import { consoleCompletionExtension } from '../completion/consoleCompletion';
import { mongoshProvider } from '../completion/consoleProviders';
import { sqlEditorTheme } from '../query/editorTheme';
import { errorRange } from '../query/errorMarks';
import { getQueryTabState, useQueryTabStore } from '../query/queryTabStore';
import styles from './ScriptConsole.module.css';
import { useScriptTab } from './scriptStore';

/** The app's run shortcuts (rebindable, F-121), ahead of CodeMirror's own keys. */
const SCRIPT_ACTIONS: readonly ActionId[] = ['query.run', 'query.runStatement', 'query.cancel'];

function actionKeys(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event) => {
        const id = SCRIPT_ACTIONS.find((action) => matchesAction(event, action));
        if (!id || !runAction(id)) return false;
        event.preventDefault();
        return true;
      },
    }),
  );
}

const setErrorMark = StateEffect.define<TextRange | null>();
const errorMark = Decoration.mark({ class: 'cm-error-range' });

/** Where the last run failed, underlined until the text changes. */
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

/**
 * The mongosh editor of a document query tab: JavaScript as mongosh takes it. Like the SQL
 * editor, it mirrors its text and selection into `queryTabStore`, which is what runs, saves and
 * restores the tab.
 */
export function ScriptEditor({ tabId }: { tabId: string }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const label = t('mongo.script.editor');
  const labelRef = useRef(label);
  const { outcome, sourceText } = useScriptTab(tabId);
  const position = outcome?.failure?.position ?? null;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const stored = getQueryTabState(tabId);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: stored.content,
        selection: {
          anchor: Math.min(stored.selection.anchor, stored.content.length),
          head: Math.min(stored.selection.head, stored.content.length),
        },
        extensions: [
          cspSafeEditor(),
          actionKeys(),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          bracketMatching(),
          indentOnInput(),
          search({ top: true }),
          keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
          javascript(),
          consoleCompletionExtension(mongoshProvider(tabId)),
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
      useQueryTabStore
        .getState()
        .setScroll(tabId, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
      viewRef.current = null;
      view.destroy();
    };
  }, [tabId]);

  // The failure of the last run, marked where it happened while the text is the one that ran.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    const range =
      position !== null && sourceText === text ? errorRange(text, position.offset) : null;
    view.dispatch({ effects: setErrorMark.of(range) });
  }, [position, sourceText]);

  return <div ref={host} className={styles.editor} data-testid="script-editor" />;
}
