import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { ipc, unwrap, type KvBytes, type KvEdit, type KvKeyInfo, type KvNewValue } from '../../ipc';
import { toast, useToastStore } from '../../ui/toastStore';
import { showJournalEntry } from '../journal/journalStore';
import { findConnection } from '../query/connectionLookup';
import { openKeyTab } from './kvActions';
import { decodeBase64 } from './kvBytes';
import { applyNow, refreshKeys, stageEdit } from './kvEditActions';
import { bytesValue, parseHex, type CollectionKind } from './kvEditModel';
import { tabEdits } from './kvEditStore';
import { askForm, flag, text, type KvFormField, type KvFormValues } from './kvFormStore';
import { tr } from './kvText';

/**
 * The forms of key edits (M4-6): what each action asks, turned into a `KvEdit`. Edits of a
 * key's content are staged in its tab; key-level changes (rename, copy, delete, create) apply
 * at once after their confirmation.
 */

const HEX_PAIRS = /(..)/g;

/** Bytes as hexadecimal pairs, for a binary value typed in a form. */
function hexOf(bytes: KvBytes): string {
  if (bytes.base64 === null) return '';
  return Array.from(decodeBase64(bytes.base64), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(HEX_PAIRS, '$1 ')
    .trim();
}

/** A field holding a value: text, or hexadecimal when the value is binary. */
function valueField(name: string, label: string, original: KvBytes | null): KvFormField {
  const binary = original?.base64 != null;
  return {
    name,
    label: binary ? tr('keyValue.form.hexLabel', { label }) : label,
    kind: 'textarea',
    mono: true,
    value: original === null ? '' : binary ? hexOf(original) : original.text,
    ...(binary ? { hint: tr('keyValue.form.hexHint') } : {}),
  };
}

function binaryOf(original: KvBytes | null): boolean {
  return original?.base64 != null;
}

/** The bytes a value field holds; `null` when its hexadecimal is invalid. */
function readValue(values: KvFormValues, name: string, binary: boolean): KvBytes | null {
  const raw = text(values, name);
  if (!binary) return { text: raw, base64: null };
  const bytes = parseHex(raw);
  return bytes ? bytesValue(bytes) : null;
}

function hexError(values: KvFormValues, name: string, binary: boolean): string | null {
  return binary && readValue(values, name, true) === null ? tr('keyValue.form.badHex') : null;
}

function notEmpty(values: KvFormValues, name: string, label: string): string | null {
  return text(values, name) === '' ? tr('keyValue.form.required', { label }) : null;
}

/** A score as Redis takes it: a number, `inf` or `-inf`. */
export function validScore(score: string): boolean {
  const lower = score.trim().toLowerCase();
  if (lower === 'inf' || lower === '+inf' || lower === '-inf') return true;
  return lower !== '' && Number.isFinite(Number(lower));
}

function scoreError(values: KvFormValues, name: string): string | null {
  return validScore(text(values, name)) ? null : tr('keyValue.form.badScore');
}

/** A row of a collection as the grid shows it: its cells as exact bytes. */
export interface CollectionRow {
  cells: KvBytes[];
}

/** Edits the value of a row: a hash field's value, a list element, a member's score. */
export async function editRow(
  tabId: string,
  kind: CollectionKind,
  key: KvBytes,
  row: CollectionRow,
): Promise<void> {
  const [first, second, third] = row.cells;
  if (!first) return;
  switch (kind) {
    case 'hash':
    case 'list': {
      const original = second ?? null;
      const binary = binaryOf(original);
      const values = await askForm({
        title:
          kind === 'hash'
            ? tr('keyValue.form.editField', { field: first.text })
            : tr('keyValue.form.editElement', { index: first.text }),
        submitLabel: tr('keyValue.form.stage'),
        fields: [valueField('value', tr('keyValue.form.value'), original)],
        validate: (v) => hexError(v, 'value', binary),
      });
      if (!values || !original) return;
      const value = readValue(values, 'value', binary);
      if (!value) return;
      stageEdit(
        tabId,
        kind === 'hash'
          ? { op: 'hashSet', key, field: first, original, value }
          : { op: 'listSet', key, index: Number(first.text), original, value },
      );
      return;
    }
    case 'zset': {
      const member = second;
      const original = third?.text ?? null;
      if (!member || original === null) return;
      const values = await askForm({
        title: tr('keyValue.form.editScore', { member: member.text }),
        submitLabel: tr('keyValue.form.stage'),
        fields: [
          {
            name: 'score',
            label: tr('keyValue.form.score'),
            kind: 'text',
            mono: true,
            value: original,
          },
        ],
        validate: (v) => scoreError(v, 'score'),
      });
      if (!values) return;
      stageEdit(tabId, {
        op: 'zsetSet',
        key,
        member,
        original,
        score: text(values, 'score').trim(),
      });
      return;
    }
    default:
      return;
  }
}

/** Renames a hash field (staged: `HSET` the new name, `HDEL` the old one). */
export async function renameField(tabId: string, key: KvBytes, row: CollectionRow): Promise<void> {
  const [field, value] = row.cells;
  if (!field || !value) return;
  const values = await askForm({
    title: tr('keyValue.form.renameField', { field: field.text }),
    submitLabel: tr('keyValue.form.stage'),
    fields: [
      {
        name: 'to',
        label: tr('keyValue.form.newName'),
        kind: 'text',
        mono: true,
        value: field.text,
      },
    ],
    validate: (v) =>
      notEmpty(v, 'to', tr('keyValue.form.newName')) ??
      (text(v, 'to') === field.text ? tr('keyValue.form.sameName') : null),
  });
  if (!values) return;
  stageEdit(tabId, {
    op: 'hashRename',
    key,
    field,
    to: { text: text(values, 'to'), base64: null },
    value,
  });
}

/** Removes a row: a field, an element (by index), a member, a stream entry. */
export function removeRow(
  tabId: string,
  kind: CollectionKind,
  key: KvBytes,
  row: CollectionRow,
): void {
  const [first, second, third] = row.cells;
  if (!first) return;
  let edit: KvEdit | null = null;
  switch (kind) {
    case 'hash':
      if (second) edit = { op: 'hashDelete', key, field: first, original: second };
      break;
    case 'list':
      if (second) edit = { op: 'listRemove', key, index: Number(first.text), original: second };
      break;
    case 'set':
      edit = { op: 'setRemove', key, member: first };
      break;
    case 'zset':
      if (second && third) edit = { op: 'zsetRemove', key, member: second, original: third.text };
      break;
    case 'stream': {
      let fields: Record<string, unknown>;
      try {
        fields = second ? (JSON.parse(second.text) as Record<string, unknown>) : {};
      } catch {
        fields = {};
      }
      edit = {
        op: 'streamDelete',
        key,
        id: first.text,
        fields: Object.entries(fields).map(([field, value]) => ({
          field: { text: field, base64: null },
          value: { text: typeof value === 'string' ? value : JSON.stringify(value), base64: null },
        })),
      };
      break;
    }
  }
  if (edit) stageEdit(tabId, edit);
}

/** Lines `field=value` (or `field value`) of a stream entry. */
function streamFields(raw: string): { field: KvBytes; value: KvBytes }[] | null {
  const fields = [];
  for (const line of raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')) {
    const at = line.search(/[=\s]/);
    if (at <= 0) return null;
    fields.push({
      field: { text: line.slice(0, at), base64: null },
      value: { text: line.slice(at + 1).trim(), base64: null },
    });
  }
  return fields.length > 0 ? fields : null;
}

/** Adds to a collection: a field, elements at the head or tail, a member, an entry. */
export async function addItem(tabId: string, kind: CollectionKind, key: KvBytes): Promise<void> {
  const fieldsOf: Record<CollectionKind, KvFormField[]> = {
    hash: [
      { name: 'field', label: tr('keyValue.form.field'), kind: 'text', mono: true, value: '' },
      { name: 'value', label: tr('keyValue.form.value'), kind: 'textarea', mono: true, value: '' },
    ],
    list: [
      { name: 'value', label: tr('keyValue.form.value'), kind: 'textarea', mono: true, value: '' },
      { name: 'head', label: tr('keyValue.form.atHead'), kind: 'switch', value: false },
    ],
    set: [
      { name: 'member', label: tr('keyValue.form.member'), kind: 'text', mono: true, value: '' },
    ],
    zset: [
      { name: 'member', label: tr('keyValue.form.member'), kind: 'text', mono: true, value: '' },
      { name: 'score', label: tr('keyValue.form.score'), kind: 'text', mono: true, value: '0' },
    ],
    stream: [
      {
        name: 'fields',
        label: tr('keyValue.form.entryFields'),
        kind: 'textarea',
        mono: true,
        value: '',
        placeholder: 'field=value',
        hint: tr('keyValue.form.entryHint'),
      },
    ],
  };
  const values = await askForm({
    title: tr(`keyValue.form.add.${kind}`),
    submitLabel: tr('keyValue.form.stage'),
    fields: fieldsOf[kind],
    validate: (v) => {
      switch (kind) {
        case 'hash':
          return notEmpty(v, 'field', tr('keyValue.form.field'));
        case 'set':
          return notEmpty(v, 'member', tr('keyValue.form.member'));
        case 'zset':
          return notEmpty(v, 'member', tr('keyValue.form.member')) ?? scoreError(v, 'score');
        case 'stream':
          return streamFields(text(v, 'fields')) ? null : tr('keyValue.form.badEntry');
        default:
          return null;
      }
    },
  });
  if (!values) return;
  const t = (name: string): KvBytes => ({ text: text(values, name), base64: null });
  switch (kind) {
    case 'hash':
      stageEdit(tabId, {
        op: 'hashSet',
        key,
        field: t('field'),
        original: null,
        value: t('value'),
      });
      return;
    case 'list':
      stageEdit(tabId, { op: 'listPush', key, head: flag(values, 'head'), values: [t('value')] });
      return;
    case 'set':
      stageEdit(tabId, { op: 'setAdd', key, member: t('member') });
      return;
    case 'zset':
      stageEdit(tabId, {
        op: 'zsetSet',
        key,
        member: t('member'),
        original: null,
        score: text(values, 'score').trim(),
      });
      return;
    case 'stream': {
      const fields = streamFields(text(values, 'fields'));
      if (fields) stageEdit(tabId, { op: 'streamAdd', key, fields });
      return;
    }
  }
}

/** Seconds as text into milliseconds; `null` when not a positive number. */
function secondsOf(raw: string): number | null {
  const seconds = Number(raw.trim());
  return raw.trim() !== '' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Sets or removes the time to live (staged with the other edits of the tab). */
export async function editTtl(tabId: string, info: KvKeyInfo): Promise<void> {
  const values = await askForm({
    title: tr('keyValue.form.ttlTitle', { key: info.key.text }),
    submitLabel: tr('keyValue.form.stage'),
    fields: [
      {
        name: 'persist',
        label: tr('keyValue.form.noExpiry'),
        kind: 'switch',
        value: info.ttlMs === null,
      },
      {
        name: 'seconds',
        label: tr('keyValue.form.ttlSeconds'),
        kind: 'text',
        mono: true,
        value: info.ttlMs === null ? '' : String(Math.ceil(info.ttlMs / 1000)),
        visible: (v) => !flag(v, 'persist'),
      },
    ],
    validate: (v) =>
      flag(v, 'persist') || secondsOf(text(v, 'seconds')) !== null
        ? null
        : tr('keyValue.form.badTtl'),
  });
  if (!values) return;
  const ms = secondsOf(text(values, 'seconds'));
  stageEdit(tabId, {
    op: 'expire',
    key: info.key,
    original: info.expireAtMs,
    ttl: flag(values, 'persist') || ms === null ? { kind: 'persist' } : { kind: 'in', ms },
  });
}

/** Replaces a RedisJSON document or the value at one of its paths. */
export async function editJson(tabId: string, key: KvBytes, documentText: string): Promise<void> {
  let doc: unknown = null;
  try {
    doc = JSON.parse(documentText);
  } catch {
    doc = null;
  }
  const values = await askForm({
    title: tr('keyValue.form.jsonTitle', { key: key.text }),
    submitLabel: tr('keyValue.form.stage'),
    fields: [
      {
        name: 'path',
        label: tr('keyValue.form.jsonPath'),
        kind: 'text',
        mono: true,
        value: '$',
        hint: tr('keyValue.form.jsonPathHint'),
      },
      {
        name: 'value',
        label: tr('keyValue.form.value'),
        kind: 'textarea',
        mono: true,
        value: JSON.stringify(doc, null, 2),
      },
    ],
    validate: (v) => {
      if (jsonAt(doc, text(v, 'path')) === undefined) return tr('keyValue.form.badPath');
      try {
        JSON.parse(text(v, 'value'));
        return null;
      } catch {
        return tr('keyValue.form.badJson');
      }
    },
  });
  if (!values) return;
  const path = text(values, 'path').trim();
  const original = path === '$' ? documentText : JSON.stringify(jsonAt(doc, path));
  stageEdit(tabId, { op: 'jsonSet', key, path, original, value: text(values, 'value') });
}

/** The value at a simple JSONPath (`$`, `$.a.b`, `$.a[0]`, `$['a b']`); `undefined`: none. */
export function jsonAt(doc: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed.startsWith('$')) return undefined;
  const steps = trimmed.slice(1).match(/\.([^.[\]]+)|\[(\d+)\]|\['([^']*)'\]/g);
  const rest = trimmed.slice(1).replace(/\.([^.[\]]+)|\[(\d+)\]|\['([^']*)'\]/g, '');
  if (rest !== '') return undefined;
  let at: unknown = doc;
  for (const step of steps ?? []) {
    const name = step.startsWith('.')
      ? step.slice(1)
      : step.startsWith("['")
        ? step.slice(2, -2)
        : step.slice(1, -1);
    if (at === null || typeof at !== 'object') return undefined;
    if (!(name in at)) return undefined;
    at = (at as Record<string, unknown>)[name];
  }
  return at;
}

function refused(tabId: string | null): boolean {
  if (tabId !== null && (tabEdits(tabId)?.edits.length ?? 0) > 0) {
    toast({ variant: 'warning', title: tr('keyValue.edit.pendingFirst') });
    return true;
  }
  return false;
}

/** Renames a key: refused over an existing key unless overwriting is confirmed. */
export async function renameKey(
  connectionId: string,
  database: number,
  key: KvBytes,
  tabId: string | null = null,
): Promise<void> {
  if (refused(tabId)) return;
  const values = await askForm({
    title: tr('keyValue.form.renameKey', { key: key.text }),
    submitLabel: tr('keyValue.form.next'),
    fields: [
      { name: 'to', label: tr('keyValue.form.newName'), kind: 'text', mono: true, value: key.text },
    ],
    validate: (v) =>
      notEmpty(v, 'to', tr('keyValue.form.newName')) ??
      (text(v, 'to') === key.text ? tr('keyValue.form.sameName') : null),
  });
  if (!values) return;
  const to: KvBytes = { text: text(values, 'to'), base64: null };
  const ask = {
    title: tr('keyValue.rename.title', { key: key.text, to: to.text }),
    confirmLabel: tr('keyValue.rename.confirm'),
    danger: false,
  };
  let outcome = await applyNow(
    connectionId,
    { database, edits: [{ op: 'rename', key, to, overwrite: false }] },
    ask,
  );
  if (outcome === 'conflicted') {
    // The new name is taken: overwriting is its own, dangerous, confirmation.
    outcome = await applyNow(
      connectionId,
      { database, edits: [{ op: 'rename', key, to, overwrite: true }] },
      {
        title: tr('keyValue.rename.overwriteTitle', { to: to.text }),
        confirmLabel: tr('keyValue.rename.overwrite'),
        danger: true,
      },
    );
  }
  if (outcome && outcome !== 'conflicted') openKeyTab(connectionId, database, to);
}

/** Duplicates a key under a new name (`COPY`, which must not exist). */
export async function copyKey(connectionId: string, database: number, key: KvBytes): Promise<void> {
  const values = await askForm({
    title: tr('keyValue.form.copyKey', { key: key.text }),
    submitLabel: tr('keyValue.form.next'),
    fields: [
      {
        name: 'to',
        label: tr('keyValue.form.newName'),
        kind: 'text',
        mono: true,
        value: `${key.text}:copy`,
      },
    ],
    validate: (v) => notEmpty(v, 'to', tr('keyValue.form.newName')),
  });
  if (!values) return;
  const to: KvBytes = { text: text(values, 'to'), base64: null };
  const outcome = await applyNow(
    connectionId,
    { database, edits: [{ op: 'copy', key, to }] },
    {
      title: tr('keyValue.copy.title', { key: key.text, to: to.text }),
      confirmLabel: tr('keyValue.copy.confirm'),
      danger: false,
    },
  );
  if (outcome === 'conflicted')
    toast({ variant: 'warning', title: tr('keyValue.copy.exists', { to: to.text }) });
  else if (outcome) openKeyTab(connectionId, database, to);
}

/** Deletes keys (one from a tab, several marked in the explorer), restorable from the journal. */
export async function deleteKeys(
  connectionId: string,
  database: number,
  keys: readonly KvBytes[],
  tabId: string | null = null,
): Promise<boolean> {
  if (keys.length === 0 || refused(tabId)) return false;
  const outcome = await applyNow(
    connectionId,
    { database, edits: keys.map((key) => ({ op: 'delete', key, guard: null })) },
    {
      title:
        keys.length === 1
          ? tr('keyValue.delete.titleOne', { key: keys[0]?.text ?? '' })
          : tr('keyValue.delete.title', { count: keys.length }),
      confirmLabel: tr('keyValue.delete.confirm', { count: keys.length }),
      danger: true,
    },
  );
  return outcome !== null && outcome !== 'conflicted';
}

const NEW_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'json'] as const;
type NewType = (typeof NEW_TYPES)[number];

