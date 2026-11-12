import type { TextPosition } from '../bindings';
import type { Ejson, EjsonDocument } from './documentData';

/**
 * The few mongosh statements the mock backend understands, one per line: enough to show the
 * script editor in `pnpm dev` and Playwright (a find, a count, writes refused when read-only,
 * a dangerous delete or drop that asks first, prints, `use` / `show`, a thrown error). The
 * real backend runs any script in an embedded JavaScript engine; this is not an interpreter.
 */
export type MockStatement =
  | { kind: 'use'; database: string }
  | { kind: 'show'; what: string }
  | { kind: 'print'; text: string }
  | { kind: 'sleep'; ms: number }
  | { kind: 'throw'; message: string }
  | {
      kind: 'find';
      collection: string;
      filter: EjsonDocument | null;
      limit: number | null;
      one: boolean;
    }
  | { kind: 'count'; collection: string; filter: EjsonDocument | null }
  | {
      kind: 'write';
      method: string;
      collection: string | null;
      filter: EjsonDocument | null;
      body: Ejson | null;
    }
  | { kind: 'unsupported'; method: string }
  | { kind: 'value'; text: string }
  | { kind: 'runCommand'; command: EjsonDocument | null }
  | { kind: 'unknown'; text: string };

export interface MockLine {
  statement: MockStatement;
  /** Where the statement's call is, in the whole editor text. */
  position: TextPosition;
}

/** `{ status: 'paid', n: 1 }` → JSON, for the mock's simple literals; `null` when it is not. */
export function relaxedJson(text: string): Ejson | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const json = trimmed
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(json) as Ejson;
  } catch {
    return null;
  }
}

function objectOf(text: string): EjsonDocument | null {
  const value = relaxedJson(text);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** The first argument of a call's argument text (`{ a: 1 }, { $set: … }` → `{ a: 1 }`). */
function splitArguments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote) {
      if (c === quote && text.charAt(i - 1) !== '\\') quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim() !== '') out.push(text.slice(start));
  return out.map((a) => a.trim());
}

function literal(text: string): string {
  const quoted = /^(['"`])(.*)\1$/s.exec(text.trim());
  return quoted ? (quoted[2] ?? '') : text.trim();
}

function parse(body: string): { statement: MockStatement; column: number } {
  let match = /^use\s+(\S+)$/.exec(body);
  if (match) return { statement: { kind: 'use', database: match[1] ?? '' }, column: 0 };
  match = /^show\s+(\w+)$/.exec(body);
  if (match) return { statement: { kind: 'show', what: match[1] ?? '' }, column: 0 };
  match = /^(?:print|printjson|console\.log)\((.*)\)$/.exec(body);
  if (match) return { statement: { kind: 'print', text: literal(match[1] ?? '') }, column: 0 };
  match = /^sleep\((\d+)\)$/.exec(body);
  if (match) return { statement: { kind: 'sleep', ms: Number(match[1]) }, column: 0 };
  match = /^throw new Error\((['"])(.*)\1\)$/.exec(body);
  if (match) return { statement: { kind: 'throw', message: match[2] ?? '' }, column: 0 };
  match = /^db\.(\w+)\.(find|findOne)\((.*?)\)(?:\.limit\((\d+)\))?(?:\.toArray\(\))?$/.exec(body);
  if (match) {
    const [, collection = '', method = '', args = '', limit] = match;
    return {
      statement: {
        kind: 'find',
        collection,
        filter: objectOf(splitArguments(args)[0] ?? ''),
        limit: limit === undefined ? null : Number(limit),
        one: method === 'findOne',
      },
      column: body.indexOf(`.${method}(`) + 1,
    };
  }
  match = /^db\.(\w+)\.countDocuments\((.*)\)$/.exec(body);
  if (match) {
    return {
      statement: {
        kind: 'count',
        collection: match[1] ?? '',
        filter: objectOf(match[2] ?? ''),
      },
      column: body.indexOf('.countDocuments(') + 1,
    };
  }
  match =
    /^db\.(\w+)\.(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|drop)\((.*)\)$/.exec(
      body,
    );
  if (match) {
    const [, collection = '', method = '', args = ''] = match;
    const [first = '', second = ''] = splitArguments(args);
    const insert = method.startsWith('insert');
    return {
      statement: {
        kind: 'write',
        method,
        collection,
        filter: insert ? null : objectOf(first),
        body: insert ? relaxedJson(first) : relaxedJson(second),
      },
      column: body.indexOf(`.${method}(`) + 1,
    };
  }
  if (/^db\.dropDatabase\(\)$/.test(body)) {
    return {
      statement: {
        kind: 'write',
        method: 'dropDatabase',
        collection: null,
        filter: null,
        body: null,
      },
      column: 3,
    };
  }
  match = /^db\.runCommand\((.*)\)$/.exec(body);
  if (match) {
    return {
      statement: { kind: 'runCommand', command: objectOf(match[1] ?? '') },
      column: 3,
    };
  }
  match = /^(rs|sh)\.(\w+)\(.*\)$/.exec(body);
  if (match) {
    return {
      statement: { kind: 'unsupported', method: `${match[1] ?? ''}.${match[2] ?? ''}()` },
      column: (match[1] ?? '').length + 1,
    };
  }
  if (/^-?\d+(\.\d+)?$/.test(body) || /^(['"]).*\1$/.test(body)) {
    return { statement: { kind: 'value', text: literal(body) }, column: 0 };
  }
  return { statement: { kind: 'unknown', text: body }, column: 0 };
}

/** The statements of `text[from, to)`, placed in the whole text. */
export function parseMockScript(text: string, from = 0, to = text.length): MockLine[] {
  const lines: MockLine[] = [];
  let offset = from;
  let line = text.slice(0, from).split('\n').length;
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  let column = from - lineStart;
  for (const raw of text.slice(from, to).split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim().replace(/;$/, '').trim();
    if (body !== '' && !body.startsWith('//')) {
      const parsed = parse(body);
      const at = column + indent + parsed.column;
      lines.push({
        statement: parsed.statement,
        position: { offset: offset + indent + parsed.column, line, column: at + 1 },
      });
    }
    offset += raw.length + 1;
    line += 1;
    column = 0;
  }
  return lines;
}
