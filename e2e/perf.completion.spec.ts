import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * Autocomplete on a 10 000-object schema (P-05: suggestions < 50 ms per keystroke), on the mock
 * backend with a production build and no simulated latency, so that what is measured is the
 * front: the statement lookup, the context analysis, the ranking over the catalog index, and
 * CodeMirror drawing the list. CPU ×1, then ×4 for a slower machine.
 *
 * Two figures per keystroke: the time of the completion source itself (what P-05 asks for,
 * recorded by the source in `window.__yadbeCompletionTimings`), and the time from the key to the
 * list repainted (adds CodeMirror's 20 ms typing delay and the rendering).
 */

interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setMetaCatalog: (kind: 'shop' | 'large') => void;
}
type PerfWindow = Window & {
  __yadbeMock?: MockControls;
  __yadbeCompletionTimings?: number[];
  __yadbeKeyToList?: number[];
};

const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const options = (page: Page) => page.locator('.cm-tooltip-autocomplete [role="option"]');

function stats(durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { median: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)), keys: sorted.length };
}

/** Records, for every key typed, the time until the suggestions list was last repainted. */
async function observeKeyToList(page: Page) {
  await page.evaluate(() => {
    const scope = window as PerfWindow;
    scope.__yadbeKeyToList = [];
    let started = 0;
    let last = 0;
    const flush = () => {
      if (started > 0 && last > started) scope.__yadbeKeyToList?.push(last - started);
    };
    document.addEventListener(
      'beforeinput',
      () => {
        flush();
        started = performance.now();
        last = 0;
      },
      true,
    );
    new MutationObserver((records) => {
      if (
        records.some(
          (r) => r.target instanceof Element && r.target.closest('.cm-tooltip-autocomplete'),
        )
      ) {
        last = performance.now();
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
    (scope as unknown as { __flushKeys: () => void }).__flushKeys = flush;
  });
}

async function typeSlowly(page: Page, text: string) {
  for (const char of text) {
    await page.keyboard.type(char);
    // Past CodeMirror's typing delay and the source, so that every key is a run of its own.
    await page.waitForTimeout(90);
  }
}

async function clear(page: Page) {
  // Focus, not click: an open info panel covers the middle of the editor.
  await page.keyboard.press('Escape');
  await editor(page).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
}

/** Types `text` at the start of `script`, after the first `skip` characters. */
async function typeInto(page: Page, script: string, skip: number, text: string) {
  await clear(page);
  await page.keyboard.insertText(script);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < skip; i++) await page.keyboard.press('ArrowRight');
  await typeSlowly(page, text);
}

test.use({ colorScheme: 'dark', locale: 'en-US', viewport: { width: 1280, height: 800 } });

test('suggestions on 10 000 objects', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(sidebarItem(page, 'local postgres')).toBeVisible();
  await page.evaluate(() => {
    const mock = (window as PerfWindow).__yadbeMock;
    mock?.setLatency(0);
    mock?.setMetaLatency(0);
    mock?.setMetaCatalog('large');
  });
  await sidebarItem(page, 'local postgres').dblclick();
  await expect(editor(page)).toBeVisible();
  await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);

  // First need: the catalog is read, indexed and the lists built, then the list shows by itself.
  await editor(page).click();
  await page.keyboard.type('select * from table_04');
  await expect(options(page).first()).toContainText('table_04');

  await observeKeyToList(page);
  const cdp = await page.context().newCDPSession(page);

  const scenarios = [
    // Relations of the whole database, schema-qualified when off the search path.
    () => typeInto(page, '', 0, 'select * from table_0450'),
    // Objects of one schema.
    () => typeInto(page, '', 0, 'select * from schema_03.tab'),
    // Columns of an alias, resolved from the statement's FROM.
    () =>
      typeInto(
        page,
        'select  from schema_01.table_0001 o join schema_02.table_0002 p on 1 = 1',
        'select '.length,
        'o.col_0',
      ),
    // A column name among the statement's, then the catalog's.
    () =>
      typeInto(
        page,
        'select  from schema_01.table_0001 o join schema_02.table_0002 p on 1 = 1',
        'select '.length,
        'col_03',
      ),
  ];

  const raw: { rate: number; source: number[]; keyToList: number[] }[] = [];
  const run = async (rate: number) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.evaluate(() => {
      (window as PerfWindow).__yadbeCompletionTimings = [];
      (window as PerfWindow).__yadbeKeyToList = [];
    });
    for (const scenario of scenarios) await scenario();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      (window as unknown as { __flushKeys: () => void }).__flushKeys();
    });
    const { source, keyToList } = await page.evaluate(() => ({
      source: (window as PerfWindow).__yadbeCompletionTimings ?? [],
      keyToList: (window as PerfWindow).__yadbeKeyToList ?? [],
    }));
    const round = (values: number[]) => values.map((v) => Math.round(v * 10) / 10);
    raw.push({ rate, source: round(source), keyToList: round(keyToList) });
    return { source: stats(source), keyToList: stats(keyToList) };
  };

  const x1 = await run(1);
  const x4 = await run(4);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const result = { catalog: '9 500 relations + 500 routines', x1, x4 };
  console.log(`Autocomplete, 10 000 objects: ${JSON.stringify(result)}`);
  writeFileSync(test.info().outputPath('completion-10k.json'), JSON.stringify(result, null, 2));
  writeFileSync(test.info().outputPath('completion-10k-raw.json'), JSON.stringify(raw));
  // P-05: < 50 ms per keystroke, at normal speed.
  expect(x1.source.p95).toBeLessThan(50);
  expect(x1.source.keys).toBeGreaterThan(40);
});
