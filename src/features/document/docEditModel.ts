import type { DocChangeSet, DocConflict, DocEdit, PathSeg, ValueKind } from '../../ipc';
import { parseJson, stringifyJson, type JsonNode } from '../grid/jsonTree';

/**
 * Pending edits of a collection tab (M4-4), as plain immutable values. Documents are identified
 * by their `_id` (canonical Extended JSON, as the backend sends it with each page), so edits
 * outlive a page change; each keeps the whole document as it was read, which is what the
 * backend guards the change with. Nothing is sent before Apply.
 *
 * A document is changed either field by field (paths set or unset; a path inside a changed one
 * changes that one's value) or as a whole (edited as JSON); it can be deleted. New documents
 * (added or duplicated) are kept as their JSON text.
 */

export type Path = readonly PathSeg[];

/** One field to set or unset. Texts are Extended JSON. */
export interface FieldChange {
  path: Path;
  /** The value as read; `null`: the field was missing. */
  original: string | null;
  /** The value to write; `null`: unset it. */
  value: string | null;
}

export interface DocumentEdit {
  /** The document's `_id`, canonical Extended JSON. */
  id: string;
  /** The whole document as read, canonical Extended JSON. */
  original: string;
  /** By `pathKey`. */
  fields: ReadonlyMap<string, FieldChange>;
  /** The whole document as edited as JSON; replaces the fields. */
  replacement: string | null;
  deleted: boolean;
}

export interface NewDocument {
  /** Stable while the edit lives (keys of React lists, marks). */
  key: number;
  /** Extended JSON text, `_id` included. */
  document: string;
}

export interface DocEdits {
  /** By document `_id`. */
  documents: ReadonlyMap<string, DocumentEdit>;
  inserts: readonly NewDocument[];
}

export const NO_EDITS: DocEdits = { documents: new Map(), inserts: [] };

export function pathKey(path: Path): string {
  return JSON.stringify(path);
}

export function pathText(path: Path): string {
  return path.map(String).join('.');
}

function isPrefix(a: Path, b: Path): boolean {
  return a.length <= b.length && a.every((seg, i) => seg === b[i]);
}

// --- Values -----------------------------------------------------------------------------------

/** JSON text of a tree without any space, as the backend writes it. */
export function compactJson(node: JsonNode): string {
  switch (node.type) {
    case 'null':
      return 'null';
    case 'bool':
      return node.value ? 'true' : 'false';
    case 'number':
      return node.raw;
    case 'string':
      return JSON.stringify(node.value);
    case 'array':
      return `[${node.items.map(compactJson).join(',')}]`;
    case 'object':
      return `{${node.entries.map(([k, v]) => `${JSON.stringify(k)}:${compactJson(v)}`).join(',')}}`;
  }
}

/** The keys that make an object an Extended JSON value (a leaf), not a document. */
function isWrapper(node: JsonNode): boolean {
  if (node.type !== 'object') return false;
  const keys = node.entries.map(([k]) => k);
  if (keys.length === 2 && keys.includes('$code') && keys.includes('$scope')) return true;
  return keys.length === 1 && (keys[0] ?? '').startsWith('$');
}

export function valueAt(node: JsonNode | undefined, path: Path): JsonNode | undefined {
  let current = node;
  for (const seg of path) {
    if (!current) return undefined;
    if (typeof seg === 'number') {
      current = current.type === 'array' ? current.items[seg] : undefined;
    } else {
      current =
        current.type === 'object' && !isWrapper(current)
          ? current.entries.find(([k]) => k === seg)?.[1]
          : undefined;
    }
  }
  return current;
}

/**
 * `node` with `value` at `path` (`undefined`: removed). A missing document on the way is created;
 * a path through anything else is refused (`null`).
 */
