import {
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete';

import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import type { Engine, SnippetDefinition } from '../../ipc';
import type { CompletionHost } from '../completion/completionSource';
import { findConnection } from '../query/connectionLookup';
import { builtinSnippetsFor } from './builtinSnippets';
import { expandVariables, flattenSnippet, localDate, type SnippetContext } from './snippetSyntax';
import { fetchSnippets } from './useLibrary';

/** The word being typed, letters first: a trigger word is a plain identifier. */
const TRIGGER_WORD = /[A-Za-z][A-Za-z0-9_]*/;

/** A snippet the editor offers: the user's own, or a built-in of the engine's dialect. */
export interface OfferedSnippet {
  id: string;
  trigger: string;
  name: string;
  template: string;
  builtin: boolean;
}

/**
 * The snippets that apply where an editor runs: the global ones and the connection's, then the
 * built-ins of the dialect that no user snippet shadows (same trigger word).
 */
export function offeredSnippets(
  user: readonly SnippetDefinition[],
  connectionId: string | null,
  engine: Engine,
  nameOfBuiltin: (key: MessageKey) => string,
): OfferedSnippet[] {
  const own: OfferedSnippet[] = user
    .filter((def) => def.connectionId === null || def.connectionId === connectionId)
    .map((def) => ({
      id: def.id,
      trigger: def.trigger,
      name: def.name,
      template: def.template,
      builtin: false,
    }));
  const shadowed = new Set(own.map((def) => def.trigger.toLowerCase()));
  const builtins: OfferedSnippet[] = builtinSnippetsFor(engine)
    .filter((def) => !shadowed.has(def.trigger))
    .map((def) => ({
      id: `builtin:${def.trigger}`,
      trigger: def.trigger,
      name: nameOfBuiltin(def.name),
      template: def.template,
      builtin: true,
    }));
  return [...own, ...builtins];
}

/** The offered snippets whose trigger word starts with what is typed, an exact one first. */
export function matchingSnippets(
  offered: readonly OfferedSnippet[],
  typed: string,
): OfferedSnippet[] {
  const word = typed.toLowerCase();
  if (word === '') return [];
  return offered
    .filter((def) => def.trigger.toLowerCase().startsWith(word))
    .sort((a, b) => {
      const exact =
        Number(b.trigger.toLowerCase() === word) - Number(a.trigger.toLowerCase() === word);
      return (
        exact ||
        Number(a.builtin) - Number(b.builtin) ||
        a.trigger.localeCompare(b.trigger) ||
        a.name.localeCompare(b.name)
      );
    });
}

function previewOf(offered: OfferedSnippet, context: SnippetContext): HTMLElement {
  const locale = useI18nStore.getState().locale;
  const info = document.createElement('div');
  const heading = document.createElement('p');
  heading.textContent = translate(locale, 'completion.snippet.info', { name: offered.name });
  const code = document.createElement('pre');
  code.textContent = flattenSnippet(offered.template, context);
  code.style.margin = '0';
  code.style.whiteSpace = 'pre-wrap';
  code.style.fontFamily = 'var(--font-code)';
  info.append(heading, code);
  return info;
}

/**
 * Snippet expansion (F-050), registered next to the SQL source of the editor's completion: typing
 * the start of a trigger word lists the snippets, `Tab` accepts and starts the tab stops.
 */
export function snippetCompletionSource(host: CompletionHost): CompletionSource {
  return async (cm: CompletionContext) => {
    const word = cm.matchBefore(TRIGGER_WORD);
    if (!word || word.to <= word.from) return null;
    // `orders.sel`: a member of something, not a snippet.
    if (cm.state.sliceDoc(Math.max(0, word.from - 1), word.from) === '.') return null;
    if (!cm.explicit && (!host.asYouType() || word.to - word.from < 2)) return null;
    const target = host.target();
    let user: SnippetDefinition[] = [];
    try {
      user = await fetchSnippets();
    } catch {
      // Without the library the built-ins still work.
    }
    if (cm.aborted) return null;
    const locale = useI18nStore.getState().locale;
    const offered = offeredSnippets(user, target?.connectionId ?? null, host.engine(), (key) =>
      translate(locale, key),
    );
    const matches = matchingSnippets(offered, cm.state.sliceDoc(word.from, word.to));
    if (matches.length === 0) return null;
    const contextNow = (): SnippetContext => {
      const current = host.target();
      const connection = findConnection(current?.connectionId ?? null);
      return {
        connection: connection?.name ?? '',
        database: current?.database ?? current?.connectionDatabase ?? '',
        date: localDate(new Date()),
      };
    };
    const options: Completion[] = matches.map((match) => ({
      label: match.trigger,
      detail: match.name,
      type: 'snippet',
      // Resolved once the snippet is applied, with the date of that moment.
      apply: (view, completion, from, to) => {
        snippet(expandVariables(match.template, contextNow()))(view, completion, from, to);
      },
      info: () => previewOf(match, contextNow()),
    }));
    // The editor's own order: snippets lead when a trigger word is being typed.
    return { from: word.from, to: word.to, filter: false, options };
  };
}
