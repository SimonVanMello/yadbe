import type { DocNode } from '../documents/docTree';
import { parseJson, type JsonNode } from '../grid/jsonTree';

/**
 * Plain JSON (an Elasticsearch hit, a whole response) for the documents view. Numbers keep the
 * text the server wrote, so a 64-bit id or a long stays exact; `_id` and `@timestamp`-like
 * values get their own colors.
 */

function scalar(
  kind: Extract<DocNode, { type: 'scalar' }>['kind'],
  text: string,
  json: string,
): DocNode {
  return { type: 'scalar', kind, text, json, label: null };
}

const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function node(value: JsonNode, key: string | null): DocNode {
  switch (value.type) {
    case 'string': {
      const json = JSON.stringify(value.value);
      if (key === '_id') return scalar('id', json, json);
      return scalar(DATE.test(value.value) ? 'date' : 'string', json, json);
    }
    case 'number':
      return scalar('number', value.raw, value.raw);
    case 'bool':
      return scalar('bool', String(value.value), String(value.value));
    case 'null':
      return scalar('null', 'null', 'null');
    case 'array':
      return { type: 'array', items: value.items.map((item) => node(item, null)) };
    case 'object':
      return {
        type: 'object',
        entries: value.entries.map(([name, child]) => [name, node(child, name)]),
      };
  }
}

/** A JSON text as a documents-view node; text that is not JSON shows as one value. */
export function jsonDocument(text: string): DocNode {
  try {
    return node(parseJson(text), null);
  } catch {
    return scalar('other', text, JSON.stringify(text));
  }
}
