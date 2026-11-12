import type {
  Engine,
  JournalStatement,
  JournalTargetKind,
  KvApplyOutcome,
  KvBytes,
  KvChangeSet,
  KvConflict,
  KvConflictKind,
  KvEdit,
  KvEditDanger,
  KvNamespaceCount,
  KvNamespaceDeleted,
  KvPreview,
  KvPreviewLine,
  KvSnapshot,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import type { MockJournal } from './journal';
import type { MockKvKey, MockKvValue } from './keyValueData';
import { quote } from './redisCli';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The edit commands of the mock key-value server (mirror of `session/keyvalue/edit.rs`). */
export type KeyValueEditCommands = Pick<
  Commands,
  | 'kvPreviewChanges'
  | 'kvApplyChanges'
  | 'kvPreviewRevert'
  | 'kvApplyRevert'
  | 'kvNamespaceCount'
  | 'kvDeleteNamespace'
>;

/** What the edits need of the mock server. */
export interface MockKvStore {
  session(connectionId: string): { database: number; readOnly: boolean } | null;
  /** A key the edit may change in place. */
  get(connectionId: string, db: number, name: string): MockKvKey | null;
  put(connectionId: string, db: number, key: MockKvKey): void;
  remove(connectionId: string, db: number, name: string): void;
  names(connectionId: string, db: number): string[];
  /** Keys created and deleted, for the explorer's scan. */
  moved(connectionId: string, db: number, added: string[], removed: string[]): void;
  log(connectionId: string, sql: string, error?: YadbeError | null): void;
}

/** "Now" of the mock server: expiries are this plus the key's time to live. */
export const MOCK_EPOCH_MS = Date.UTC(2026, 10, 12, 9, 0, 0);
/** A key whose first apply finds it changed by someone else (a scripted conflict). */
export const MOCK_STALE_KEY = 'user:7:profile';
const MANY_KEYS = 10;
const SNAPSHOT_BOUND = 16 * 1024 * 1024;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

/** The mock's name of a key or value the frontend sends (code points for raw bytes). */
function text(bytes: KvBytes): string {
  return bytes.base64 === null ? bytes.text : atob(bytes.base64);
}

function encode(value: string): string {
  let raw = '';
  for (const b of new TextEncoder().encode(value)) raw += String.fromCharCode(b);
  return btoa(raw);
}

function decode(dump: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(dump), (ch) => ch.charCodeAt(0)));
}

function snapshotOf(key: MockKvKey): KvSnapshot {
  return {
    dump: encode(JSON.stringify(key)),
    expireAt: key.ttlMs === null ? null : MOCK_EPOCH_MS + key.ttlMs,
  };
}

function fromSnapshot(snapshot: KvSnapshot): MockKvKey | null {
  try {
    return JSON.parse(decode(snapshot.dump)) as MockKvKey;
  } catch {
    return null;
  }
}

