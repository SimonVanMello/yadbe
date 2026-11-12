import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { KvBytes, KvConflict, KvEdit, KvKeyKind, ValueKind } from '../../ipc';
import { bytesId } from './kvBytes';

/**
 * Pending edits of a key tab (M4-6): the `KvEdit`s Apply sends, kept in the order the user
 * made them, one per thing changed (a later edit of the same field replaces the earlier one
 * and keeps what the user first saw). The grid overlay, the counts and "keep mine" of a
 * conflict are derived from them.
 */

export type CollectionKind = Extract<KvKeyKind, 'hash' | 'list' | 'set' | 'zset' | 'stream'>;

const HEX = /^[0-9a-f]*$/i;

/** The exact bytes of a grid cell: its text, or the hexadecimal of a binary value. */
export function cellBytes(text: string, kind: ValueKind): KvBytes {
  if (kind !== 'bytes' || !HEX.test(text) || text.length % 2 !== 0) return { text, base64: null };
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytesValue(bytes);
}

/** Bytes as the backend sends them: text when UTF-8, else escaped text and base64. */
export function bytesValue(bytes: Uint8Array): KvBytes {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), base64: null };
  } catch {
    let raw = '';
    let shown = '';
    for (const b of bytes) {
      raw += String.fromCharCode(b);
      if (b === 0x5c) shown += '\\\\';
      else if (b === 0x22) shown += '\\"';
      else if (b >= 0x20 && b < 0x7f) shown += String.fromCharCode(b);
      else shown += `\\x${b.toString(16).padStart(2, '0')}`;
    }
    return { text: shown, base64: btoa(raw) };
  }
}

/** Hexadecimal pairs typed by the user (spaces ignored) as bytes; `null` when not hex. */
export function parseHex(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || !HEX.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The column holding what identifies a row of each collection. */
export function identityColumn(kind: CollectionKind): number {
  return kind === 'zset' ? 1 : 0;
}

/** The identity of a collection row: its field, member, stream id or list index. */
export function rowIdentity(kind: CollectionKind, cells: readonly KvBytes[]): string {
  const cell = cells[identityColumn(kind)] ?? { text: '', base64: null };
  if (kind === 'list') return `i:${cell.text}`;
  if (kind === 'stream') return `s:${cell.text}`;
  return bytesId(cell);
}

/** What an edit changes, to merge two edits of the same thing. */
function targetOf(edit: KvEdit): string | null {
  switch (edit.op) {
    case 'stringSet':
      return 'string';
    case 'jsonSet':
      return `json:${edit.path}`;
    case 'hashSet':
    case 'hashDelete':
    case 'hashRename':
      return bytesId(edit.field);
    case 'listSet':
    case 'listRemove':
      return `i:${String(edit.index)}`;
    case 'setAdd':
    case 'setRemove':
    case 'zsetSet':
    case 'zsetRemove':
      return bytesId(edit.member);
    case 'streamDelete':
      return `s:${edit.id}`;
    case 'expire':
      return 'ttl';
    default:
      return null;
  }
}

/**
 * Adds an edit to the pending ones. A second edit of the same field, member, element or time
 * to live replaces the first, keeping the first one's original (what the server holds); an
 * edit that brings a thing back to its original drops out.
 */
export function upsert(edits: readonly KvEdit[], edit: KvEdit): KvEdit[] {
  const target = targetOf(edit);
  if (target === null) return [...edits, edit];
  const at = edits.findIndex((e) => targetOf(e) === target);
  if (at < 0) return [...edits, edit];
  const previous = edits[at];
  if (!previous) return [...edits, edit];
  const merged = merge(previous, edit);
  const next = [...edits];
  if (merged === null) next.splice(at, 1);
  else next[at] = merged;
  return next;
}

function same(a: KvBytes | null, b: KvBytes | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && bytesId(a) === bytesId(b));
}

