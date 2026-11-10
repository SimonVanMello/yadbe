import { writeFileSync } from 'node:fs';

import { expect, test, type Browser, type Locator } from '@playwright/test';

/**
 * P-04 (spec §3): scrolling a 100k × 50 result at a sustained 60 fps, no frame over 32 ms, on
 * both axes. Production build of the frontend on the mock backend (`pnpm perf:grid`). An
 * in-page rAF loop moves the grid at a constant speed and records every frame interval, with
 * the CPU at ×1 and ×4 (CDP throttling). Three movements:
 *
 * - vertical: a fast flick down then up (6 000 px/s ≈ 250 rows/s);
 * - horizontal: back and forth across the 50 columns (3 000 px/s);
 * - jumps: the scrollbar thumb dragged to a new place every frame (worst case for loading).
 *
 * Also reported: frames that still showed loading rows, and how many windows were fetched (the
 * cache must not send a request per window crossed).
 */

const DURATION_MS = 5_000;
const BUDGET_MS = 1000 / 60;
const LONG_FRAME_MS = 32;

type Movement = 'vertical' | 'horizontal' | 'jumps';

interface Stats {
  frames: number;
  fps: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  over20: number;
  over32: number;
  loadingFrames: number;
  fetches: number;
  /** Main thread time over the movement, by kind (ms). */
  mainThread: Record<string, number>;
}

type Cdp = Awaited<ReturnType<typeof openGrid>>['cdp'];

const METRICS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'];

async function metrics(cdp: Cdp): Promise<Record<string, number>> {
  const { metrics: all } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(
    METRICS.map((name) => [name, all.find((m) => m.name === name)?.value ?? 0]),
  );
}

