import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RowBlock } from './rowSource';
import { WindowCache } from './windowCache';

interface Pending {
  offset: number;
  limit: number;
  resolve: (rows?: number) => void;
  reject: () => void;
}

function setup(
  rowCount: number,
  options: { maxWindows?: number; maxConcurrent?: number; settleMs?: number } = {},
) {
  const pending: Pending[] = [];
  let available = rowCount;
  const cache = new WindowCache({
    windowSize: 10,
    maxWindows: options.maxWindows ?? 100,
    maxConcurrent: options.maxConcurrent ?? 2,
    refreshMs: 100,
    retryMs: 1000,
    settleMs: options.settleMs ?? 0,
    movingGapMs: 150,
    now: () => Date.now(),
    fetch: (offset, limit) =>
      new Promise<RowBlock>((resolve, reject) => {
        pending.push({
          offset,
          limit,
          resolve: (rows) => {
            const count = Math.max(0, Math.min(limit, (rows ?? available) - offset));
            resolve({
              offset,
              rowCount: count,
              columns: [
                {
                  values: Array.from({ length: count }, (_, i) => `r${String(offset + i)}`),
                  kinds: null,
                  truncated: [],
                },
              ],
            });
          },
          reject: () => {
            reject(new Error('boom'));
          },
        });
      }),
  });
  cache.setRowCount(rowCount);
  const flush = async () => {
    while (pending.length > 0) {
      for (const p of pending.splice(0)) p.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return {
    cache,
    pending,
    flush,
    grow: (count: number) => {
      available = count;
      cache.setRowCount(count);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WindowCache', () => {
  it('fetches the visible windows, nearest the middle first, a few at a time', async () => {
    const { cache, pending, flush } = setup(1000);
    cache.want(30, 60);
    expect(pending.map((p) => p.offset)).toEqual([40, 30]);
    await flush();
    expect(cache.get(35)?.offset).toBe(30);
    expect(cache.get(59)?.columns[0]?.values[9]).toBe('r59');
    // Neighbours are prefetched after the visible windows.
    expect(cache.get(25)).toBeDefined();
    expect(cache.get(65)).toBeDefined();
    expect(cache.get(95)).toBeUndefined();
  });

  it('does not queue every window crossed while the scrollbar is dragged', async () => {
    const { cache, pending, flush } = setup(1_000_000, { settleMs: 60 });
    // One new viewport per frame for a second.
    for (let frame = 0; frame < 60; frame++) {
      cache.want(frame * 16_007, frame * 16_007 + 30);
      await flush();
      vi.advanceTimersByTime(16);
    }
    // While moving: one visible window at most every 150 ms, no neighbours.
    expect(cache.fetchCount).toBeLessThanOrEqual(8);
    expect(pending).toHaveLength(0);
    // Once settled: the last viewport, then its neighbours.
    vi.advanceTimersByTime(200);
    await flush();
    const last = 59 * 16_007;
    expect(cache.get(last)).toBeDefined();
    expect(cache.get(last + 29)).toBeDefined();
    expect(cache.get(last - 10)).toBeDefined();
  });

  it('keeps memory bounded and evicts what is no longer wanted', async () => {
    const { cache, flush } = setup(10_000, { maxWindows: 5 });
    for (let row = 0; row < 500; row += 20) {
      cache.want(row, row + 10);
      await flush();
    }
    expect(cache.size).toBeLessThanOrEqual(5);
    expect(cache.get(495)).toBeDefined();
    expect(cache.get(0)).toBeUndefined();
  });

  it('refetches the last window while a streaming result grows, at a bounded rate', async () => {
    const { cache, pending, flush, grow } = setup(15);
    cache.want(0, 30);
    await flush();
    expect(cache.get(14)).toBeDefined();
    expect(cache.get(15)).toBeUndefined();
    grow(18);
    cache.want(0, 30);
    // Fetched less than 100 ms ago: waits.
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(pending.map((p) => p.offset)).toEqual([10]);
    await flush();
    expect(cache.get(17)?.columns[0]?.values[7]).toBe('r17');
  });

  it('asks a window again once an answer older than the row count arrives', async () => {
    const { cache, pending, grow } = setup(12);
    cache.want(0, 20);
    const second = pending.find((p) => p.offset === 10);
    grow(20);
    cache.want(0, 20);
    // One request per window at a time.
    expect(pending.filter((p) => p.offset === 10)).toHaveLength(1);
    second?.resolve(12);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get(11)).toBeDefined();
    expect(cache.get(19)).toBeUndefined();
    vi.advanceTimersByTime(100);
    const again = pending.filter((p) => p.offset === 10 && p !== second);
    expect(again).toHaveLength(1);
    again[0]?.resolve();
    await Promise.resolve();
    expect(cache.get(19)).toBeDefined();
  });

  it('retries a failed window later, then gives up', async () => {
    const { cache, pending } = setup(10, { maxConcurrent: 1 });
    cache.want(0, 10);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(pending).toHaveLength(1);
      pending.shift()?.reject();
      await Promise.resolve();
      await Promise.resolve();
      expect(pending).toHaveLength(0);
      vi.advanceTimersByTime(1000);
    }
    expect(pending).toHaveLength(0);
    expect(cache.fetchCount).toBe(3);
  });

  it('notifies subscribers when blocks arrive', async () => {
    const { cache, flush } = setup(10);
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);
    cache.want(0, 10);
    await flush();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    cache.setRowCount(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops fetching once disposed, and starts again when revived', async () => {
    const { cache, pending, flush } = setup(30, { maxConcurrent: 1 });
    cache.want(0, 10);
    await flush();
    expect(cache.get(0)).toBeDefined();
    cache.dispose();
    expect(cache.get(0)).toBeUndefined();
    cache.want(10, 20);
    expect(pending).toHaveLength(0);
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.revive();
    expect(listener).toHaveBeenCalled();
    cache.want(0, 10);
    expect(pending).toHaveLength(1);
  });
});
