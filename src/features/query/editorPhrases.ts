import type { Locale, MessageKey } from '../../i18n/i18n';
import { translate } from '../../i18n/i18n';

/**
 * Texts of CodeMirror's find/replace panel and "go to line" box, keyed by the English phrase
 * CodeMirror asks for. They go through the app's catalog so that the panel follows the UI
 * language (SPEC §6).
 */
const PHRASES: readonly [phrase: string, key: MessageKey][] = [
  ['Find', 'editor.phrase.find'],
  ['Replace', 'editor.phrase.replace'],
  ['next', 'editor.phrase.next'],
  ['previous', 'editor.phrase.previous'],
  ['all', 'editor.phrase.all'],
  ['match case', 'editor.phrase.matchCase'],
  ['regexp', 'editor.phrase.regexp'],
  ['by word', 'editor.phrase.byWord'],
  ['replace', 'editor.phrase.replaceOne'],
  ['replace all', 'editor.phrase.replaceAll'],
  ['close', 'editor.phrase.close'],
  ['Go to line', 'editor.phrase.goToLine'],
  ['go', 'editor.phrase.go'],
  ['current match', 'editor.phrase.currentMatch'],
  ['on line', 'editor.phrase.onLine'],
  ['Completions', 'completion.listbox'],
];

/** The phrase table CodeMirror's `EditorState.phrases` takes for a language. */
export function editorPhrases(locale: Locale): Record<string, string> {
  return Object.fromEntries(PHRASES.map(([phrase, key]) => [phrase, translate(locale, key)]));
}
