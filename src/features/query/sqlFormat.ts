import type { Engine } from '../../ipc';

/**
 * The SQL formatter (F-049): a token-level layout, no parser. It only changes the whitespace
 * between tokens and the case of keywords, so it never changes what a statement means:
 * strings, quoted names, comments, dollar-quoted bodies and operators are copied as they are,
 * two tokens are never glued together, and routine bodies (`CREATE PROCEDURE`, triggers,
 * procedural `IF` / `BEGIN … END` blocks), `GO` lines and `DELIMITER` regions are kept
 * verbatim.
 *
 * The result depends only on the tokens (and on whether a comment or a blank line stood on its
 * own line), so formatting twice gives the same text.
 */

export type KeywordCase = 'upper' | 'lower' | 'preserve';

export interface FormatOptions {
  engine: Engine;
  keywordCase: KeywordCase;
  /** One level of indentation: two or four spaces, or a tab. */
  indent: string;
}

type Kind =
  | 'word'
  | 'quoted'
  | 'string'
  | 'number'
  | 'param'
  | 'op'
  | 'punct'
  | 'lineComment'
  | 'blockComment'
  /** A `GO` line, a `DELIMITER` line, a region under a custom delimiter: kept verbatim. */
  | 'verbatim';

interface Token {
  kind: Kind;
  text: string;
  start: number;
  end: number;
  /** Line breaks in the whitespace before the token. */
  breaks: number;
  /** Whitespace stood between this token and the previous one. */
  spaced: boolean;
}

// --- Lexer ----------------------------------------------------------------------------------

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$]/u;
const DIGIT = /[0-9]/;
const OP_BASE = '+-*/<>=!~^&|%';

function lineEnd(text: string, from: number): number {
  const end = text.indexOf('\n', from);
  return end < 0 ? text.length : end;
}

