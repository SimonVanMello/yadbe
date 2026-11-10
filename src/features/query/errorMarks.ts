import type { QueryMessage, TextRange } from '../../ipc';
import type { TabExecution } from './executionModel';

const WORD = /[\p{L}\p{N}_$]/u;

/**
 * The span to underline for an error reported at `offset` of `text`: the word or quoted name
 * that starts there, else the one character, else the last character of the text.
 */
export function errorRange(text: string, offset: number): TextRange {
  const length = text.length;
  if (length === 0) return { from: 0, to: 0 };
  const from = Math.max(0, Math.min(offset, length - 1));
  const first = text.charAt(from);
  if (first === '"' || first === '`' || first === '[') {
    const closer = first === '[' ? ']' : first;
    const close = text.indexOf(closer, from + 1);
    return { from, to: close === -1 ? from + 1 : close + 1 };
  }
  let to = from;
  while (to < length && WORD.test(text.charAt(to))) to += 1;
  return { from, to: Math.max(to, from + 1) };
}

export interface ErrorMark extends TextRange {
  /** `seq` of the message the span belongs to. */
  seq: number;
}

/**
 * The spans to underline for the errors of an execution, in the coordinates of the text that
 * was sent (`sourceText`). Messages without a position are not marked.
 */
export function errorMarks(execution: Pick<TabExecution, 'messages' | 'sourceText'>): ErrorMark[] {
  const text = execution.sourceText;
  if (text === null) return [];
  const marks: ErrorMark[] = [];
  for (const message of execution.messages) {
    const position = positionOf(message);
    if (position === null) continue;
    marks.push({ seq: message.seq, ...errorRange(text, position) });
  }
  return marks;
}

/** Where in the editor text a message points, `null` when it points nowhere. */
export function positionOf(message: QueryMessage): number | null {
  return message.body.kind === 'error' ? (message.body.position?.offset ?? null) : null;
}

/**
 * Where clicking a message should land: its position, else the start of its statement (a
 * refused statement, a cancelled one).
 */
export function jumpTarget(message: QueryMessage, statements: readonly TextRange[]): number | null {
  const position = positionOf(message);
  if (position !== null) return position;
  if (message.body.kind !== 'error' || message.statementIndex === null) return null;
  return statements[message.statementIndex]?.from ?? null;
}
