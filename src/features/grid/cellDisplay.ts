import type { ValueKind } from '../../ipc';
import { arrayJson } from './cellJson';

/**
 * How a cell reads on screen (F-060). Values arrive as lossless text and are shown as is
 * (no rounding, no locale grouping); what the grid adds is making invisible things visible:
 * `NULL`, the empty string, leading / trailing whitespace and line breaks.
 */

/** Characters drawn at most per cell: a cell is one line, wider text is cut by the ellipsis. */
export const DISPLAY_CHARS = 400;

export type CellDisplay =
  | { type: 'null' }
  | { type: 'empty' }
  | { type: 'plain'; text: string }
  /** Text with marked parts (whitespace shown as symbols), as alternating segments. */
  | { type: 'marked'; parts: readonly DisplayPart[] };

export interface DisplayPart {
  text: string;
  mark: boolean;
}

const NEEDS_MARKS = /^\s|\s$|[\n\r\t]/;

const SYMBOLS: Record<string, string> = {
  ' ': '·',
  '\t': '→',
  '\n': '↵',
  '\r': '␍',
};

function symbolize(whitespace: string): string {
  let out = '';
  for (const char of whitespace) out += SYMBOLS[char] ?? '·';
  return out;
}

/** Display form of a cell. `kind` decides prefixes (binary is shown as `0x…`). */
export function describeCell(text: string | null, kind: ValueKind): CellDisplay {
  if (text === null) return { type: 'null' };
  if (text === '') return { type: 'empty' };
  if (kind === 'bytes') return { type: 'plain', text: `0x${text.slice(0, DISPLAY_CHARS)}` };
  if (kind === 'array') {
    // Arrays travel as the JSON of their values; show them as plain JSON.
    const plain = arrayJson(text);
    if (plain !== null) return { type: 'plain', text: plain.slice(0, DISPLAY_CHARS) };
  }
  const shown = text.length > DISPLAY_CHARS ? text.slice(0, DISPLAY_CHARS) : text;
  if (!NEEDS_MARKS.test(shown)) return { type: 'plain', text: shown };

  const parts: DisplayPart[] = [];
  const push = (value: string, mark: boolean) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last && last.mark === mark) last.text += value;
    else parts.push({ text: value, mark });
  };
  const leading = /^\s+/.exec(shown)?.[0] ?? '';
  // Text cut at DISPLAY_CHARS has no visible end: its trailing whitespace is not the value's.
  const trailing = text.length > DISPLAY_CHARS ? '' : (/\s+$/.exec(shown)?.[0] ?? '');
  if (leading.length === shown.length) {
    push(symbolize(shown), true);
    return { type: 'marked', parts };
  }
  push(symbolize(leading), true);
  const middle = shown.slice(leading.length, shown.length - trailing.length);
  for (const piece of middle.split(/([\n\r\t]+)/)) {
    if (/^[\n\r\t]+$/.test(piece)) push(symbolize(piece), true);
    else push(piece, false);
  }
  push(symbolize(trailing), true);
  return { type: 'marked', parts };
}

/** Longest line a cell shows, in characters (auto-fit width). */
export function displayLength(text: string | null, kind: ValueKind, nullLabel: string): number {
  if (text === null) return nullLabel.length;
  if (kind === 'bytes') return Math.min(DISPLAY_CHARS, text.length) + 2;
  if (kind === 'array') return Math.min(DISPLAY_CHARS, (arrayJson(text) ?? text).length);
  return Math.min(DISPLAY_CHARS, text.length);
}