/** End of a quoted span opened at `i` and closed by `close` (doubled to escape). */
function quotedEnd(text: string, i: number, close: string, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (backslash && c === '\\') {
      j += 2;
      continue;
    }
    if (c === close) {
      if (text.charAt(j + 1) === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

function lex(text: string, engine: Engine): Token[] {
  const tokens: Token[] = [];
  const pg = engine === 'postgres';
  const mysql = engine === 'mysql';
  const mssql = engine === 'mssql';
  const opChars = pg ? `${OP_BASE}@#?` : OP_BASE;
  let breaks = 0;
  let spaced = false;
  let i = 0;
  const add = (kind: Kind, start: number, end: number, minBreaks = 0) => {
    tokens.push({
      kind,
      text: text.slice(start, end),
      start,
      end,
      breaks: Math.max(breaks, minBreaks),
      spaced,
    });
    breaks = 0;
    spaced = false;
  };
  const push = (kind: Kind, end: number) => {
    add(kind, i, end);
    i = end;
  };
  while (i < text.length) {
    const atLineStart = i === 0 || text.charAt(i - 1) === '\n';
    if (atLineStart && (mssql || mysql)) {
      const end = lineEnd(text, i);
      const line = text.slice(i, end).replace(/\r$/, '');
      const go = mssql && /^\s*go(\s+\d+)?\s*(--.*)?$/i.test(line);
      const delimiter = mysql ? /^\s*delimiter\s+(\S+)/i.exec(line) : null;
      if (go || delimiter?.[1]) {
        const lead = /^\s*/.exec(line)?.[0].length ?? 0;
        add('verbatim', i + lead, i + line.trimEnd().length, 1);
        i = end;
        if (delimiter?.[1] && delimiter[1] !== ';') {
          // Everything up to `DELIMITER ;` is a script the formatter does not touch.
          const back = /\n[ \t]*delimiter\s+;/i.exec(text.slice(i));
          const stop = back ? i + back.index : text.length;
          const region = text.slice(i, stop);
          const first = region.search(/\S/);
          if (first >= 0) {
            breaks = (region.slice(0, first).match(/\n/g) ?? []).length;
            add('verbatim', i + first, i + region.trimEnd().length, 1);
          }
          i = stop;
        }
        continue;
      }
    }
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      if (c === '\n') breaks++;
      spaced = true;
      i++;
      continue;
    }
    if (c === '-' && next === '-') {
      const third = text.charAt(i + 2);
      if (!mysql || third === '' || /\s/.test(third)) {
        let end = lineEnd(text, i);
        if (text.charAt(end - 1) === '\r') end--;
        push('lineComment', end);
        continue;
      }
    }
    if (c === '#' && mysql) {
      let end = lineEnd(text, i);
      if (text.charAt(end - 1) === '\r') end--;
      push('lineComment', end);
      continue;
    }
    if (c === '/' && next === '*') {
      const nested = pg || mssql;
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text.charAt(j) === '*' && text.charAt(j + 1) === '/') {
          depth--;
          j += 2;
        } else if (nested && text.charAt(j) === '/' && text.charAt(j + 1) === '*') {
          depth++;
          j += 2;
        } else j++;
      }
      push('blockComment', j);
      continue;
    }
    if (c === "'") {
      const prev = tokens.at(-1);
      const prefix =
        prev !== undefined &&
        prev.end === i &&
        prev.kind === 'word' &&
        /^([nexb]|_\w+)$/i.test(prev.text)
          ? prev
          : undefined;
      const backslash = mysql || (pg && prefix !== undefined && /^e$/i.test(prefix.text));
      const end = quotedEnd(text, i, "'", backslash);
      if (prefix) {
        // `N'…'`, `E'…'`, `X'…'`: the prefix belongs to the string.
        tokens.pop();
        tokens.push({ ...prefix, kind: 'string', text: text.slice(prefix.start, end), end });
        breaks = 0;
        spaced = false;
        i = end;
        continue;
      }
      push('string', end);
      continue;
    }
    if (c === '"') {
      push(mysql ? 'string' : 'quoted', quotedEnd(text, i, '"', mysql));
      continue;
    }
    if (c === '`' && (mysql || engine === 'sqlite')) {
      push('quoted', quotedEnd(text, i, '`', false));
      continue;
    }
    if (c === '[' && (mssql || engine === 'sqlite')) {
      push('quoted', quotedEnd(text, i, ']', false));
      continue;
    }
    if (c === '$') {
      if (pg && !WORD_PART.test(text.charAt(i - 1))) {
        const tag = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(i, i + 128));
        if (tag) {
          const close = text.indexOf(tag[0], i + tag[0].length);
          push('string', close < 0 ? text.length : close + tag[0].length);
          continue;
        }
      }
      if (DIGIT.test(next) || (engine === 'sqlite' && WORD_START.test(next))) {
        let j = i + 1;
        while (j < text.length && WORD_PART.test(text.charAt(j))) j++;
        push('param', j);
        continue;
      }
    }
    if (c === ':' && next === ':') {
      push('punct', i + 2);
      continue;
    }
    if (c === ':' && next === '=') {
      push('op', i + 2);
      continue;
    }
    if (c === ':' && WORD_START.test(next)) {
      let j = i + 1;
      while (j < text.length && WORD_PART.test(text.charAt(j))) j++;
      push('param', j);
      continue;
    }
    if (c === '@' && !pg) {
      let j = i + 1;
      while (text.charAt(j) === '@') j++;
      while (j < text.length && (WORD_PART.test(text.charAt(j)) || text.charAt(j) === '#')) j++;
      // `@` alone (`'u'@'h'`) is punctuation.
      push(j > i + 1 ? 'param' : 'punct', j);
      continue;
    }
    if (c === '?' && !pg) {
      let j = i + 1;
      while (DIGIT.test(text.charAt(j))) j++;
      push('param', j);
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(next))) {
      const match = /^(0x[0-9a-f]+|\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/i.exec(
        text.slice(i, i + 256),
      );
      let j = i + (match?.[0].length ?? 1);
      // `1abc` is one name on MySQL: never split it from its letters.
      while (j < text.length && WORD_PART.test(text.charAt(j))) j++;
      push('number', j);
      continue;
    }
    if (WORD_START.test(c) || (mssql && c === '#')) {
      let j = i + 1;
      while (
        j < text.length &&
        (WORD_PART.test(text.charAt(j)) || (mssql && text.charAt(j) === '#'))
      )
        j++;
      push('word', j);
      continue;
    }
    if (opChars.includes(c)) {
      let j = i + 1;
      while (
        j < text.length &&
        opChars.includes(text.charAt(j)) &&
        !text.startsWith('--', j) &&
        !text.startsWith('/*', j)
      )
        j++;
      push('op', j);
      continue;
    }
    push('punct', i + 1);
  }
  return tokens;
}

