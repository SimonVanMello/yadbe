import type { LineRange } from '../../ipc';

/**
 * The console text as the editor sees it: where requests start, which lines a run takes. The
 * backend reads the requests themselves (`db::search::console`); this only finds lines.
 */

const REQUEST_LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+\S+\s*$/i;

/** 0-based lines that start a request. */
export function requestLines(text: string): number[] {
  const starts: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (REQUEST_LINE.test(line)) starts.push(index);
  });
  return starts;
}

function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * The lines a run takes: the selected lines when there is a selection (a selection that ends
 * at the start of a line leaves that line out), else the cursor's line (the backend picks the
 * request it belongs to); `null` for every request.
 */
export function runLines(
  text: string,
  selection: { anchor: number; head: number },
  all: boolean,
): LineRange | null {
  if (all) return null;
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  if (from === to) {
    const line = lineOf(text, from);
    return { from: line, to: line };
  }
  const end = text[to - 1] === '\n' ? to - 1 : to;
  return { from: lineOf(text, from), to: lineOf(text, end) };
}

/** The request under a line: the start of the last request line at or before it. */
export function requestAt(text: string, line: number): number | null {
  const before = requestLines(text).filter((start) => start <= line);
  return before.at(-1) ?? null;
}

/**
 * The offset of a 1-based line and column of `text` (an error position the backend mapped to
 * the editor's lines); `null` when the text has no such line.
 */
export function consoleErrorOffset(text: string, line: number, column: number): number | null {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return null;
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
  const length = lines[line - 1]?.length ?? 0;
  return offset + Math.min(Math.max(column - 1, 0), Math.max(length - 1, 0));
}
