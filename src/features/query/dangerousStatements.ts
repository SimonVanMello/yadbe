import type { TextRange } from '../../ipc';

/** What makes a statement worth a confirmation (F-051). */
export type DangerKind = 'updateWithoutWhere' | 'deleteWithoutWhere' | 'truncate' | 'drop';

export interface DangerousStatement {
  /** Index in the list of statements about to run. */
  index: number;
  range: TextRange;
  kind: DangerKind;
  /** The statement as written, without its delimiter. */
  sql: string;
}

interface Word {
  word: string;
  /** Group of parentheses the word sits in: 0 at the top level of the statement. */
  group: number;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;

/**
 * Lower-cased words of a statement that are neither comments, string literals nor quoted
 * identifiers, each with the parenthesized group it belongs to. This is not a SQL parser: the
 * statement boundaries come from the backend's splitter, this only needs to tell keywords from
 * the text around them.
 */
function scanWords(sql: string): Word[] {
  const words: Word[] = [];
  const open: number[] = [0];
  let groups = 0;
  let i = 0;
  const n = sql.length;
  const skipUntil = (closer: string, from: number): number => {
    let j = from;
    while (j < n) {
      if (sql.startsWith(closer, j)) {
        // A doubled closer is an escaped one.
        if (sql.startsWith(closer, j + closer.length)) j += closer.length * 2;
        else return j + closer.length;
      } else j += 1;
    }
    return n;
  };
  while (i < n) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && next === '*') {
      // PostgreSQL nests block comments; elsewhere an inner opener is rare enough to ignore.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
    } else if (c === "'") {
      const escaped = /[eE]/.test(sql.charAt(i - 1)) && !/\w/.test(sql.charAt(i - 2));
      if (escaped) {
        let j = i + 1;
        while (j < n && sql.charAt(j) !== "'") j += sql.charAt(j) === '\\' ? 2 : 1;
        i = j + 1;
      } else i = skipUntil("'", i + 1);
    } else if (c === '"') {
      i = skipUntil('"', i + 1);
    } else if (c === '`') {
      i = skipUntil('`', i + 1);
    } else if (c === '[') {
      i = skipUntil(']', i + 1);
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
      } else i += 1;
    } else if (c === '(') {
      groups += 1;
      open.push(groups);
      i += 1;
    } else if (c === ')') {
      if (open.length > 1) open.pop();
      i += 1;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql.charAt(j))) j += 1;
      words.push({ word: sql.slice(i, j).toLowerCase(), group: open[open.length - 1] ?? 0 });
      i = j;
    } else i += 1;
  }
  return words;
}

const DML_VERBS = new Set(['select', 'insert', 'update', 'delete', 'merge', 'values']);

/** The verb a statement runs: the first top-level keyword, past a `WITH` clause. */
function topLevelVerb(words: readonly Word[]): string | null {
  const top = words.filter((w) => w.group === 0).map((w) => w.word);
  const first = top[0];
  if (first === undefined) return null;
  if (first === 'with') return top.find((word, i) => i > 0 && DML_VERBS.has(word)) ?? null;
  if (first === 'explain') {
    // `EXPLAIN` alone only plans; `EXPLAIN ANALYZE` (also as `EXPLAIN (ANALYZE)`) runs it.
    const analyzed = words.some((w) => w.word === 'analyze' || w.word === 'analyse');
    return analyzed ? (top.find((word) => DML_VERBS.has(word)) ?? null) : null;
  }
  return first;
}

function lacksWhere(words: readonly Word[], group: number): boolean {
  return !words.some((w) => w.group === group && w.word === 'where');
}

/**
 * Whether a statement needs a confirmation: `UPDATE` / `DELETE` without a top-level `WHERE`,
 * `TRUNCATE` or `DROP` (F-051). A data-modifying CTE (`WITH d AS (DELETE FROM t …)`) counts too.
 */
export function classifyStatement(sql: string): DangerKind | null {
  const words = scanWords(sql);
  switch (topLevelVerb(words)) {
    case 'truncate':
      return 'truncate';
    case 'drop':
      return 'drop';
    case 'update':
      if (lacksWhere(words, 0)) return 'updateWithoutWhere';
      break;
    case 'delete':
      if (lacksWhere(words, 0)) return 'deleteWithoutWhere';
      break;
    default:
      break;
  }
  // A writable CTE that starts with the verb is a statement of its own.
  const seen = new Set<number>();
  for (const [index, { word, group }] of words.entries()) {
    if (group === 0 || seen.has(group)) continue;
    seen.add(group);
    if (word === 'update' && lacksWhere(words.slice(index), group)) return 'updateWithoutWhere';
    if (word === 'delete' && lacksWhere(words.slice(index), group)) return 'deleteWithoutWhere';
  }
  return null;
}

/**
 * The statements among `ranges` (as returned by the backend's splitter, in `text`) that need a
 * confirmation before they run.
 */
export function findDangerousStatements(
  text: string,
  ranges: readonly TextRange[],
): DangerousStatement[] {
  const found: DangerousStatement[] = [];
  for (const [index, range] of ranges.entries()) {
    const sql = text.slice(range.from, range.to);
    const kind = classifyStatement(sql);
    if (kind !== null) found.push({ index, range, kind, sql: sql.trim() });
  }
  return found;
}