// --- Keywords -------------------------------------------------------------------------------

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

/**
 * Keywords whose case changes. On PostgreSQL (unquoted names fold to lower case) and SQLite
 * (names compare without case) the case of a name never matters; on MySQL (table names keep
 * their case) and SQL Server (case-sensitive collations) only reserved words are touched: they
 * cannot be names without quotes.
 */
const COMMON = words(`
  select from where and or not null is in as on join inner left right outer cross group by
  order having union all distinct intersect except insert into values update set delete
  create table alter drop unique primary key foreign references constraint default check
  case when then else between like exists asc desc with index add column for collate
`);
const KEYWORDS: Record<Engine, ReadonlySet<string>> = {
  postgres: new Set([
    ...COMMON,
    ...words(`end full natural limit offset fetch returning ilike similar nulls recursive cast
      using lateral over partition window filter within true false begin commit rollback
      truncate grant revoke view escape returns language do conflict nothing temporary
      temp trigger function procedure`),
  ]),
  sqlite: new Set([
    ...COMMON,
    ...words(`end natural limit offset returning nulls recursive cast using over partition
      window filter true false begin commit rollback view escape trigger temporary temp
      conflict nothing do glob`),
  ]),
  mysql: new Set([
    ...COMMON,
    ...words(`natural limit recursive cast using lateral over partition window grant revoke
      true false escape fetch interval regexp xor div mod straight_join procedure trigger
      declare return to of lock`),
  ]),
  mssql: new Set([
    ...COMMON,
    ...words(`end full top fetch over begin commit rollback tran transaction truncate grant
      revoke to declare exec execute return procedure proc function trigger merge view
      escape open close of`),
  ]),
};

/** Keywords followed by `(` with a space: what follows is not a call. */
const SPACED_BEFORE_PAREN = words(`
  in values as over exists any some all on using and or not when then else from join select
  where having by into set case return returns table with recursive lateral union intersect
  except is like between filter within key references check unique default primary foreign
  conflict do
`);

const JOIN_WORDS = words('left right inner full cross natural outer join straight_join');

/** Statements kept verbatim: routine definitions and procedural blocks. */
const ROUTINE_WORDS = words('procedure proc function trigger event package');
const PROCEDURAL = words('while try catch loop repeat elseif cursor');

/** Words that end a clause's item list. */
const CLAUSE_STARTS = words(`
  select from where group order having limit offset fetch union intersect except minus window
  returning values set into on join left right inner full cross natural
`);

const isWord = (token: Token | undefined, ...list: string[]): boolean =>
  token?.kind === 'word' && list.includes(token.text.toLowerCase());

const isPunct = (token: Token | undefined, text: string): boolean =>
  token !== undefined && token.kind === 'punct' && token.text === text;

const isComment = (token: Token | undefined): boolean =>
  token?.kind === 'lineComment' || token?.kind === 'blockComment';

const lowerOf = (token: Token | undefined): string =>
  token?.kind === 'word' ? token.text.toLowerCase() : '';

// --- Layout ---------------------------------------------------------------------------------

interface Ctx {
  kind: 'root' | 'subquery' | 'block' | 'inline';
  /** Indent level of the clauses of this query. */
  level: number;
  /** Indent level of the line the `(` opened on. */
  openLevel: number;
  clause: string | null;
  /** Commas of the current clause start a new line. */
  listBreak: boolean;
  caseDepth: number;
  between: boolean;
}