export function setAt(
  node: JsonNode | undefined,
  path: Path,
  value: JsonNode | undefined,
): JsonNode | undefined | null {
  const [seg, ...rest] = path;
  if (seg === undefined) return value;
  if (typeof seg === 'number') {
    if (node?.type !== 'array' || seg >= node.items.length) return null;
    const child = setAt(node.items[seg], rest, value);
    if (child === null) return null;
    const items = [...node.items];
    if (child === undefined) items.splice(seg, 1);
    else items[seg] = child;
    return { type: 'array', items };
  }
  const base: JsonNode = node ?? { type: 'object', entries: [] };
  if (base.type !== 'object' || isWrapper(base)) return null;
  const at = base.entries.findIndex(([k]) => k === seg);
  const child = setAt(at >= 0 ? base.entries[at]?.[1] : undefined, rest, value);
  if (child === null) return null;
  const entries = [...base.entries];
  if (child === undefined) {
    if (at >= 0) entries.splice(at, 1);
  } else if (at >= 0) {
    entries[at] = [seg, child];
  } else {
    entries.push([seg, child]);
  }
  return { type: 'object', entries };
}

/** Two Extended JSON texts hold the same value (as written: key order counts). */
export function sameValue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return compactJson(parseJson(a)) === compactJson(parseJson(b));
  } catch {
    return a === b;
  }
}

function text(node: JsonNode | undefined): string | null {
  return node === undefined ? null : compactJson(node);
}

