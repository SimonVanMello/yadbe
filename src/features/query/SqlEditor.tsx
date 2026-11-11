import { closeBrackets, closeBracketsKeymap, snippet } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
} from '@codemirror/view';
import { useEffect, useMemo, useRef } from 'react';

import { runAction, type ActionId } from '../../app/actions';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { Engine, TextRange } from '../../ipc';
import { styleNonce } from '../../ui/cspNonce';
import { useCatalogLoading } from '../completion/catalogStore';
import { completionExtension } from '../completion/completionExtension';
import { createCompletionHost } from '../completion/completionHost';
import { STANDARD_QUOTING, quotingOf, type Quoting } from '../completion/identifierQuoting';
import { useEngineInfo } from '../connections/connectionStore';
import { usePreference, usePreferenceStore } from '../preferences/preferenceStore';
import { currentOffset, markRun, queryFields, setErrors, setStatement } from './editorFields';
import { editorOptions, type EditorPreferences } from './editorOptions';
import { editorPhrases } from './editorPhrases';
import { useEditorCursorStore } from './editorCursorStore';
import { registerEditor, type EditorController } from './editorRegistry';
import { sqlEditorTheme } from './editorTheme';
import { errorMarks } from './errorMarks';
import { useTabExecution } from './executionStore';
import { getQueryTabState, useQueryTabStore } from './queryTabStore';
import styles from './SqlEditor.module.css';
import { sqlLanguage } from './sqlLanguage';

/** Line and column of the main cursor, for the status bar. `lineAt` is logarithmic. */
function reportCursor(tabId: string, state: EditorState): void {
  const { from, to, head } = state.selection.main;
  const line = state.doc.lineAt(head);
  useEditorCursorStore
    .getState()
    .set(tabId, { line: line.number, column: head - line.from + 1, selected: to - from });
}

/**
 * Editor states kept while a tab's editor is unmounted (the editor only exists for the active
 * tab), so that undo history survives a tab switch. Serialized, not live: a state keeps the
 * closures of the component that built it, and the next mount builds fresh ones.
 */
const savedStates = new Map<string, unknown>();

/** Forgets the undo history of a closed tab. */
export function forgetEditorState(tabId: string): void {
  savedStates.delete(tabId);
}

function currentOptions(): EditorPreferences {
  const { values } = usePreferenceStore.getState();
  return {
    tabSize: values.tabSize,
    indentWithSpaces: values.indentWithSpaces,
    lineWrapping: values.lineWrapping,
    lineNumbers: values.lineNumbers,
    highlightStatement: values.highlightStatement,
  };
}

const SCROLL_SAVE_DELAY_MS = 200;

function runKeys(): Extension {
  const bind = (key: string, action: ActionId) => ({
    key,
    // Handled by the action registry (also reachable from the toolbar and the palette); CodeMirror
    // only has to keep its own `Mod-Enter` (insert blank line) from winning.
    run: () => runAction(action),
    preventDefault: true,
  });
  return Prec.highest(
    keymap.of([
      bind('Mod-Enter', 'query.run'),
      bind('Mod-Shift-Enter', 'query.runStatement'),
      bind('Mod-.', 'query.cancel'),
      // CodeMirror's search keymap binds `Mod-Shift-l` (select every match): the library is ours.
      bind('Mod-Shift-l', 'query.saveToLibrary'),
    ]),
  );
}

interface EditorOptions {
  tabId: string;
  getEngine: () => Engine;
  label: string;
  /** Schema-aware suggestions (F-043). */
  completion: Extension;
}