/** Whether the clause starting after `start` (at its depth) has a top-level comma. */
function clauseHasComma(code: Token[], start: number): boolean {
  let depth = 0;
  for (let j = start + 1; j < code.length; j++) {
    const token = code[j];
    if (!token) break;
    if (isPunct(token, '(')) depth++;
    else if (isPunct(token, ')')) {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0) {
      if (isPunct(token, ',')) return true;
      if (CLAUSE_STARTS.has(lowerOf(token))) return false;
    }
  }
  return false;
}

class Writer {
  private out = '';
  private lineLevel = 0;
  private pending: number | null = null;
  /** The last token written. */
  last: Token | undefined;

  constructor(private readonly indent: string) {}

  get level(): number {
    return this.lineLevel;
  }

  /** The next token starts a line at `level` (the latest request wins). */
  breakAt(level: number): void {
    this.pending = Math.max(0, level);
  }

  hasPendingBreak(): boolean {
    return this.pending !== null;
  }

  /** Writes a token: on a new line when one is pending, else after a space when `space`. */
  write(text: string, space: boolean, token: Token, blankLine = false): void {
    if (this.pending !== null) {
      if (this.out !== '') this.out += blankLine ? '\n\n' : '\n';
      this.out += this.indent.repeat(this.pending);
      this.lineLevel = this.pending;
      this.pending = null;
    } else if (this.out !== '' && (space || isComment(this.last))) {
      this.out += ' ';
    }
    this.out += text;
    this.last = token;
  }

  /** A comment that stood at the end of a line stays there, before any pending break. */
  writeTrailing(text: string, token: Token): void {
    this.out += this.out === '' ? text : ` ${text}`;
    this.last = token;
  }

  text(): string {
    return this.out.replace(/[ \t]+$/gm, '');
  }
}

/** The token as written, keyword case applied. */
function caseOf(
  token: Token,
  options: FormatOptions,
  prev: Token | undefined,
  next: Token | undefined,
): string {
  if (options.keywordCase === 'preserve' || token.kind !== 'word') return token.text;
  const lower = token.text.toLowerCase();
  if (!KEYWORDS[options.engine].has(lower)) return token.text;
  // Part of a qualified name, or a function call (`left(…)`, `replace(…)`): a name.
  if (isPunct(prev, '.') || isPunct(next, '.')) return token.text;
  if (isPunct(next, '(') && next?.spaced === false && !SPACED_BEFORE_PAREN.has(lower)) {
    return token.text;
  }
  return options.keywordCase === 'upper' ? token.text.toUpperCase() : lower;
}

/** Whether a space separates `prev` and `token` (when no line break does). */
function spaceBetween(prev: Token | undefined, token: Token, afterUnary: boolean): boolean {
  if (!prev) return false;
  if (isComment(token) || isComment(prev)) return true;
  // Two operators are never glued: `- -1` must not become `--1`.
  if (prev.kind === 'op' && token.kind === 'op') return true;
  // MySQL reads `--` followed by a space as a comment: `a--1` stays as written.
  if (prev.kind === 'op' && prev.text.endsWith('--')) return false;
  if (
    isPunct(token, ',') ||
    isPunct(token, ';') ||
    isPunct(token, ')') ||
    isPunct(token, ']') ||
    isPunct(token, '.') ||
    isPunct(prev, '.') ||
    isPunct(token, '::') ||
    isPunct(prev, '::') ||
    isPunct(prev, '(') ||
    isPunct(prev, '[')
  ) {
    return false;
  }
  if (isPunct(token, ':') || isPunct(prev, ':')) return false;
  if (isPunct(token, '[')) return token.spaced;
  if (isPunct(token, '(')) {
    if (prev.kind === 'word' && SPACED_BEFORE_PAREN.has(prev.text.toLowerCase())) return true;
    if (prev.kind === 'op' || isPunct(prev, ',')) return true;
    // A call, a type (`varchar(20)`), a column list (`t (a, b)`): as written.
    return token.spaced;
  }
  if (prev.kind === 'op' && afterUnary) return false;
  return true;
}

