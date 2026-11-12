import type { BsonType, ColumnMeta, DocCollection, DocIndex, ValueKind } from '../bindings';
import type { Cell } from '../mockQuery';

/**
 * The mock MongoDB server's data: believable documents in canonical Extended JSON (nested
 * documents, arrays, mixed types, missing fields), and the mirror of what the backend makes of
 * them (`db::document::ejson`, `session::document::results`): BSON types and grid cells.
 */

/** A canonical Extended JSON value, as plain JavaScript (objects keep their key order). */
export type Ejson = null | boolean | number | string | Ejson[] | { [key: string]: Ejson };
export type EjsonDocument = { [key: string]: Ejson };

export interface MockCollection {
  info: DocCollection;
  documents: EjsonDocument[];
  indexes: DocIndex[];
}

export type MockDatabases = Map<string, Map<string, MockCollection>>;

function hash(a: number, b: number): number {
  let h = (a * 2_654_435_761) ^ (b * 40_503);
  h = Math.imul(h ^ (h >>> 15), 2_246_822_507);
  h = Math.imul(h ^ (h >>> 13), 3_266_489_909);
  return (h ^ (h >>> 16)) >>> 0;
}

const oid = (n: number, salt: number): Ejson => ({
  $oid: `65${(0x1f00000 + n).toString(16).padStart(8, '0')}${hash(n, salt).toString(16).padStart(8, '0')}${(n % 4096).toString(16).padStart(6, '0')}`.slice(
    0,
    24,
  ),
});
const int = (n: number): Ejson => ({ $numberInt: String(n) });
const long = (n: number | string): Ejson => ({ $numberLong: String(n) });
const decimal = (text: string): Ejson => ({ $numberDecimal: text });
const double = (n: number): Ejson => ({
  $numberDouble: Number.isInteger(n) ? `${String(n)}.0` : String(n),
});
const date = (ms: number): Ejson => ({ $date: { $numberLong: String(ms) } });

const BASE_MS = Date.UTC(2025, 0, 6, 9, 30);
const NAMES = ['Ana', 'Bruno', 'Chloé', 'Dmitri', 'Eun-ji', 'Farid', 'Grace', 'Hugo', 'Inès'];
const CITIES = [
  ['Lyon', 'FR'],
  ['Porto', 'PT'],
  ['Gent', 'BE'],
  ['Kyoto', 'JP'],
  ['Montréal', 'CA'],
];
const WORDS = ['lamp', 'desk', 'chair', 'shelf', 'mug', 'rug', 'clock', 'vase', 'stool'];
const COLORS = ['oak', 'black', 'white', 'sage', 'terracotta'];
const STATUSES = ['paid', 'open', 'shipped', 'refunded'];

function product(i: number): EjsonDocument {
  const h = hash(i, 7);
  const word = WORDS[h % WORDS.length] ?? 'lamp';
  const doc: EjsonDocument = {
    _id: oid(i, 1),
    sku: `SKU-${String(1000 + i)}`,
    name: `${(COLORS[(h >>> 4) % COLORS.length] ?? 'oak').replace(/^./, (c) => c.toUpperCase())} ${word}`,
    price: decimal(`${String(9 + (h % 190))}.${String(h % 100).padStart(2, '0')}`),
    // A few stocks were written by a script that used 64-bit integers.
    stock: i % 9 === 0 ? long(h % 400) : int(h % 400),
    tags: [word, i % 2 === 0 ? 'bestseller' : 'new'],
    specs: { weight: double(((h % 500) + 50) / 100), color: COLORS[h % COLORS.length] ?? 'oak' },
    createdAt: date(BASE_MS - i * 3_600_000 * 7),
  };
  if (i % 4 === 0) doc.discontinued = i % 8 === 0;
  if (i % 11 === 0) doc.rating = null;
  else if (i % 3 === 0) doc.rating = double(3 + (h % 20) / 10);
  return doc;
}

