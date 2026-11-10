import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setMetaCatalog: (kind: 'shop' | 'large') => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

/**
 * P-06 (spec §3): palette fuzzy search over 10 000 database objects, target < 30 ms per
 * keystroke. The mock `large` catalog (10 schemas of 900 tables, 50 views and 50 functions
 * each: 10 000 relations and routines in one database). For each keystroke, an in-page script
 * sets the value of the field and dispatches `input`. Three durations: the field itself (React
 * renders the typed key at once; the results follow, interruptibly, for the deferred text), the
 * results (until `data-query` on the status line says they were rendered for that text: search,
 * ranking, grouping and the render of the visible rows) and the next frame after that (style,
 * layout, paint). The gate is on the results at CPU x1. Production build, no simulated latency:
 * what is measured is the front.
 */

const QUERIES = [
  // Typed a key at a time (the incremental path), objects only.
  '@',
  '@t',
  '@ta',
  '@tab',
  '@table',
  '@table_',
  '@table_0',
  '@table_03',
  '@table_034',
  '@table_0345',
  // Other shapes: schema-qualified, scattered letters, no match, every kind at once.
  '@schema_03.table_02',
  '@tbl345',
  '@view_01',
  '@zzz',
  '',
  'table_03',
  'sch.ord',
];
const ROUNDS = 6;

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}

const fmt = (s: ReturnType<typeof stats>) =>
  `median ${s.median} ms, p95 ${s.p95} ms, max ${s.max} ms`;

async function prepare(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    (window as MockWindow).__yadbeMock?.setLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaCatalog('large');
  });
  await page.reload();
  await page.evaluate(() => {
    (window as MockWindow).__yadbeMock?.setLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaCatalog('large');
  });
  await tree(page)
    .getByRole('treeitem', { name: /^local postgres,/ })
    .dblclick();
  await expect(tree(page).getByRole('treeitem', { name: /^local postgres,/ })).toHaveAccessibleName(
    /Connected/,
  );
}

/** Opens the palette on its objects and returns the ms until their count shows. */
function openOnObjects(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const start = performance.now();
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }),
        );
        const typeAt = () => {
          const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
          if (!input) {
            requestAnimationFrame(typeAt);
            return;
          }
          // eslint-disable-next-line @typescript-eslint/unbound-method
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, '@');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const poll = () => {
            const status =
              document.querySelector('[role="dialog"] [aria-live="polite"]')?.textContent ?? '';
            if (/\d{2},\d{3}|\d{5}/.test(status)) resolve(performance.now() - start);
            else if (performance.now() - start > 20_000) reject(new Error(`stuck on "${status}"`));
            else requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(typeAt);
      }),
  );
}

async function measure(page: Page, throttle: number) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const opening: number[] = [];
  const sync: number[] = [];
  const settled: number[] = [];
  const frame: number[] = [];
  const perQuery = new Map<string, number[]>();
  for (let round = 0; round < ROUNDS; round++) {
    opening.push(await openOnObjects(page));
    const timings = await page.evaluate(async (queries) => {
      const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
      const status = document.querySelector('[role="dialog"] [aria-live="polite"]');
      if (!input || !status) throw new Error('the palette is not open');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      const out: { query: string; sync: number; settled: number; frame: number }[] = [];
      for (const query of queries) {
        // The text the results were last rendered for: `data-query` on the status line.
        const rendered = () => status.getAttribute('data-query') === query;
        const start = performance.now();
        let done: (ms: number) => void = () => undefined;
        const settledAt = new Promise<number>((resolve) => {
          done = resolve;
        });
        const watch = new MutationObserver(() => {
          if (rendered()) done(performance.now() - start);
        });
        watch.observe(status, { attributes: true, attributeFilter: ['data-query'] });
        setter?.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const synchronous = performance.now() - start;
        // Typing what the field already holds renders nothing: the results are those of the text.
        if (rendered()) done(synchronous);
        const settled = await settledAt;
        watch.disconnect();
        await new Promise<void>((frame) => {
          requestAnimationFrame(() => {
            frame();
          });
        });
        out.push({ query, sync: synchronous, settled, frame: performance.now() - start });
      }
      return out;
    }, QUERIES);
    // The first round warms the JIT up and builds the index: it is measured for the opening only.
    if (round > 0) {
      for (const timing of timings) {
        sync.push(timing.sync);
        settled.push(timing.settled);
        frame.push(timing.frame);
        perQuery.set(timing.query, [...(perQuery.get(timing.query) ?? []), timing.settled]);
      }
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeHidden();
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return { opening, sync, settled, frame, perQuery };
}

test('P-06: palette search over 10 000 objects', async ({ page }) => {
  test.setTimeout(240_000);
  await prepare(page);
  const lines: string[] = [];
  let sync1 = Infinity;
  for (const throttle of [1, 4]) {
    const { opening, sync, settled, frame, perQuery } = await measure(page, throttle);
    const results = stats(settled);
    if (throttle === 1) sync1 = results.p95;
    lines.push(
      `CPU x${String(throttle)}`,
      `  opening on the objects (first one fetches and indexes the catalog): ${opening
        .map((ms) => `${String(Math.round(ms))} ms`)
        .join(', ')}`,
      `  keystroke, the field: ${fmt(stats(sync))}`,
      `  keystroke, results rendered: ${fmt(results)}`,
      `  keystroke, results painted (next frame): ${fmt(stats(frame))}`,
      '  per query (results rendered, p95):',
      ...[...perQuery].map(
        ([query, values]) => `    ${JSON.stringify(query)}: ${String(stats(values).p95)} ms`,
      ),
    );
  }
  const text = `P-06 palette over 10 000 objects (target: < 30 ms per keystroke)\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p06.txt'), text);
  expect(sync1).toBeLessThan(30);
});
