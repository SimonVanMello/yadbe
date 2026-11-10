import type { RowBlock } from './rowSource';

export interface WindowCacheOptions {
  /** Loads rows `[offset, offset + limit)` (fewer at the end). */
  fetch: (offset: number, limit: number) => Promise<RowBlock>;
  /** Rows per window (the backend serves windows of 500). */
  windowSize?: number;
  /** Windows kept in memory; the least recently wanted ones go first. */
  maxWindows: number;
  /** Requests in flight at once: scrolling fast never queues more than this. */
  maxConcurrent?: number;
  /** A window that is still filling (streaming) is fetched again at most this often. */
  refreshMs?: number;
  /** Wait before retrying a window whose fetch failed; three failures give up. */
  retryMs?: number;
  /**
   * The viewport counts as moving until it has wanted the same windows this long. While it
   * moves (a dragged scrollbar wants new windows every frame), visible windows are fetched one
   * at a time at most every `movingGapMs`, and neighbours not at all.
   */
  settleMs?: number;
  movingGapMs?: number;
  now?: () => number;
}

const MAX_ATTEMPTS = 3;

/**
 * Bounded cache of row windows with a fetch scheduler. Only the windows the viewport wants
 * (latest call) are fetched, nearest first, a few at a time: dragging the scrollbar across a
 * million rows costs a handful of requests, not one per window crossed.
 */
export class WindowCache {
  readonly windowSize: number;
  /** Windows requested so far (for tests and measurements). */
  fetchCount = 0;

