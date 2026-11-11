import {
  completionStatus,
  insertBracket,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext as CmContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { translate } from '../../i18n/i18n';
import { useI18nStore } from '../../i18n/i18n';
import type { Engine, TextRange } from '../../ipc';
import { ipc, unwrap } from '../../ipc';
import { StatementLookup } from '../query/statementLookup';
import type { CatalogIndex } from './catalogIndex';
import { ensureCatalog, needsCatalog, peekCatalog, resolveDatabase } from './catalogStore';
import { analyze } from './completionContext';
import { buildInfo, type InfoEnv } from './completionInfo';
import { relationColumns, suggest, type Suggestion } from './completionOptions';
import type { Quoting } from './identifierQuoting';
import { vocabularyOf } from './sqlVocabulary';

declare global {
  interface Window {
    /**
     * Durations (ms) of each run of the source, recorded while an array is set here: what the
     * P-05 measurement (`pnpm perf:completion`) reads. Nothing is recorded otherwise.
     */
    __yadbeCompletionTimings?: number[];
  }
}

/**
 * Requests that found the catalog missing, per editor: asked again when it arrives, if the user
 * is still where they were (see `dropPendingCompletion`).
 */
const pending = new WeakMap<EditorView, { doc: Text; pos: number }>();

/**
 * Editors whose user moved on (ran the script) and has not typed or moved the cursor since:
 * CodeMirror asks a pending source again after every transaction, which must not make a late
 * catalog open the list unasked.
 */
const settled = new WeakSet<EditorView>();

/** The user ran the script: a catalog that arrives from now on opens nothing by itself. */
export function settleCompletion(view: EditorView): void {
  pending.delete(view);
  settled.add(view);
}

/** The user typed or moved the cursor: completion is theirs to ask again. */
export function wakeCompletion(view: EditorView): void {
  settled.delete(view);
}

/** Where the editor's statements run: enough to find the catalog to complete from. */
export interface CompletionTarget {
  connectionId: string;
  /** The tab's own database; `null` for its connection's. */
  database: string | null;
  connectionDatabase: string;
  /** The connection is open: the catalog can be read. Otherwise only what is cached is used. */
  connected: boolean;
}

export interface CompletionHost {
  engine: () => Engine;
  quoting: () => Quoting;
  /** `null` when the tab has no connection. */
  target: () => CompletionTarget | null;
  /** Suggest while typing; off, only `Ctrl+Space` asks. */
  asYouType: () => boolean;
  tableDetails: InfoEnv['tableDetails'];
}

/** Longest wait for the statement under the cursor before the whole script is used. */
const STATEMENT_WAIT_MS = 50;

const WORD_BEFORE = /[\p{L}\p{N}_$#@]*/u;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The completion source of a SQL editor: finds the statement under the cursor, works out what
 * is expected there (`completionContext`), asks `completionOptions` for the ranked suggestions
 * and hands them to CodeMirror, which only displays them (`filter: false`: the order is ours).
 */
export function sqlCompletionSource(host: CompletionHost): CompletionSource {
  const lookup = new StatementLookup();
  let lastDoc: Text | null = null;
  let lastEngine: Engine | null = null;
  let version = 0;
  const databases = new Map<string, Promise<string | null>>();
  /** File engines: the database the server calls current, once known. */
  const knownDatabases = new Map<string, string>();

  const databaseOf = (target: CompletionTarget): Promise<string | null> => {
    const named = target.database ?? target.connectionDatabase;
    if (named.trim() !== '') return Promise.resolve(named);
    let found = databases.get(target.connectionId);
    if (!found) {
      found = resolveDatabase(target.connectionId, null, '').then((database) => {
        if (database !== null) knownDatabases.set(target.connectionId, database);
        return database;
      });
      databases.set(target.connectionId, found);
    }
    return found;
  };

  /**
   * The index if it is there. Missing or out of date, it is read in the background: the
   * request that found nothing is asked again once the catalog arrives.
   */
  const catalogFor = (target: CompletionTarget, cm: CmContext): CatalogIndex | null => {
    const load = (database: string, forRequest: boolean) => {
      if (!target.connected || !needsCatalog(target.connectionId, database)) return;
      const { view } = cm;
      if (forRequest && view && (cm.explicit || !settled.has(view))) {
        pending.set(view, { doc: cm.state.doc, pos: cm.pos });
      }
      void ensureCatalog(target.connectionId, database).then(() => {
        if (!view) return;
        const request = pending.get(view);
        pending.delete(view);
        if (!request) return;
        // Still where the request was made, in the editor the user is working in (a list that
        // pops up unasked, after a run or in another tab's editor, is noise): show what the
        // catalog brings.
        const { state } = view;
        const focused = view.dom.contains(view.dom.ownerDocument.activeElement);
        if (focused && state.doc === request.doc && state.selection.main.head === request.pos) {
          startCompletion(view);
        }
      });
    };
    const named = target.database ?? target.connectionDatabase;
    if (named.trim() === '') {
      if (target.connected) {
        void databaseOf(target).then((database) => {
          if (database !== null) load(database, true);
        });
      }
      const database = knownDatabases.get(target.connectionId);
      return database === undefined ? null : peekCatalog(target.connectionId, database);
    }
    const index = peekCatalog(target.connectionId, named);
    load(named, index === null);
    return index;
  };

  const statementOf = async (state: EditorState, pos: number): Promise<TextRange> => {
    const engine = host.engine();
    if (engine !== lastEngine) {
      lastEngine = engine;
      lookup.reset();
    }
    if (state.doc !== lastDoc) {
      lastDoc = state.doc;
      version += 1;
    }
    const whole = { from: 0, to: state.doc.length };
    let found: TextRange | null | undefined;
    try {
      const text = state.doc.toString();
      found = await withTimeout(
        lookup.at(version, pos, () => unwrap(ipc.commands.statementAt(engine, text, pos))),
        STATEMENT_WAIT_MS,
      );
    } catch {
      return whole;
    }
    // Between statements or in a comment-only stretch the splitter has nothing to say, and a
    // cursor past a finished statement is in a new one: the whole script is read, and the
    // analysis cuts it at the `;` around the cursor.
    if (found === undefined || found === null) return whole;
    if (pos < found.from || pos > found.to) {
      const closed = state.sliceDoc(Math.max(found.from, found.to - 1), found.to) === ';';
      return pos > found.to && !closed ? { from: found.from, to: pos } : whole;
    }
    return found;
  };

  const compute: CompletionSource = async (cm) => {
    const { state, pos, explicit } = cm;
    if (!explicit) {
      if (!host.asYouType()) return null;
      const word = cm.matchBefore(WORD_BEFORE);
      const typed = word !== null && word.to > word.from;
      if (!typed && state.sliceDoc(Math.max(0, pos - 1), pos) !== '.') return null;
    }
    const engine = host.engine();
    const quoting = host.quoting();
    const target = host.target();
    const index = target ? catalogFor(target, cm) : null;
    const range = await statementOf(state, pos);
    if (cm.aborted) return null;
    const ctx = analyze({
      text: state.sliceDoc(range.from, Math.max(range.to, pos)),
      base: range.from,
      cursor: pos,
      rules: quoting,
      columnsOf: (path) => relationColumns(index, path),
    });
    const suggestions = suggest(ctx, index, vocabularyOf(engine), quoting);
    if (suggestions.length === 0) return null;
    const env: InfoEnv = {
      index,
      locale: useI18nStore.getState().locale,
      tableDetails: host.tableDetails,
    };
    const result: CompletionResult = {
      from: ctx.from,
      to: ctx.to,
      filter: false,
      options: suggestions.map((suggestion) => toCompletion(suggestion, env)),
    };
    return result;
  };

  return async (cm) => {
    const sink = window.__yadbeCompletionTimings;
    if (!sink) return compute(cm);
    const started = performance.now();
    try {
      return await compute(cm);
    } finally {
      sink.push(performance.now() - started);
    }
  };
}

function toCompletion(suggestion: Suggestion, env: InfoEnv): Completion {
  const completion: Completion = {
    label: suggestion.label,
    type: suggestion.kind,
    detail: suggestion.detail || (suggestion.kind === 'join' ? kindLabel('join', env) : undefined),
    apply: (view, picked, from, to) => {
      const call = suggestion.cursorBack === 1 && suggestion.insert.endsWith('()');
      // A call goes in as its name and a bracket pair the editor tracks, so that typing the
      // closing `)` steps over it instead of doubling it.
      const insert = call ? suggestion.insert.slice(0, -2) : suggestion.insert;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(picked),
      });
      if (call) {
        const paired = insertBracket(view.state, '(');
        if (paired) {
          view.dispatch(paired);
        } else {
          const head = view.state.selection.main.head;
          view.dispatch({ changes: { from: head, insert: '()' }, selection: { anchor: head + 1 } });
        }
      }
      // `shop.` / `o.` go on: the members are the next thing wanted.
      if (suggestion.follow) {
        setTimeout(() => {
          if (completionStatus(view.state) === null) startCompletion(view);
        }, 0);
      }
    },
  };
  const info = suggestion.info;
  if (info) completion.info = () => buildInfo(info, env);
  return completion;
}

function kindLabel(kind: 'join', env: InfoEnv): string {
  return translate(env.locale, `completion.kind.${kind}`);
}
