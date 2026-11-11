import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';

import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { snippetCompletionSource, withSnippets } from '../library/snippetCompletion';
import { sqlCompletionSource, type CompletionHost } from './completionSource';

/** One-letter marks of the kinds of suggestion; the full name is the mark's tooltip. */
const GLYPHS: Record<string, string> = {
  table: 'T',
  view: 'V',
  materializedView: 'M',
  schema: 'S',
  column: 'C',
  function: 'ƒ',
  procedure: 'P',
  keyword: 'K',
  type: 'Y',
  alias: 'A',
  cte: 'W',
  join: 'J',
  snippet: '{}',
};

/** Pause after a keystroke before the suggestions start: short, the source is what takes time. */
const TYPING_DELAY_MS = 20;

function kindMark(type: string | undefined): Node | null {
  if (type === undefined) return null;
  const mark = document.createElement('span');
  mark.className = 'cm-yadbe-kind';
  mark.dataset.kind = type;
  mark.textContent = GLYPHS[type] ?? '';
  mark.title = translate(useI18nStore.getState().locale, `completion.kind.${type}` as MessageKey);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/**
 * Schema-aware completion for a SQL editor (F-043): suggestions while typing and on
 * `Ctrl+Space`, `Esc` closes, `Enter` and `Tab` accept. `Mod+Enter` (run) is bound above this and
 * is never swallowed.
 */
export function completionExtension(host: CompletionHost): Extension {
  return [
    autocompletion({
      override: [withSnippets(sqlCompletionSource(host), snippetCompletionSource(host))],
      icons: false,
      activateOnTypingDelay: TYPING_DELAY_MS,
      maxRenderedOptions: 60,
      addToOptions: [{ render: (completion) => kindMark(completion.type), position: 20 }],
      optionClass: (completion) => `cm-yadbe-option cm-yadbe-option-${completion.type ?? 'none'}`,
    }),
    // Tab accepts a suggestion when one is open; with none, it indents as before.
    Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ];
}
