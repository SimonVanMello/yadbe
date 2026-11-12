import { startingWith, type ConsoleOption, type ConsoleSuggestions } from './consoleCompletion';
import {
  AGGREGATION_STAGES,
  COLLECTION_METHODS,
  CURSOR_METHODS,
  DATABASE_METHODS,
  GLOBALS,
  QUERY_OPERATORS,
  SHELL_COMMANDS,
  SHOW_TARGETS,
} from './mongoshApi';

/** Where in a mongosh script the cursor is, which says what can come next. */
export type MongoshContext =
  /** `use <db>`. */
  | { kind: 'use'; from: number; prefix: string }
  /** `show <target>`. */
  | { kind: 'show'; from: number; prefix: string }
  /** A name at the start of a statement or in an expression. */
  | { kind: 'global'; from: number; prefix: string; lineStart: boolean }
  /** `db.<here>`: the collections and the methods of the database. */
  | { kind: 'db'; from: number; prefix: string }
  /** `db.<collection>.<here>`. */
  | { kind: 'collection'; from: number; prefix: string; collection: string }
  /** `db.<collection>.find(…).<here>`. */
  | { kind: 'cursor'; from: number; prefix: string }
  /** `db.getCollection('<here>')` and `db.getSiblingDB('<here>')`. */
  | { kind: 'collectionName'; from: number; prefix: string }
  | { kind: 'databaseName'; from: number; prefix: string }
  /** A key in a filter, projection, sort or pipeline stage. */
  | {
      kind: 'field';
      from: number;
      prefix: string;
      /** The collection the call works on, `null` when it is not known. */
      collection: string | null;
      /** The key the object is the value of (`$match`), `null` at the top of an argument. */
      parentKey: string | null;
      /** The method the call is (`find`, `aggregate`…). */
      method: string;
      /** Whether the key is being typed inside quotes. */
      quoted: boolean;
    }
  | { kind: 'none' };

const IDENT = /[A-Za-z_$][\w$]*$/;

/** The identifier ending at `end`, as `{ from, text }`. */
function wordBefore(text: string, end: number): { from: number; text: string } {
  const match = IDENT.exec(text.slice(0, end));
  return match ? { from: end - match[0].length, text: match[0] } : { from: end, text: '' };
}

interface Frame {
  open: '(' | '[' | '{';
  /** `(`: the call, when it is `db.<collection>.<method>(`. */
  call: { collection: string | null; method: string } | null;
  /** `{`: whether a key is expected (after `{` or `,`) and the last key read. */
  expectKey: boolean;
  key: string | null;
}

