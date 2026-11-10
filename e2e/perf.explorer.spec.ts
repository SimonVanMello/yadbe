import { writeFileSync } from 'node:fs';

import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setMetaCatalog: (
    kind: 'shop' | 'large',
    options?: {
      schemas: number;
      tablesPerSchema: number;
      columnsPerTable: number;
      viewsPerSchema: number;
      functionsPerSchema: number;
    },
  ) => void;
  commands: { getTableDetails: (...args: unknown[]) => Promise<unknown> };
}
type MockWindow = Window & { __yadbeMock?: MockControls };

/**
 * Explorer (M1-2, F-020 to F-022, spec §6 "nothing blocks"): the front's share of showing a
 * catalog, on the mock backend with a production build and no simulated server latency, so that
 * what is measured is React and the DOM. Reported, not gated, except for a generous ceiling.
 */

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** CPU time the main thread has spent so far, in seconds. */
async function taskSeconds(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
}

function stats(durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { median: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)), runs: sorted.length };
}

/** Time from the double click on a connection to the first level (databases and schemas) drawn. */
function timeToFirstLevel(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const start = performance.now();
    const row = [...document.querySelectorAll('[role="treeitem"]')].find((el) =>
      el.getAttribute('aria-label')?.startsWith('local postgres,'),
    );
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the first level never showed'));
      }, 20_000);
      const check = () => {
        const labels = [...document.querySelectorAll('[role="treeitem"]')].map((el) =>
          el.getAttribute('aria-label'),
        );
        if (
          labels.includes('app_dev') &&
          labels.includes('public') &&
          labels.includes('schema_00')
        ) {
          clearTimeout(timer);
          // Resolve once the frame that shows it is painted.
          requestAnimationFrame(() => {
            setTimeout(() => {
              resolve(performance.now() - start);
            }, 0);
          });
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  });
}

/**
 * Scrolls the tree from top to bottom, `step` px per frame (a fast fling: about 40 rows a frame),
 * and returns each frame's duration.
 */
function scrollFrames(page: Page, step: number, distance = Infinity): Promise<number[]> {
  return page.evaluate(
    async ({ step, distance }) => {
      const element = document.querySelector('[role="tree"]');
      if (!element) throw new Error('no tree');
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const durations: number[] = [];
      element.scrollTop = 0;
      let previous = await frame();
      while (
        element.scrollTop < distance &&
        element.scrollTop + element.clientHeight < element.scrollHeight - 1
      ) {
        element.scrollTop += step;
        const now = await frame();
        durations.push(now - previous);
        previous = now;
      }
      return durations;
    },
    { step, distance },
  );
}

/** Time from typing in the filter to the tree showing the matches. */
function timeToFilter(page: Page, text: string, firstMatch: string): Promise<number> {
  return page.evaluate(
    async ({ text, firstMatch }) => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Filter connections"]',
      );
      if (!input) throw new Error('no filter');
      const list = document.querySelector('[role="tree"]');
      if (list) list.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const start = performance.now();
      // React tracks the value of a controlled input: only the native setter makes it notice.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('the filter never showed'));
        }, 20_000);
        const check = () => {
          const first = [...document.querySelectorAll('[role="treeitem"]')].find((el) =>
            el.getAttribute('aria-label')?.startsWith(firstMatch),
          );
          if (first) {
            clearTimeout(timer);
            requestAnimationFrame(() => {
              setTimeout(() => {
                resolve(performance.now() - start);
              }, 0);
            });
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      });
    },
    { text, firstMatch },
  );
}

test.use({ colorScheme: 'dark', locale: 'en-US', viewport: { width: 1280, height: 1000 } });