  private readonly options: Required<Omit<WindowCacheOptions, 'now'>> & { now: () => number };
  /** Map order is recency: a wanted window is moved to the end. */
  private readonly blockMap = new Map<number, RowBlock>();
  private readonly inflight = new Set<number>();
  private readonly lastFetch = new Map<number, number>();
  private readonly failures = new Map<number, { count: number; at: number }>();
  private readonly listeners = new Set<() => void>();
  private wanted: number[] = [];
  private wantedKey = '';
  /** How many of `wanted` are on screen (the rest are neighbours). */
  private visibleCount = 0;
  private movedAt = -Infinity;
  private lastStart = -Infinity;
  private rows = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: WindowCacheOptions) {
    this.options = {
      windowSize: 500,
      maxConcurrent: 2,
      refreshMs: 100,
      retryMs: 1000,
      settleMs: 60,
      movingGapMs: 150,
      now: () => performance.now(),
      ...options,
    };
    this.windowSize = this.options.windowSize;
  }

  get rowCount(): number {
    return this.rows;
  }

  get size(): number {
    return this.blockMap.size;
  }

  /** The loaded block holding `row`, if that row is loaded. */
  get(row: number): RowBlock | undefined {
    const block = this.blockMap.get(Math.floor(row / this.windowSize));
    return block && row - block.offset < block.rowCount ? block : undefined;
  }

  /** Any loaded block of window `index`, even one still filling. */
  peekWindow(index: number): RowBlock | undefined {
    return this.blockMap.get(index);
  }

  /** Every block in memory. */
  blocks(): IterableIterator<RowBlock> {
    return this.blockMap.values();
  }

  setRowCount(count: number): void {
    if (count === this.rows) return;
    this.rows = count;
    // The windows around the viewport depend on the row count: recompute them on the next call.
    this.wantedKey = '';
    for (const index of [...this.blockMap.keys()]) {
      if (index * this.windowSize >= count) this.blockMap.delete(index);
    }
    this.notify();
    this.pump();
  }

  /** Rows `[start, end)` are visible: fetch their windows first, then one on each side. */
  want(start: number, end: number): void {
    const size = this.windowSize;
    const first = Math.max(0, Math.floor(start / size));
    const last = Math.max(first, Math.floor((Math.max(start, end) - 1) / size));
    const key = `${first}:${last}`;
    if (key === this.wantedKey) {
      this.pump();
      return;
    }
    this.wantedKey = key;
    this.movedAt = this.options.now();
    const middle = (first + last) / 2;
    const visible: number[] = [];
    for (let i = first; i <= last; i++) visible.push(i);
    visible.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
    const lastWindow = Math.ceil(this.rows / size) - 1;
    const around = [first - 1, last + 1].filter((i) => i >= 0 && i <= lastWindow);
    this.wanted = [...visible, ...around];
    this.visibleCount = visible.length;
    for (const index of this.wanted) {
      const block = this.blockMap.get(index);
      if (block) {
        this.blockMap.delete(index);
        this.blockMap.set(index, block);
      }
    }
    this.pump();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stops fetching and frees the rows (the grid unmounted). Listeners stay subscribed. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.blockMap.clear();
  }

  /** Undoes `dispose` (a component remounted with the same cache, e.g. React's strict mode). */
  revive(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.wantedKey = '';
    this.notify();
    this.pump();
  }

  private expected(index: number): number {
    return Math.max(0, Math.min(this.windowSize, this.rows - index * this.windowSize));
  }

  /** 0: fetch now; a positive number: fetch in that many ms; `null`: nothing to fetch. */
  private due(index: number, now: number): number | null {
    const expected = this.expected(index);
    if (expected === 0 || this.inflight.has(index)) return null;
    const block = this.blockMap.get(index);
    if (block && block.rowCount >= expected) return null;
    const failure = this.failures.get(index);
    if (failure) {
      if (failure.count >= MAX_ATTEMPTS) return null;
      const wait = failure.at + this.options.retryMs - now;
      if (wait > 0) return wait;
    }
    if (block) {
      const wait = (this.lastFetch.get(index) ?? 0) + this.options.refreshMs - now;
      if (wait > 0) return wait;
    }
    return 0;
  }

  private pump(): void {
    if (this.disposed) return;
    const now = this.options.now();
    const { settleMs, movingGapMs, maxConcurrent } = this.options;
    const settledIn = this.movedAt + settleMs - now;
    const moving = settledIn > 0;
    let nextWait = moving ? settledIn : Infinity;
    for (const [position, index] of this.wanted.entries()) {
      if (this.inflight.size >= maxConcurrent) break;
      if (moving && position >= this.visibleCount) break;
      const wait = this.due(index, now);
      if (wait === null) continue;
      const gap = moving ? this.lastStart + movingGapMs - now : 0;
      if (wait > 0 || gap > 0) {
        nextWait = Math.min(nextWait, Math.max(wait, gap));
        continue;
      }
      this.start(index, now);
      if (moving) break;
    }
    if (nextWait !== Infinity && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, nextWait);
    }
  }

  private start(index: number, now: number): void {
    this.inflight.add(index);
    this.lastStart = now;
    this.lastFetch.set(index, now);
    this.fetchCount++;
    this.options.fetch(index * this.windowSize, this.windowSize).then(
      (block) => {
        this.inflight.delete(index);
        if (this.disposed) return;
        this.failures.delete(index);
        const old = this.blockMap.get(index);
        // A slower, older answer never replaces a fuller block.
        if (!old || block.rowCount >= old.rowCount) {
          this.blockMap.delete(index);
          if (index * this.windowSize < this.rows) this.blockMap.set(index, block);
          this.evict();
          this.notify();
        }
        this.pump();
      },
      () => {
        this.inflight.delete(index);
        if (this.disposed) return;
        const count = (this.failures.get(index)?.count ?? 0) + 1;
        this.failures.set(index, { count, at: this.options.now() });
        this.pump();
      },
    );
  }

  private evict(): void {
    if (this.blockMap.size <= this.options.maxWindows) return;
    const keep = new Set(this.wanted);
    for (const index of this.blockMap.keys()) {
      if (this.blockMap.size <= this.options.maxWindows) break;
      if (!keep.has(index)) this.blockMap.delete(index);
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