/** Formats one statement (its tokens, without the `;` that ends it). */
function formatStatement(tokens: Token[], options: FormatOptions, w: Writer): void {
  const keywords = KEYWORDS[options.engine];
  const root: Ctx = {
    kind: 'root',
    level: 0,
    openLevel: 0,
    clause: null,
    listBreak: false,
    caseDepth: 0,
    between: false,
  };
  const stack: Ctx[] = [root];
  const code = tokens.filter((t) => !isComment(t));
  const withStatement = isWord(code[0], 'with');
  let codeIndex = -1;
  let prevCode: Token | undefined;
  let createTable = false;
  // After a list clause's keyword, until its first item: `SELECT DISTINCT TOP (5)`…
  let itemsPending = false;
  let preludeDepth = 0;
  let lastUnary = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (isComment(token)) {
      if (token.breaks === 0 && w.last !== undefined) w.writeTrailing(token.text, token);
      else {
        if (!w.hasPendingBreak() && w.last !== undefined) w.breakAt(w.level);
        // A blank line before a comment of its own (a section of the statement) stays.
        w.write(token.text, true, token, token.breaks >= 2 && w.last !== undefined);
      }
      const after = tokens[index + 1];
      if (
        (token.kind === 'lineComment' || (after !== undefined && after.breaks > 0)) &&
        !w.hasPendingBreak()
      ) {
        w.breakAt(w.level);
      }
      continue;
    }
    codeIndex++;
    const c = stack[stack.length - 1] ?? root;
    const next = code[codeIndex + 1];
    const lower = lowerOf(token);
    const first = prevCode === undefined || isPunct(prevCode, '(');
    const clauseLevel = c.kind === 'subquery' || c.kind === 'root' ? c.level : null;

    if (lower === 'case') c.caseDepth++;
    else if (lower === 'end' && c.caseDepth > 0) c.caseDepth--;

    if (itemsPending && clauseLevel !== null) {
      const modifier =
        isWord(token, 'distinct', 'all', 'top', 'distinctrow') ||
        (isWord(token, 'on') && isWord(prevCode, 'distinct'));
      const argument =
        preludeDepth > 0 ||
        (isWord(prevCode, 'top') && (token.kind === 'number' || isPunct(token, '('))) ||
        (isWord(prevCode, 'on') && isPunct(token, '('));
      if (!modifier && !argument) {
        w.breakAt(clauseLevel + 1);
        itemsPending = false;
      }
    }

    // Clause keywords start their line in a query (not in a call, a CASE or a qualified name).
    const call = isPunct(next, '(') && next?.spaced === false && !SPACED_BEFORE_PAREN.has(lower);
    const named = isPunct(prevCode, '.') || isPunct(next, '.');
    if (token.kind === 'word' && clauseLevel !== null && c.caseDepth === 0 && !call && !named) {
      const prevLower = lowerOf(prevCode);
      let breakLevel: number | null = null;
      let clause: string | null = null;
      switch (lower) {
        case 'select':
          if (!first) breakLevel = clauseLevel;
          clause = 'select';
          break;
        case 'from':
          if (
            prevLower !== 'delete' &&
            !(prevLower === 'distinct' && isWord(code[codeIndex - 2], 'is'))
          ) {
            breakLevel = clauseLevel;
          }
          clause = 'from';
          break;
        case 'where':
        case 'having':
        case 'window':
        case 'returning':
        case 'limit':
          breakLevel = clauseLevel;
          clause = lower;
          break;
        case 'offset':
          if (c.clause !== 'fetch') breakLevel = clauseLevel;
          clause = 'offset';
          break;
        case 'fetch':
          if (!first) breakLevel = clauseLevel;
          clause = 'fetch';
          break;
        case 'group':
        case 'order':
          if (isWord(next, 'by')) {
            breakLevel = clauseLevel;
            clause = lower;
          }
          break;
        case 'union':
        case 'intersect':
        case 'except':
        case 'minus':
          breakLevel = clauseLevel;
          clause = 'union';
          break;
        case 'values':
          if (!first) breakLevel = clauseLevel;
          clause = 'values';
          break;
        case 'set':
          if (c.clause === 'update' || c.clause === 'conflict') {
            breakLevel = clauseLevel;
            clause = 'set';
          }
          break;
        case 'update':
          if (first) clause = 'update';
          else if (prevLower === 'do') clause = 'conflict';
          break;
        case 'into':
          if (c.clause === 'select') {
            breakLevel = clauseLevel;
            clause = 'into';
          }
          break;
        case 'on':
          if (isWord(next, 'conflict', 'duplicate')) {
            breakLevel = clauseLevel;
            clause = 'conflict';
          } else if (c.clause === 'join') {
            clause = 'on';
          }
          break;
        case 'and':
        case 'or':
          if (c.between && lower === 'and') c.between = false;
          else if (c.clause === 'where' || c.clause === 'having') breakLevel = clauseLevel + 1;
          else if (c.clause === 'on') breakLevel = clauseLevel + 2;
          break;
        case 'between':
          c.between = true;
          break;
        default:
          if (JOIN_WORDS.has(lower) && !JOIN_WORDS.has(prevLower)) {
            // `LEFT OUTER JOIN`, `CROSS APPLY`: the group's first word starts the line.
            let k = codeIndex;
            while (isWord(code[k], ...JOIN_WORDS) && !isWord(code[k], 'join')) k++;
            const joins = isWord(code[k], 'join', 'apply');
            if (joins && (c.clause === 'from' || c.clause === 'join' || c.clause === 'on')) {
              breakLevel = clauseLevel + 1;
              clause = 'join';
            }
          }
      }
      if (clause !== null) {
        c.clause = clause;
        c.listBreak =
          (clause === 'select' ||
            clause === 'set' ||
            clause === 'returning' ||
            clause === 'values') &&
          clauseHasComma(code, codeIndex);
        itemsPending = c.listBreak;
        preludeDepth = 0;
      }
      if (breakLevel !== null) w.breakAt(breakLevel);
    } else if (lower === 'between') {
      c.between = true;
    }
    if (
      lower === 'table' &&
      isWord(prevCode, 'create', 'temporary', 'temp', 'unlogged', 'global', 'local', 'virtual')
    ) {
      createTable = true;
    }

    if (isPunct(token, '(')) {
      const subquery = isWord(next, 'select', 'with', 'values');
      const block = createTable && c.kind === 'root';
      w.write('(', spaceBetween(prevCode, token, lastUnary), token);
      if (itemsPending) preludeDepth++;
      if (subquery || block) {
        const level = w.level + 1;
        stack.push({
          kind: subquery ? 'subquery' : 'block',
          level,
          openLevel: w.level,
          clause: null,
          listBreak: block,
          caseDepth: 0,
          between: false,
        });
        createTable = false;
        w.breakAt(level);
      } else {
        stack.push({
          kind: 'inline',
          level: c.level,
          openLevel: w.level,
          clause: c.clause,
          listBreak: false,
          caseDepth: 0,
          between: false,
        });
      }
      prevCode = token;
      lastUnary = false;
      continue;
    }
    if (isPunct(token, ')')) {
      const closing = stack.length > 1 ? stack.pop() : undefined;
      if (itemsPending && preludeDepth > 0) preludeDepth--;
      if (closing && closing.kind !== 'inline') w.breakAt(closing.openLevel);
      w.write(')', false, token);
      prevCode = token;
      lastUnary = false;
      continue;
    }
    if (isPunct(token, ',')) {
      w.write(',', false, token);
      if (c.kind === 'block') w.breakAt(c.level);
      else if (c.kind !== 'inline' && c.caseDepth === 0) {
        if (c.listBreak) w.breakAt(c.level + 1);
        else if (c.clause === null && withStatement) w.breakAt(c.level);
      }
      prevCode = token;
      lastUnary = false;
      continue;
    }

    const unary =
      token.kind === 'op' &&
      (token.text === '-' || token.text === '+') &&
      (prevCode === undefined ||
        prevCode.kind === 'op' ||
        isPunct(prevCode, '(') ||
        isPunct(prevCode, ',') ||
        (prevCode.kind === 'word' && keywords.has(lowerOf(prevCode))));
    w.write(
      caseOf(token, options, prevCode, next),
      spaceBetween(prevCode, token, lastUnary),
      token,
    );
    lastUnary = unary;
    prevCode = token;
  }
}

