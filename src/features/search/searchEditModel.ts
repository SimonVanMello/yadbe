import type {
  SearchApplyOutcome,
  SearchChangeSet,
  SearchEdit,
  SearchEditBlock,
  SearchEditInfo,
  SeqGuard,
} from '../../ipc';
import type { MessageKey, MessageParams } from '../../i18n/i18n';
import { parseJson, type JsonNode } from '../grid/jsonTree';

/**
 * Document edits of an index tab (M4-8), pure: the pending documents, which hit can be
 * changed and why not, what is left after an apply. One document per request: a change set
 * is applied one edit at a time, stopping at the first failure.
 */

/** A hit as an edit needs it: where it is, its version and whether it has a `_source`. */
export interface HitRef {
  index: string;
  id: string;
  routing: string | null;
  guard: SeqGuard | null;
  hasSource: boolean;
}

/** One staged edit, with a key that identifies its document. */
export interface PendingDoc {
  key: string;
  edit: SearchEdit;
}

function scalarText(node: JsonNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string') return node.value;
  if (node.type === 'number') return node.raw;
  return null;
}

function field(node: JsonNode, name: string): JsonNode | undefined {
  return node.type === 'object' ? node.entries.find(([key]) => key === name)?.[1] : undefined;
}

/** A whole hit (JSON text, as `searchFetchDocuments` reads it), numbers exact. */
export function hitRefOf(text: string): HitRef | null {
  let hit: JsonNode;
  try {
    hit = parseJson(text);
  } catch {
    return null;
  }
  const index = scalarText(field(hit, '_index'));
  const id = scalarText(field(hit, '_id'));
  if (index === null || id === null) return null;
  const seqNo = scalarText(field(hit, '_seq_no'));
  const primaryTerm = scalarText(field(hit, '_primary_term'));
  return {
    index,
    id,
    routing: scalarText(field(hit, '_routing')),
    guard: seqNo !== null && primaryTerm !== null ? { seqNo, primaryTerm } : null,
    hasSource: field(hit, '_source') !== undefined,
  };
}

/** Where a document is: the key of its pending edit. */
export function docKey(index: string, id: string): string {
  return JSON.stringify([index, id]);
}

let createdKeys = 0;

function keyOf(edit: SearchEdit): string {
  if (edit.kind === 'create' && (edit.id === null || edit.id === '')) {
    createdKeys += 1;
    return `new-${String(createdKeys)}`;
  }
  return docKey(edit.index, edit.id ?? '');
}

/** Stages `edit`: it replaces a pending edit of the same document. */
export function stage(list: readonly PendingDoc[], edit: SearchEdit): PendingDoc[] {
  const key = keyOf(edit);
  const at = list.findIndex((p) => p.key === key);
  if (at === -1) return [...list, { key, edit }];
  const previous = list[at];
  // Editing a document created in this batch stays a create.
  const merged: SearchEdit =
    previous?.edit.kind === 'create' && edit.kind === 'replace'
      ? { ...previous.edit, source: edit.source }
      : edit;
  return list.map((p, i) => (i === at ? { key, edit: merged } : p));
}

export function unstage(list: readonly PendingDoc[], key: string): PendingDoc[] {
  return list.filter((p) => p.key !== key);
}

export function changeSetOf(target: string, list: readonly PendingDoc[]): SearchChangeSet {
  return { target, edits: list.map((p) => p.edit) };
}

/** What an apply leaves pending: the edits it did not apply. */
export function afterApply(
  list: readonly PendingDoc[],
  outcome: Pick<SearchApplyOutcome, 'applied'>,
): PendingDoc[] {
  return list.slice(outcome.applied.length);
}

/** The pending edit `edit` made on the server's version `guard` (keep mine, overwrite). */
export function rebase(list: readonly PendingDoc[], edit: number, guard: SeqGuard): PendingDoc[] {
  return list.map((p, i) => {
    if (i !== edit || p.edit.kind === 'create') return p;
    return { ...p, edit: { ...p.edit, guard } };
  });
}

/** A message key and its parameters, for a reason or a description. */
export interface Said {
  key: MessageKey;
  params?: MessageParams;
}

/** Why a document cannot be changed, as said in the UI. */
export function blockText(block: SearchEditBlock): Said {
  switch (block.kind) {
    case 'readOnlyConnection':
      return { key: 'search.edit.block.readOnly' };
    case 'dataStream':
      return { key: 'search.edit.block.dataStream', params: { name: block.name } };
    case 'closed':
      return { key: 'search.edit.block.closed', params: { index: block.index } };
    case 'writeBlock':
      return {
        key: 'search.edit.block.writeBlock',
        params: { index: block.index, setting: block.setting },
      };
    case 'noSource':
      return { key: 'search.edit.block.noSource' };
    case 'unknownIndex':
      return { key: 'search.edit.block.unknownIndex', params: { index: block.index } };
  }
}

/** Why `hit` cannot be edited or deleted here (`null`: it can), from the tab's edit info. */
export function hitBlock(info: SearchEditInfo | null, hit: HitRef): SearchEditBlock | null {
  if (info?.readOnly) return { kind: 'readOnlyConnection' };
  if (!hit.hasSource) return { kind: 'noSource' };
  const state = info?.indices.find((s) => s.index === hit.index);
  if (state?.dataStream) return { kind: 'dataStream', name: state.dataStream };
  if (state?.closed) return { kind: 'closed', index: hit.index };
  if (state?.writeBlock) {
    return { kind: 'writeBlock', index: hit.index, setting: state.writeBlock };
  }
  return null;
}

/** Where a duplicate of `hit` goes: its index, or its data stream for a backing index. */
export function duplicateTarget(info: SearchEditInfo | null, hit: HitRef): string {
  return info?.indices.find((s) => s.index === hit.index)?.dataStream ?? hit.index;
}

/** What an edit does, in a list. */
export function describe(edit: SearchEdit): Said {
  switch (edit.kind) {
    case 'replace':
      return { key: 'search.edit.describe.replace', params: { id: edit.id, index: edit.index } };
    case 'delete':
      return { key: 'search.edit.describe.delete', params: { id: edit.id, index: edit.index } };
    case 'create':
      return edit.id
        ? { key: 'search.edit.describe.create', params: { id: edit.id, index: edit.index } }
        : { key: 'search.edit.describe.createAuto', params: { index: edit.index } };
  }
}

/** A document text checked as the backend will: a JSON object. `null`: valid. */
export function documentError(text: string): { line: number; column: number } | 'notObject' | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? null
      : 'notObject';
  } catch (error) {
    // V8: "… at position 12 (line 2 column 5)"; older: "at position 12".
    const message = error instanceof Error ? error.message : '';
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol) return { line: Number(lineCol[1]), column: Number(lineCol[2]) };
    const position = /position (\d+)/.exec(message);
    const offset = position ? Number(position[1]) : text.length;
    const before = text.slice(0, offset).split('\n');
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
  }
}
