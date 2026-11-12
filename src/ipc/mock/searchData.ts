import type {
  IndexHealth,
  SearchAlias,
  SearchDataStream,
  SearchField,
  SearchSetting,
  SearchTemplate,
} from '../bindings';

/**
 * The mock Elasticsearch cluster: a few indices whose documents are computed from their number
 * (so 25 000 log lines cost nothing), a data stream, an alias and index templates.
 */

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface MockIndex {
  name: string;
  health: IndexHealth;
  open: boolean;
  system: boolean;
  count: number;
  fields: SearchField[];
  settings: SearchSetting[];
  /** Document `i` (0-based) and its `_id`. */
  doc(i: number): { id: string; source: JsonObject };
}

const SORTABLE = new Set([
  'keyword',
  'long',
  'integer',
  'double',
  'scaled_float',
  'date',
  'boolean',
  'ip',
]);

function fields(spec: [string, string][], multi: string[] = []): SearchField[] {
  return spec
    .map(([path, typeName]) => ({
      path,
      typeName,
      sortable: SORTABLE.has(typeName),
      multiField: multi.includes(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function settings(shards: number, replicas: number, uuid: string): SearchSetting[] {
  return [
    { key: 'index.number_of_shards', value: String(shards) },
    { key: 'index.number_of_replicas', value: String(replicas) },
    { key: 'index.creation_date', value: '1762000000000' },
    { key: 'index.uuid', value: uuid },
    { key: 'index.version.created', value: '9009000' },
  ];
}

const NAMES = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Edsger Dijkstra', 'Barbara Liskov'];
const STATUSES = ['paid', 'pending', 'shipped', 'refunded'];
const LEVELS = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'];
const SERVICES = ['checkout', 'search', 'auth', 'catalog'];
const BASE_MS = Date.UTC(2025, 10, 1, 8, 0, 0);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function orders(): MockIndex {
  return {
    name: 'orders',
    health: 'green',
    open: true,
    system: false,
    count: 1240,
    fields: fields(
      [
        ['order_id', 'keyword'],
        ['status', 'keyword'],
        ['total', 'scaled_float'],
        ['currency', 'keyword'],
        ['created_at', 'date'],
        ['customer', 'object'],
        ['customer.name', 'keyword'],
        ['customer.email', 'keyword'],
        ['customer.vip', 'boolean'],
        ['lines', 'nested'],
        ['lines.sku', 'keyword'],
        ['lines.qty', 'integer'],
        ['notes', 'text'],
        ['notes.keyword', 'keyword'],
      ],
      ['notes.keyword'],
    ),
    settings: settings(1, 1, 'q9Xh1sZ2Rk6m0eA4bL3VtQ'),
    doc(i) {
      const name = NAMES[i % NAMES.length] ?? 'Ada Lovelace';
      return {
        id: `o-${String(10_000 + i)}`,
        source: {
          order_id: `ORD-${String(10_000 + i)}`,
          status: STATUSES[i % STATUSES.length] ?? 'paid',
          total: Math.round(((i * 37) % 500) * 100 + 99) / 100,
          currency: 'EUR',
          created_at: iso(BASE_MS + i * 3_600_000),
          customer: {
            name,
            email: `${name.split(' ')[0]?.toLowerCase() ?? 'x'}@example.com`,
            vip: i % 5 === 0,
          },
          lines: [
            { sku: `SKU-${String(i % 40).padStart(3, '0')}`, qty: 1 + (i % 3) },
            ...(i % 4 === 0 ? [{ sku: 'SKU-900', qty: 1 }] : []),
          ],
          notes: i % 9 === 0 ? 'gift wrap, leave at the door' : null,
        },
      };
    },
  };
}

function products(): MockIndex {
  return {
    name: 'products',
    health: 'green',
    open: true,
    system: false,
    count: 86,
    fields: fields([
      ['sku', 'keyword'],
      ['name', 'text'],
      ['price', 'double'],
      ['stock', 'integer'],
      ['tags', 'keyword'],
    ]),
    settings: settings(1, 1, 'Pm2cW8xYQ4uJr1n7sT0bAg'),
    doc(i) {
      return {
        id: `SKU-${String(i).padStart(3, '0')}`,
        source: {
          sku: `SKU-${String(i).padStart(3, '0')}`,
          name: `Product ${String(i)}`,
          price: Math.round((5 + ((i * 13) % 200)) * 100) / 100,
          stock: (i * 7) % 120,
          tags: i % 2 === 0 ? ['new', 'eu'] : ['eu'],
        },
      };
    },
  };
}

function logs(name: string, count: number, system: boolean, health: IndexHealth): MockIndex {
  return {
    name,
    health,
    open: true,
    system,
    count,
    fields: fields([
      ['@timestamp', 'date'],
      ['level', 'keyword'],
      ['service', 'keyword'],
      ['message', 'text'],
      ['latency_ms', 'long'],
      ['host.ip', 'ip'],
      ['host', 'object'],
    ]),
    settings: settings(2, 1, `${name.slice(0, 8)}Lg7d2ZQ`),
    doc(i) {
      const level = LEVELS[i % LEVELS.length] ?? 'INFO';
      const service = SERVICES[i % SERVICES.length] ?? 'auth';
      return {
        id: `${name.slice(0, 3)}-${String(i)}`,
        source: {
          '@timestamp': iso(BASE_MS + i * 7_000),
          level,
          service,
          message: `${service}: request ${String(i)} handled`,
          latency_ms: (i * 31) % 900,
          host: { ip: `10.0.${String(i % 4)}.${String(10 + (i % 50))}` },
        },
      };
    },
  };
}

export function mockSearchIndices(): Map<string, MockIndex> {
  const list = [
    orders(),
    products(),
    logs('logs-app-2025.11', 25_000, false, 'yellow'),
    logs('.ds-logs-web-2025.11.12-000001', 3400, true, 'green'),
    { ...products(), name: '.kibana_1', count: 12, system: true },
  ];
  return new Map(list.map((index) => [index.name, index]));
}

export const MOCK_DATA_STREAMS: SearchDataStream[] = [
  {
    name: 'logs-web',
    health: 'green',
    indices: ['.ds-logs-web-2025.11.12-000001'],
    template: 'logs-web',
    timestampField: '@timestamp',
    system: false,
  },
];

export const MOCK_ALIASES: SearchAlias[] = [
  {
    name: 'orders-current',
    indices: ['orders'],
    writeIndex: 'orders',
    filtered: false,
    system: false,
  },
  {
    name: '.kibana',
    indices: ['.kibana_1'],
    writeIndex: '.kibana_1',
    filtered: false,
    system: true,
  },
];

export const MOCK_TEMPLATES: SearchTemplate[] = [
  { name: 'logs-web', patterns: ['logs-web*'], priority: 200, dataStream: true, system: false },
  { name: 'orders', patterns: ['orders*'], priority: 100, dataStream: false, system: false },
  { name: '.kibana', patterns: ['.kibana*'], priority: 0, dataStream: false, system: true },
];

/** The index a target names: an index, an alias or a data stream. */
export function resolveTarget(
  indices: ReadonlyMap<string, MockIndex>,
  target: string,
): MockIndex | null {
  const direct = indices.get(target);
  if (direct) return direct;
  const alias = MOCK_ALIASES.find((a) => a.name === target);
  const stream = MOCK_DATA_STREAMS.find((s) => s.name === target);
  const backing = alias?.indices[0] ?? stream?.indices[0];
  return backing === undefined ? null : (indices.get(backing) ?? null);
}

/** The value at a dotted path of a source. */
export function valueAt(source: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}