/** `later` over `earlier` of the same target; `null` when nothing is left to do. */
function merge(earlier: KvEdit, later: KvEdit): KvEdit | null {
  // A field added then removed, a member added then removed: nothing happened.
  if (earlier.op === 'hashSet' && earlier.original === null && later.op === 'hashDelete')
    return null;
  if (earlier.op === 'setAdd' && later.op === 'setRemove') return null;
  if (earlier.op === 'setRemove' && later.op === 'setAdd') return null;
  if (earlier.op === 'zsetSet' && earlier.original === null && later.op === 'zsetRemove')
    return null;
  switch (later.op) {
    case 'stringSet':
      if (earlier.op !== 'stringSet') return later;
      return same(earlier.original, later.value) ? null : { ...later, original: earlier.original };
    case 'hashSet':
      if (earlier.op === 'hashDelete') {
        return same(earlier.original, later.value)
          ? null
          : { ...later, original: earlier.original };
      }
      if (earlier.op !== 'hashSet') return later;
      return same(earlier.original, later.value) ? null : { ...later, original: earlier.original };
    case 'hashDelete':
      if (earlier.op === 'hashSet' && earlier.original !== null)
        return { ...later, original: earlier.original };
      return later;
    case 'listSet':
      if (earlier.op !== 'listSet') return later;
      return same(earlier.original, later.value) ? null : { ...later, original: earlier.original };
    case 'listRemove':
      if (earlier.op === 'listSet') return { ...later, original: earlier.original };
      return later;
    case 'zsetSet':
      if (earlier.op === 'zsetRemove') {
        return earlier.original === later.score ? null : { ...later, original: earlier.original };
      }
      if (earlier.op !== 'zsetSet') return later;
      return earlier.original === later.score ? null : { ...later, original: earlier.original };
    case 'zsetRemove':
      if (earlier.op === 'zsetSet' && earlier.original !== null)
        return { ...later, original: earlier.original };
      return later;
    case 'expire':
      if (earlier.op !== 'expire') return later;
      return { ...later, original: earlier.original };
    case 'jsonSet':
      if (earlier.op !== 'jsonSet') return later;
      return earlier.original === later.value ? null : { ...later, original: earlier.original };
    default:
      return later;
  }
}

/** A row of the grid as an edit shows it: its state and the cells that changed. */
export interface RowOverlay {
  state: 'modified' | 'deleted';
  /** New text of changed cells, by data column. */
  cells: Map<number, string | null>;
  /** Hover text: what a changed cell held. */
  titles: Map<number, string>;
}

/** What the pending edits change in a collection's grid. */
export interface Overlay {
  /** Rows of the server, by identity. */
  rows: Map<string, RowOverlay>;
  /** Rows the edits add, after the server's rows. */
  added: (string | null)[][];
  /** A version that moves whenever the overlay changes. */
  version: string;
}

function row(rows: Map<string, RowOverlay>, id: string): RowOverlay {
  let found = rows.get(id);
  if (!found) {
    found = { state: 'modified', cells: new Map(), titles: new Map() };
    rows.set(id, found);
  }
  return found;
}