/** A new ObjectId as drivers make one: seconds, random bytes, a counter. */
let counter = Math.floor(Math.random() * 0xffffff);
export function newObjectId(now = Date.now()): string {
  const seconds = Math.floor(now / 1000)
    .toString(16)
    .padStart(8, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  counter = (counter + 1) % 0x1000000;
  return `${seconds}${random}${counter.toString(16).padStart(6, '0')}`;
}

/** `text` (a JSON document) with an `_id` first: its own, or a new ObjectId. */
export function withId(textOrNode: string | JsonNode): JsonNode {
  const node = typeof textOrNode === 'string' ? parseJson(textOrNode) : textOrNode;
  if (node.type !== 'object') throw new Error('not a document');
  const own = node.entries.find(([k]) => k === '_id');
  const id: JsonNode = own?.[1] ?? {
    type: 'object',
    entries: [['$oid', { type: 'string', value: newObjectId() }]],
  };
  return {
    type: 'object',
    entries: [['_id', id], ...node.entries.filter(([k]) => k !== '_id')],
  };
}

// --- Edits ------------------------------------------------------------------------------------

/** A document as read, for an edit. */
export interface Target {
  id: string;
  original: string;
}

function blank(target: Target): DocumentEdit {
  return { ...target, fields: new Map(), replacement: null, deleted: false };
}

function withDocument(edits: DocEdits, id: string, edit: DocumentEdit | null): DocEdits {
  const documents = new Map(edits.documents);
  if (edit && (edit.deleted || edit.replacement !== null || edit.fields.size > 0)) {
    documents.set(id, edit);
  } else {
    documents.delete(id);
  }
  return { ...edits, documents };
}

/**
 * Sets (`value` text) or unsets (`null`) the field at `path` of a document. Inside a field that
 * is already changed, that change's value is edited; a change back to what was read is dropped.
 * `null` result: the path cannot be reached in the document as it is now.
 */
export function setField(
  edits: DocEdits,
  target: Target,
  path: Path,
  value: string | null,
): DocEdits | null {
  const current = edits.documents.get(target.id) ?? blank(target);
  if (current.deleted) return null;
  const node = value === null ? undefined : parseJson(value);
  if (current.replacement !== null) {
    const next = setAt(parseJson(current.replacement), path, node);
    if (!next) return null;
    return replaceDocument(edits, target, compactJson(next));
  }
  const ancestor = [...current.fields.values()].find(
    (change) => change.path.length < path.length && isPrefix(change.path, path),
  );
  const fields = new Map(current.fields);
  if (ancestor) {
    const base = ancestor.value === null ? undefined : parseJson(ancestor.value);
    const next = setAt(base, path.slice(ancestor.path.length), node);
    if (next === null) return null;
    const nextText = text(next);
    if (sameValue(nextText, ancestor.original)) fields.delete(pathKey(ancestor.path));
    else fields.set(pathKey(ancestor.path), { ...ancestor, value: nextText });
  } else {
    for (const [key, change] of fields) if (isPrefix(path, change.path)) fields.delete(key);
    const original = text(valueAt(parseJson(current.original), path));
    if (typeof path[path.length - 1] === 'number' && (original === null || value === null)) {
      return null;
    }
    if (!sameValue(original, value)) fields.set(pathKey(path), { path, original, value });
  }
  return withDocument(edits, target.id, { ...current, fields });
}

/** Replaces a document by `replacement` (edited as JSON); the same text as read drops it. */
export function replaceDocument(edits: DocEdits, target: Target, replacement: string): DocEdits {
  const current = edits.documents.get(target.id) ?? blank(target);
  const same = sameValue(compactJson(withId(replacement)), compactJson(withId(target.original)));
  return withDocument(edits, target.id, {
    ...current,
    fields: new Map(),
    replacement: same ? null : replacement,
  });
}

export function deleteDocuments(edits: DocEdits, targets: readonly Target[]): DocEdits {
  let next = edits;
  for (const target of targets) {
    const current = next.documents.get(target.id) ?? blank(target);
    next = withDocument(next, target.id, { ...current, deleted: true });
  }
  return next;
}

/** Drops every pending change of a document (a deletion included). */
export function revertDocument(edits: DocEdits, id: string): DocEdits {
  return withDocument(edits, id, null);
}

/** Takes the deletion back, keeping the document's other changes. */
export function undelete(edits: DocEdits, id: string): DocEdits {
  const current = edits.documents.get(id);
  return current ? withDocument(edits, id, { ...current, deleted: false }) : edits;
}

let nextKey = 1;

export function addDocument(edits: DocEdits, document: string): DocEdits {
  return { ...edits, inserts: [...edits.inserts, { key: nextKey++, document }] };
}

export function updateInsert(edits: DocEdits, key: number, document: string): DocEdits {
  return {
    ...edits,
    inserts: edits.inserts.map((insert) => (insert.key === key ? { key, document } : insert)),
  };
}

export function removeInsert(edits: DocEdits, key: number): DocEdits {
  return { ...edits, inserts: edits.inserts.filter((insert) => insert.key !== key) };
}

/** A copy of a document as a new one, with a new ObjectId. */
export function duplicateOf(document: string): string {
  const node = parseJson(document);
  if (node.type !== 'object') throw new Error('not a document');
  return compactJson(
    withId({ type: 'object', entries: node.entries.filter(([k]) => k !== '_id') }),
  );
}

export function pendingCount(edits: DocEdits): number {
  return edits.documents.size + edits.inserts.length;
}

/** The document as it will be after Apply (`null`: deleted). */
export function effective(edit: DocumentEdit): JsonNode | null {
  if (edit.deleted) return null;
  if (edit.replacement !== null) return withId(edit.replacement);
  let node: JsonNode | undefined = parseJson(edit.original);
  for (const change of edit.fields.values()) {
    const next = setAt(
      node,
      change.path,
      change.value === null ? undefined : parseJson(change.value),
    );
    if (next) node = next;
  }
  return node;
}

/** Where each change of a change set comes from, in its order. */
export type EditRef = { kind: 'document'; id: string } | { kind: 'insert'; key: number };

/** What Apply sends, and where each change comes from. */
export function toChangeSet(
  edits: DocEdits,
  database: string,
  collection: string,
): { changes: DocChangeSet; refs: EditRef[] } {
  const list: DocEdit[] = [];
  const refs: EditRef[] = [];
  for (const edit of edits.documents.values()) {
    refs.push({ kind: 'document', id: edit.id });
    if (edit.deleted) {
      list.push({ kind: 'delete', id: edit.id, original: edit.original });
    } else if (edit.replacement !== null) {
      list.push({
        kind: 'replace',
        id: edit.id,
        original: edit.original,
        replacement: edit.replacement,
      });
    } else {
      list.push({
        kind: 'update',
        id: edit.id,
        fields: [...edit.fields.values()].map((f) => ({
          path: [...f.path],
          original: f.original,
          value: f.value,
        })),
      });
    }
  }
  for (const insert of edits.inserts) {
    refs.push({ kind: 'insert', key: insert.key });
    list.push({ kind: 'insert', document: insert.document });
  }
  return { changes: { database, collection, edits: list }, refs };
}

/** The edits left once the changes at `applied` (indices of the change set) are on the server. */
export function withoutApplied(
  edits: DocEdits,
  refs: readonly EditRef[],
  applied: readonly number[],
): DocEdits {
  let next = edits;
  for (const index of applied) {
    const ref = refs[index];
    if (ref?.kind === 'document') next = revertDocument(next, ref.id);
    else if (ref?.kind === 'insert') next = removeInsert(next, ref.key);
  }
  return next;
}

/**
 * A conflict resolved by keeping mine: the change now compares with what the server holds
 * (`now`), so the next Apply writes over their change, by choice. A change already equal to
 * theirs is dropped; a document gone on the server drops its changes.
 */
export function keepMine(edits: DocEdits, conflict: DocConflict): DocEdits {
  const edit = edits.documents.get(conflict.id);
  if (!edit) return edits;
  if (conflict.kind === 'deleted' || conflict.current === null) {
    return revertDocument(edits, conflict.id);
  }
  if (edit.deleted || edit.replacement !== null) {
    return withDocument(edits, conflict.id, { ...edit, original: conflict.current });
  }
  const current = parseJson(conflict.current);
  const fields = new Map<string, FieldChange>();
  for (const [key, change] of edit.fields) {
    const theirs = text(valueAt(current, change.path));
    if (!sameValue(theirs, change.value)) fields.set(key, { ...change, original: theirs });
  }
  return withDocument(edits, conflict.id, { ...edit, original: conflict.current, fields });
}

// --- Field editor -----------------------------------------------------------------------------

/** The types the field editor writes (the BSON types a user types most). */
export type FieldType =
  'string' | 'int' | 'long' | 'double' | 'decimal' | 'bool' | 'date' | 'objectId' | 'null' | 'json';

export const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'null',
  'json',
];

