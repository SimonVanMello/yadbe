/**
 * A forgiving SQL tokenizer for the autocomplete: it only has to tell words, quoted names,
 * strings, comments and punctuation apart, on text that is being typed (unterminated strings and
 * quotes are normal). Statement boundaries are the backend's business (`statementAt`).
 */

export type TokenKind = 'word' | 'quoted' | 'string' | 'comment' | 'number' | 'param' | 'punct';

export interface Token {
  kind: TokenKind;
  /** Offsets in the tokenized text. */
  from: number;
  to: number;
  /**
   * A word as written, a quoted name without its quotes (doubled closing quotes undone), the
   * punctuation character(s); empty for strings, comments, numbers and parameters.
   */
  value: string;
  /** Lower-cased `value`, for words only (keyword tests). */
  lower: string;
  /** The string, quoted name or block comment has its closing delimiter. */
  closed: boolean;
  /** A `--` comment: it ends at the end of its line. */
  line: boolean;
}

/** How the engine writes quoted names, from the capabilities of its dialect. */
export interface QuoteRules {
  open: string;
  close: string;
}

const WORD_START = /[\p{L}_#@]/u;
const WORD_PART = /[\p{L}\p{N}_$#@]/u;
const DIGIT = /[0-9]/;
const DOLLAR_TAG = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u;

/** Characters that open a quoted name: the dialect's own, and `"` unless it is a string there. */
function identifierQuotes(rules: QuoteRules): Map<string, string> {
  const quotes = new Map<string, string>([[rules.open, rules.close]]);
  // In MySQL (backticks) a double quote opens a string, everywhere else a quoted name.
  if (rules.open !== '`') quotes.set('"', '"');
  return quotes;
}

function make(
  kind: TokenKind,
  from: number,
  to: number,
  value = '',
  closed = true,
  line = false,
): Token {
  return { kind, from, to, value, lower: kind === 'word' ? value.toLowerCase() : '', closed, line };
}

export function tokenize(text: string, rules: QuoteRules): Token[] {
  const quotes = identifierQuotes(rules);
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    const next = text.charAt(i + 1);
    if (c === '-' && next === '-') {
      let end = text.indexOf('\n', i);
      if (end < 0) end = n;
      else if (end > i && text.charAt(end - 1) === '\r') end--;
      tokens.push(make('comment', i, end, '', false, true));
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const to = end < 0 ? n : end + 2;
      tokens.push(make('comment', i, to, '', end >= 0));
      i = to;
      continue;
    }
    if (c === "'" || (c === '"' && !quotes.has('"'))) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text.charAt(j) === c) {
          if (text.charAt(j + 1) === c) {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      tokens.push(make('string', i, j, '', closed));
      i = j;
      continue;
    }
    if (c === '$') {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 80));
      if (tag) {
        const delimiter = tag[0];
        const end = text.indexOf(delimiter, i + delimiter.length);
        const to = end < 0 ? n : end + delimiter.length;
        tokens.push(make('string', i, to, '', end >= 0));
        i = to;
        continue;
      }
      let j = i + 1;
      while (j < n && DIGIT.test(text.charAt(j))) j++;
      tokens.push(make('param', i, j));
      i = j;
      continue;
    }
    const close = quotes.get(c);
    if (close !== undefined) {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const d = text.charAt(j);
        if (d === close) {
          if (text.charAt(j + 1) === close) {
            value += close;
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += d;
        j++;
      }
      tokens.push(make('quoted', i, j, value, closed));
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text.charAt(j))) j++;
      tokens.push(make('word', i, j, text.slice(i, j)));
      i = j;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-Fx._]/.test(text.charAt(j))) j++;
      tokens.push(make('number', i, j));
      i = j;
      continue;
    }
    if (c === ':' && next === ':') {
      tokens.push(make('punct', i, i + 2, '::'));
      i += 2;
      continue;
    }
    tokens.push(make('punct', i, i + 1, c));
    i++;
  }
  return tokens;
}

/** Whether `cursor` lies inside a string or comment token, where nothing is suggested. */
export function insideLiteral(token: Token, cursor: number): boolean {
  if (token.kind !== 'string' && token.kind !== 'comment') return false;
  if (token.line) return cursor > token.from && cursor <= token.to;
  return token.closed ? cursor > token.from && cursor < token.to : cursor > token.from;
}