async function openGrid(browser: Browser, throttle: number) {
  const { baseURL, viewport } = test.info().project.use;
  const context = await browser.newContext({ baseURL, viewport, colorScheme: 'dark' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto('/#grid?sql=select * from big_table&tick=1');
  await expect(page.getByTestId('grid-demo-status')).toHaveText('succeeded', { timeout: 30_000 });
  const grid = page.getByRole('grid');
  await expect(grid.getByRole('gridcell').first()).toBeVisible();
  await expect(grid).toHaveAttribute('aria-rowcount', '100001');
  await page.evaluate(() => document.fonts.ready);
  // Counts the window requests the grid sends.
  await page.evaluate(() => {
    type Fetch = (...args: unknown[]) => unknown;
    const scope = window as unknown as {
      __yadbeMock?: { commands: { fetchResultWindow: Fetch } };
      __fetches: { count: number };
    };
    const mock = scope.__yadbeMock;
    if (!mock) throw new Error('mock backend missing');
    const original = mock.commands.fetchResultWindow;
    const counter = { count: 0 };
    scope.__fetches = counter;
    mock.commands.fetchResultWindow = (...args: unknown[]) => {
      counter.count++;
      return original(...args);
    };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await cdp.send('Performance.enable');
  return { context, grid, cdp };
}

async function move(grid: Locator, cdp: Cdp, movement: Movement): Promise<Stats> {
  // Start where the rows are loaded: the sweeps measure drawing, `jumps` measures loading.
  await grid.evaluate(
    (el, top) => {
      el.scrollTop = top === 'third' ? (el.scrollHeight - el.clientHeight) / 3 : 0;
      el.scrollLeft = 0;
    },
    movement === 'horizontal' ? 'third' : 'top',
  );
  await grid.page().waitForTimeout(1_000);
  const before = await metrics(cdp);
  const result = await grid.evaluate(
    (el, args) =>
      new Promise<{ intervals: number[]; loading: number; fetches: number }>((resolve) => {
        const counter = (window as unknown as { __fetches: { count: number } }).__fetches;
        const fetchesBefore = counter.count;
        const intervals: number[] = [];
        let loading = 0;
        const maxTop = el.scrollHeight - el.clientHeight;
        const maxLeft = el.scrollWidth - el.clientWidth;
        let seed = 7;
        const random = () => {
          seed = (seed * 16_807) % 2_147_483_647;
          return seed / 2_147_483_647;
        };
        const start = performance.now();
        let last = start;
        const tick = (now: number) => {
          intervals.push(now - last);
          last = now;
          const elapsed = now - start;
          const half = args.duration / 2;
          const there = (speed: number, max: number) => {
            const travel = Math.min(max, (speed * half) / 1000);
            const t = elapsed < half ? elapsed / half : 2 - elapsed / half;
            return travel * Math.max(0, t);
          };
          if (args.movement === 'vertical') el.scrollTop = there(6_000, maxTop);
          else if (args.movement === 'horizontal') {
            // Several sweeps across the columns.
            const period = 2 * maxLeft;
            const x = ((elapsed / 1000) * 3_000) % period;
            el.scrollLeft = x < maxLeft ? x : period - x;
          } else el.scrollTop = random() * maxTop;
          // What this frame paints (rows placed by the scroll handler of the previous step).
          if (el.querySelector('[data-loading]')) loading++;
          if (elapsed < args.duration) requestAnimationFrame(tick);
          else
            resolve({
              intervals: intervals.slice(1),
              loading,
              fetches: counter.count - fetchesBefore,
            });
        };
        requestAnimationFrame(tick);
      }),
    { duration: DURATION_MS, movement },
  );
  const after = await metrics(cdp);
  const mainThread = Object.fromEntries(
    METRICS.map((name) => [
      name.replace('Duration', ''),
      Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000),
    ]),
  );
  const sorted = [...result.intervals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    frames: sorted.length,
    fps: round(1000 / at(0.5)),
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    p99Ms: round(at(0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
    over20: sorted.filter((d) => d > 20).length,
    over32: sorted.filter((d) => d > LONG_FRAME_MS).length,
    loadingFrames: result.loading,
    fetches: result.fetches,
    mainThread,
  };
}

test('P-04: grid scrolling, 100k rows × 50 columns', async ({ browser }) => {
  test.setTimeout(240_000);
  const results: Record<string, Record<Movement, Stats>> = {};
  const lines: string[] = [];
  for (const throttle of [1, 4]) {
    const { context, grid, cdp } = await openGrid(browser, throttle);
    // Warm-up: JIT and first layouts.
    await move(grid, cdp, 'vertical');
    const row = {} as Record<Movement, Stats>;
    for (const movement of ['vertical', 'horizontal', 'jumps'] as const) {
      const s = await move(grid, cdp, movement);
      row[movement] = s;
      lines.push(
        `CPU ×${String(throttle)} ${movement.padEnd(10)}: ${String(s.frames)} frames, median ${String(s.medianMs)} ms (${String(s.fps)} fps), ` +
          `p95 ${String(s.p95Ms)} ms, p99 ${String(s.p99Ms)} ms, max ${String(s.maxMs)} ms, >20 ms: ${String(s.over20)}, >32 ms: ${String(s.over32)}, ` +
          `frames with loading rows: ${String(s.loadingFrames)}, windows fetched: ${String(s.fetches)}, main thread ${JSON.stringify(s.mainThread)}`,
      );
    }
    results[String(throttle)] = row;
    await context.close();
  }
  const text = `P-04 grid scroll, mock big_table (100k × 50), ${String(DURATION_MS / 1000)} s per movement (target: 60 fps, no frame > ${String(LONG_FRAME_MS)} ms)\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p04.txt'), text);
  writeFileSync(test.info().outputPath('p04.json'), JSON.stringify(results, null, 2));
  for (const movement of ['vertical', 'horizontal'] as const) {
    const s = results['1']?.[movement];
    expect(s?.medianMs ?? Infinity, movement).toBeLessThanOrEqual(BUDGET_MS * 1.1);
    expect(s?.over32 ?? Infinity, movement).toBe(0);
  }
});