function wrapped(node: JsonNode): [string, JsonNode] | null {
  if (node.type !== 'object' || node.entries.length !== 1) return null;
  const [entry] = node.entries;
  return entry && entry[0].startsWith('$') ? entry : null;
}

function bodyText(node: JsonNode | undefined): string {
  return node?.type === 'string' ? node.value : '';
}

const INT32 = /^-?\d+$/;

/** The type a value is edited as, so that a changed number keeps its type. */
export function fieldTypeOf(node: JsonNode | undefined): FieldType {
  if (!node) return 'string';
  switch (node.type) {
    case 'string':
      return 'string';
    case 'bool':
      return 'bool';
    case 'null':
      return 'null';
    case 'number':
      return INT32.test(node.raw)
        ? Math.abs(Number(node.raw)) < 2 ** 31
          ? 'int'
          : 'long'
        : 'double';
    case 'array':
      return 'json';
    case 'object': {
      const w = wrapped(node);
      switch (w?.[0]) {
        case '$numberInt':
          return 'int';
        case '$numberLong':
          return 'long';
        case '$numberDouble':
          return 'double';
        case '$numberDecimal':
          return 'decimal';
        case '$date':
          return 'date';
        case '$oid':
          return 'objectId';
        default:
          return 'json';
      }
    }
  }
}

