import { javascript } from '@codemirror/lang-javascript';
import { sql } from '@codemirror/lang-sql';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';

import type { Engine } from '../../ipc';
import { isSqlEngine } from '../../ipc/sqlEngines';
import { redisCli } from '../keyvalue/redisLanguage';
import { dialectOf } from '../query/sqlLanguage';
import { consoleSyntax } from '../search/consoleLanguage';
import styles from './SyntaxText.module.css';

/** A run of text with its colour class (`null`: plain). Runs are contiguous and cover the text. */
export interface Segment {
  from: number;
  to: number;
  className: string | null;
}

/** The part of a Lezer parser the history needs: text in, syntax tree out. */
interface TextParser {
  parse(input: string): Parameters<typeof highlightTree>[0];
}

/** The editors' rules (`sqlHighlight`), mapped to classes instead of inline colours. */
const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], class: styles.keyword ?? '' },
  { tag: [tags.string, tags.special(tags.string)], class: styles.string ?? '' },
  { tag: [tags.number, tags.bool, tags.null], class: styles.number ?? '' },
  { tag: [tags.typeName, tags.standard(tags.typeName)], class: styles.type ?? '' },
  { tag: tags.propertyName, class: styles.property ?? '' },
  {
    tag: [tags.function(tags.variableName), tags.standard(tags.name)],
    class: styles.function ?? '',
  },
  {
    tag: [tags.special(tags.name), tags.special(tags.variableName), tags.atom],
    class: styles.special ?? '',
  },
  { tag: [tags.operator, tags.punctuation, tags.separator], class: styles.operator ?? '' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], class: styles.comment ?? '' },
  { tag: tags.invalid, class: styles.invalid ?? '' },
]);

const parsers = new Map<Engine, TextParser>();

/** The language of an engine's history entries: its dialect, mongosh, redis-cli or the console. */
function parserOf(engine: Engine): TextParser {
  const known = parsers.get(engine);
  if (known) return known;
  let parser: TextParser;
  if (isSqlEngine(engine)) parser = sql({ dialect: dialectOf(engine) }).language.parser;
  else if (engine === 'mongodb') parser = javascript().language.parser;
  else if (engine === 'redis') parser = redisCli.parser;
  else parser = consoleSyntax.parser;
  parsers.set(engine, parser);
  return parser;
}

/** Characters highlighted per entry: a row shows two lines, the rest is cut before parsing. */
export const HIGHLIGHT_CHARS = 480;

const CACHE_MAX = 3000;
const cache = new Map<string, Segment[]>();

/**
 * The colour runs of `text` in the language of `engine`. Memoized (a virtualized list asks again
 * for the rows it scrolls back to); only the first `HIGHLIGHT_CHARS` are ever parsed.
 */
export function highlightRuns(engine: Engine, text: string): Segment[] {
  const head = text.length > HIGHLIGHT_CHARS ? text.slice(0, HIGHLIGHT_CHARS) : text;
  const key = `${engine}\u0000${head}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const runs = computeRuns(engine, head);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, runs);
  return runs;
}

function computeRuns(engine: Engine, text: string): Segment[] {
  let runs: Segment[] = [];
  let at = 0;
  const push = (from: number, to: number, className: string | null) => {
    if (to > from) runs.push({ from, to, className });
  };
  try {
    const tree = parserOf(engine).parse(text);
    highlightTree(tree, highlighter, (from, to, classes) => {
      push(at, from, null);
      push(from, to, classes);
      at = to;
    });
  } catch {
    // A tokenizer failure only costs the colours.
    runs = [];
    at = 0;
  }
  push(at, text.length, null);
  return runs;
}

/** A piece of the text with its syntax class and whether a search word matched it. */
export interface Piece {
  text: string;
  className: string | null;
  match: boolean;
}

/** Cuts `text` at every boundary of the colour runs and of the match ranges. */
export function mergePieces(
  text: string,
  runs: readonly Segment[],
  matches: readonly (readonly [number, number])[],
): Piece[] {
  const cuts = new Set<number>([0, text.length]);
  for (const run of runs) {
    cuts.add(run.from);
    cuts.add(run.to);
  }
  for (const [from, to] of matches) {
    cuts.add(from);
    cuts.add(to);
  }
  const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
  const pieces: Piece[] = [];
  let runIndex = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] ?? 0;
    const to = points[i + 1] ?? from;
    while (runIndex < runs.length && (runs[runIndex]?.to ?? 0) <= from) runIndex++;
    const run = runs[runIndex];
    const className = run && run.from <= from && run.to >= to ? run.className : null;
    pieces.push({
      text: text.slice(from, to),
      className,
      match: matches.some(([start, end]) => start <= from && end >= to),
    });
  }
  return pieces;
}