function editorExtensions(
  options: EditorOptions,
  compartments: { language: Compartment; phrases: Compartment; options: Compartment },
  engine: Engine,
  locale: 'en' | 'fr',
): Extension {
  const { tabId } = options;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  const nonce = styleNonce();
  return [
    // Outside `tauri dev` the CSP only accepts styles with the page's nonce: CodeMirror injects
    // `<style>` tags of its own.
    nonce === null ? [] : EditorView.cspNonce.of(nonce),
    runKeys(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    // Alt+click adds a cursor (F-040: multi-cursor); `Mod-d` and `Mod-Alt-Up/Down` do too.
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    indentOnInput(),
    compartments.options.of(editorOptions(currentOptions(), options.getEngine)),
    bracketMatching(),
    closeBrackets(),
    options.completion,
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    compartments.language.of(sqlLanguage(engine)),
    compartments.phrases.of(locale === 'fr' ? EditorState.phrases.of(editorPhrases('fr')) : []),
    sqlEditorTheme,
    queryFields,
    EditorView.contentAttributes.of({ 'aria-label': options.label }),
    EditorView.updateListener.of((update) => {
      const state = useQueryTabStore.getState();
      if (update.docChanged) state.setContent(tabId, update.state.doc.toString());
      if (update.docChanged || update.selectionSet) {
        const { anchor, head } = update.state.selection.main;
        state.setSelection(tabId, { anchor, head });
        reportCursor(tabId, update.state);
      }
    }),
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const current = useQueryTabStore.getState();
          if (tabId in current.tabs) {
            current.setScroll(tabId, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
          }
        }, SCROLL_SAVE_DELAY_MS);
      },
    }),
  ];
}

interface SqlEditorProps {
  tabId: string;
  /** The engine of the tab's connection: picks the SQL dialect. */
  engine: Engine;
  /** The tab's connection, whose cached schema feeds the suggestions. */
  connectionId: string;
  /** The connection's own database (empty for file engines). */
  connectionDatabase: string;
}

/**
 * The SQL editor of a query tab (F-040). CodeMirror owns the text while it is mounted and
 * mirrors it, the selection and the scroll position into `queryTabStore`, which is what runs,
 * saves and restores. The tab's `EditorController` (see `editorRegistry.ts`) lets the rest of the
 * app jump to an error or replace the text.
 */