function isoOf(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

/** What the editor shows for a value of `type`. */
export function editorText(node: JsonNode | undefined, type: FieldType): string {
  if (!node) return '';
  const w = wrapped(node);
  switch (type) {
    case 'string':
      return node.type === 'string' ? node.value : compactJson(node);
    case 'bool':
      return node.type === 'bool' && node.value ? 'true' : 'false';
    case 'null':
      return '';
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
      if (node.type === 'number') return node.raw;
      return w ? bodyText(w[1]) : '';
    case 'date': {
      if (!w) return '';
      const body = w[1];
      if (body.type === 'string') return body.value;
      const ms = Number(bodyText(valueAt(body, ['$numberLong'])));
      return Number.isFinite(ms) ? isoOf(ms) : '';
    }
    case 'objectId':
      return w ? bodyText(w[1]) : '';
    case 'json':
      return stringifyJson(node, 2);
  }
}

/** Why the editor's text is not a value of its type (an i18n key), or the value. */
export type TypedValue = { ok: true; json: string } | { ok: false; error: string };

const wrap = (key: string, body: string): string => JSON.stringify({ [key]: body });

export function typedValue(type: FieldType, input: string): TypedValue {
  const value = input.trim();
  const bad = (error: string): TypedValue => ({ ok: false, error });
  switch (type) {
    case 'string':
      return { ok: true, json: JSON.stringify(input) };
    case 'null':
      return { ok: true, json: 'null' };
    case 'bool':
      if (value === 'true' || value === 'false') return { ok: true, json: value };
      return bad('mongo.edit.invalid.bool');
    case 'int': {
      if (!INT32.test(value)) return bad('mongo.edit.invalid.int');
      const n = Number(value);
      if (n < -(2 ** 31) || n >= 2 ** 31) return bad('mongo.edit.invalid.int');
      return { ok: true, json: wrap('$numberInt', String(n)) };
    }
    case 'long': {
      if (!INT32.test(value)) return bad('mongo.edit.invalid.long');
      const n = BigInt(value);
      if (n < -(2n ** 63n) || n >= 2n ** 63n) return bad('mongo.edit.invalid.long');
      return { ok: true, json: wrap('$numberLong', n.toString()) };
    }
    case 'double': {
      if (['NaN', 'Infinity', '-Infinity'].includes(value)) {
        return { ok: true, json: wrap('$numberDouble', value) };
      }
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value))
        return bad('mongo.edit.invalid.double');
      const n = Number(value);
      if (!Number.isFinite(n)) return bad('mongo.edit.invalid.double');
      return {
        ok: true,
        json: wrap(
          '$numberDouble',
          Number.isInteger(n) && !/[eE]/.test(String(n)) ? `${String(n)}.0` : String(n),
        ),
      };
    }
    case 'decimal':
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^-?(NaN|Infinity)$/.test(value)) {
        return bad('mongo.edit.invalid.decimal');
      }
      return { ok: true, json: wrap('$numberDecimal', value) };
    case 'date': {
      const ms = Date.parse(value);
      if (value === '' || Number.isNaN(ms)) return bad('mongo.edit.invalid.date');
      return { ok: true, json: JSON.stringify({ $date: { $numberLong: String(ms) } }) };
    }
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(value)) return bad('mongo.edit.invalid.objectId');
      return { ok: true, json: wrap('$oid', value.toLowerCase()) };
    case 'json':
      try {
        return { ok: true, json: compactJson(parseJson(value)) };
      } catch {
        return bad('mongo.edit.invalid.json');
      }
  }
}

// --- Display ----------------------------------------------------------------------------------

/**
 * A document as the JSON editor shows it: relaxed where that loses nothing (Int32 as a plain
 * number, a fractional Double as a plain number, an ObjectId, a date as ISO text), canonical
 * elsewhere (Int64, a whole Double, Decimal128, NaN), so that saving it unchanged writes the
 * same types back.
 */
