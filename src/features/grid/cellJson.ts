import type { Value, ValueKind } from '../../ipc';
import { stringifyJson, tryParseJson } from './jsonTree';

const NUMERIC: ReadonlySet<ValueKind> = new Set(['int', 'decimal', 'float']);

export function isNumericKind(kind: ValueKind): boolean {
  return NUMERIC.has(kind);
}

/** A JSON number literal (what `NaN` or `Infinity` are not). */
export const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A JSON fragment for one value of a `Value[]` (array cells). */
function jsonOfValue(value: Value): string {
  switch (value.kind) {
    case 'null':
    case 'missing':
      return 'null';
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'array':
      return `[${value.value.map(jsonOfValue).join(', ')}]`;
    default:
      return jsonOfCell(value.value, value.kind);
  }
}

/**
 * A cell as JSON: numbers stay numbers (as written, never through a double), JSON stays JSON,
 * arrays become plain JSON arrays, the rest are strings.
 */
export function jsonOfCell(text: string | null, kind: ValueKind): string {
  if (text === null) return 'null';
  if (isNumericKind(kind)) return JSON_NUMBER.test(text) ? text : JSON.stringify(text);
  if (kind === 'bool' && (text === 'true' || text === 'false')) return text;
  if (kind === 'json') {
    const tree = tryParseJson(text);
    return tree ? stringifyJson(tree) : JSON.stringify(text);
  }
  if (kind === 'array') {
    const plain = arrayJson(text);
    if (plain !== null) return plain;
  }
  return JSON.stringify(text);
}

/**
 * An array cell (the JSON of its `Value[]`, as the backend sends it) as a plain JSON array:
 * `[{"kind":"text","value":"a"},{"kind":"null"}]` → `["a", null]`. `null` if not that form.
 */
export function arrayJson(text: string): string | null {
  try {
    const items = JSON.parse(text) as unknown;
    return Array.isArray(items) ? `[${(items as Value[]).map(jsonOfValue).join(', ')}]` : null;
  } catch {
    return null;
  }
}