/** The grid overlay of a collection's pending edits. */
export function overlayOf(edits: readonly KvEdit[]): Overlay {
  const rows = new Map<string, RowOverlay>();
  const added: (string | null)[][] = [];
  for (const edit of edits) {
    switch (edit.op) {
      case 'hashSet':
        if (edit.original === null) added.push([edit.field.text, edit.value.text]);
        else {
          const r = row(rows, bytesId(edit.field));
          r.cells.set(1, edit.value.text);
          r.titles.set(1, edit.original.text);
        }
        break;
      case 'hashDelete':
        row(rows, bytesId(edit.field)).state = 'deleted';
        break;
      case 'hashRename': {
        const r = row(rows, bytesId(edit.field));
        r.cells.set(0, edit.to.text);
        r.titles.set(0, edit.field.text);
        break;
      }
      case 'listSet': {
        const r = row(rows, `i:${String(edit.index)}`);
        r.cells.set(1, edit.value.text);
        r.titles.set(1, edit.original.text);
        break;
      }
      case 'listRemove':
        row(rows, `i:${String(edit.index)}`).state = 'deleted';
        break;
      case 'listPush':
        for (const value of edit.values) added.push([edit.head ? '⤒' : '⤓', value.text]);
        break;
      case 'setAdd':
        added.push([edit.member.text]);
        break;
      case 'setRemove':
        row(rows, bytesId(edit.member)).state = 'deleted';
        break;
      case 'zsetSet':
        if (edit.original === null) added.push([null, edit.member.text, edit.score]);
        else {
          const r = row(rows, bytesId(edit.member));
          r.cells.set(2, edit.score);
          r.titles.set(2, edit.original);
        }
        break;
      case 'zsetRemove':
        row(rows, bytesId(edit.member)).state = 'deleted';
        break;
      case 'streamAdd':
        added.push([
          '*',
          JSON.stringify(Object.fromEntries(edit.fields.map((f) => [f.field.text, f.value.text]))),
        ]);
        break;
      case 'streamDelete':
        row(rows, `s:${edit.id}`).state = 'deleted';
        break;
      default:
        break;
    }
  }
  return { rows, added, version: JSON.stringify(edits) };
}

/** The pending count shown in the tab: one per edit, pushed elements counted each. */
export function pendingCount(edits: readonly KvEdit[]): number {
  return edits.reduce((n, e) => n + (e.op === 'listPush' ? e.values.length : 1), 0);
}

/**
 * "Keep mine" of a conflict: the edit applied over what the server holds now; `null` when it
 * cannot be (the thing is gone, the key changed type).
 */
export function rebase(edit: KvEdit, conflict: KvConflict): KvEdit | null {
  if (!conflict.rebasable && conflict.kind !== 'aborted') return null;
  if (conflict.kind === 'aborted') return edit;
  const current = conflict.current;
  switch (edit.op) {
    case 'stringSet':
    case 'hashSet':
      return current === null ? null : { ...edit, original: current };
    case 'listSet':
      return current === null ? null : { ...edit, original: current };
    case 'zsetSet':
      return current === null ? null : { ...edit, original: current.text };
    case 'jsonSet':
      return current === null ? null : { ...edit, original: current.text };
    case 'expire':
      return { ...edit, original: current === null ? null : Number(current.text) };
    default:
      return null;
  }
}

/** The value an edit writes, as shown in the conflict dialog; `null` when it writes none. */
export function editValueText(edit: KvEdit): string | null {
  switch (edit.op) {
    case 'stringSet':
    case 'hashSet':
    case 'listSet':
      return edit.value.text;
    case 'hashRename':
      return edit.to.text;
    case 'zsetSet':
      return edit.score;
    case 'jsonSet':
      return edit.value;
    case 'expire':
      return edit.ttl.kind === 'persist' ? 'PERSIST' : String(edit.ttl.ms ?? '');
    default:
      return null;
  }
}

/** A short sentence naming what an edit does, for the conflict dialog. */
export function describeEdit(edit: KvEdit): { key: MessageKey; params: MessageParams } {
  switch (edit.op) {
    case 'hashSet':
    case 'hashDelete':
    case 'hashRename':
      return { key: `keyValue.edit.describe.${edit.op}`, params: { field: edit.field.text } };
    case 'listSet':
    case 'listRemove':
      return { key: `keyValue.edit.describe.${edit.op}`, params: { index: edit.index } };
    case 'setAdd':
    case 'setRemove':
    case 'zsetSet':
    case 'zsetRemove':
      return { key: `keyValue.edit.describe.${edit.op}`, params: { member: edit.member.text } };
    case 'streamDelete':
      return { key: 'keyValue.edit.describe.streamDelete', params: { id: edit.id } };
    case 'jsonSet':
      return { key: 'keyValue.edit.describe.jsonSet', params: { path: edit.path } };
    case 'rename':
    case 'copy':
      return { key: `keyValue.edit.describe.${edit.op}`, params: { to: edit.to.text } };
    default:
      return { key: `keyValue.edit.describe.${edit.op}`, params: {} };
  }
}