/** A statement of the script, or a verbatim piece. */
interface Piece {
  tokens: Token[];
  /** The `;` that ended it, if any. */
  terminated: boolean;
  /** Line breaks before it in the original. */
  breaks: number;
  verbatim: boolean;
}

function routineHead(code: Token[]): boolean {
  if (!isWord(code[0], 'create', 'alter')) return false;
  return code.slice(1, 10).some((t) => ROUTINE_WORDS.has(lowerOf(t)));
}

/** Procedural T-SQL or MySQL: `IF … BEGIN … END`, loops, cursors, `TRY` / `CATCH`. */
function procedural(code: Token[]): boolean {
  return code.some((t, k) => {
    const lower = lowerOf(t);
    if (PROCEDURAL.has(lower)) return true;
    if (lower === 'if') return k === 0 || isWord(code[k - 1], 'else', 'begin', 'then');
    if (lower === 'begin') {
      const next = code[k + 1];
      return next !== undefined && !isWord(next, 'tran', 'transaction', 'distributed', 'work');
    }
    return false;
  });
}

function pieces(tokens: Token[], engine: Engine): Piece[] {
  const out: Piece[] = [];
  let current: Token[] = [];
  let block = 0;
  let routine = false;
  let breaksAtSemicolon = 0;
  const flush = (terminated: boolean) => {
    const code = current.filter((t) => !isComment(t));
    if (current.length > 0 || terminated) {
      out.push({
        tokens: current,
        terminated,
        breaks: current[0]?.breaks ?? breaksAtSemicolon,
        verbatim:
          routine ||
          code.length === 0 ||
          ((engine === 'mssql' || engine === 'mysql') && procedural(code)),
      });
    }
    current = [];
    block = 0;
    routine = false;
  };
  for (const token of tokens) {
    if (token.kind === 'verbatim') {
      flush(false);
      out.push({ tokens: [token], terminated: false, breaks: token.breaks, verbatim: true });
      continue;
    }
    if (isPunct(token, ';') && block === 0 && !(routine && engine === 'mssql')) {
      breaksAtSemicolon = token.breaks;
      flush(true);
      continue;
    }
    current.push(token);
    if (token.kind === 'word') {
      const code = current.filter((t) => !isComment(t));
      if (!routine && code.length <= 10 && routineHead(code)) routine = true;
      const lower = token.text.toLowerCase();
      if (routine) {
        if (lower === 'begin' || (lower === 'case' && block > 0)) block++;
        else if (lower === 'end' && block > 0) block--;
      }
    }
  }
  flush(false);
  return out;
}

