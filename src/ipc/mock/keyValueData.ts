/**
 * The keyspace of the mock Redis connection: every key type, nested namespaces, TTLs, a binary
 * key, a RedisJSON document and a module type yadbe has no viewer for. Deterministic, so captures
 * and tests do not move.
 */

export type MockKvValue =
  | { type: 'string'; value: string }
  | { type: 'hash'; value: [string, string][] }
  | { type: 'list'; value: string[] }
  | { type: 'set'; value: string[] }
  | { type: 'zset'; value: [string, number][] }
  | { type: 'stream'; value: { id: string; fields: [string, string][] }[] }
  | { type: 'ReJSON-RL'; value: string }
  | { type: 'MBbloom--'; value: string };

export interface MockKvKey {
  /** The key; code points 0–255 stand for raw bytes when `binary` is set. */
  name: string;
  binary: boolean;
  value: MockKvValue;
  /** Milliseconds left; `null`: no expiry. */
  ttlMs: number | null;
}

const PLANS = ['free', 'pro', 'team', 'enterprise'];
const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Edsger', 'Frances'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Dijkstra'];

function pick<T>(items: readonly T[], i: number): T {
  return items[i % items.length] as T;
}

function key(name: string, value: MockKvValue, ttlMs: number | null = null): MockKvKey {
  return { name, binary: false, value, ttlMs };
}

/** Database 0: an application's cache, sessions, queues and leaderboards. */
function applicationKeys(): MockKvKey[] {
  const keys: MockKvKey[] = [];
  for (let id = 1; id <= 120; id++) {
    const first = pick(FIRST, id);
    const last = pick(LAST, id * 3);
    keys.push(
      key(`user:${String(id)}:profile`, {
        type: 'hash',
        value: [
          ['name', `${first} ${last}`],
          ['email', `${first.toLowerCase()}.${last.toLowerCase()}@example.com`],
          ['plan', pick(PLANS, id)],
          ['created_at', `2026-0${String(1 + (id % 9))}-1${String(id % 10)}T08:30:00Z`],
          ['logins', String(id * 7)],
        ],
      }),
    );
    if (id % 3 === 0) {
      keys.push(
        key(`user:${String(id)}:roles`, {
          type: 'set',
          value: [
            'reader',
            ...(id % 2 === 0 ? ['writer'] : []),
            ...(id % 9 === 0 ? ['admin'] : []),
          ],
        }),
      );
    }
  }
  for (let i = 0; i < 40; i++) {
    const token = (0x5f3a91c + i * 7919).toString(16);
    keys.push(
      key(
        `session:${token}`,
        {
          type: 'string',
          value: JSON.stringify({
            user: 1 + i,
            ip: `10.0.${String(i)}.12`,
            csrf: token.slice(0, 6),
          }),
        },
        (i + 1) * 61_000,
      ),
    );
  }
  keys.push(
    key('queue:emails', {
      type: 'list',
      value: Array.from(
        { length: 2_400 },
        (_, i) =>
          `{"to":"user${String(i)}@example.com","template":"${pick(['welcome', 'reset', 'digest'], i)}"}`,
      ),
    }),
    key('queue:jobs:high', {
      type: 'list',
      value: ['reindex:products', 'thumbnails:batch-42', 'export:orders:2026-10'],
    }),
    key('leaderboard:global', {
      type: 'zset',
      value: Array.from(
        { length: 1_500 },
        (_, i) => [`player:${String(1000 + i)}`, 98_000 - i * 61.5] as [string, number],
      ),
    }),
    key(
      'leaderboard:weekly:2026-45',
      {
        type: 'zset',
        value: Array.from({ length: 25 }, (_, i) => [
          `player:${String(1000 + i * 3)}`,
          900 - i * 31,
        ]),
      },
      6 * 86_400_000,
    ),
    key('events:orders', {
      type: 'stream',
      value: Array.from({ length: 1_200 }, (_, i) => ({
        id: `${String(1_762_000_000_000 + i * 1_000)}-0`,
        fields: [
          ['order', String(5_000 + i)],
          ['status', pick(['created', 'paid', 'shipped', 'delivered'], i)],
          ['amount', (19.9 + i * 1.25).toFixed(2)],
        ] as [string, string][],
      })),
    }),
    key('config:feature-flags', {
      type: 'hash',
      value: [
        ['new_checkout', 'true'],
        ['dark_mode', 'true'],
        ['beta_search', 'false'],
        ['max_cart_items', '50'],
      ],
    }),
    key('config:app', {
      type: 'string',
      value: JSON.stringify({
        name: 'shop',
        version: '4.2.0',
        regions: ['eu-west-1', 'us-east-1'],
        limits: { requests: 1200, burst: 300 },
        maintenance: null,
      }),
    }),
    key(
      'cache:page:/products/42',
      {
        type: 'string',
        value: `<!doctype html><html><head><title>Product 42</title></head><body>${'<p>Lorem ipsum dolor sit amet.</p>'.repeat(400)}</body></html>`,
      },
      300_000,
    ),
    key(
      'cache:page:/home',
      { type: 'string', value: '<!doctype html><title>Home</title>' },
      120_000,
    ),
    key('counter:visits', { type: 'string', value: '1048576' }),
    key('doc:product:42', {
      type: 'ReJSON-RL',
      value: JSON.stringify({
        id: 42,
        name: 'Mechanical keyboard',
        price: 129.9,
        tags: ['hardware', 'keyboard'],
        stock: { warehouse: 'LYS', quantity: 17 },
      }),
    }),
    key('bloom:signups', { type: 'MBbloom--', value: '' }),
    {
      name: 'bin:thumb:ÿØÿà',
      binary: true,
      value: {
        type: 'string',
        value: 'ÿØÿà\u0000\u0010JFIF\u0000\u0001\u0001\u0000\u0000\u0001',
      },
      ttlMs: null,
    },
  );
  return keys;
}

/** Database 1: a few scratch keys. */
function scratchKeys(): MockKvKey[] {
  return [
    key('tmp:import:7f3a', { type: 'string', value: 'running' }, 45_000),
    key('tmp:import:7f3b', { type: 'string', value: 'done' }, 15_000),
    key('lock:billing', { type: 'string', value: 'worker-3' }, 9_000),
  ];
}

/** Keys of a synthetic large database (`metrics:<host>:<n>`), made on demand. */
export function syntheticKey(i: number): MockKvKey {
  return key(`metrics:host-${String(i % 40).padStart(2, '0')}:${String(i)}`, {
    type: 'string',
    value: String((i * 37) % 1000),
  });
}

/** The keys of each database of the mock server. */
export function seedKeyspace(): Map<number, Map<string, MockKvKey>> {
  const byDb = new Map<number, Map<string, MockKvKey>>();
  const put = (db: number, keys: MockKvKey[]) =>
    byDb.set(db, new Map(keys.map((k) => [k.name, k] as const)));
  put(0, applicationKeys());
  put(1, scratchKeys());
  return byDb;
}

/** Database 3 of the mock: this many synthetic keys (a large keyspace, for "load more"). */
export const SYNTHETIC_DB = 3;
export const SYNTHETIC_KEYS = 60_000;
