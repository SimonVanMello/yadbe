import type { Engine, TextRange } from './bindings';

/**
 * Statement splitter of the mock backend: the same rules as the backend's tokenizer-level
 * splitter (`db/split.rs`), for `pnpm dev` and Playwright. Offsets are JavaScript string
 * indices (UTF-16 code units), like the backend's ranges.
 */
interface Syntax {
  dollarQuotes: boolean;
  backslashStrings: boolean;
  nestedComments: boolean;
  hashComments: boolean;
  backticks: boolean;
  brackets: boolean;
  goBatches: boolean;
  delimiterCommand: boolean;
}

const SYNTAX: Record<Engine, Syntax> = {
  postgres: {
    dollarQuotes: true,
    backslashStrings: false,
    nestedComments: true,
    hashComments: false,
    backticks: false,
    brackets: false,
    goBatches: false,
    delimiterCommand: false,
  },
  sqlite: {
    dollarQuotes: false,
    backslashStrings: false,
    nestedComments: false,
    hashComments: false,
    backticks: true,
    brackets: true,
    goBatches: false,
    delimiterCommand: false,
  },
  mssql: {
    dollarQuotes: false,
    backslashStrings: false,
    nestedComments: true,
    hashComments: false,
    backticks: false,
    brackets: true,
    goBatches: true,
    delimiterCommand: false,
  },
  mysql: {
    dollarQuotes: false,
    backslashStrings: true,
    nestedComments: false,
    hashComments: true,
    backticks: true,
    brackets: false,
    goBatches: false,
    delimiterCommand: true,
  },
};

export interface MockStatement extends TextRange {
  /** End of the delimiter that closed the statement (`to` when there is none). */
  end: number;
}

const isIdent = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_$]/u.test(c);

/** Skips a quoted span opened at `i` (the quote itself); returns the index after it. */
function skipQuoted(text: string, i: number, close: string, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (backslash && c === '\\') {
      j += 2;
      continue;
    }
    if (c === close) {
      if (text[j + 1] === close && close !== ']') {
        j += 2;
        continue;
      }
      if (close === ']' && text[j + 1] === ']') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

function lineEnd(text: string, i: number): number {
  const n = text.indexOf('\n', i);
  return n === -1 ? text.length : n;
}

export function mockSplit(engine: Engine, text: string): MockStatement[] {
  const s = SYNTAX[engine];
  const out: MockStatement[] = [];
  let delimiter = ';';
  let start = -1;
  let codeEnd = -1;
  let blockDepth = 0;
  let words: string[] = [];
  let i = 0;

  const close = (delimEnd: number): void => {
    if (start >= 0 && codeEnd > start) out.push({ from: start, to: codeEnd, end: delimEnd });
    start = -1;
    codeEnd = -1;
    blockDepth = 0;
    words = [];
  };
  const mark = (from: number, to: number): void => {
    if (start < 0) start = from;
    codeEnd = to;
  };

  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart && (s.goBatches || s.delimiterCommand)) {
      const end = lineEnd(text, i);
      const line = text.slice(i, end);
      if (s.goBatches && /^\s*go(\s+\d+)?\s*(--.*)?\r?$/i.test(line)) {
        close(end);
        i = end;
        continue;
      }
      const delim = s.delimiterCommand ? /^\s*delimiter\s+(\S+)/i.exec(line) : null;
      if (delim?.[1] && codeEnd < 0) {
        close(end);
        delimiter = delim[1];
        i = end;
        continue;
      }
    }
    const c = text[i] ?? '';
    const next = text[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (
      c === '-' &&
      next === '-' &&
      (!s.hashComments || text[i + 2] === undefined || /\s/.test(text[i + 2] ?? ''))
    ) {
      i = lineEnd(text, i);
      continue;
    }
    if (c === '#' && s.hashComments) {
      i = lineEnd(text, i);
      continue;
    }
    if (c === '/' && next === '*') {
      const executable = s.hashComments && (text[i + 2] === '!' || text[i + 2] === '+');
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (s.nestedComments && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else j++;
      }
      if (executable) mark(i, j);
      i = j;
      continue;
    }
    if (!s.goBatches && blockDepth === 0 && text.startsWith(delimiter, i)) {
      close(i + delimiter.length);
      i += delimiter.length;
      continue;
    }
    if (c === "'") {
      const prev = text[i - 1];
      const eString =
        s.dollarQuotes && (prev === 'e' || prev === 'E') && !isIdent(text[i - 2]) && start >= 0;
      const j = skipQuoted(text, i, "'", s.backslashStrings || eString);
      mark(i, j);
      i = j;
      continue;
    }
    if (c === '"' || (c === '`' && s.backticks)) {
      const j = skipQuoted(text, i, c, s.backslashStrings && c === '"');
      mark(i, j);
      i = j;
      continue;
    }
    if (c === '[' && s.brackets) {
      const j = skipQuoted(text, i, ']', false);
      mark(i, j);
      i = j;
      continue;
    }
    if (c === '$' && s.dollarQuotes && !isIdent(text[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const closeAt = text.indexOf(tag[0], i + tag[0].length);
        const j = closeAt === -1 ? text.length : closeAt + tag[0].length;
        mark(i, j);
        i = j;
        continue;
      }
    }
    if (isIdent(c)) {
      let j = i + 1;
      while (isIdent(text[j])) j++;
      const word = text.slice(i, j).toLowerCase();
      words.push(word);
      const trigger =
        words[0] === 'create' &&
        (words[1] === 'trigger' ||
          ((words[1] === 'temp' || words[1] === 'temporary') && words[2] === 'trigger'));
      if (engine === 'sqlite' && trigger) {
        if (word === 'begin') blockDepth++;
        else if (word === 'case' && blockDepth > 0) blockDepth++;
        else if (word === 'end' && blockDepth > 0) blockDepth--;
      } else if (engine === 'postgres' && words[0] === 'create') {
        if (word === 'atomic' && words[words.length - 2] === 'begin') blockDepth++;
        else if (word === 'case' && blockDepth > 0) blockDepth++;
        else if (word === 'end' && blockDepth > 0) blockDepth--;
      }
      mark(i, j);
      i = j;
      continue;
    }
    mark(i, i + 1);
    i++;
  }
  close(text.length);
  return out.map((st) => ({ ...st, end: Math.max(st.end, st.to) }));
}

function newlines(text: string): number {
  let n = 0;
  for (const c of text) if (c === '\n') n++;
  return n;
}

/** The statement under the cursor: the backend's `statement_at` rule. */
export function mockStatementAt(
  engine: Engine,
  text: string,
  offset: number,
): MockStatement | null {
  const statements = mockSplit(engine, text);
  let found: MockStatement | null = null;
  for (const st of statements) if (st.from <= offset && offset <= st.end) found = st;
  if (found) return found;
  const before = [...statements].reverse().find((st) => st.end < offset);
  const after = statements.find((st) => st.from > offset);
  if (before && newlines(text.slice(before.end, offset)) <= 1) return before;
  if (after && newlines(text.slice(offset, after.from)) <= 1) return after;
  return null;
}