export function editableJson(node: JsonNode): JsonNode {
  const w = wrapped(node);
  if (w) {
    const [key, body] = w;
    if (key === '$numberInt' && body.type === 'string') return { type: 'number', raw: body.value };
    if (key === '$numberDouble' && body.type === 'string' && /[.eE]/.test(body.value)) {
      const n = Number(body.value);
      if (Number.isFinite(n) && !Number.isInteger(n)) return { type: 'number', raw: body.value };
    }
    if (key === '$date') {
      const ms = Number(bodyText(valueAt(body, ['$numberLong'])));
      const year = new Date(ms).getUTCFullYear();
      if (Number.isFinite(ms) && year >= 1970 && year <= 9999) {
        return { type: 'object', entries: [['$date', { type: 'string', value: isoOf(ms) }]] };
      }
    }
    return node;
  }
  if (node.type === 'object') {
    return { type: 'object', entries: node.entries.map(([k, v]) => [k, editableJson(v)]) };
  }
  if (node.type === 'array') return { type: 'array', items: node.items.map(editableJson) };
  return node;
}

export function editableText(document: string): string {
  return stringifyJson(editableJson(parseJson(document)), 2);
}

function pad(n: number, size = 2): string {
  return String(n).padStart(size, '0');
}

/** A date cell as the backend writes it (`YYYY-MM-DD HH:MM:SS[.mmm]+00`). */
function dateCell(ms: number): string | null {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  const millis = d.getUTCMilliseconds();
  return `${pad(year, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${millis ? `.${pad(millis, 3)}` : ''}+00`;
}

function hexOf(base64: string): string {
  try {
    return Array.from(atob(base64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/** A value as a grid cell, the way the backend makes cells of a page (`ejson::to_value`). */
export function cellOf(node: JsonNode | undefined): { text: string | null; kind: ValueKind } {
  // The backend's windows write a missing field as an empty text of kind `missing`.
  if (!node) return { text: '', kind: 'missing' };
  switch (node.type) {
    case 'null':
      return { text: null, kind: 'text' };
    case 'bool':
      return { text: node.value ? 'true' : 'false', kind: 'bool' };
    case 'string':
      return { text: node.value, kind: 'text' };
    case 'number':
      return { text: node.raw, kind: /^-?\d+$/.test(node.raw) ? 'int' : 'float' };
    case 'array':
      return { text: compactJson(node), kind: 'json' };
    case 'object': {
      const w = wrapped(node);
      const body = w?.[1];
      switch (w?.[0]) {
        case '$oid':
          return { text: bodyText(body), kind: 'objectId' };
        case '$numberInt':
        case '$numberLong':
          return { text: bodyText(body), kind: 'int' };
        case '$numberDouble':
          return { text: bodyText(body).replace(/\.0$/, ''), kind: 'float' };
        case '$numberDecimal':
          return { text: bodyText(body), kind: 'decimal' };
        case '$date': {
          const ms =
            body?.type === 'string'
              ? Date.parse(body.value)
              : Number(bodyText(valueAt(body, ['$numberLong'])));
          const cell = dateCell(ms);
          if (cell) return { text: cell, kind: 'timestampTz' };
          break;
        }
        case '$binary': {
          const sub = bodyText(valueAt(body, ['subType']));
          const hex = hexOf(bodyText(valueAt(body, ['base64'])));
          if (sub === '00' || sub === '0') return { text: hex, kind: 'bytes' };
          if ((sub === '04' || sub === '4') && hex.length === 32) {
            return {
              text: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
              kind: 'uuid',
            };
          }
          break;
        }
      }
      return { text: compactJson(node), kind: 'json' };
    }
  }
}

/** Top-level fields whose value differs between two documents (by name). */
export function changedFields(
  before: JsonNode | undefined,
  after: JsonNode | undefined,
): Set<string> {
  const names = new Set<string>();
  const entries = (node: JsonNode | undefined) => (node?.type === 'object' ? node.entries : []);
  for (const [k] of [...entries(before), ...entries(after)]) names.add(k);
  const changed = new Set<string>();
  for (const name of names) {
    const a = text(valueAt(before, [name]));
    const b = text(valueAt(after, [name]));
    if (a !== b) changed.add(name);
  }
  return changed;
}
