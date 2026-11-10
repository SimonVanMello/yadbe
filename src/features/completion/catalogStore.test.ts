import { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ipc, unwrap } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import {
  ensureCatalog,
  needsCatalog,
  peekCatalog,
  resetCatalogStore,
  resolveDatabase,
  useCatalogLoading,
  type CatalogDeps,
} from './catalogStore';

const PG = 'conn-local-pg';
const SQLITE = 'conn-app-sqlite';

let client: QueryClient;
let clock = 0;
let deps: CatalogDeps;
let reads: MockInstance<typeof ipc.commands.getCompletionCatalog>;

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  resetCatalogStore();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clock = 1_000_000;
  deps = { client, now: () => clock };
  await unwrap(ipc.commands.connect(PG, null));
  await unwrap(ipc.commands.connect(SQLITE, null));
  reads = vi.spyOn(ipc.commands, 'getCompletionCatalog');
});

afterEach(() => {
  reads.mockRestore();
  resetCatalogStore();
});

/** The backend says a node was refreshed, as `refresh_meta` does. */
async function refresh(node: Parameters<typeof ipc.commands.refreshMeta>[1], connection = PG) {
  await unwrap(ipc.commands.refreshMeta(connection, node));
}

describe('loading the catalog', () => {
  it('reads it on first need, once for every caller', async () => {
    expect(peekCatalog(PG, 'app_dev', deps)).toBeNull();
    const [a, b] = await Promise.all([
      ensureCatalog(PG, 'app_dev', deps),
      ensureCatalog(PG, 'app_dev', deps),
    ]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(peekCatalog(PG, 'app_dev', deps)).toBe(a);
  });

  it('serves a loaded catalog without reading again, and indexes it once', async () => {
    const first = await ensureCatalog(PG, 'app_dev', deps);
    const again = await ensureCatalog(PG, 'app_dev', deps);
    expect(again).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(needsCatalog(PG, 'app_dev', deps)).toBe(false);
    expect(first?.database).toBe('app_dev');
  });

  it('keeps a catalog per database', async () => {
    await ensureCatalog(PG, 'app_dev', deps);
    expect(needsCatalog(PG, 'postgres', deps)).toBe(true);
    expect(peekCatalog(PG, 'postgres', deps)).toBeNull();
  });

  it('asks for the system objects too', async () => {
    await ensureCatalog(PG, 'app_dev', deps);
    expect(reads).toHaveBeenCalledWith(expect.any(String), PG, 'app_dev', true);
  });

  it('answers null when the connection cannot be read, and waits before trying again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await unwrap(ipc.commands.disconnect(PG));
    expect(await ensureCatalog(PG, 'app_dev', deps)).toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await ensureCatalog(PG, 'app_dev', deps)).toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    clock += 6000;
    await unwrap(ipc.commands.connect(PG, null));
    expect(await ensureCatalog(PG, 'app_dev', deps)).not.toBeNull();
    expect(reads).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('loading indicator', () => {
  it('is on while a first read is under way, off after', async () => {
    mockBackend.setMetaLatency(300);
    const { result } = renderHook(() => useCatalogLoading(PG));
    expect(result.current).toBe(false);
    const load = ensureCatalog(PG, 'app_dev', deps);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(loadingFor('other')).toBe(false);
    await load;
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('stays off while an out-of-date catalog is refreshed: it is still usable', async () => {
    await ensureCatalog(PG, 'app_dev', deps);
    await refresh({ level: 'connection' });
    mockBackend.setMetaLatency(300);
    const { result } = renderHook(() => useCatalogLoading(PG));
    const load = ensureCatalog(PG, 'app_dev', deps);
    expect(result.current).toBe(false);
    await load;
  });
});

function loadingFor(connection: string): boolean {
  return renderHook(() => useCatalogLoading(connection)).result.current;
}

describe('invalidation by metaRefreshed', () => {
  beforeEach(async () => {
    await ensureCatalog(PG, 'app_dev', deps);
    await ensureCatalog(PG, 'postgres', deps);
  });

  it('a refresh of the connection makes every catalog of it stale, but still readable', async () => {
    const before = peekCatalog(PG, 'app_dev', deps);
    await refresh({ level: 'connection' });
    expect(needsCatalog(PG, 'app_dev', deps)).toBe(true);
    expect(needsCatalog(PG, 'postgres', deps)).toBe(true);
    expect(peekCatalog(PG, 'app_dev', deps)).toBe(before);
    const reloaded = await ensureCatalog(PG, 'app_dev', deps);
    expect(reloaded).not.toBe(before);
    expect(needsCatalog(PG, 'app_dev', deps)).toBe(false);
    expect(needsCatalog(PG, 'postgres', deps)).toBe(true);
  });

  it.each([
    ['a database', { level: 'database', database: 'app_dev' }],
    ['a schema', { level: 'schema', database: 'app_dev', schema: 'shop' }],
    ['a kind of object', { level: 'objects', database: 'app_dev', schema: 'shop', kind: 'table' }],
    ['a table', { level: 'table', table: { database: 'app_dev', schema: 'shop', name: 'orders' } }],
  ] as const)('a refresh of %s makes that database stale only', async (_, node) => {
    await refresh(node);
    expect(needsCatalog(PG, 'app_dev', deps)).toBe(true);
    expect(needsCatalog(PG, 'postgres', deps)).toBe(false);
  });

  it('leaves the other connections alone', async () => {
    await refresh({ level: 'connection' }, SQLITE);
    expect(needsCatalog(PG, 'app_dev', deps)).toBe(false);
  });

  it('lives under the connection`s metadata key: closing the connection removes it', () => {
    // `metaFeed` removes `['meta', connection]` when a session closes.
    client.removeQueries({ queryKey: ['meta', PG] });
    expect(peekCatalog(PG, 'app_dev', deps)).toBeNull();
    expect(needsCatalog(PG, 'app_dev', deps)).toBe(true);
  });
});

describe('the database of a tab', () => {
  it('is the tab`s own, else the connection`s', async () => {
    expect(await resolveDatabase(PG, 'postgres', 'app_dev', client)).toBe('postgres');
    expect(await resolveDatabase(PG, null, 'app_dev', client)).toBe('app_dev');
  });

  it('is the current one of a server that says so, for file engines', async () => {
    expect(await resolveDatabase(SQLITE, null, '', client)).toBe('main');
  });

  it('is unknown when the connection is not open', async () => {
    await unwrap(ipc.commands.disconnect(SQLITE));
    expect(await resolveDatabase(SQLITE, null, '', client)).toBeNull();
  });
});
