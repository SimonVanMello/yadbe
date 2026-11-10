import type { Value } from '../../ipc';
import { parseJson, tryParseJson, type JsonNode } from './jsonTree';

/** Display modes of the cell viewer (F-064). */
export type ViewerMode = 'text' | 'json' | 'xml' | 'hex';

/** Bytes a hex dump shows at most (the rest is announced, and stays copyable / savable). */
export const HEX_DUMP_BYTES = 64 * 1024;
/** Characters the text view shows at most. */
export const TEXT_VIEW_CHARS = 500_000;

/** Lines of a classic hex dump: offset, 16 bytes in two groups, printable ASCII. */
export function hexDump(hex: string, maxBytes = HEX_DUMP_BYTES): string[] {
  const total = Math.floor(hex.length / 2);
  const count = Math.min(total, maxBytes);
  const lines: string[] = [];
  for (let start = 0; start < count; start += 16) {
    const end = Math.min(count, start + 16);
    let bytes = '';
    let ascii = '';
    for (let i = start; i < start + 16; i++) {
      if (i === start + 8) bytes += ' ';
      if (i < end) {
        const pair = hex.slice(i * 2, i * 2 + 2);
        const code = parseInt(pair, 16);
        bytes += `${pair} `;
        ascii += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '.';
      } else {
        bytes += '   ';
      }
    }
    lines.push(`${start.toString(16).padStart(8, '0')}  ${bytes} |${ascii}|`);
  }
  return lines;
}

export type XmlNode =
  | { type: 'element'; name: string; attributes: [string, string][]; children: XmlNode[] }
  | { type: 'text'; text: string }
  | { type: 'comment'; text: string }
  | { type: 'cdata'; text: string }
  | { type: 'instruction'; target: string; text: string };

const MAX_XML_NODES = 20_000;

/** The document's nodes (whitespace-only text dropped), or `null` when not well-formed XML. */
export function parseXml(text: string): XmlNode[] | null {
  if (!/^\s*</.test(text)) return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  let budget = MAX_XML_NODES;
  const convert = (node: Node): XmlNode | null => {
    if (budget-- <= 0) return null;
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        const el = node as Element;
        return {
          type: 'element',
          name: el.tagName,
          attributes: [...el.attributes].map((a) => [a.name, a.value]),
          children: [...el.childNodes].flatMap((child) => convert(child) ?? []),
        };
      }
      case Node.TEXT_NODE: {
        const value = node.nodeValue ?? '';
        return value.trim() ? { type: 'text', text: value.trim() } : null;
      }
      case Node.CDATA_SECTION_NODE:
        return { type: 'cdata', text: node.nodeValue ?? '' };
      case Node.COMMENT_NODE:
        return { type: 'comment', text: (node.nodeValue ?? '').trim() };
      case Node.PROCESSING_INSTRUCTION_NODE: {
        const pi = node as ProcessingInstruction;
        return { type: 'instruction', target: pi.target, text: pi.data };
      }
      default:
        return null;
    }
  };
  return [...doc.childNodes].flatMap((node) => convert(node) ?? []);
}

export interface Analysis {
  /** The value as text (hex for binary), what Copy puts on the clipboard. */
  text: string;
  modes: ViewerMode[];
  /** The mode shown first. */
  preferred: ViewerMode;
  json: JsonNode | null;
  /** Why a JSON column's value could not be read as JSON. */
  jsonError: string | null;
  xml: XmlNode[] | null;
}

/** What the viewer can show for a value. `null` for SQL NULL. */
export function analyzeValue(value: Value): Analysis | null {
  if (value.kind === 'null') return null;
  if (value.kind === 'bytes') {
    return {
      text: value.value,
      modes: ['hex', 'text'],
      preferred: 'hex',
      json: null,
      jsonError: null,
      xml: null,
    };
  }
  const text =
    value.kind === 'bool'
      ? String(value.value)
      : value.kind === 'array'
        ? JSON.stringify(value.value)
        : value.value;
  let json: JsonNode | null = null;
  let jsonError: string | null = null;
  const trimmed = text.trimStart();
  if (value.kind === 'json' || value.kind === 'array' || /^[[{]/.test(trimmed)) {
    try {
      json = value.kind === 'array' ? arrayTree(value.value) : parseJson(text);
    } catch (error) {
      if (value.kind === 'json') jsonError = error instanceof Error ? error.message : String(error);
    }
  }
  const xml = !json && trimmed.startsWith('<') ? parseXml(text) : null;
  const modes: ViewerMode[] = ['text'];
  if (json) modes.unshift('json');
  if (xml) modes.unshift('xml');
  return { text, modes, preferred: modes[0] ?? 'text', json, jsonError, xml };
}

/** An array value as JSON: its elements in their JSON form (numbers kept exact). */
function arrayTree(values: Value[]): JsonNode {
  const node = (v: Value): JsonNode => {
    switch (v.kind) {
      case 'null':
        return { type: 'null' };
      case 'bool':
        return { type: 'bool', value: v.value };
      case 'array':
        return { type: 'array', items: v.value.map(node) };
      case 'int':
      case 'decimal':
      case 'float':
        return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v.value)
          ? { type: 'number', raw: v.value }
          : { type: 'string', value: v.value };
      case 'json':
        return tryParseJson(v.value) ?? { type: 'string', value: v.value };
      default:
        return { type: 'string', value: v.value };
    }
  };
  return { type: 'array', items: values.map(node) };
}

/** File extension for saving a value shown in `mode`. */
export function extensionFor(mode: ViewerMode): string {
  switch (mode) {
    case 'json':
      return 'json';
    case 'xml':
      return 'xml';
    case 'hex':
      return 'bin';
    case 'text':
      return 'txt';
  }
}