test('first level after connect, 500 tables', async ({ page }) => {
  await page.goto('/');
  await expect(item(page, /^local postgres,/)).toBeVisible();
  await page.evaluate(() => {
    (window as MockWindow).__yadbeMock?.setLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaCatalog('large', {
      schemas: 1,
      tablesPerSchema: 500,
      columnsPerTable: 10,
      viewsPerSchema: 0,
      functionsPerSchema: 0,
    });
  });
  const firstLevel = await timeToFirstLevel(page);
  await expect(item(page, /^local postgres,/)).toHaveAccessibleName(/Connected/);

  // Opening the schema and its 500 tables.
  await expand(item(page, /^schema_00$/));
  const started = Date.now();
  await expand(item(page, /^Tables \(/));
  await expect(item(page, /^table_0000$/)).toBeVisible();
  const tables = Date.now() - started;
  const result = { firstLevelMs: Math.round(firstLevel), expandedTablesMsPlaywright: tables };
  console.log(`Explorer, 500 tables: ${JSON.stringify(result)}`);
  writeFileSync(test.info().outputPath('explorer-500.json'), JSON.stringify(result, null, 2));
  expect(firstLevel).toBeLessThan(1000);
});

test('scrolling and filtering 10 000 objects', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(item(page, /^local postgres,/)).toBeVisible();
  await page.evaluate(() => {
    (window as MockWindow).__yadbeMock?.setLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaLatency(0);
    (window as MockWindow).__yadbeMock?.setMetaCatalog('large');
  });
  await item(page, /^local postgres,/).dblclick();
  await expect(item(page, /^local postgres,/)).toHaveAccessibleName(/Connected/);
  // Bottom up, so that the schemas still to open stay at the top, where they are drawn.
  for (let schema = 9; schema >= 0; schema--) {
    await expand(item(page, new RegExp(`^schema_0${String(schema)}$`)));
    // Views first: once the tables are open, the views row is thousands of rows further down.
    await expand(item(page, /^Views \(/).first());
    await expand(item(page, /^Tables \(/).first());
  }
  const rows = await page.evaluate(() => {
    const element = document.querySelector('[role="tree"]');
    return element ? Math.round(element.scrollHeight / 28) : 0;
  });
  const mounted = await tree(page).getByRole('treeitem').count();
  await page.screenshot({ path: test.info().outputPath('explorer-10k.png') });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const top = () =>
    page.evaluate(() => {
      const element = document.querySelector('[role="tree"]');
      if (element) element.scrollTop = 0;
    });
  /** Frame durations (wall clock, noisy on a busy machine) and the CPU time of the main thread. */
  const scroll = async (step: number, distance?: number) => {
    await top();
    const before = await taskSeconds(cdp);
    const frames = await scrollFrames(page, step, distance);
    const cpu = (await taskSeconds(cdp)) - before;
    return { ...stats(frames), cpuPerFrame: Math.round((cpu * 10_000) / frames.length) / 10 };
  };

  await scroll(1200);
  // A wheel: about 4 rows a frame over 200 rows; a fling: about 40 rows a frame over the whole list.
  const wheelNormal = await scroll(120, 5600);
  const flingNormal = await scroll(1200);
  const filterNormal = await timeToFilter(page, 'table_01', 'table_0001');
  await page.getByRole('textbox', { name: 'Filter connections' }).fill('');
  await expect(item(page, /^schema_00$/)).toBeVisible();
  /** Typing the filter a key at a time: every keystroke until its matches are drawn. */
  const typing = async (text: string, firstMatch: string) => {
    const durations: number[] = [];
    for (let length = 1; length <= text.length; length++) {
      const prefix = text.slice(0, length);
      durations.push(await timeToFilter(page, prefix, length < 2 ? 'table_' : firstMatch));
    }
    await page.getByRole('textbox', { name: 'Filter connections' }).fill('');
    await expect(item(page, /^schema_00$/)).toBeVisible();
    return stats(durations);
  };
  const typingNormal = await typing('table_03', 'table_0003');

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const wheelThrottled = await scroll(120, 5600);
  const flingThrottled = await scroll(1200);
  const filterThrottled = await timeToFilter(page, 'table_02', 'table_0002');
  await page.getByRole('textbox', { name: 'Filter connections' }).fill('');
  await expect(item(page, /^schema_00$/)).toBeVisible();
  const typingThrottled = await typing('table_04', 'table_0004');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const result = {
    rowsInTheTree: rows,
    rowsMounted: mounted,
    wheelFrameMs: { x1: wheelNormal, x4: wheelThrottled },
    flingFrameMs: { x1: flingNormal, x4: flingThrottled },
    filterMs: { x1: Math.round(filterNormal), x4: Math.round(filterThrottled) },
    filterPerKeystrokeMs: { x1: typingNormal, x4: typingThrottled },
  };
  console.log(`Explorer, 10 000 objects: ${JSON.stringify(result)}`);
  writeFileSync(test.info().outputPath('explorer-10k.json'), JSON.stringify(result, null, 2));
  expect(mounted).toBeLessThan(120);
});