export function SqlEditor({ tabId, engine, connectionId, connectionDatabase }: SqlEditorProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartments = useRef({
    language: new Compartment(),
    phrases: new Compartment(),
    options: new Compartment(),
  });
  const engineRef = useRef(engine);
  const labelRef = useRef(t('editor.label'));
  const execution = useTabExecution(tabId);
  const engineInfo = useEngineInfo(engine);
  const quotingRef = useRef<Quoting>(STANDARD_QUOTING);
  const databaseRef = useRef(connectionDatabase);
  const connectionRef = useRef(connectionId);
  const loadingSchema = useCatalogLoading(connectionId);

  useEffect(() => {
    quotingRef.current = engineInfo ? quotingOf(engineInfo.capabilities) : STANDARD_QUOTING;
  }, [engineInfo]);

  useEffect(() => {
    databaseRef.current = connectionDatabase;
    connectionRef.current = connectionId;
  }, [connectionDatabase, connectionId]);

  useEffect(() => {
    engineRef.current = engine;
    viewRef.current?.dispatch({
      effects: compartments.current.language.reconfigure(sqlLanguage(engine)),
    });
  }, [engine]);

  const tabSize = usePreference('tabSize');
  const indentWithSpaces = usePreference('indentWithSpaces');
  const lineWrapping = usePreference('lineWrapping');
  const lineNumbersOn = usePreference('lineNumbers');
  const highlightStatement = usePreference('highlightStatement');
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.current.options.reconfigure(
          editorOptions(
            {
              tabSize,
              indentWithSpaces,
              lineWrapping,
              lineNumbers: lineNumbersOn,
              highlightStatement,
            },
            () => engineRef.current,
          ),
        ),
        // The tint of the statement under the cursor goes with its plugin.
        ...(highlightStatement ? [] : [setStatement.of(null)]),
      ],
    });
  }, [tabSize, indentWithSpaces, lineWrapping, lineNumbersOn, highlightStatement]);

  useEffect(() => {
    labelRef.current = t('editor.label');
    viewRef.current?.dispatch({
      effects: compartments.current.phrases.reconfigure(
        locale === 'fr' ? EditorState.phrases.of(editorPhrases('fr')) : [],
      ),
    });
  }, [locale, t]);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const stored = getQueryTabState(tabId);
    const completion = completionExtension(
      createCompletionHost({
        tabId,
        connectionId: () => connectionRef.current,
        connectionDatabase: () => databaseRef.current,
        engine: () => engineRef.current,
        quoting: () => quotingRef.current,
      }),
    );
    const extensions = editorExtensions(
      { tabId, getEngine: () => engineRef.current, label: labelRef.current, completion },
      compartments.current,
      engineRef.current,
      useI18nStore.getState().locale,
    );
    let state: EditorState | null = null;
    const saved = savedStates.get(tabId);
    if (saved !== undefined) {
      try {
        const restored = EditorState.fromJSON(saved, { extensions }, { history: historyField });
        // The store wins: the text may have changed while the editor was away (file read again).
        if (restored.doc.toString() === stored.content) state = restored;
      } catch {
        state = null;
      }
    }
    state ??= EditorState.create({
      doc: stored.content,
      selection: {
        anchor: Math.min(stored.selection.anchor, stored.content.length),
        head: Math.min(stored.selection.head, stored.content.length),
      },
      extensions,
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    reportCursor(tabId, view.state);

    const restoreScroll = () => {
      view.scrollDOM.scrollTop = stored.scrollTop;
      view.scrollDOM.scrollLeft = stored.scrollLeft;
    };
    // Once the first measure gave the document its real height.
    const frame = requestAnimationFrame(restoreScroll);
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('[role="tablist"]')) view.focus();

    const controller: EditorController = {
      focus: () => {
        view.focus();
      },
      jumpTo: (offset) => {
        const pos = currentOffset(view, offset);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        view.focus();
      },
      markRunStart: () => {
        view.dispatch({ effects: markRun.of(null) });
      },
      setErrors: (ranges: readonly TextRange[]) => {
        view.dispatch({ effects: setErrors.of(ranges) });
      },
      replaceContent: (text) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: 0 },
          scrollIntoView: true,
        });
      },
      insertAtCursor: (text) => {
        view.dispatch({
          ...view.state.replaceSelection(text),
          scrollIntoView: true,
          userEvent: 'input.paste',
        });
        view.focus();
      },
      insertSnippet: (template) => {
        const { from, to } = view.state.selection.main;
        view.focus();
        snippet(template)(view, null, from, to);
      },
    };
    const unregister = registerEditor(tabId, controller);

    return () => {
      cancelAnimationFrame(frame);
      unregister();
      const store = useQueryTabStore.getState();
      // A closed tab is already gone from the store: nothing to keep, and nothing to recreate.
      if (tabId in store.tabs) {
        // Last word to the store: a scroll or move still waiting for its timer is not lost.
        store.setScroll(tabId, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
        const { anchor, head } = view.state.selection.main;
        store.setSelection(tabId, { anchor, head });
        savedStates.set(tabId, view.state.toJSON({ history: historyField }));
      }
      useEditorCursorStore.getState().forget(tabId);
      viewRef.current = null;
      view.destroy();
    };
  }, [tabId]);

  // Underline the errors of the latest run, as soon as the messages that carry them arrive.
  const { messages, sourceText } = execution;
  const marks = useMemo(() => errorMarks({ messages, sourceText }), [messages, sourceText]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setErrors.of(marks) });
  }, [marks]);

  return (
    <div className={styles.frame}>
      <div ref={host} className={styles.editor} data-testid="sql-editor" />
      {loadingSchema && (
        <span className={styles.schemaStatus} role="status">
          {t('completion.loading')}
        </span>
      )}
    </div>
  );
}
