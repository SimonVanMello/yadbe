import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/**
 * Completion of the consoles of the other engine families (mongosh, search requests, Redis
 * commands). Each family has a pure part, which reads the text before the cursor and says what
 * is being typed (`mongoshContext`, `searchContext`, `redisContext`) and what to offer for it
 * (`mongoshOptions`, …), and a provider that feeds it the metadata the explorer already holds.
 * This file is the CodeMirror side they share, like `completionExtension.ts` is for SQL.
 */

/** One suggestion, before CodeMirror sees it. */
export interface ConsoleOption {
  label: string;
  /** What gets inserted when it differs from the label. */
  apply?: string;
  /** `method`, `property`, `variable`, `keyword`, `class`, `constant`, `text`, `namespace`. */
  type: string;
  detail?: string;
  /** Higher first among the matches. */
  boost?: number;
}

/** What to offer and which part of the line it replaces. */
export interface ConsoleSuggestions {
  from: number;
  to: number;
  options: ConsoleOption[];
}

/**
 * The text before the cursor is all the pure parts read, so a provider is a function of that
 * and `explicit` (the user pressed Ctrl+Space).
 */
export type ConsoleProvider = (
  text: string,
  position: number,
  explicit: boolean,
) => ConsoleSuggestions | null | Promise<ConsoleSuggestions | null>;

/** `a` before `b` among the options that match, with a stable order inside each group. */
export function byLabel(a: ConsoleOption, b: ConsoleOption): number {
  return (b.boost ?? 0) - (a.boost ?? 0) || a.label.localeCompare(b.label);
}

/** The options whose label starts with `prefix` (ignoring case), best first. */
export function startingWith(options: readonly ConsoleOption[], prefix: string): ConsoleOption[] {
  const lower = prefix.toLowerCase();
  const seen = new Set<string>();
  return options
    .filter((option) => {
      if (seen.has(option.label) || !option.label.toLowerCase().startsWith(lower)) return false;
      seen.add(option.label);
      // Typing it out in full leaves nothing to suggest.
      return option.label.length > prefix.length || option.label !== prefix;
    })
    .sort(byLabel);
}

/** How many suggestions the list shows at most. */
const MAX_OPTIONS = 60;

function toResult(suggestions: ConsoleSuggestions): CompletionResult {
  return {
    from: suggestions.from,
    to: suggestions.to,
    options: suggestions.options.slice(0, MAX_OPTIONS).map((option): Completion => ({
      label: option.label,
      apply: option.apply,
      type: option.type,
      detail: option.detail,
      boost: option.boost,
    })),
    // The pure part filters on its own: CodeMirror must not drop what it decided to offer.
    filter: false,
  };
}

/** Suggestions while typing and on `Ctrl+Space`; `Tab` accepts one when the list is open. */
export function consoleCompletionExtension(provider: ConsoleProvider): Extension {
  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const text = context.state.doc.toString();
    const found = await provider(text, context.pos, context.explicit);
    if (context.aborted || found === null || found.options.length === 0) return null;
    return toResult(found);
  };
  return [
    autocompletion({
      override: [source],
      icons: false,
      activateOnTypingDelay: 20,
      maxRenderedOptions: MAX_OPTIONS,
    }),
    Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ];
}