function sameKey(a: MockKvKey | null, b: MockKvKey | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readOnlyRefusal(): YadbeError {
  return {
    code: 'readOnlyViolation',
    message: {
      en: 'This connection is read-only: keys cannot be changed. Nothing was run.',
      fr: 'Cette connexion est en lecture seule : les clés ne peuvent pas être modifiées. Rien n’a été exécuté.',
    },
    action: 'editConnection',
    detail: null,
    tunnel: null,
  };
}

function cmd(...args: string[]): string {
  return args.map(quote).join(' ');
}

function ttlCommand(key: string, ttl: Extract<KvEdit, { op: 'expire' }>['ttl']): string {
  switch (ttl.kind) {
    case 'persist':
      return cmd('PERSIST', key);
    case 'in':
      return cmd('PEXPIRE', key, String(Math.round(ttl.ms ?? 0)));
    case 'at':
      return cmd('PEXPIREAT', key, String(Math.round(ttl.ms ?? 0)));
  }
}

/** The keys an edit touches. */
function keysOf(edit: KvEdit): string[] {
  const keys = [text(edit.key)];
  if (edit.op === 'rename' || edit.op === 'copy') keys.push(text(edit.to));
  return keys;
}

/** Checks (as shown) and commands of one edit, like the backend's planner. */
function planOf(edit: KvEdit): { checks: string[]; commands: string[] } {
  const k = text(edit.key);
  switch (edit.op) {
    case 'stringSet':
      return edit.original === null
        ? { checks: [cmd('TYPE', k)], commands: [cmd('SET', k, text(edit.value))] }
        : {
            checks: [cmd('TYPE', k), cmd('GET', k)],
            commands: [cmd('SET', k, text(edit.value), 'KEEPTTL')],
          };
    case 'hashSet':
      return {
        checks: [cmd('TYPE', k), cmd('HGET', k, text(edit.field))],
        commands: [cmd('HSET', k, text(edit.field), text(edit.value))],
      };
    case 'hashDelete':
      return {
        checks: [cmd('TYPE', k), cmd('HGET', k, text(edit.field))],
        commands: [cmd('HDEL', k, text(edit.field))],
      };
    case 'hashRename':
      return {
        checks: [cmd('TYPE', k), cmd('HGET', k, text(edit.field)), cmd('HGET', k, text(edit.to))],
        commands: [
          cmd('HSET', k, text(edit.to), text(edit.value)),
          cmd('HDEL', k, text(edit.field)),
        ],
      };
    case 'listSet':
      return {
        checks: [cmd('TYPE', k), cmd('LINDEX', k, String(edit.index))],
        commands: [cmd('LSET', k, String(edit.index), text(edit.value))],
      };
    case 'listRemove':
      return {
        checks: [
          cmd('TYPE', k),
          cmd('LINDEX', k, String(edit.index)),
          cmd('LPOS', k, 'yadbe:removed:…'),
        ],
        commands: [
          cmd('LSET', k, String(edit.index), 'yadbe:removed:…'),
          cmd('LREM', k, '0', 'yadbe:removed:…'),
        ],
      };
    case 'listPush':
      return {
        checks: [cmd('TYPE', k)],
        commands: [cmd(edit.head ? 'LPUSH' : 'RPUSH', k, ...edit.values.map(text))],
      };
    case 'listPop':
      return {
        checks: [cmd('TYPE', k), cmd('LRANGE', k, '…')],
        commands: [cmd(edit.head ? 'LPOP' : 'RPOP', k, String(edit.values.length))],
      };
    case 'setAdd':
    case 'setRemove':
      return {
        checks: [cmd('TYPE', k), cmd('SISMEMBER', k, text(edit.member))],
        commands: [cmd(edit.op === 'setAdd' ? 'SADD' : 'SREM', k, text(edit.member))],
      };
    case 'zsetSet':
      return {
        checks: [cmd('TYPE', k), cmd('ZSCORE', k, text(edit.member))],
        commands: [cmd('ZADD', k, edit.score, text(edit.member))],
      };
    case 'zsetRemove':
      return {
        checks: [cmd('TYPE', k), cmd('ZSCORE', k, text(edit.member))],
        commands: [cmd('ZREM', k, text(edit.member))],
      };
    case 'streamAdd':
      return {
        checks: [cmd('TYPE', k)],
        commands: [
          cmd('XADD', k, '*', ...edit.fields.flatMap((f) => [text(f.field), text(f.value)])),
        ],
      };
    case 'streamDelete':
      return {
        checks: [cmd('TYPE', k), cmd('XRANGE', k, edit.id, edit.id)],
        commands: [cmd('XDEL', k, edit.id)],
      };
    case 'jsonSet':
      return {
        checks: [
          cmd('TYPE', k),
          ...(edit.original === null ? [] : [cmd('JSON.GET', k, edit.path)]),
        ],
        commands: [cmd('JSON.SET', k, edit.path, edit.value)],
      };
    case 'expire':
      return { checks: [cmd('PEXPIRETIME', k)], commands: [ttlCommand(k, edit.ttl)] };
    case 'rename':
      return {
        checks: [cmd('EXISTS', k), ...(edit.overwrite ? [] : [cmd('EXISTS', text(edit.to))])],
        commands: [cmd('RENAME', k, text(edit.to))],
      };
    case 'copy':
      return {
        checks: [cmd('EXISTS', k), cmd('EXISTS', text(edit.to))],
        commands: [cmd('COPY', k, text(edit.to))],
      };
    case 'create': {
      const v = edit.value;
      const create = (() => {
        switch (v.type) {
          case 'string':
            return cmd('SET', k, text(v.value));
          case 'hash':
            return cmd('HSET', k, ...v.fields.flatMap((f) => [text(f.field), text(f.value)]));
          case 'list':
            return cmd('RPUSH', k, ...v.values.map(text));
          case 'set':
            return cmd('SADD', k, ...v.members.map(text));
          case 'zset':
            return cmd('ZADD', k, ...v.members.flatMap((m) => [m.score, text(m.member)]));
          case 'stream':
            return cmd('XADD', k, '*', ...v.fields.flatMap((f) => [text(f.field), text(f.value)]));
          case 'json':
            return cmd('JSON.SET', k, '$', v.value);
        }
      })();
      return {
        checks: [cmd('TYPE', k)],
        commands:
          edit.ttlMs === null
            ? [create]
            : [create, cmd('PEXPIRE', k, String(Math.round(edit.ttlMs)))],
      };
    }
    case 'delete':
      return {
        checks: edit.guard === null ? [] : [cmd('DUMP', k)],
        commands: [cmd('UNLINK', k)],
      };
    case 'restore':
      return {
        checks: [edit.replace === null ? cmd('EXISTS', k) : cmd('DUMP', k)],
        commands: [
          `${cmd('RESTORE', k, String(edit.snapshot.expireAt ?? 0))} <DUMP payload, ${String(
            edit.snapshot.dump.length,
          )} bytes>${edit.replace === null ? '' : ' REPLACE'}${edit.snapshot.expireAt === null ? '' : ' ABSTTL'}`,
        ],
      };
  }
}

function previewLines(set: KvChangeSet): KvPreviewLine[] {
  const keys = [...new Set(set.edits.flatMap(keysOf))];
  const lines: KvPreviewLine[] = [{ text: cmd('WATCH', ...keys), role: 'control' }];
  const plans = set.edits.map(planOf);
  const seen = new Set<string>();
  for (const plan of plans) {
    for (const check of plan.checks) {
      if (seen.has(check)) continue;
      seen.add(check);
      lines.push({ text: check, role: 'check' });
    }
  }
  lines.push({ text: 'MULTI', role: 'control' });
  for (const plan of plans) for (const c of plan.commands) lines.push({ text: c, role: 'command' });
  lines.push({ text: 'EXEC', role: 'control' });
  return lines;
}

/** A score typed as text (`1.5`, `inf`, `-inf`). */
function scoreOf(score: string): number {
  const lower = score.trim().toLowerCase();
  if (lower === 'inf' || lower === '+inf') return Infinity;
  if (lower === '-inf') return -Infinity;
  return Number(lower);
}

function typeName(key: MockKvKey | null): string {
  return key ? key.value.type : 'none';
}

/** The steps of a simple JSONPath (`$.a.b`, `$.a[0]`). */
function pathParts(path: string): string[] {
  return (path.slice(1).match(/[^.[\]]+/g) ?? []).filter((p) => p !== '');
}

/** The parsed value at a simple JSONPath (`$`, `$.a.b`, `$.a[0]`), `undefined` when absent. */
function jsonAt(doc: unknown, path: string): unknown {
  if (path === '$') return doc;
  const parts = pathParts(path);
  let at: unknown = doc;
  for (const part of parts) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

function setJsonAt(doc: unknown, path: string, value: unknown): unknown {
  if (path === '$') return value;
  const parts = pathParts(path);
  const last = parts.pop();
  const parent = parts.length === 0 ? doc : jsonAt(doc, `$.${parts.join('.')}`);
  if (last !== undefined && parent !== null && typeof parent === 'object') {
    (parent as Record<string, unknown>)[last] = value;
  }
  return doc;
}

interface Verdict {
  kind: KvConflictKind;
  expected: string | null;
  current: string | null;
  actualType?: string;
  rebasable?: boolean;
}

/** Whether an edit can apply on what the mock holds now; `null` when it can. */
function check(edit: KvEdit, key: MockKvKey | null, target: MockKvKey | null): Verdict | null {
  const value: MockKvValue | null = key?.value ?? null;
  const want = (type: string, orNone: boolean): Verdict | null => {
    const actual = typeName(key);
    if (actual === type || (orNone && actual === 'none')) return null;
    if (actual === 'none') return { kind: 'missing', expected: type, current: null };
    return { kind: 'typeChanged', expected: type, current: null, actualType: actual };
  };
  const compare = (expected: string | null, current: string | null): Verdict | null => {
    if (expected === current) return null;
    if (current === null) return { kind: 'missing', expected, current };
    if (expected === null) return { kind: 'exists', expected, current, rebasable: true };
    return { kind: 'changed', expected, current, rebasable: true };
  };
  switch (edit.op) {
    case 'stringSet':
      if (edit.original === null)
        return key ? { kind: 'exists', expected: null, current: null } : null;
      return (
        want('string', false) ??
        compare(text(edit.original), value?.type === 'string' ? value.value : null)
      );
    case 'hashSet':
    case 'hashDelete':
    case 'hashRename': {
      const typed = want('hash', edit.op === 'hashSet' && edit.original === null);
      if (typed) return typed;
      const fields = value?.type === 'hash' ? value.value : [];
      const field = (name: string) => fields.find(([f]) => f === name)?.[1] ?? null;
      if (edit.op === 'hashSet')
        return compare(
          edit.original === null ? null : text(edit.original),
          field(text(edit.field)),
        );
      if (edit.op === 'hashDelete') return compare(text(edit.original), field(text(edit.field)));
      const moved = compare(text(edit.value), field(text(edit.field)));
      if (moved) return moved;
      return field(text(edit.to)) === null
        ? null
        : { kind: 'exists', expected: null, current: field(text(edit.to)) };
    }
    case 'listSet':
    case 'listRemove': {
      const typed = want('list', false);
      if (typed) return typed;
      const items = value?.type === 'list' ? value.value : [];
      return compare(text(edit.original), items[edit.index] ?? null);
    }
    case 'listPush':
      return want('list', true);
    case 'listPop': {
      const typed = want('list', false);
      if (typed) return typed;
      const items = value?.type === 'list' ? value.value : [];
      const n = edit.values.length;
      const part = edit.head ? items.slice(0, n) : items.slice(-n);
      return part.join('\u0000') === edit.values.map(text).join('\u0000')
        ? null
        : { kind: 'changed', expected: null, current: null };
    }
    case 'setAdd':
    case 'setRemove': {
      const typed = want('set', edit.op === 'setAdd');
      if (typed) return typed;
      const has = value?.type === 'set' && value.value.includes(text(edit.member));
      if (edit.op === 'setAdd')
        return has ? { kind: 'exists', expected: null, current: text(edit.member) } : null;
      return has ? null : { kind: 'missing', expected: text(edit.member), current: null };
    }
    case 'zsetSet':
    case 'zsetRemove': {
      const typed = want('zset', edit.op === 'zsetSet' && edit.original === null);
      if (typed) return typed;
      const score =
        value?.type === 'zset'
          ? (value.value.find(([m]) => m === text(edit.member))?.[1] ?? null)
          : null;
      const expected = edit.original === null ? null : scoreOf(edit.original);
      if (expected === score) return null;
      return compare(
        expected === null ? null : String(expected),
        score === null ? null : String(score),
      );
    }
    case 'streamAdd':
      return want('stream', true);
    case 'streamDelete': {
      const typed = want('stream', false);
      if (typed) return typed;
      const found = value?.type === 'stream' && value.value.some((e) => e.id === edit.id);
      return found ? null : { kind: 'missing', expected: edit.id, current: null };
    }
    case 'jsonSet': {
      if (edit.original === null)
        return key ? { kind: 'exists', expected: null, current: null } : null;
      const typed = want('ReJSON-RL', false);
      if (typed) return typed;
      const doc: unknown = value?.type === 'ReJSON-RL' ? JSON.parse(value.value) : null;
      const at = jsonAt(doc, edit.path);
      const current = at === undefined ? null : JSON.stringify(at);
      return compare(JSON.stringify(JSON.parse(edit.original)), current);
    }
    case 'expire': {
      if (!key) return { kind: 'missing', expected: null, current: null };
      const current = key.ttlMs === null ? null : MOCK_EPOCH_MS + key.ttlMs;
      if (current === edit.original) return null;
      return {
        kind: 'changed',
        expected: edit.original === null ? null : String(edit.original),
        current: current === null ? null : String(current),
        rebasable: true,
      };
    }
    case 'rename':
    case 'copy':
      if (!key) return { kind: 'missing', expected: null, current: null };
      if (target && !(edit.op === 'rename' && edit.overwrite))
        return { kind: 'exists', expected: null, current: null };
      return null;
    case 'create':
      return key ? { kind: 'exists', expected: null, current: null } : null;
    case 'delete': {
      if (edit.guard === null) return null;
      const guard = fromSnapshot(edit.guard);
      if (!key) return { kind: 'missing', expected: null, current: null };
      return sameKey(key, guard) ? null : { kind: 'changed', expected: null, current: null };
    }
    case 'restore': {
      if (edit.replace === null)
        return key ? { kind: 'exists', expected: null, current: null } : null;
      if (!key) return { kind: 'missing', expected: null, current: null };
      return sameKey(key, fromSnapshot(edit.replace))
        ? null
        : { kind: 'changed', expected: null, current: null };
    }
  }
}

function emptyValue(type: MockKvValue['type']): MockKvValue {
  switch (type) {
    case 'hash':
      return { type: 'hash', value: [] };
    case 'list':
      return { type: 'list', value: [] };
    case 'set':
      return { type: 'set', value: [] };
    case 'zset':
      return { type: 'zset', value: [] };
    case 'stream':
      return { type: 'stream', value: [] };
    default:
      return { type: 'string', value: '' };
  }
}

/** Gives every edit its effect on the mock keyspace (checked before). */
function applyEdit(
  store: MockKvStore,
  connectionId: string,
  db: number,
  edit: KvEdit,
  streamIds: { next: number },
): void {
  const name = text(edit.key);
  const ensure = (type: MockKvValue['type']): MockKvKey => {
    const found = store.get(connectionId, db, name);
    if (found) return found;
    const created: MockKvKey = {
      name,
      binary: edit.key.base64 !== null,
      value: emptyValue(type),
      ttlMs: null,
    };
    store.put(connectionId, db, created);
    return created;
  };
  const dropIfEmpty = (key: MockKvKey) => {
    if (Array.isArray(key.value.value) && key.value.value.length === 0)
      store.remove(connectionId, db, name);
  };
  switch (edit.op) {
    case 'stringSet': {
      const key = ensure('string');
      key.value = { type: 'string', value: text(edit.value) };
      return;
    }
    case 'hashSet':
    case 'hashDelete':
    case 'hashRename': {
      const key = ensure('hash');
      if (key.value.type !== 'hash') return;
      const fields = key.value.value;
      const set = (field: string, value: string) => {
        const at = fields.findIndex(([f]) => f === field);
        if (at >= 0) fields[at] = [field, value];
        else fields.push([field, value]);
      };
      const remove = (field: string) => {
        const at = fields.findIndex(([f]) => f === field);
        if (at >= 0) fields.splice(at, 1);
      };
      if (edit.op === 'hashSet') set(text(edit.field), text(edit.value));
      else if (edit.op === 'hashDelete') remove(text(edit.field));
      else {
        set(text(edit.to), text(edit.value));
        remove(text(edit.field));
      }
      dropIfEmpty(key);
      return;
    }
    case 'listSet':
    case 'listRemove':
    case 'listPush':
    case 'listPop': {
      const key = ensure('list');
      if (key.value.type !== 'list') return;
      const items = key.value.value;
      if (edit.op === 'listSet') items[edit.index] = text(edit.value);
      else if (edit.op === 'listRemove') items[edit.index] = '\u0000removed';
      else if (edit.op === 'listPush') {
        for (const v of edit.values) {
          if (edit.head) items.unshift(text(v));
          else items.push(text(v));
        }
      } else if (edit.head) items.splice(0, edit.values.length);
      else items.splice(items.length - edit.values.length);
      key.value.value = items.filter((v) => v !== '\u0000removed');
      dropIfEmpty(key);
      return;
    }
    case 'setAdd':
    case 'setRemove': {
      const key = ensure('set');
      if (key.value.type !== 'set') return;
      const member = text(edit.member);
      key.value.value =
        edit.op === 'setAdd'
          ? [...key.value.value, member]
          : key.value.value.filter((m) => m !== member);
      dropIfEmpty(key);
      return;
    }
    case 'zsetSet':
    case 'zsetRemove': {
      const key = ensure('zset');
      if (key.value.type !== 'zset') return;
      const member = text(edit.member);
      const rest = key.value.value.filter(([m]) => m !== member);
      key.value.value =
        edit.op === 'zsetSet'
          ? [...rest, [member, scoreOf(edit.score)] as [string, number]].sort((a, b) => a[1] - b[1])
          : rest;
      dropIfEmpty(key);
      return;
    }
    case 'streamAdd': {
      const key = ensure('stream');
      if (key.value.type !== 'stream') return;
      key.value.value.push({
        id: `${String(MOCK_EPOCH_MS + streamIds.next++)}-0`,
        fields: edit.fields.map((f) => [text(f.field), text(f.value)]),
      });
      return;
    }
    case 'streamDelete': {
      const key = ensure('stream');
      if (key.value.type !== 'stream') return;
      key.value.value = key.value.value.filter((e) => e.id !== edit.id);
      return;
    }
    case 'jsonSet': {
      const key = ensure('string');
      const doc: unknown = key.value.type === 'ReJSON-RL' ? JSON.parse(key.value.value) : null;
      const next = setJsonAt(doc, edit.path, JSON.parse(edit.value));
      key.value = { type: 'ReJSON-RL', value: JSON.stringify(next) };
      return;
    }
    case 'expire': {
      const key = store.get(connectionId, db, name);
      if (!key) return;
      key.ttlMs =
        edit.ttl.kind === 'persist'
          ? null
          : edit.ttl.kind === 'in'
            ? (edit.ttl.ms ?? 0)
            : Math.max(0, (edit.ttl.ms ?? 0) - MOCK_EPOCH_MS);
      return;
    }
    case 'rename':
    case 'copy': {
      const key = store.get(connectionId, db, name);
      if (!key) return;
      const to = text(edit.to);
      store.put(connectionId, db, {
        ...structuredClone(key),
        name: to,
        binary: edit.to.base64 !== null,
      });
      if (edit.op === 'rename') store.remove(connectionId, db, name);
      return;
    }
    case 'create': {
      const v = edit.value;
      const value: MockKvValue = (() => {
        switch (v.type) {
          case 'string':
            return { type: 'string', value: text(v.value) };
          case 'hash':
            return { type: 'hash', value: v.fields.map((f) => [text(f.field), text(f.value)]) };
          case 'list':
            return { type: 'list', value: v.values.map(text) };
          case 'set':
            return { type: 'set', value: v.members.map(text) };
          case 'zset':
            return {
              type: 'zset',
              value: v.members.map((m): [string, number] => [text(m.member), scoreOf(m.score)]),
            };
          case 'stream':
            return {
              type: 'stream',
              value: [
                {
                  id: `${String(MOCK_EPOCH_MS + streamIds.next++)}-0`,
                  fields: v.fields.map((f) => [text(f.field), text(f.value)]),
                },
              ],
            };
          case 'json':
            return { type: 'ReJSON-RL', value: v.value };
        }
      })();
      store.put(connectionId, db, {
        name,
        binary: edit.key.base64 !== null,
        value,
        ttlMs: edit.ttlMs,
      });
      return;
    }
    case 'delete':
      store.remove(connectionId, db, name);
      return;
    case 'restore': {
      const restored = fromSnapshot(edit.snapshot);
      if (restored) store.put(connectionId, db, restored);
      return;
    }
  }
}

function dangersOf(store: MockKvStore, connectionId: string, set: KvChangeSet): KvEditDanger[] {
  const dangers: KvEditDanger[] = [];
  const deletes = set.edits.filter((e) => e.op === 'delete' && e.guard === null);
  if (deletes.length >= MANY_KEYS) {
    const exist = deletes.filter((e) => store.get(connectionId, set.database, text(e.key))).length;
    dangers.push({
      kind: { kind: 'deleteKeys', count: deletes.length },
      effect: {
        en: `Deletes ${String(deletes.length)} keys; ${String(exist)} of them exist now. The journal keeps them (up to 16 MB in all) so that they can be restored.`,
        fr: `Supprime ${String(deletes.length)} clés ; ${String(exist)} d'entre elles existent actuellement. Le journal les conserve (jusqu'à 16 Mo en tout) pour pouvoir les restaurer.`,
      },
    });
  }
  const expires = set.edits.filter((e) => e.op === 'expire');
  if (expires.length >= MANY_KEYS) {
    dangers.push({
      kind: { kind: 'expireMany', count: expires.length },
      effect: {
        en: `Changes the time to live of ${String(expires.length)} keys.`,
        fr: `Modifie la durée de vie de ${String(expires.length)} clés.`,
      },
    });
  }
  for (const edit of set.edits) {
    if (edit.op !== 'rename' || !edit.overwrite) continue;
    const target = store.get(connectionId, set.database, text(edit.to));
    dangers.push({
      kind: { kind: 'overwrite', key: edit.key, to: edit.to },
      effect: target
        ? {
            en: `Replaces the key "${edit.to.text}" (a ${target.value.type}) with "${edit.key.text}": its value is lost unless the change is reverted.`,
            fr: `Remplace la clé « ${edit.to.text} » (de type ${target.value.type}) par « ${edit.key.text} » : sa valeur est perdue sauf annulation de la modification.`,
          }
        : {
            en: `Renames "${edit.key.text}" to "${edit.to.text}", which does not exist now.`,
            fr: `Renomme « ${edit.key.text} » en « ${edit.to.text} », qui n'existe pas actuellement.`,
          },
    });
  }
  return dangers;
}

function counts(set: KvChangeSet): { updated: number; inserted: number; deleted: number } {
  let updated = 0;
  let inserted = 0;
  let deleted = 0;
  for (const edit of set.edits) {
    switch (edit.op) {
      case 'hashDelete':
      case 'listRemove':
      case 'setRemove':
      case 'zsetRemove':
      case 'streamDelete':
      case 'delete':
        deleted++;
        break;
      case 'listPop':
        deleted += edit.values.length;
        break;
      case 'listPush':
        inserted += edit.values.length;
        break;
      case 'setAdd':
      case 'streamAdd':
      case 'copy':
      case 'create':
        inserted++;
        break;
      case 'stringSet':
      case 'hashSet':
      case 'zsetSet':
      case 'jsonSet':
        if (edit.original === null) inserted++;
        else updated++;
        break;
      case 'restore':
        if (edit.replace === null) inserted++;
        else updated++;
        break;
      default:
        updated++;
    }
  }
  return { updated, inserted, deleted };
}

function target(set: KvChangeSet): { kind: JournalTargetKind; name: string } {
  const keys = [
    ...new Set(
      set.edits.flatMap((e) => [
        e.key.text,
        ...(e.op === 'rename' || e.op === 'copy' ? [e.to.text] : []),
      ]),
    ),
  ];
  if (keys.length === 1) return { kind: 'key', name: keys[0] ?? '' };
  const shown = keys.slice(0, 5);
  if (keys.length > 5) shown.push(`… (${String(keys.length)} keys)`);
  return { kind: 'keys', name: shown.join(', ') };
}

export function createMockKvEdit(
  store: MockKvStore,
  deps: {
    journal: MockJournal;
    connectionName(connectionId: string): string;
    engine(connectionId: string): Engine;
  },
) {
  let staleDone = false;
  const streamIds = { next: 1 };

  function apply(
    connectionId: string,
    set: KvChangeSet,
    confirmed: boolean,
    reverts: number | null,
  ): KvApplyOutcome | YadbeError {
    const session = store.session(connectionId);
    if (!session) return mockErrors.notConnected();
    if (session.readOnly) return readOnlyRefusal();
    if (set.edits.length === 0)
      return mockErrors.invalidArgument('There is nothing to apply.', "Il n'y a rien à appliquer.");
    const db = set.database;
    const dangers = dangersOf(store, connectionId, set);
    if (dangers.length > 0 && !confirmed) return { status: 'needsConfirmation', dangers };
    // Someone else changes this key just before the first apply that touches it.
    if (!staleDone && set.edits.some((e) => text(e.key) === MOCK_STALE_KEY)) {
      staleDone = true;
      const stale = store.get(connectionId, db, MOCK_STALE_KEY);
      if (stale?.value.type === 'hash') {
        stale.value.value = stale.value.value.map(([f, v]) =>
          f === 'plan' ? [f, 'enterprise'] : [f, v],
        );
      }
    }
    const conflicts: KvConflict[] = [];
    set.edits.forEach((edit, index) => {
      const key = store.get(connectionId, db, text(edit.key));
      const to =
        edit.op === 'rename' || edit.op === 'copy'
          ? store.get(connectionId, db, text(edit.to))
          : null;
      const verdict = check(edit, key, to);
      if (verdict) {
        conflicts.push({
          edit: index,
          key: edit.key,
          kind: verdict.kind,
          expected: verdict.expected,
          current: verdict.current === null ? null : { text: verdict.current, base64: null },
          actualType: verdict.actualType ?? null,
          rebasable: verdict.rebasable ?? false,
        });
      }
    });
    const lines = previewLines(set);
    if (conflicts.length > 0) {
      store.log(
        connectionId,
        lines
          .filter((l) => l.role !== 'command')
          .slice(0, -2)
          .map((l) => l.text)
          .concat('UNWATCH')
          .join('\n'),
      );
      return { status: 'conflicted', conflicts };
    }
    const touched = [...new Set(set.edits.flatMap(keysOf))];
    const before = new Map(
      touched.map((name) => [name, structuredClone(store.get(connectionId, db, name))]),
    );
    for (const edit of set.edits) applyEdit(store, connectionId, db, edit, streamIds);
    store.log(connectionId, lines.map((l) => l.text).join('\n'));
    const after = new Map(touched.map((name) => [name, store.get(connectionId, db, name)]));
    const added = touched.filter((n) => !before.get(n) && after.get(n));
    const removed = touched.filter((n) => before.get(n) && !after.get(n));
    store.moved(connectionId, db, added, removed);
    // The mock reverts every key from a snapshot of it.
    const inverse: KvEdit[] = [];
    for (const name of [...touched].reverse()) {
      const was = before.get(name) ?? null;
      const now = after.get(name) ?? null;
      const key = set.edits
        .flatMap((e) => (e.op === 'rename' || e.op === 'copy' ? [e.key, e.to] : [e.key]))
        .find((k) => text(k) === name) ?? { text: name, base64: null };
      if (was)
        inverse.push({
          op: 'restore',
          key,
          snapshot: snapshotOf(was),
          replace: now ? snapshotOf(now) : null,
        });
      else if (now) inverse.push({ op: 'delete', key, guard: snapshotOf(now) });
    }
    const kvInverse: KvChangeSet | null =
      inverse.length > 0 ? { database: db, edits: inverse } : null;
    const statements: JournalStatement[] = set.edits
      .flatMap((e) => planOf(e).commands)
      .map((sql) => ({ sql, rowsAffected: 1 }));
    const { kind, name } = target(set);
    const id = deps.journal.record({
      connectionId,
      connectionName: deps.connectionName(connectionId),
      engine: deps.engine(connectionId),
      table: { database: String(db), schema: null, name },
      durationMs: 1.2,
      counts: counts(set),
      statements,
      inverse: null,
      inverseStatements: kvInverse ? kvInverse.edits.flatMap((e) => planOf(e).commands) : [],
      blocker: kvInverse ? null : { kind: 'notPlannable' },
      reverts,
      targetKind: kind,
      kvInverse,
    });
    const bytes = (n: string): KvBytes =>
      touched.includes(n)
        ? (set.edits
            .flatMap((e) => (e.op === 'rename' || e.op === 'copy' ? [e.key, e.to] : [e.key]))
            .find((k) => text(k) === n) ?? { text: n, base64: null })
        : { text: n, base64: null };
    return {
      status: 'applied',
      database: db,
      journalId: id,
      revertible: kvInverse !== null,
      added: added.map(bytes),
      removed: removed.map(bytes),
    };
  }

  function preview(connectionId: string, set: KvChangeSet): KvPreview | YadbeError {
    if (!store.session(connectionId)) return mockErrors.notConnected();
    const lines = previewLines(set);
    return {
      lines,
      commands: lines.filter((l) => l.role === 'command').length,
      batches: 1,
      dangers: dangersOf(store, connectionId, set),
    };
  }

  function outcome<T>(value: T | YadbeError): Result<T> {
    return typeof value === 'object' && value !== null && 'code' in value && 'message' in value
      ? fail(value)
      : ok(value);
  }

  const commands: KeyValueEditCommands = {
    kvPreviewChanges: (connectionId, changes) => outcome(preview(connectionId, changes)),
    kvApplyChanges: (connectionId, changes, confirmed) =>
      outcome(apply(connectionId, changes, confirmed, null)),
    kvPreviewRevert: (connectionId, entryId) => {
      const inverse = deps.journal.kvInverseFor(entryId, connectionId);
      if ('code' in inverse) return fail(inverse);
      const result = preview(connectionId, inverse);
      if ('code' in result) return fail(result);
      return ok({ ...result, dangers: [] });
    },
    kvApplyRevert: (connectionId, entryId) => {
      const inverse = deps.journal.kvInverseFor(entryId, connectionId);
      if ('code' in inverse) return fail(inverse);
      return outcome(apply(connectionId, inverse, true, entryId));
    },
    kvNamespaceCount: (connectionId, database, prefix) => {
      if (!store.session(connectionId)) return fail(mockErrors.notConnected());
      const found = store.names(connectionId, database).filter((n) => n.startsWith(text(prefix)));
      store.log(
        connectionId,
        `SCAN 0 MATCH ${quote(`${text(prefix)}*`)} COUNT 1000  -- full scan, ${String(found.length)} keys`,
      );
      const result: KvNamespaceCount = {
        pattern: quote(`${text(prefix)}*`),
        keys: found.length,
        sample: [...found]
          .sort()
          .slice(0, 20)
          .map((n) => ({ text: n, base64: null })),
        snapshotBound: SNAPSHOT_BOUND,
      };
      return ok(result);
    },
    kvDeleteNamespace: (connectionId, database, prefix) => {
      const session = store.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      if (session.readOnly) return fail(readOnlyRefusal());
      const found = store.names(connectionId, database).filter((n) => n.startsWith(text(prefix)));
      const restores: KvEdit[] = [];
      for (const name of found) {
        const key = store.get(connectionId, database, name);
        if (key)
          restores.push({
            op: 'restore',
            key: { text: name, base64: null },
            snapshot: snapshotOf(key),
            replace: null,
          });
        store.remove(connectionId, database, name);
      }
      const batches: string[] = [];
      for (let i = 0; i < found.length; i += 500) {
        batches.push(cmd('UNLINK', ...found.slice(i, i + 500)));
      }
      for (const line of batches) store.log(connectionId, `MULTI\n${line}\nEXEC`);
      store.moved(connectionId, database, [], found);
      const id =
        found.length === 0
          ? null
          : deps.journal.record({
              connectionId,
              connectionName: deps.connectionName(connectionId),
              engine: deps.engine(connectionId),
              table: { database: String(database), schema: null, name: `${text(prefix)}*` },
              durationMs: 3.4,
              counts: { updated: 0, inserted: 0, deleted: found.length },
              statements: batches.map((sql, i) => ({
                sql,
                rowsAffected: Math.min(500, found.length - i * 500),
              })),
              inverse: null,
              inverseStatements: restores.slice(0, 200).flatMap((e) => planOf(e).commands),
              blocker: null,
              reverts: null,
              targetKind: 'namespace',
              kvInverse: { database, edits: restores },
            });
      const result: KvNamespaceDeleted = {
        deleted: found.length,
        batches: batches.length,
        journalId: id,
        revertible: id !== null,
      };
      return ok(result);
    },
  };

  return {
    commands,
    reset(): void {
      staleDone = false;
      streamIds.next = 1;
    },
  };
}