/** `db.coll.method`, `db.getCollection('coll').method` or `db['coll'].method`, ending the text. */
const CALL_TARGET = [
  /\bdb\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*$/,
  /\bdb\s*\.\s*getCollection\(\s*(['"])([^'"]*)\1\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*$/,
  /\bdb\s*\[\s*(['"])([^'"]*)\1\s*\]\s*\.\s*([A-Za-z_$][\w$]*)\s*$/,
];

function callOf(before: string): Frame['call'] {
  const dot = CALL_TARGET[0]?.exec(before);
  if (dot?.[1] !== undefined && dot[2] !== undefined) {
    // `db.getCollection(` is a call on the database, not a collection named so.
    return dot[1] === 'getCollection' ? null : { collection: dot[1], method: dot[2] };
  }
  for (const pattern of CALL_TARGET.slice(1)) {
    const found = pattern.exec(before);
    if (found?.[2] !== undefined && found[3] !== undefined) {
      return { collection: found[2], method: found[3] };
    }
  }
  return null;
}

/** Methods whose arguments hold documents with field names. */
const FIELD_METHODS = new Set([
  'aggregate',
  'count',
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findAndModify',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'remove',
  'replaceOne',
  'update',
  'updateMany',
  'updateOne',
]);

/** Operators whose value holds filters of their own. */
const LOGICAL = new Set(['$and', '$elemMatch', '$expr', '$nor', '$not', '$or']);

/** Stages whose object holds field names. */
const FIELD_STAGES = new Set(['$match', '$project', '$sort', '$addFields', '$set', '$group']);

interface Scan {
  stack: Frame[];
  /** Inside a string at the end of the text: its quote, and where its content starts. */
  string: { quote: string; start: number } | null;
}

/**
 * Walks the script up to `end` keeping the open brackets, strings and comments: enough to know
 * which call the cursor is in and whether it stands where a key goes.
 */
function scan(text: string, end: number): Scan {
  const stack: Frame[] = [];
  let i = 0;
  let key: string | null = null;
  let string: Scan['string'] = null;
  const top = () => stack[stack.length - 1];
  while (i < end) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === '/' && next === '/') {
      const stop = text.indexOf('\n', i);
      i = stop < 0 || stop >= end ? end : stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const stop = text.indexOf('*/', i + 2);
      i = stop < 0 || stop + 2 > end ? end : stop + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < end && text.charAt(j) !== c) j += text.charAt(j) === '\\' ? 2 : 1;
      if (j >= end) {
        string = { quote: c, start: i + 1 };
        break;
      }
      key = text.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const call = c === '(' ? callOf(text.slice(0, i)) : null;
      stack.push({ open: c, call, expectKey: c === '{', key: null });
      key = null;
    } else if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      key = null;
    } else if (c === ':') {
      const frame = top();
      if (frame?.open === '{') {
        frame.key = key;
        frame.expectKey = false;
      }
    } else if (c === ',') {
      const frame = top();
      if (frame?.open === '{') {
        frame.expectKey = true;
        frame.key = null;
      }
      key = null;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < end && /[\w$]/.test(text.charAt(j))) j++;
      key = text.slice(i, j);
      i = j;
      continue;
    } else if (/[0-9]/.test(c)) {
      key = null;
    }
    i += 1;
  }
  return { stack, string };
}

/** The statement the cursor is in starts after the last `;` or blank line at the top level. */
function statementStart(text: string, end: number): number {
  const semicolon = text.lastIndexOf(';', end - 1);
  return semicolon < 0 ? 0 : semicolon + 1;
}

/** What is being typed at `position` in a mongosh script. */
export function mongoshContext(text: string, position: number): MongoshContext {
  const statement = statementStart(text, position);
  const body = text.slice(statement);
  const at = position - statement;
  const { stack, string } = scan(body, at);

  if (string) {
    const typed = body.slice(string.start, at);
    const frame = stack[stack.length - 1];
    const absolute = statement + string.start;
    if (frame?.open === '(' && frame.call === null) {
      const before = body.slice(0, string.start - 1);
      if (/\bdb\s*\.\s*getCollection\(\s*$/.test(before)) {
        return { kind: 'collectionName', from: absolute, prefix: typed };
      }
      if (/\bgetSiblingDB\(\s*$/.test(before)) {
        return { kind: 'databaseName', from: absolute, prefix: typed };
      }
    }
    if (frame?.open === '{' && frame.expectKey) {
      return fieldContext(stack, absolute, typed, true);
    }
    return { kind: 'none' };
  }

  const word = wordBefore(body, at);
  const from = statement + word.from;
  const before = body.slice(0, word.from);
  const line = text.slice(text.lastIndexOf('\n', position - 1) + 1, position);

  // Shell commands: `use app`, `show collections`.
  const lineHead = /^\s*(use|show)\s+(\S*)$/.exec(line);
  if (lineHead?.[1] === 'use' && stack.length === 0) {
    return { kind: 'use', from, prefix: lineHead[2] ?? '' };
  }
  if (lineHead?.[1] === 'show' && stack.length === 0) {
    return { kind: 'show', from, prefix: lineHead[2] ?? '' };
  }

  const frame = stack[stack.length - 1];
  if (frame?.open === '{' && frame.expectKey && !/\.\s*$/.test(before)) {
    return fieldContext(stack, from, word.text, false);
  }

  // `db['orders'].` and `db.getCollection('orders').` name a collection too.
  const bracketed = /\bdb\s*\[\s*(['"])([^'"]*)\1\s*\]\s*\.\s*$/.exec(before);
  if (bracketed?.[2] !== undefined) {
    return { kind: 'collection', from, prefix: word.text, collection: bracketed[2] };
  }
  const named = /\bdb\s*\.\s*getCollection\(\s*(['"])([^'"]*)\1\s*\)\s*\.\s*$/.exec(before);
  if (named?.[2] !== undefined) {
    return { kind: 'collection', from, prefix: word.text, collection: named[2] };
  }
  const member = /([A-Za-z_$][\w$]*|\))\s*\.\s*$/.exec(before);
  if (member) {
    const owner = member[1] ?? '';
    if (owner === 'db') return { kind: 'db', from, prefix: word.text };
    if (owner === ')') return { kind: 'cursor', from, prefix: word.text };
    const collection = new RegExp(`\\bdb\\s*\\.\\s*${escapeRegExp(owner)}\\s*\\.\\s*$`).exec(
      before,
    );
    if (collection) return { kind: 'collection', from, prefix: word.text, collection: owner };
    return { kind: 'none' };
  }
  // A name that is not a member: the start of a statement or an expression.
  const tail = /(\S)(\s*)$/.exec(before);
  if (tail?.[1] !== undefined && /[\w$)\]'"`]/.test(tail[1]) && !(tail[2] ?? '').includes('\n')) {
    // After a value (`find(…) x`) no name can follow.
    return { kind: 'none' };
  }
  const lineStart = /(^|\n)\s*$/.test(before);
  return { kind: 'global', from, prefix: word.text, lineStart };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldContext(
  stack: readonly Frame[],
  from: number,
  prefix: string,
  quoted: boolean,
): MongoshContext {
  // The call the object is an argument of, and the key whose value it is (`$match: { … }`).
  let call: Frame['call'] = null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame?.open === '(') {
      call = frame.call;
      break;
    }
  }
  if (!call || !FIELD_METHODS.has(call.method)) return { kind: 'none' };
  const objects = stack.filter((frame) => frame.open === '{');
  const parent = objects.length >= 2 ? (objects[objects.length - 2]?.key ?? null) : null;
  if (call.method === 'aggregate') {
    // Only inside a stage that names fields; the stage names themselves at the stage level.
    if (
      parent !== null &&
      parent.startsWith('$') &&
      !FIELD_STAGES.has(parent) &&
      !LOGICAL.has(parent)
    ) {
      return { kind: 'none' };
    }
  }
  return {
    kind: 'field',
    from,
    prefix,
    collection: call.collection,
    parentKey: parent,
    method: call.method,
    quoted,
  };
}

/** The metadata the options draw on; what is not cached is empty. */
export interface MongoshData {
  /** Collections of the current database. */
  collections: readonly string[];
  /** Databases of the connection. */
  databases: readonly string[];
  /** Sampled field paths of a collection of the current database, `null` when not read yet. */
  fields: (collection: string) => readonly string[] | null;
}

const option = (
  label: string,
  type: string,
  extra: Partial<ConsoleOption> = {},
): ConsoleOption => ({
  label,
  type,
  ...extra,
});

/** The suggestions for a context. */
export function mongoshOptions(
  context: MongoshContext,
  data: MongoshData,
  to: number,
): ConsoleSuggestions | null {
  if (context.kind === 'none') return null;
  const result = (options: ConsoleOption[]): ConsoleSuggestions | null => {
    const found = startingWith(options, context.prefix);
    return found.length === 0 ? null : { from: context.from, to, options: found };
  };
  switch (context.kind) {
    case 'use':
      return result(data.databases.map((name) => option(name, 'namespace')));
    case 'show':
      return result(SHOW_TARGETS.map((name) => option(name, 'keyword')));
    case 'databaseName':
      return result(data.databases.map((name) => option(name, 'namespace')));
    case 'collectionName':
      return result(data.collections.map((name) => option(name, 'class')));
    case 'db':
      return result([
        ...data.collections.map((name) =>
          option(name, 'class', { boost: 2, detail: 'collection' }),
        ),
        ...DATABASE_METHODS.map((name) => option(name, 'method', { apply: `${name}(` })),
      ]);
    case 'collection':
      return result(
        COLLECTION_METHODS.map((name) => option(name, 'method', { apply: `${name}(` })),
      );
    case 'cursor':
      return result(CURSOR_METHODS.map((name) => option(name, 'method', { apply: `${name}(` })));
    case 'global':
      return result([
        ...(context.lineStart
          ? SHELL_COMMANDS.map((name) => option(name, 'keyword', { boost: 1, apply: `${name} ` }))
          : []),
        ...GLOBALS.map((global) =>
          option(global.name, global.kind === 'variable' ? 'variable' : global.kind),
        ),
      ]);
    case 'field': {
      const operators = context.prefix.startsWith('$');
      const names: ConsoleOption[] = [];
      if (operators) {
        for (const name of QUERY_OPERATORS) names.push(option(name, 'keyword'));
        if (context.method === 'aggregate' && context.parentKey === null) {
          for (const name of AGGREGATION_STAGES) names.push(option(name, 'keyword', { boost: 1 }));
        }
      } else {
        const underField = context.parentKey !== null && !context.parentKey.startsWith('$');
        if (underField && context.method !== 'aggregate') {
          for (const name of QUERY_OPERATORS) names.push(option(name, 'keyword'));
        } else if (context.method === 'aggregate' && context.parentKey === null) {
          for (const name of AGGREGATION_STAGES) names.push(option(name, 'keyword'));
        } else {
          const fields = context.collection === null ? null : data.fields(context.collection);
          for (const path of fields ?? []) {
            const label = context.quoted
              ? path
              : /^[A-Za-z_$][\w$]*$/.test(path)
                ? path
                : `"${path}"`;
            names.push(option(path, 'property', { apply: label }));
          }
        }
      }
      return result(names);
    }
  }
}

/** Suggestions for a mongosh script at `position`. */
export function mongoshSuggest(
  text: string,
  position: number,
  data: MongoshData,
  explicit = false,
): ConsoleSuggestions | null {
  const context = mongoshContext(text, position);
  // A list for every space typed would be noise: names alone wait for a letter or Ctrl+Space.
  if (context.kind === 'global' && context.prefix === '' && !explicit) return null;
  return mongoshOptions(context, data, position);
}
