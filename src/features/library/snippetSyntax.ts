/**
 * The snippet template syntax (a small subset of CodeMirror's, which expands it):
 *
 * - `${1:name}`: a tab stop with a default text. `Tab` moves from stop 1 to 2 to 3…, `Esc` leaves
 *   the snippet. The same number again (`${1}`) mirrors what is typed in the first one.
 * - `${connection}`, `${database}`, `${date}`: replaced when the snippet expands, by the name of
 *   the tab's connection, its database and today's date (`2026-01-31`).
 *
 * Everything else is plain text. Any other `${word}` becomes a tab stop named `word`.
 */

export const SNIPPET_VARIABLES = ['connection', 'database', 'date'] as const;
export type SnippetVariable = (typeof SNIPPET_VARIABLES)[number];

/** What the variables stand for when a snippet expands. */
export type SnippetContext = Record<SnippetVariable, string>;

/** `${1}`, `${1:text}`, `#{1}` or `${name}`: the same grammar as CodeMirror's `snippet`. */
const FIELD = /[#$]\{(?:(\d+)(?::([^}]*))?|((?:\\[{}]|[^}])*))\}/g;

function isVariable(name: string): name is SnippetVariable {
  return (SNIPPET_VARIABLES as readonly string[]).includes(name);
}

/** Today as `YYYY-MM-DD`, in the local time zone. */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The template with its variables replaced; the tab stops are left for the editor. */
export function expandVariables(template: string, context: SnippetContext): string {
  return template.replace(FIELD, (match, _number, _text, name: string | undefined) =>
    name !== undefined && isVariable(name) ? context[name] : match,
  );
}

/** A tab stop of a template: its number and the text it starts with. */
export interface SnippetField {
  index: number;
  placeholder: string;
}

/** The numbered tab stops of a template, in the order `Tab` visits them. */
export function snippetFields(template: string): SnippetField[] {
  const fields = new Map<number, string>();
  for (const match of template.matchAll(FIELD)) {
    const [, number, text] = match;
    if (number === undefined) continue;
    const index = Number(number);
    if (!fields.has(index) || (fields.get(index) === '' && text)) fields.set(index, text ?? '');
  }
  return [...fields.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, placeholder]) => ({ index, placeholder }));
}

/**
 * The template as plain text, tab stops replaced by their default text: what opening or running
 * a snippet as a query sends. A stop that repeats another one repeats its text.
 */
export function flattenSnippet(template: string, context: SnippetContext): string {
  const seen = new Map<number, string>();
  return template.replace(
    FIELD,
    (_match, number: string | undefined, text: string | undefined, name: string | undefined) => {
      if (number !== undefined) {
        const index = Number(number);
        const value = text ?? seen.get(index) ?? '';
        if (!seen.has(index) || (seen.get(index) === '' && text)) seen.set(index, value);
        return value;
      }
      const word = name ?? '';
      return isVariable(word) ? context[word] : word;
    },
  );
}

/** Whether a template has anything the editor must expand (a field or a variable). */
export function hasPlaceholders(template: string): boolean {
  return new RegExp(FIELD.source).test(template);
}
