import type { DocNode } from '../documents/docTree';
import { parseJson, type JsonNode } from '../grid/jsonTree';

/**
 * MongoDB documents for the documents view: canonical Extended JSON (what the backend sends,
 * lossless) shown the relaxed way a MongoDB user reads it (`ObjectId('…')`, an ISO date, `5`
 * marked `long`), and copied as relaxed Extended JSON.
 */

function scalar(
  kind: Extract<DocNode, { type: 'scalar' }>['kind'],
  text: string,
  json: string,
  label: string | null = null,
): DocNode {
  return { type: 'scalar', kind, text, json, label };
}

function plainJson(node: JsonNode): string {
  switch (node.type) {
    case 'string':
      return JSON.stringify(node.value);
    case 'number':
      return node.raw;
    case 'bool':
      return node.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array':
      return `[${node.items.map(plainJson).join(',')}]`;
    case 'object':
      return `{${node.entries.map(([k, v]) => `${JSON.stringify(k)}:${plainJson(v)}`).join(',')}}`;
  }
}

function stringOf(node: JsonNode | undefined): string | null {
  return node?.type === 'string' ? node.value : null;
}

function field(node: JsonNode, key: string): JsonNode | undefined {
  return node.type === 'object' ? node.entries.find(([k]) => k === key)?.[1] : undefined;
}

function isoOf(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hexOf(base64: string): string {
  try {
    return Array.from(atob(base64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/** The Extended JSON value an object stands for, or `null` for a plain document. */
function wrapped(node: Extract<JsonNode, { type: 'object' }>): DocNode | null {
  const keys = node.entries.map(([k]) => k);
  if (keys.length === 2 && keys.includes('$code') && keys.includes('$scope')) {
    return scalar('other', `Code(${plainJson(node)})`, plainJson(node));
  }
  if (keys.length !== 1) return null;
  const [key = '', body] = node.entries[0] ?? [];
  if (!body) return null;
  const text = stringOf(body);
  switch (key) {
    case '$oid':
      return text === null
        ? null
        : scalar('id', `ObjectId('${text}')`, plainJson(node), 'objectId');
    case '$numberInt':
      return text === null ? null : scalar('number', text, text, null);
    case '$numberLong':
      return text === null ? null : scalar('number', text, text, 'long');
    case '$numberDouble': {
      if (text === null) return null;
      const finite = /^-?\d/.test(text);
      return scalar('number', text.replace(/\.0$/, ''), finite ? text : plainJson(node), 'double');
    }
    case '$numberDecimal':
      return text === null ? null : scalar('number', text, plainJson(node), 'decimal');
    case '$date': {
      const ms = Number(stringOf(field(body, '$numberLong')) ?? NaN);
      const iso = text ?? (Number.isFinite(ms) ? isoOf(ms) : null);
      return iso === null
        ? scalar('date', plainJson(node), plainJson(node), 'date')
        : scalar('date', iso, JSON.stringify({ $date: iso }), 'date');
    }
    case '$binary': {
      const base64 = stringOf(field(body, 'base64')) ?? '';
      const subType = stringOf(field(body, 'subType')) ?? '00';
      if (subType === '04') {
        const hex = hexOf(base64);
        if (hex.length === 32) {
          const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
          return scalar('binary', `UUID('${uuid}')`, plainJson(node), 'uuid');
        }
      }
      return scalar('binary', `Binary('${base64}', ${subType})`, plainJson(node), 'binData');
    }
    case '$regularExpression': {
      const pattern = stringOf(field(body, 'pattern')) ?? '';
      const options = stringOf(field(body, 'options')) ?? '';
      return scalar('other', `/${pattern}/${options}`, plainJson(node), 'regex');
    }
    case '$timestamp':
      return scalar('other', `Timestamp(${plainJson(body)})`, plainJson(node), 'timestamp');
    case '$minKey':
      return scalar('other', 'MinKey', plainJson(node));
    case '$maxKey':
      return scalar('other', 'MaxKey', plainJson(node));
    case '$symbol':
    case '$code':
    case '$undefined':
    case '$dbPointer':
    case '$uuid':
      return scalar('other', plainJson(node), plainJson(node), key.slice(1));
    default:
      return null;
  }
}

/** A canonical Extended JSON value as a documents-view node. */
export function ejsonNode(node: JsonNode): DocNode {
  switch (node.type) {
    case 'string':
      return scalar('string', JSON.stringify(node.value), JSON.stringify(node.value));
    case 'number':
      return scalar('number', node.raw, node.raw);
    case 'bool':
      return scalar('bool', node.value ? 'true' : 'false', node.value ? 'true' : 'false');
    case 'null':
      return scalar('null', 'null', 'null');
    case 'array':
      return { type: 'array', items: node.items.map(ejsonNode) };
    case 'object':
      return (
        wrapped(node) ?? {
          type: 'object',
          entries: node.entries.map(([k, v]) => [k, ejsonNode(v)]),
        }
      );
  }
}

/** A document as the backend sends it (canonical Extended JSON text). */
export function ejsonDocument(text: string): DocNode {
  try {
    return ejsonNode(parseJson(text));
  } catch {
    return scalar('other', text, JSON.stringify(text));
  }
}
