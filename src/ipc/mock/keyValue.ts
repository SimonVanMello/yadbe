import type {
  ColumnMeta,
  KvBytes,
  KvCollection,
  KvConsoleEntry,
  KvDanger,
  KvDangerKind,
  KvDatabase,
  KvKeyInfo,
  KvKeyKind,
  KvKeySummary,
  KvLevel,
  KvLevelEntry,
  KvReplyView,
  KvScanStatus,
  ValueKind,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import type { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';
import type { Cell } from '../mockQuery';
import {
  SYNTHETIC_DB,
  SYNTHETIC_KEYS,
  seedKeyspace,
  syntheticKey,
  type MockKvKey,
} from './keyValueData';
import {
  UnbalancedQuotes,
  commandLines,
  displayCommand,
  globToRegExp,
  splitArgs,
} from './redisCli';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The key-value commands the mock implements (mirror of `commands/keyvalue.rs`). */
export type KeyValueCommands = Pick<
  Commands,
  | 'kvListDatabases'
  | 'kvScanKeys'
  | 'kvScanMore'
  | 'kvScanStop'
  | 'kvScanRestart'
  | 'kvScanLevel'
  | 'kvKeySummaries'
  | 'kvKeyInfo'
  | 'kvReadString'
  | 'kvReadJson'
  | 'kvOpenCollection'
  | 'kvCollectionMore'
  | 'kvCloseCollection'
  | 'kvConsoleRun'
  | 'kvConsoleStop'
  | 'kvConsoleClose'
>;

export interface KeyValueDeps {
  events: EventEmitter;
  /** The open session of a key-value connection, `null` when it is not connected. */
  session(connectionId: string): { database: number; readOnly: boolean } | null;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  recordHistory(entry: {
    tabId: string;
    connectionId: string;
    database: string;
    sql: string;
    error: YadbeError | null;
    rows: number | null;
  }): void;
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
  latency(): number;
}

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

const SCAN_BATCH = 1_000;
const SCAN_TARGET = 10_000;
const STRING_CHUNK_MAX = 1024 * 1024;
const COLLECTION_PAGE = 500;

// --- Bytes ----------------------------------------------------------------------------------

/** A key name or value: code points 0–255 when `binary`, else text (UTF-8 on the wire). */
function bytesOf(text: string, binary: boolean): Uint8Array {
  if (!binary) return new TextEncoder().encode(text);
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
}

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

function escapeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x22) out += '\\"';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function kvBytes(name: string, binary: boolean): KvBytes {
  if (!binary) return { text: name, base64: null };
  const bytes = bytesOf(name, true);
  return { text: escapeBytes(bytes), base64: base64(bytes) };
}

/** The mock's name of a key the frontend sends back. */
function nameOf(bytes: KvBytes): string {
  return bytes.base64 === null ? bytes.text : atob(bytes.base64);
}

function kindOf(type: string): KvKeyKind {
  switch (type) {
    case 'string':
    case 'hash':
    case 'list':
    case 'set':
    case 'zset':
    case 'stream':
      return type;
    case 'ReJSON-RL':
      return 'json';
    case 'none':
      return 'missing';
    default:
      return 'unknown';
  }
}

// --- Replies --------------------------------------------------------------------------------

type Reply =
  | null
  | { int: number }
  | { status: string }
  | { bulk: string }
  | { double: number }
  | { error: string }
  | { map: [Reply, Reply][] }
  | Reply[];

function isError(reply: Reply | YadbeError): reply is YadbeError {
  return reply !== null && !Array.isArray(reply) && 'code' in reply;
}

const isScalar = (reply: Reply) => reply === null || (!Array.isArray(reply) && !('map' in reply));

function scalarCell(reply: Reply): Cell {
  if (reply === null) return null;
  if (Array.isArray(reply) || 'map' in reply) return ['json', JSON.stringify(replyJson(reply))];
  if ('int' in reply) return ['int', String(reply.int)];
  if ('double' in reply) return ['float', String(reply.double)];
  if ('error' in reply) return ['other', `(error) ${reply.error}`];
  return ['text', 'status' in reply ? reply.status : reply.bulk];
}

function replyJson(reply: Reply): unknown {
  if (reply === null) return null;
  if (Array.isArray(reply)) return reply.map(replyJson);
  if ('map' in reply)
    return Object.fromEntries(reply.map.map(([k, v]) => [String(replyJson(k)), replyJson(v)]));
  if ('int' in reply) return reply.int;
  if ('double' in reply) return reply.double;
  if ('error' in reply) return { error: reply.error };
  return 'status' in reply ? reply.status : reply.bulk;
}

function kindOfCells(cells: readonly Cell[]): ValueKind {
  const kinds = new Set(cells.flatMap((c) => (c === null ? [] : [c[0]])));
  if (kinds.size !== 1) return 'text';
  const [only] = kinds;
  return only === 'int' || only === 'float' ? only : 'text';
}

// --- Commands -------------------------------------------------------------------------------

const WRITE = new Set([
  'set',
  'setex',
  'psetex',
  'setnx',
  'mset',
  'append',
  'del',
  'unlink',
  'expire',
  'pexpire',
  'persist',
  'incr',
  'incrby',
  'decr',
  'hset',
  'hdel',
  'lpush',
  'rpush',
  'lpop',
  'rpop',
  'sadd',
  'srem',
  'zadd',
  'zrem',
  'xadd',
  'flushdb',
  'flushall',
  'rename',
  'swapdb',
  'json.set',
]);
const SCRIPTS = new Set([
  'eval',
  'evalsha',
  'eval_ro',
  'evalsha_ro',
  'fcall',
  'fcall_ro',
  'script',
  'function',
]);
const ADMIN = new Set([
  'shutdown',
  'debug',
  'config',
  'client',
  'save',
  'bgsave',
  'replicaof',
  'slaveof',
]);
const ADMIN_READS = new Set(['config|get', 'client|list', 'client|info']);
const STREAMING = new Set([
  'monitor',
  'subscribe',
  'psubscribe',
  'ssubscribe',
  'unsubscribe',
  'sync',
]);
const BLOCKING = new Set(['blpop', 'brpop', 'blmove', 'bzpopmin', 'bzpopmax', 'wait']);
const KNOWN = new Set([
  ...WRITE,
  ...SCRIPTS,
  ...ADMIN,
  ...STREAMING,
  ...BLOCKING,
  'ping',
  'echo',
  'get',
  'exists',
  'type',
  'ttl',
  'pttl',
  'hget',
  'hgetall',
  'hlen',
  'hkeys',
  'lrange',
  'llen',
  'smembers',
  'scard',
  'zrange',
  'zcard',
  'xrange',
  'xlen',
  'dbsize',
  'info',
  'select',
  'scan',
  'keys',
  'json.get',
  'publish',
  'xread',
  'auth',
  'hello',
]);

function readOnlyRefusal(name: string, why: [string, string]): YadbeError {
  const upper = name.toUpperCase();
  return {
    code: 'readOnlyViolation',
    message: {
      en: `This connection is read-only: ${upper} ${why[0]}. Nothing was run.`,
      fr: `Cette connexion est en lecture seule : ${upper} ${why[1]}. Rien n'a été exécuté.`,
    },
    action: 'editConnection',
    detail: null,
  };
}

function notSupportedYet(name: string): YadbeError {
  const upper = name.toUpperCase();
  return {
    code: 'notSupported',
    message: {
      en: `${upper} is not supported yet: it streams or waits for data, which the console cannot show. Nothing was run.`,
      fr: `${upper} n'est pas encore pris en charge : la commande diffuse ou attend des données, ce que la console ne sait pas encore afficher. Rien n'a été exécuté.`,
    },
    action: null,
    detail: null,
  };
}

function serverError(message: string): YadbeError {
  return {
    code: 'queryFailed',
    message: {
      en: 'The database rejected the statement.',
      fr: "La base de données a refusé l'instruction.",
    },
    action: null,
    detail: message,
  };
}

/** Mirror of the gate's `check_supported` and `check_read_only`. */
function gateRefusal(args: readonly string[], readOnly: boolean): YadbeError | null {
  const name = (args[0] ?? '').toLowerCase();
  const sub = (args[1] ?? '').toLowerCase();
  if (STREAMING.has(name)) return notSupportedYet(name);
  if (BLOCKING.has(name) || (name === 'xread' && args.some((a) => a.toLowerCase() === 'block')))
    return notSupportedYet(name);
  if (!readOnly) return null;
  if (SCRIPTS.has(name))
    return readOnlyRefusal(name, [
      'runs a script whose effects cannot be known before it runs',
      'exécute un script dont les effets ne peuvent être connus avant son exécution',
    ]);
  if (name === 'publish')
    return readOnlyRefusal(name, [
      'sends a message to other clients',
      'envoie un message aux autres clients',
    ]);
  if (!KNOWN.has(name))
    return readOnlyRefusal(name, [
      'is not a command this server knows, so yadbe cannot tell it only reads',
      "n'est pas une commande connue de ce serveur : yadbe ne peut pas garantir qu'elle ne fait que lire",
    ]);
  if (WRITE.has(name)) return readOnlyRefusal(name, ['changes data', 'modifie des données']);
  if (ADMIN.has(name) && !ADMIN_READS.has(`${name}|${sub}`))
    return readOnlyRefusal(name, [
      'is an administration command that may change the server',
      "est une commande d'administration qui peut modifier le serveur",
    ]);
  return null;
}

function dangerOf(args: readonly string[]): KvDangerKind | null {
  const name = (args[0] ?? '').toLowerCase();
  const sub = (args[1] ?? '').toLowerCase();
  if (name === 'flushall') return { kind: 'flushAll' };
  if (name === 'flushdb') return { kind: 'flushDb' };
  if (name === 'keys') return { kind: 'keys' };
  if ((name === 'del' || name === 'unlink') && args.length > 10)
    return { kind: 'deleteMany', keys: args.length - 1 };
  if (name === 'config' && ['set', 'resetstat', 'rewrite'].includes(sub)) return { kind: 'config' };
  if (name === 'shutdown') return { kind: 'shutdown' };
  if (name === 'debug') return { kind: 'debug' };
  if (name === 'swapdb') return { kind: 'swapDb', a: args[1] ?? '', b: args[2] ?? '' };
  return null;
}

interface MockScan {
  status: KvScanStatus;
  order: readonly string[];
  loaded: string[];
  target: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface MockCollection {
  connectionId: string;
  db: number;
  key: string;
  rows: Cell[][];
  columns: ColumnMeta[];
  shown: number;
  resultId: number;
}

/** The mock Redis server behind every key-value connection, and its sessions. */
export function createMockKeyValue(deps: KeyValueDeps) {
  let keyspaces = new Map<string, Map<number, Map<string, MockKvKey>>>();
  const scans = new Map<string, MockScan>();
  const collections = new Map<number, MockCollection>();
  const consoles = new Map<string, { db: number; results: number[]; stop: boolean }>();
  let nextScan = 1;
  let synthetic: string[] | null = null;
  const config = new Map([
    ['maxmemory', '0'],
    ['maxmemory-policy', 'noeviction'],
    ['maxmemory-samples', '5'],
    ['databases', '16'],
  ]);

  const column = (name: string, kind: ValueKind): ColumnMeta => ({ name, typeName: '', kind });

  function keyspace(connectionId: string, db: number): Map<string, MockKvKey> {
    let server = keyspaces.get(connectionId);
    if (!server) {
      server = seedKeyspace();
      keyspaces.set(connectionId, server);
    }
    if (db === SYNTHETIC_DB && !server.has(db)) {
      server.set(db, new Map());
    }
    let found = server.get(db);
    if (!found) {
      found = new Map();
      server.set(db, found);
    }
    return found;
  }

  function syntheticNames(): string[] {
    synthetic ??= Array.from({ length: SYNTHETIC_KEYS }, (_, i) => syntheticKey(i).name);
    return synthetic;
  }

  function lookup(connectionId: string, db: number, name: string): MockKvKey | null {
    const found = keyspace(connectionId, db).get(name);
    if (found) return found;
    if (db === SYNTHETIC_DB) {
      const match = /^metrics:host-\d\d:(\d+)$/.exec(name);
      const index = match ? Number(match[1]) : -1;
      if (index >= 0 && index < SYNTHETIC_KEYS) return syntheticKey(index);
    }
    return null;
  }

  function names(connectionId: string, db: number): string[] {
    const own = [...keyspace(connectionId, db).keys()];
    return db === SYNTHETIC_DB ? [...syntheticNames(), ...own] : own;
  }

  function isBinary(connectionId: string, db: number, name: string): boolean {
    return lookup(connectionId, db, name)?.binary ?? false;
  }

  function sessionOf(connectionId: string) {
    return deps.session(connectionId);
  }

  function log(connectionId: string, sql: string, error: YadbeError | null = null) {
    deps.logStatement(connectionId, sql, error);
  }

  // --- Scans --------------------------------------------------------------------------------

  const scanKey = (connectionId: string, db: number) => `${connectionId}\u001f${String(db)}`;

  function emit(connectionId: string, scan: MockScan) {
    deps.events.emit('kvScanProgress', { connectionId, status: { ...scan.status } });
  }

  function step(connectionId: string, scan: MockScan) {
    scan.timer = null;
    const { status } = scan;
    if (status.state !== 'running') return;
    const next = scan.order.slice(scan.loaded.length, scan.loaded.length + SCAN_BATCH);
    scan.loaded.push(...next);
    status.loaded = scan.loaded.length;
    if (next.length > 0) status.version += 1;
    if (scan.loaded.length >= scan.order.length) status.state = 'done';
    else if (scan.loaded.length >= scan.target) status.state = 'paused';
    emit(connectionId, scan);
    if (status.state === 'running') {
      scan.timer = setTimeout(
        () => {
          step(connectionId, scan);
        },
        Math.max(5, deps.latency() / 4),
      );
    } else {
      const pattern = status.pattern === null ? '' : ` MATCH ${status.pattern}`;
      log(
        connectionId,
        `SCAN 0${pattern} COUNT 1000  -- ${String(Math.ceil(scan.loaded.length / SCAN_BATCH))} batches, ${String(scan.loaded.length)} keys`,
      );
    }
  }

  function startScan(connectionId: string, db: number, pattern: string | null): MockScan {
    const previous = scans.get(scanKey(connectionId, db));
    if (previous?.timer) clearTimeout(previous.timer);
    const all = names(connectionId, db);
    const regex = pattern === null ? null : globToRegExp(pattern);
    const order = regex ? all.filter((name) => regex.test(name)) : all;
    log(connectionId, 'DBSIZE');
    const scan: MockScan = {
      status: {
        scanId: nextScan++,
        database: db,
        pattern,
        loaded: 0,
        estimate: all.length,
        state: 'running',
        error: null,
        version: 0,
      },
      order,
      loaded: [],
      target: SCAN_TARGET,
      timer: null,
    };
    scans.set(scanKey(connectionId, db), scan);
    // The first batch arrives with the status: the tree has keys at once.
    step(connectionId, scan);
    return scan;
  }

  function currentScan(connectionId: string, db: number): MockScan | YadbeError {
    return (
      scans.get(scanKey(connectionId, db)) ??
      mockErrors.invalidArgument(
        'No key scan runs on this database: open it in the explorer.',
        "Aucun parcours de clés n'est en cours sur cette base : ouvrez-la dans l'explorateur.",
      )
    );
  }

  function level(
    connectionId: string,
    db: number,
    scan: MockScan,
    prefix: string,
    delimiter: string,
    offset: number,
    limit: number,
  ): KvLevel {
    const namespaces = new Map<string, number>();
    const leaves: string[] = [];
    for (const name of scan.loaded) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const at = delimiter === '' ? -1 : rest.indexOf(delimiter);
      if (at >= 0) {
        const segment = rest.slice(0, at);
        namespaces.set(segment, (namespaces.get(segment) ?? 0) + 1);
      } else leaves.push(name);
    }
    const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const entries: KvLevelEntry[] = [
      ...[...namespaces.entries()]
        .sort(([a], [b]) => byBytes(a, b))
        .map(([segment, keys]): KvLevelEntry => ({
          type: 'namespace',
          name: { text: segment, base64: null },
          prefix: { text: `${prefix}${segment}${delimiter}`, base64: null },
          keys,
        })),
      ...leaves.sort(byBytes).map((name): KvLevelEntry => {
        const binary = isBinary(connectionId, db, name);
        return {
          type: 'key',
          name: kvBytes(name.slice(prefix.length), binary),
          key: kvBytes(name, binary),
        };
      }),
    ];
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      version: scan.status.version,
    };
  }

  // --- Keys ---------------------------------------------------------------------------------

  function ttlOf(key: MockKvKey | null): number | null {
    return key?.ttlMs ?? null;
  }

  function memoryOf(key: MockKvKey): number {
    const value = key.value;
    const size = (() => {
      switch (value.type) {
        case 'string':
        case 'ReJSON-RL':
        case 'MBbloom--':
          return value.value.length + 16;
        case 'hash':
          return value.value.reduce((n, [f, v]) => n + f.length + v.length + 24, 64);
        case 'list':
        case 'set':
          return value.value.reduce((n, v) => n + v.length + 16, 64);
        case 'zset':
          return value.value.reduce((n, [m]) => n + m.length + 32, 128);
        case 'stream':
          return value.value.length * 96 + 256;
      }
    })();
    return Math.ceil(size / 8) * 8 + key.name.length;
  }

  function encodingOf(key: MockKvKey): string {
    const value = key.value;
    switch (value.type) {
      case 'string':
        return /^-?\d+$/.test(value.value) ? 'int' : value.value.length <= 44 ? 'embstr' : 'raw';
      case 'hash':
        return value.value.length <= 128 ? 'listpack' : 'hashtable';
      case 'list':
        return value.value.length <= 128 ? 'listpack' : 'quicklist';
      case 'set':
        return value.value.length <= 128 ? 'listpack' : 'hashtable';
      case 'zset':
        return value.value.length <= 128 ? 'listpack' : 'skiplist';
      case 'stream':
        return 'stream';
      default:
        return 'raw';
    }
  }

  function lengthOf(key: MockKvKey): number | null {
    const value = key.value;
    switch (value.type) {
      case 'string':
        return bytesOf(value.value, key.binary).length;
      case 'hash':
      case 'list':
      case 'set':
      case 'zset':
      case 'stream':
        return value.value.length;
      default:
        return null;
    }
  }

  function textCell(text: string, binary = false): Cell {
    if (!binary) return ['text', text];
    return ['bytes', [...bytesOf(text, true)].map((b) => b.toString(16).padStart(2, '0')).join('')];
  }

  function collectionRows(key: MockKvKey): { columns: ColumnMeta[]; rows: Cell[][] } | null {
    const value = key.value;
    switch (value.type) {
      case 'hash':
        return {
          columns: [column('field', 'text'), column('value', 'text')],
          rows: value.value.map(([f, v]) => [textCell(f), textCell(v)]),
        };
      case 'set':
        return { columns: [column('member', 'text')], rows: value.value.map((m) => [textCell(m)]) };
      case 'zset':
        return {
          columns: [column('rank', 'int'), column('member', 'text'), column('score', 'float')],
          rows: [...value.value]
            .sort((a, b) => a[1] - b[1])
            .map(([member, score], rank) => [
              ['int', String(rank)],
              textCell(member),
              ['float', String(score)],
            ]),
        };
      case 'list':
        return {
          columns: [column('index', 'int'), column('value', 'text')],
          rows: value.value.map((item, index) => [['int', String(index)], textCell(item)]),
        };
      case 'stream':
        return {
          columns: [column('id', 'text'), column('fields', 'json')],
          rows: value.value.map((entry) => [
            textCell(entry.id),
            ['json', JSON.stringify(Object.fromEntries(entry.fields))],
          ]),
        };
      default:
        return null;
    }
  }

  // --- Console ------------------------------------------------------------------------------

  function viewOf(reply: Reply, results: number[]): KvReplyView {
    if (reply === null) return { kind: 'nil' };
    const scalar = (
      text: string,
      kind: 'status' | 'bulk' | 'int' | 'double' | 'error',
    ): KvReplyView => ({
      kind: 'scalar',
      value: { text, base64: null },
      scalar: kind,
    });
    const grid = (names: string[], rows: Cell[][]): KvReplyView => {
      const columns = names.map((name, i) =>
        column(name, kindOfCells(rows.map((r) => r[i] ?? null))),
      );
      const resultId = deps.storeRows(columns, rows);
      results.push(resultId);
      return { kind: 'grid', resultId, columns, rowCount: rows.length };
    };
    if (Array.isArray(reply)) {
      if (reply.length === 0) return { kind: 'empty' };
      if (reply.every(isScalar))
        return grid(
          ['#', 'value'],
          reply.map((item, i) => [['int', String(i + 1)], scalarCell(item)]),
        );
      const width = Array.isArray(reply[0]) ? reply[0].length : 0;
      if (
        width >= 2 &&
        reply.every((item) => Array.isArray(item) && item.length === width && item.every(isScalar))
      ) {
        return grid(
          Array.from({ length: width }, (_, i) => String(i + 1)),
          reply.map((item) => (Array.isArray(item) ? item.map(scalarCell) : [])),
        );
      }
      return { kind: 'tree', json: JSON.stringify(replyJson(reply)), truncated: false };
    }
    if ('map' in reply) {
      if (reply.map.length === 0) return { kind: 'empty' };
      if (reply.map.every(([k, v]) => isScalar(k) && isScalar(v)))
        return grid(
          ['field', 'value'],
          reply.map.map(([k, v]) => [scalarCell(k), scalarCell(v)]),
        );
      return { kind: 'tree', json: JSON.stringify(replyJson(reply)), truncated: false };
    }
    if ('int' in reply) return scalar(String(reply.int), 'int');
    if ('double' in reply) return scalar(String(reply.double), 'double');
    if ('error' in reply) return scalar(reply.error, 'error');
    if ('status' in reply) return scalar(reply.status, 'status');
    return scalar(reply.bulk, 'bulk');
  }

  /** A few commands of a real server, enough to make the console believable. */
  function execute(connectionId: string, db: number, args: string[]): Reply | YadbeError {
    const space = keyspace(connectionId, db);
    const name = (args[0] ?? '').toLowerCase();
    const k = args[1] ?? '';
    const found = lookup(connectionId, db, k);
    const wrongType = serverError(
      'WRONGTYPE Operation against a key holding the wrong kind of value',
    );
    const typed = <T extends MockKvKey['value']['type']>(type: T) => {
      if (!found) return null;
      return found.value.type === type
        ? (found.value as Extract<MockKvKey['value'], { type: T }>)
        : wrongType;
    };
    switch (name) {
      case 'ping':
        return { status: args[1] ?? 'PONG' };
      case 'echo':
        return { bulk: k };
      case 'auth':
      case 'hello':
        return { status: 'OK' };
      case 'select': {
        const index = Number(k);
        return Number.isInteger(index) && index >= 0 && index < 16
          ? { status: 'OK' }
          : serverError('ERR DB index is out of range');
      }
      case 'dbsize':
        return { int: names(connectionId, db).length };
      case 'info':
        return {
          bulk: `# Keyspace\r\n${[0, 1, SYNTHETIC_DB]
            .map(
              (i) =>
                `db${String(i)}:keys=${String(names(connectionId, i).length)},expires=0,avg_ttl=0`,
            )
            .join('\r\n')}\r\n`,
        };
      case 'get': {
        const value = typed('string');
        if (value === null) return null;
        return 'code' in value ? value : { bulk: value.value };
      }
      case 'set':
        space.set(k, {
          name: k,
          binary: false,
          value: { type: 'string', value: args[2] ?? '' },
          ttlMs: null,
        });
        return { status: 'OK' };
      case 'del':
      case 'unlink': {
        let removed = 0;
        for (const key of args.slice(1)) if (space.delete(key)) removed++;
        return { int: removed };
      }
      case 'exists':
        return {
          int: args.slice(1).filter((key) => lookup(connectionId, db, key) !== null).length,
        };
      case 'type':
        return { status: found ? found.value.type : 'none' };
      case 'ttl':
      case 'pttl': {
        if (!found) return { int: -2 };
        if (found.ttlMs === null) return { int: -1 };
        return { int: name === 'ttl' ? Math.ceil(found.ttlMs / 1000) : found.ttlMs };
      }
      case 'incr': {
        const current = Number(
          typed('string') && found?.value.type === 'string' ? found.value.value : 0,
        );
        const next = current + 1;
        space.set(k, {
          name: k,
          binary: false,
          value: { type: 'string', value: String(next) },
          ttlMs: null,
        });
        return { int: next };
      }
      case 'hgetall': {
        const value = typed('hash');
        if (value === null) return { map: [] };
        return 'code' in value
          ? value
          : { map: value.value.map(([f, v]) => [{ bulk: f }, { bulk: v }]) };
      }
      case 'hget': {
        const value = typed('hash');
        if (value === null) return null;
        if ('code' in value) return value;
        const hit = value.value.find(([f]) => f === args[2]);
        return hit ? { bulk: hit[1] } : null;
      }
      case 'hlen': {
        const value = typed('hash');
        return value === null ? { int: 0 } : 'code' in value ? value : { int: value.value.length };
      }
      case 'lrange': {
        const value = typed('list');
        if (value === null) return [];
        if ('code' in value) return value;
        const start = Number(args[2] ?? 0);
        const stop = Number(args[3] ?? -1);
        const end = stop < 0 ? value.value.length + stop + 1 : stop + 1;
        return value.value.slice(start, end).map((item) => ({ bulk: item }));
      }
      case 'smembers': {
        const value = typed('set');
        if (value === null) return [];
        return 'code' in value ? value : value.value.map((m) => ({ bulk: m }));
      }
      case 'zrange': {
        const value = typed('zset');
        if (value === null) return [];
        if ('code' in value) return value;
        const start = Number(args[2] ?? 0);
        const stop = Number(args[3] ?? -1);
        const sorted = [...value.value].sort((a, b) => a[1] - b[1]);
        const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
        const slice = sorted.slice(start, end);
        return args.some((a) => a.toLowerCase() === 'withscores')
          ? slice.map(([m, s]): Reply => [{ bulk: m }, { double: s }])
          : slice.map(([m]) => ({ bulk: m }));
      }
      case 'xrange': {
        const value = typed('stream');
        if (value === null) return [];
        if ('code' in value) return value;
        return value.value
          .slice(0, 10)
          .map((entry): Reply => [
            { bulk: entry.id },
            entry.fields.flatMap(([f, v]): Reply[] => [{ bulk: f }, { bulk: v }]),
          ]);
      }
      case 'json.get': {
        const value = typed('ReJSON-RL');
        if (value === null) return null;
        return 'code' in value ? value : { bulk: value.value };
      }
      case 'scan': {
        const all = names(connectionId, db);
        const cursor = Number(k) || 0;
        const next = cursor + 10 >= all.length ? 0 : cursor + 10;
        return [{ bulk: String(next) }, all.slice(cursor, cursor + 10).map((n) => ({ bulk: n }))];
      }
      case 'keys': {
        const regex = globToRegExp(k || '*');
        return names(connectionId, db)
          .filter((n) => regex.test(n))
          .slice(0, 5_000)
          .map((n) => ({ bulk: n }));
      }
      case 'flushdb':
        space.clear();
        return { status: 'OK' };
      case 'flushall':
        keyspaces.delete(connectionId);
        return { status: 'OK' };
      case 'config': {
        const sub = k.toLowerCase();
        if (sub === 'get') {
          const regex = globToRegExp(args[2] ?? '*');
          return {
            map: [...config.entries()]
              .filter(([n]) => regex.test(n))
              .map(([n, v]) => [{ bulk: n }, { bulk: v }]),
          };
        }
        if (sub === 'set') {
          for (let i = 2; i + 1 < args.length; i += 2) config.set(args[i] ?? '', args[i + 1] ?? '');
          return { status: 'OK' };
        }
        return serverError(`ERR unknown subcommand '${k}'`);
      }
      default:
        return serverError(
          `ERR unknown command '${args[0] ?? ''}', with args beginning with: ${args
            .slice(1, 3)
            .map((a) => `'${a}'`)
            .join(' ')}`,
        );
    }
  }

  function effectOf(
    connectionId: string,
    db: number,
    args: string[],
    kind: KvDangerKind,
  ): KvDanger['effect'] {
    switch (kind.kind) {
      case 'flushAll': {
        const total = [0, 1, SYNTHETIC_DB].reduce((n, i) => n + names(connectionId, i).length, 0);
        return {
          en: `Deletes every key of every database on this server: ${String(total)} keys.`,
          fr: `Supprime toutes les clés de toutes les bases de ce serveur : ${String(total)} clés.`,
        };
      }
      case 'flushDb': {
        const count = String(names(connectionId, db).length);
        return {
          en: `Deletes every key of database ${String(db)}: ${count} keys.`,
          fr: `Supprime toutes les clés de la base ${String(db)} : ${count} clés.`,
        };
      }
      case 'keys': {
        const count = String(names(connectionId, db).length);
        return {
          en: `Walks all ${count} keys of database ${String(db)} in one go and blocks the server meanwhile. The explorer lists keys with SCAN instead.`,
          fr: `Parcourt d'un coup les ${count} clés de la base ${String(db)} et bloque le serveur pendant ce temps. L'explorateur liste les clés avec SCAN à la place.`,
        };
      }
      case 'deleteMany': {
        const existing = String(
          args.slice(1).filter((k) => lookup(connectionId, db, k) !== null).length,
        );
        return {
          en: `Deletes ${String(kind.keys)} keys; ${existing} of them exist now.`,
          fr: `Supprime ${String(kind.keys)} clés ; ${existing} d'entre elles existent actuellement.`,
        };
      }
      case 'config': {
        const pairs: string[] = [];
        for (let i = 2; i + 1 < args.length; i += 2)
          pairs.push(
            `${args[i] ?? ''}: ${config.get(args[i] ?? '') ?? '?'} → ${args[i + 1] ?? ''}`,
          );
        return {
          en: `Changes server settings for every client: ${pairs.join(', ')}.`,
          fr: `Modifie des réglages du serveur pour tous les clients : ${pairs.join(', ')}.`,
        };
      }
      case 'shutdown':
        return {
          en: 'Stops the server: every client is disconnected.',
          fr: 'Arrête le serveur : tous les clients sont déconnectés.',
        };
      default:
        return {
          en: 'A command that can harm the server or its data.',
          fr: 'Une commande qui peut nuire au serveur ou à ses données.',
        };
    }
  }

  /** Read anew each time: a stop arrives while a run awaits. */
  function stopped(tabId: string): boolean {
    return consoles.get(tabId)?.stop ?? false;
  }

  const commands: KeyValueCommands = {
    kvListDatabases: (connectionId) => {
      const session = sessionOf(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      log(connectionId, 'INFO keyspace');
      const databases: KvDatabase[] = [0, 1, SYNTHETIC_DB]
        .map((index) => ({
          index,
          keys: names(connectionId, index).length,
          expires: [...keyspace(connectionId, index).values()].filter((k) => k.ttlMs !== null)
            .length,
          current: index === session.database,
        }))
        .filter((db) => db.keys > 0 || db.current);
      if (!databases.some((db) => db.current))
        databases.push({ index: session.database, keys: 0, expires: 0, current: true });
      return ok(databases.sort((a, b) => a.index - b.index));
    },

    kvScanKeys: (connectionId, database, pattern) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      const clean =
        pattern === null || pattern.trim() === '' || pattern.trim() === '*' ? null : pattern.trim();
      const current = scans.get(scanKey(connectionId, database));
      const scan =
        current && current.status.pattern === clean
          ? current
          : startScan(connectionId, database, clean);
      return ok({ ...scan.status });
    },

    kvScanMore: (connectionId, database, count) => {
      const scan = currentScan(connectionId, database);
      if ('code' in scan) return fail(scan);
      if (scan.status.state !== 'done') {
        scan.target = count === null ? Infinity : scan.loaded.length + count;
        scan.status.state = 'running';
        scan.status.error = null;
        if (!scan.timer) step(connectionId, scan);
      }
      return ok({ ...scan.status });
    },

    kvScanStop: (connectionId, database) => {
      const scan = currentScan(connectionId, database);
      if ('code' in scan) return fail(scan);
      if (scan.status.state === 'running') {
        if (scan.timer) clearTimeout(scan.timer);
        scan.timer = null;
        scan.status.state = 'stopped';
        emit(connectionId, scan);
      }
      return ok({ ...scan.status });
    },

    kvScanRestart: (connectionId, database) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      const pattern = scans.get(scanKey(connectionId, database))?.status.pattern ?? null;
      return ok({ ...startScan(connectionId, database, pattern).status });
    },

    kvScanLevel: (connectionId, database, prefix, delimiter, offset, limit) => {
      const scan = currentScan(connectionId, database);
      if ('code' in scan) return fail(scan);
      return ok(
        level(
          connectionId,
          database,
          scan,
          nameOf(prefix),
          delimiter,
          offset,
          Math.min(limit, 5_000),
        ),
      );
    },

    kvKeySummaries: (connectionId, database, keys) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      log(
        connectionId,
        keys.map((k) => `TYPE ${k.text}\nPTTL ${k.text}\nMEMORY USAGE ${k.text}`).join('\n'),
      );
      const summaries: KvKeySummary[] = keys.map((bytes) => {
        const key = lookup(connectionId, database, nameOf(bytes));
        const typeName = key ? key.value.type : 'none';
        return {
          key: bytes,
          kind: kindOf(typeName),
          typeName,
          ttlMs: ttlOf(key),
          memory: key ? memoryOf(key) : null,
        };
      });
      return ok(summaries);
    },

    kvKeyInfo: (connectionId, database, bytes) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      const key = lookup(connectionId, database, nameOf(bytes));
      log(
        connectionId,
        `TYPE ${bytes.text}\nPTTL ${bytes.text}\nOBJECT ENCODING ${bytes.text}\nMEMORY USAGE ${bytes.text}`,
      );
      const typeName = key ? key.value.type : 'none';
      const info: KvKeyInfo = {
        key: bytes,
        database,
        kind: kindOf(typeName),
        typeName,
        ttlMs: ttlOf(key),
        encoding: key ? encodingOf(key) : null,
        memory: key ? memoryOf(key) : null,
        length: key ? lengthOf(key) : null,
        jsonModule: true,
      };
      return ok(info);
    },

    kvReadString: (connectionId, database, bytes, offset, length) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      const key = lookup(connectionId, database, nameOf(bytes));
      if (key && key.value.type !== 'string')
        return fail(
          serverError('WRONGTYPE Operation against a key holding the wrong kind of value'),
        );
      const all =
        key?.value.type === 'string' ? bytesOf(key.value.value, key.binary) : new Uint8Array();
      const from = offset;
      const size = Math.min(Math.max(1, length), STRING_CHUNK_MAX);
      log(
        connectionId,
        `STRLEN ${bytes.text}\nGETRANGE ${bytes.text} ${String(from)} ${String(from + size - 1)}`,
      );
      return ok({
        total: all.length,
        offset: from,
        base64: base64(all.subarray(from, from + size)),
      });
    },

    kvReadJson: (connectionId, database, bytes) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      const key = lookup(connectionId, database, nameOf(bytes));
      log(connectionId, `JSON.GET ${bytes.text}`);
      if (key?.value.type !== 'ReJSON-RL')
        return fail(
          serverError('WRONGTYPE Operation against a key holding the wrong kind of value'),
        );
      return ok(key.value.value);
    },

    kvOpenCollection: (connectionId, database, bytes, rows) => {
      if (!sessionOf(connectionId)) return fail(mockErrors.notConnected());
      const name = nameOf(bytes);
      const key = lookup(connectionId, database, name);
      const data = key ? collectionRows(key) : null;
      if (!key || !data)
        return fail(
          mockErrors.invalidArgument(
            `The key is a ${key?.value.type ?? 'none'}, not a collection.`,
            `La clé est de type ${key?.value.type ?? 'none'}, pas une collection.`,
          ),
        );
      const shown = Math.min(
        data.rows.length,
        Math.max(COLLECTION_PAGE, Math.ceil(rows / COLLECTION_PAGE) * COLLECTION_PAGE),
      );
      // Every row is stored at once; the grid sees `rowCount` of them, as if read so far.
      const resultId = deps.storeRows(data.columns, data.rows);
      log(
        connectionId,
        `${key.value.type === 'hash' ? 'HSCAN' : key.value.type === 'set' ? 'SSCAN' : key.value.type === 'zset' ? 'ZRANGE' : key.value.type === 'list' ? 'LRANGE' : 'XRANGE'} ${bytes.text} …`,
      );
      collections.set(resultId, {
        connectionId,
        db: database,
        key: name,
        rows: data.rows,
        columns: data.columns,
        shown,
        resultId,
      });
      const result: KvCollection = {
        resultId,
        columns: data.columns,
        rowCount: shown,
        done: shown >= data.rows.length,
        total: data.rows.length,
      };
      return ok(result);
    },

    kvCollectionMore: (resultId, rows) => {
      const collection = collections.get(resultId);
      if (!collection) return fail(mockErrors.resultNotFound(resultId));
      const shown =
        rows === null
          ? collection.rows.length
          : Math.min(collection.rows.length, collection.shown + Math.max(COLLECTION_PAGE, rows));
      collection.shown = shown;
      return ok({
        resultId,
        columns: collection.columns,
        rowCount: shown,
        done: shown >= collection.rows.length,
        total: collection.rows.length,
      });
    },

    kvCloseCollection: (resultId) => {
      collections.delete(resultId);
      deps.freeResults([resultId]);
      return ok(null);
    },

    kvConsoleRun: async (tabId, connectionId, text, confirmed) => {
      const session = sessionOf(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      let console = consoles.get(tabId);
      if (!console) {
        console = { db: session.database, results: [], stop: false };
        consoles.set(tabId, console);
      }
      console.stop = false;
      const lines = commandLines(text);
      const parsed: { line: number; args: string[] }[] = [];
      for (const entry of lines) {
        try {
          parsed.push({ line: entry.line, args: splitArgs(entry.text) });
        } catch (error) {
          if (!(error instanceof UnbalancedQuotes)) throw error;
          return ok({
            kind: 'ran',
            entries: [
              {
                line: entry.line,
                command: entry.text,
                database: console.db,
                durationMs: 0,
                reply: null,
                error: mockErrors.invalidArgument(
                  'Unbalanced quotes in the command line.',
                  'Guillemets non équilibrés dans la ligne de commande.',
                ),
              },
            ],
            database: console.db,
            skipped: lines.length - 1,
          });
        }
      }
      if (!confirmed) {
        const dangers: KvDanger[] = parsed.flatMap(({ line, args }) => {
          const kind = dangerOf(args);
          return kind
            ? [
                {
                  line,
                  command: displayCommand(args),
                  kind,
                  effect: effectOf(connectionId, console.db, args, kind),
                },
              ]
            : [];
        });
        if (dangers.length > 0) return ok({ kind: 'needsConfirmation', dangers });
      }
      deps.freeResults(console.results);
      console.results = [];
      await new Promise((resolve) => setTimeout(resolve, Math.min(deps.latency(), 150)));
      const entries: KvConsoleEntry[] = [];
      let skipped = 0;
      for (const [index, { line, args }] of parsed.entries()) {
        if (stopped(tabId)) {
          skipped = parsed.length - index;
          break;
        }
        const command = displayCommand(args);
        const ranOn = console.db;
        const refusal = gateRefusal(args, session.readOnly);
        const reply = refusal ?? execute(connectionId, console.db, args);
        const error = isError(reply) ? reply : null;
        const failed = error !== null;
        if (!failed && (args[0] ?? '').toLowerCase() === 'select') console.db = Number(args[1]);
        const view = isError(reply) ? null : viewOf(reply, console.results);
        deps.recordHistory({
          tabId,
          connectionId,
          database: String(ranOn),
          sql: command,
          error,
          rows: view?.kind === 'grid' ? view.rowCount : null,
        });
        entries.push({
          line,
          command,
          database: ranOn,
          durationMs: 0.4 + (index % 5) * 0.3,
          reply: view,
          error,
        });
        if (failed) {
          skipped = parsed.length - index - 1;
          break;
        }
      }
      return ok({ kind: 'ran', entries, database: console.db, skipped });
    },

    kvConsoleStop: (tabId) => {
      const console = consoles.get(tabId);
      if (console) console.stop = true;
      return ok(null);
    },

    kvConsoleClose: (tabId) => {
      const console = consoles.get(tabId);
      if (console) deps.freeResults(console.results);
      consoles.delete(tabId);
      return ok(null);
    },
  };

  return {
    commands,
    /** Forgets what a connection's sessions held (disconnect). */
    forgetConnection(connectionId: string): void {
      for (const [id, scan] of scans) {
        if (id.startsWith(`${connectionId}\u001f`)) {
          if (scan.timer) clearTimeout(scan.timer);
          scans.delete(id);
        }
      }
    },
    reset(): void {
      for (const scan of scans.values()) if (scan.timer) clearTimeout(scan.timer);
      scans.clear();
      collections.clear();
      consoles.clear();
      keyspaces = new Map();
    },
  };
}
