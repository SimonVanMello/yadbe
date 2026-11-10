/**
 * A JSON reader that keeps numbers as written. `JSON.parse` turns `12345678901234567890.25`
 * into a rounded double; values from a database must stay exact (rule 8), so the cell viewer
 * and the JSON copy use this tree instead.
 */

export type JsonNode =
  | { type: 'object'; entries: [string, JsonNode][] }
  | { type: 'array'; items: JsonNode[] }
  | { type: 'string'; value: string }
  | { type: 'number'; raw: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' };

export class JsonSyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} at position ${String(position)}`);
    this.name = 'JsonSyntaxError';
    this.position = position;
  }
}

const MAX_DEPTH = 512;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// eslint-disable-next-line no-control-regex -- JSON strings cannot hold raw control characters.
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

export function parseJson(text: string): JsonNode {
  let pos = 0;

  const fail = (message: string): never => {
    throw new JsonSyntaxError(message, pos);
  };

  const skip = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) pos++;
      else break;
    }
  };

  const readString = (): string => {
    STRING.lastIndex = pos;
    const match = STRING.exec(text);
    if (!match) return fail('Invalid string');
    pos += match[0].length;
    return JSON.parse(match[0]) as string;
  };

  const value = (depth: number): JsonNode => {
    if (depth > MAX_DEPTH) fail('Nesting too deep');
    skip();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const entries: [string, JsonNode][] = [];
      skip();
      if (text[pos] === '}') {
        pos++;
        return { type: 'object', entries };
      }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail('Expected a key');
        const key = readString();
        skip();
        if (text[pos] !== ':') fail('Expected ":"');
        pos++;
        entries.push([key, value(depth + 1)]);
        skip();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return { type: 'object', entries };
        }
        fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      pos++;
      const items: JsonNode[] = [];
      skip();
      if (text[pos] === ']') {
        pos++;
        return { type: 'array', items };
      }
      for (;;) {
        items.push(value(depth + 1));
        skip();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return { type: 'array', items };
        }
        fail('Expected "," or "]"');
      }
    }
    if (c === '"') return { type: 'string', value: readString() };
    if (text.startsWith('true', pos)) {
      pos += 4;
      return { type: 'bool', value: true };
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return { type: 'bool', value: false };
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return { type: 'null' };
    }
    NUMBER.lastIndex = pos;
    const number = NUMBER.exec(text);
    if (number) {
      pos += number[0].length;
      return { type: 'number', raw: number[0] };
    }
    return fail('Unexpected character');
  };

  const root = value(0);
  skip();
  if (pos < text.length) fail('Unexpected text after the value');
  return root;
}

/** `null` when `text` is not JSON. */
export function tryParseJson(text: string): JsonNode | null {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}

/** JSON text of a tree; `indent` 0 writes it on one line (`, ` and `: ` separators). */
export function stringifyJson(node: JsonNode, indent = 0): string {
  const write = (n: JsonNode, level: number): string => {
    switch (n.type) {
      case 'null':
        return 'null';
      case 'bool':
        return n.value ? 'true' : 'false';
      case 'number':
        return n.raw;
      case 'string':
        return JSON.stringify(n.value);
      case 'array': {
        if (n.items.length === 0) return '[]';
        const items = n.items.map((item) => write(item, level + 1));
        return wrap('[', ']', items, level);
      }
      case 'object': {
        if (n.entries.length === 0) return '{}';
        const entries = n.entries.map(
          ([key, child]) => `${JSON.stringify(key)}: ${write(child, level + 1)}`,
        );
        return wrap('{', '}', entries, level);
      }
    }
  };
  const wrap = (open: string, close: string, parts: string[], level: number) => {
    if (indent === 0) return `${open}${parts.join(', ')}${close}`;
    const pad = ' '.repeat(indent * (level + 1));
    return `${open}\n${parts.map((p) => pad + p).join(',\n')}\n${' '.repeat(indent * level)}${close}`;
  };
  return write(node, 0);
}

/** Nodes in a tree (to decide how much of it the viewer expands up front). */
export function countNodes(node: JsonNode, limit = Infinity): number {
  let count = 0;
  const stack: JsonNode[] = [node];
  while (stack.length > 0 && count < limit) {
    const n = stack.pop();
    if (!n) break;
    count++;
    if (n.type === 'array') for (const item of n.items) stack.push(item);
    else if (n.type === 'object') for (const [, child] of n.entries) stack.push(child);
  }
  return count;
}