/** Formats a script (or a selection of one). */
export function formatSql(text: string, options: FormatOptions): string {
  const parts = pieces(lex(text, options.engine), options.engine);
  let out = '';
  parts.forEach((piece, n) => {
    const head = piece.tokens[0];
    if (n > 0) {
      // A comment on the line of the previous statement's `;` stays there.
      const trailing =
        head !== undefined && isComment(head) && head.breaks === 0 && parts[n - 1]?.terminated;
      out += trailing ? ' ' : piece.breaks >= 2 ? '\n\n' : '\n';
    }
    const tail = piece.tokens.at(-1);
    if (piece.verbatim) {
      out += head && tail ? text.slice(head.start, tail.end) : '';
    } else {
      const w = new Writer(options.indent);
      formatStatement(piece.tokens, options, w);
      out += w.text();
    }
    if (piece.terminated) out += tail?.kind === 'lineComment' ? '\n;' : ';';
  });
  if (out !== '' && /\n\s*$/.test(text)) out += '\n';
  return out;
}

/** Every token of `text` but whitespace, keywords lower-cased: what formatting must keep. */
export function significantTokens(text: string, engine: Engine): string[] {
  return lex(text, engine).map((t) => (t.kind === 'word' ? t.text.toLowerCase() : t.text));
}