/** Creates a key of a type with its first value (Redis keeps no empty collection). */
export async function createKey(
  connectionId: string,
  database: number,
  prefix: string,
  jsonModule: boolean,
): Promise<void> {
  const types = NEW_TYPES.filter((type) => type !== 'json' || jsonModule);
  const is =
    (...kinds: NewType[]) =>
    (v: KvFormValues) =>
      kinds.includes(text(v, 'type') as NewType);
  const values = await askForm({
    title: tr('keyValue.create.title', { database }),
    submitLabel: tr('keyValue.form.next'),
    fields: [
      { name: 'key', label: tr('keyValue.create.key'), kind: 'text', mono: true, value: prefix },
      {
        name: 'type',
        label: tr('keyValue.create.type'),
        kind: 'select',
        value: 'string',
        options: types.map((type) => ({ value: type, label: tr(`keyValue.create.types.${type}`) })),
      },
      {
        name: 'field',
        label: tr('keyValue.form.field'),
        kind: 'text',
        mono: true,
        value: '',
        visible: is('hash'),
      },
      {
        name: 'member',
        label: tr('keyValue.form.member'),
        kind: 'text',
        mono: true,
        value: '',
        visible: is('set', 'zset'),
      },
      {
        name: 'score',
        label: tr('keyValue.form.score'),
        kind: 'text',
        mono: true,
        value: '0',
        visible: is('zset'),
      },
      {
        name: 'value',
        label: tr('keyValue.form.value'),
        kind: 'textarea',
        mono: true,
        value: '',
        visible: is('string', 'hash', 'list', 'json'),
      },
      {
        name: 'fields',
        label: tr('keyValue.form.entryFields'),
        kind: 'textarea',
        mono: true,
        value: '',
        placeholder: 'field=value',
        visible: is('stream'),
      },
      {
        name: 'ttl',
        label: tr('keyValue.create.ttl'),
        kind: 'text',
        mono: true,
        value: '',
        hint: tr('keyValue.create.ttlHint'),
      },
    ],
    validate: (v) => {
      const type = text(v, 'type') as NewType;
      return (
        notEmpty(v, 'key', tr('keyValue.create.key')) ??
        (type === 'hash' ? notEmpty(v, 'field', tr('keyValue.form.field')) : null) ??
        (type === 'set' || type === 'zset'
          ? notEmpty(v, 'member', tr('keyValue.form.member'))
          : null) ??
        (type === 'zset' ? scoreError(v, 'score') : null) ??
        (type === 'stream' && !streamFields(text(v, 'fields'))
          ? tr('keyValue.form.badEntry')
          : null) ??
        (type === 'json' && !isJson(text(v, 'value')) ? tr('keyValue.form.badJson') : null) ??
        (text(v, 'ttl').trim() !== '' && secondsOf(text(v, 'ttl')) === null
          ? tr('keyValue.form.badTtl')
          : null)
      );
    },
  });
  if (!values) return;
  const t = (name: string): KvBytes => ({ text: text(values, name), base64: null });
  const type = text(values, 'type') as NewType;
  const value: KvNewValue = (() => {
    switch (type) {
      case 'string':
        return { type, value: t('value') };
      case 'hash':
        return { type, fields: [{ field: t('field'), value: t('value') }] };
      case 'list':
        return { type, values: [t('value')] };
      case 'set':
        return { type, members: [t('member')] };
      case 'zset':
        return { type, members: [{ member: t('member'), score: text(values, 'score').trim() }] };
      case 'stream':
        return { type, fields: streamFields(text(values, 'fields')) ?? [] };
      case 'json':
        return { type, value: text(values, 'value') };
    }
  })();
  const key = t('key');
  const outcome = await applyNow(
    connectionId,
    { database, edits: [{ op: 'create', key, value, ttlMs: secondsOf(text(values, 'ttl')) }] },
    {
      title: tr('keyValue.create.confirmTitle', { key: key.text }),
      confirmLabel: tr('keyValue.create.confirm'),
      danger: false,
    },
  );
  if (outcome === 'conflicted')
    toast({ variant: 'warning', title: tr('keyValue.create.exists', { key: key.text }) });
  else if (outcome) openKeyTab(connectionId, database, key);
}

function isJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes every key under a prefix of the explorer. Counted first with a full `SCAN`; deleted
 * by atomic batches of 500 keys: the whole is not one transaction, which the confirmation
 * says, with why.
 */
export async function deleteNamespace(
  connectionId: string,
  database: number,
  prefix: KvBytes,
): Promise<void> {
  let count;
  try {
    count = await unwrap(ipc.commands.kvNamespaceCount(connectionId, database, prefix));
  } catch (error) {
    showError(error, { title: tr('keyValue.edit.failed') });
    return;
  }
  const keys = count.keys ?? 0;
  if (keys === 0) {
    toast({ title: tr('keyValue.namespace.empty', { pattern: count.pattern }) });
    return;
  }
  const connection = findConnection(connectionId);
  const ok = await confirm({
    title: tr('keyValue.namespace.title', { pattern: count.pattern }),
    description: tr('keyValue.namespace.description', {
      count: keys,
      pattern: count.pattern,
      bound: Math.round((count.snapshotBound ?? 0) / 1024 / 1024),
    }),
    items: [
      ...count.sample.map((key) => ({
        label: key.text,
        note: tr('keyValue.namespace.deleted'),
        danger: true,
      })),
      ...(keys > count.sample.length
        ? [{ label: tr('keyValue.namespace.more', { count: keys - count.sample.length }) }]
        : []),
    ],
    statement: `SCAN 0 MATCH ${count.pattern} COUNT 1000\nMULTI\nDUMP … / PEXPIRETIME …\nUNLINK … (500 keys)\nEXEC`,
    confirmLabel: tr('keyValue.namespace.confirm', { count: keys }),
    danger: true,
    ...(connection ? { connection } : {}),
  });
  if (!ok) return;
  const progress = toast({
    title: tr('keyValue.namespace.running', { pattern: count.pattern }),
    duration: Infinity,
  });
  try {
    const done = await unwrap(ipc.commands.kvDeleteNamespace(connectionId, database, prefix));
    const journalId = done.journalId;
    toast({
      variant: 'success',
      title: tr('keyValue.namespace.done', { count: done.deleted ?? 0 }),
      ...(done.revertible ? {} : { description: tr('keyValue.namespace.notRevertible') }),
      ...(journalId !== null
        ? {
            action: {
              label: tr('journal.showEntry'),
              onClick: () => {
                showJournalEntry(journalId);
              },
            },
          }
        : {}),
    });
  } catch (error) {
    showError(error, { title: tr('keyValue.edit.failed') });
  } finally {
    useToastStore.getState().dismiss(progress);
    refreshKeys(connectionId, database);
  }
}