function order(i: number): EjsonDocument {
  const h = hash(i, 11);
  const [city = 'Lyon', country = 'FR'] = CITIES[h % CITIES.length] ?? [];
  const name = NAMES[h % NAMES.length] ?? 'Ana';
  const count = 1 + (h % 3);
  const items: Ejson[] = [];
  let cents = 0;
  for (let k = 0; k < count; k++) {
    const p = hash(i, 20 + k);
    const qty = 1 + (p % 4);
    const unit = 900 + (p % 9000);
    cents += qty * unit;
    items.push({
      sku: `SKU-${String(1000 + (p % 240))}`,
      qty: int(qty),
      price: decimal(`${String(Math.floor(unit / 100))}.${String(unit % 100).padStart(2, '0')}`),
    });
  }
  const doc: EjsonDocument = {
    _id: oid(i, 2),
    number: long(20_250_000 + i),
    customer: {
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}${String(i % 97)}@example.com`,
      address: { city, country },
    },
    items,
    total: decimal(`${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`),
    status: STATUSES[h % STATUSES.length] ?? 'paid',
    placedAt: date(BASE_MS - i * 2_400_000),
  };
  if (i % 5 === 0) doc.notes = i % 10 === 0 ? 'Leave at the door' : 'Gift wrap';
  return doc;
}

function customer(i: number): EjsonDocument {
  const name = NAMES[i % NAMES.length] ?? 'Ana';
  return {
    _id: int(i + 1),
    name: `${name} ${String.fromCharCode(65 + (i % 26))}.`,
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}${String(i)}@example.com`,
    since: date(BASE_MS - i * 86_400_000 * 9),
    vip: i % 7 === 0,
  };
}

function metric(i: number): EjsonDocument {
  return {
    ts: date(BASE_MS + i * 60_000),
    meta: { host: `web-${String((i % 3) + 1)}` },
    cpu: double(Math.round((20 + (hash(i, 5) % 7000) / 100) * 100) / 100),
    _id: oid(i, 5),
  };
}

const uuidOf = (i: number): Ejson => {
  const bytes = Array.from({ length: 16 }, (_, k) => hash(i, k) & 0xff);
  return { $binary: { base64: btoa(String.fromCharCode(...bytes)), subType: '04' } };
};

function session(i: number): EjsonDocument {
  return {
    _id: uuidOf(i),
    user: int(1 + (i % 80)),
    events: long(hash(i, 3) % 900),
    startedAt: date(BASE_MS + i * 900_000),
  };
}

const ID_INDEX: DocIndex = {
  name: '_id_',
  keys: '{"_id":1}',
  unique: false,
  sparse: false,
  partial: false,
  hidden: false,
  expireAfterSecs: null,
};

function index(name: string, keys: string, extra: Partial<DocIndex> = {}): DocIndex {
  return { ...ID_INDEX, name, keys, ...extra };
}

function collection(
  name: string,
  documents: EjsonDocument[],
  indexes: DocIndex[] = [],
  info: Partial<DocCollection> = {},
): [string, MockCollection] {
  const kind = info.kind ?? 'collection';
  return [
    name,
    {
      info: {
        name,
        kind,
        system: name.startsWith('system.'),
        capped: false,
        viewOn: null,
        ...info,
      },
      documents,
      indexes: kind === 'collection' ? [ID_INDEX, ...indexes] : [],
    },
  ];
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A fresh copy of the mock server's data (writes change it). */
export function mockDatabases(): MockDatabases {
  const products = range(240).map(product);
  return new Map([
    [
      'catalog',
      new Map([
        collection('customers', range(80).map(customer), [
          index('email_1', '{"email":1}', { unique: true }),
        ]),
        collection('metrics', range(120).map(metric), [], { kind: 'timeseries' }),
        collection('orders', range(1300).map(order), [
          index('status_1_placedAt_-1', '{"status":1,"placedAt":-1}'),
          index('customer.email_1', '{"customer.email":1}', { sparse: true }),
        ]),
        collection('products', products, [
          index('sku_1', '{"sku":1}', { unique: true }),
          index('tags_1', '{"tags":1}'),
        ]),
        collection(
          'topRated',
          products.filter((p) => p.rating !== undefined && p.rating !== null),
          [],
          { kind: 'view', viewOn: 'products' },
        ),
      ]),
    ],
    [
      'analytics',
      new Map([
        collection('sessions', range(60).map(session), [
          index('startedAt_1', '{"startedAt":1}', { expireAfterSecs: 2_592_000 }),
        ]),
      ]),
    ],
    [
      'admin',
      new Map([
        collection('system.version', [{ _id: 'featureCompatibilityVersion', version: '7.0' }]),
      ]),
    ],
    ['config', new Map([collection('system.sessions', [])])],
    ['local', new Map([collection('startup_log', [])])],
  ]);
}

// --- What the backend makes of documents ----------------------------------------------------

const WRAPPERS: Record<string, BsonType> = {
  $oid: 'objectId',
  $numberInt: 'int',
  $numberLong: 'long',
  $numberDouble: 'double',
  $numberDecimal: 'decimal',
  $date: 'date',
  $binary: 'binData',
  $uuid: 'binData',
  $regularExpression: 'regex',
  $timestamp: 'timestamp',
  $minKey: 'minKey',
  $maxKey: 'maxKey',
  $symbol: 'symbol',
  $code: 'javascript',
  $undefined: 'undefined',
  $dbPointer: 'dbPointer',
};

function isObject(value: Ejson): value is { [key: string]: Ejson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Mirror of `ejson::type_of`. */
export function bsonTypeOf(value: Ejson): BsonType {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (Array.isArray(value)) return 'array';
  const keys = Object.keys(value);
  if (keys.length === 2 && keys.includes('$code') && keys.includes('$scope')) {
    return 'javascriptWithScope';
  }
  const only = keys.length === 1 ? keys[0] : undefined;
  return (only !== undefined ? WRAPPERS[only] : undefined) ?? 'object';
}

/** Mirror of `ejson::kind_of_type`. */
function kindOf(type: BsonType): ValueKind {
  switch (type) {
    case 'double':
      return 'float';
    case 'string':
      return 'text';
    case 'bool':
      return 'bool';
    case 'int':
    case 'long':
      return 'int';
    case 'decimal':
      return 'decimal';
    case 'date':
      return 'timestampTz';
    case 'objectId':
      return 'objectId';
    case 'binData':
      return 'bytes';
    default:
      return 'json';
  }
}

function formatMillis(ms: number): string {
  const iso = new Date(ms).toISOString();
  const [day = '', time = ''] = iso.split('T');
  const [clock = '', fraction = '000Z'] = time.split('.');
  const millis = fraction.slice(0, 3);
  return `${day} ${clock}${millis === '000' ? '' : `.${millis}`}+00`;
}

function hexOfBase64(base64: string): string {
  return Array.from(atob(base64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/** Mirror of `ejson::to_value`: the grid cell of a value. */
export function cellOf(value: Ejson): Cell {
  if (value === null) return null;
  const type = bsonTypeOf(value);
  if (!isObject(value)) {
    if (typeof value === 'boolean') return ['bool', String(value)];
    if (typeof value === 'string') return ['text', value];
    if (typeof value === 'number')
      return [Number.isInteger(value) ? 'int' : 'float', String(value)];
    return ['json', JSON.stringify(value)];
  }
  const body = Object.values(value)[0];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  switch (type) {
    case 'objectId':
      return ['objectId', text];
    case 'int':
    case 'long':
      return ['int', text];
    case 'decimal':
      return ['decimal', text];
    case 'double':
      return ['float', text.replace(/\.0$/, '')];
    case 'date': {
      const ms = isObject(body ?? null)
        ? Number((body as { $numberLong: string }).$numberLong)
        : NaN;
      return Number.isFinite(ms)
        ? ['timestampTz', formatMillis(ms)]
        : ['json', JSON.stringify(value)];
    }
    case 'binData': {
      const binary = body as { base64: string; subType: string };
      const hex = hexOfBase64(binary.base64);
      if (binary.subType === '00') return ['bytes', hex];
      if (binary.subType === '04' && hex.length === 32) {
        return [
          'uuid',
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        ];
      }
      return ['json', JSON.stringify(value)];
    }
    default:
      return ['json', JSON.stringify(value)];
  }
}

/** Mirror of `results::store_documents`: grid columns and rows (a missing field is `missing`). */
export function gridOf(documents: readonly EjsonDocument[]): {
  columns: ColumnMeta[];
  rows: Cell[][];
} {
  const order: string[] = [];
  const types = new Map<string, BsonType[]>();
  for (const document of documents) {
    for (const [key, value] of Object.entries(document)) {
      let seen = types.get(key);
      if (!seen) {
        seen = [];
        types.set(key, seen);
        order.push(key);
      }
      const type = bsonTypeOf(value);
      if (!seen.includes(type)) seen.push(type);
    }
  }
  const at = order.indexOf('_id');
  if (at > 0) order.unshift(...order.splice(at, 1));
  const columns = order.map((name): ColumnMeta => {
    const present = (types.get(name) ?? []).filter((t) => t !== 'null');
    const kinds = present.map(kindOf);
    const first = kinds[0];
    return {
      name,
      typeName: present.join(' | '),
      kind: first === undefined ? 'text' : kinds.every((k) => k === first) ? first : 'json',
    };
  });
  const rows = documents.map((document) =>
    order.map((name): Cell => {
      if (!(name in document)) return ['missing', ''];
      return cellOf(document[name] ?? null);
    }),
  );
  return { columns, rows };
}
