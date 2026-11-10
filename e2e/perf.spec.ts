import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * P-07 (spec §3): tab switch < 50 ms. Measured from the keydown to the next painted frame, on
 * the mock backend with a production build. A switch calls no backend command for its content
 * (connection states are pushed by events); it saves the tab state (`save_tabs`), asynchronously.
 */

const SWITCHES = 60;
const TARGET_MS = 50;
const CONNECTIONS = ['app.sqlite', 'local postgres', 'wordpress'];

/** One query tab per connection, opened from the sidebar like a double click does. */
async function openThreeTabs(page: Page) {
  for (const [index, name] of CONNECTIONS.entries()) {
    if (index > 0) await page.keyboard.press('Control+T');
    await page
      .getByRole('tree', { name: 'Connections' })
      .getByRole('treeitem', { name: new RegExp(`^${name},`) })
      .dblclick();
    await expect(
      page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab', { selected: true }),
    ).toHaveAccessibleName(new RegExp(name.replace('.', '\\.')));
    // A connection that needs a password would open the prompt: not part of this measure.
    await page.keyboard.press('Escape');
  }
  await expect(page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab')).toHaveCount(3);
  // Let the simulated connection attempts settle: the measure is about stable tabs.
  await expect(page.getByRole('treeitem', { name: /^app\.sqlite,/ })).toHaveAccessibleName(
    /Connected/,
  );
}

/** Switches tabs `count` times with ⌃1/⌃2/⌃3 and returns each duration in ms. */
function measureSwitches(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (count) => {
    const nextFrame = () =>
      new Promise<void>((resolve) => {
        // rAF runs before the paint; the message after it runs once the frame is painted.
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            resolve();
          };
          channel.port2.postMessage(null);
        });
      });
    const durations: number[] = [];
    for (let i = 0; i < count; i++) {
      const digit = String((i % 3) + 1);
      await nextFrame();
      const start = performance.now();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: digit, code: `Digit${digit}`, ctrlKey: true }),
      );
      await nextFrame();
      durations.push(performance.now() - start);
      const selected = document.querySelector('[role="tab"][aria-selected="true"]');
      const panel = document.getElementById('tab-panel');
      if (!selected || panel?.getAttribute('aria-labelledby') !== selected.id) {
        throw new Error(`tab ${digit} not shown after the switch`);
      }
    }
    return durations;
  }, count);
}

function stats(durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { median: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)), runs: sorted.length };
}

test.use({ colorScheme: 'dark', locale: 'en-US' });

test('P-07 tab switch stays under 50 ms', async ({ page }) => {
  await page.goto('/');
  await openThreeTabs(page);
  await page.screenshot({ path: test.info().outputPath('tabs.png') });
  // Warm-up: first mounts of each view.
  await measureSwitches(page, 6);

  const normal = stats(await measureSwitches(page, SWITCHES));

  // Pessimistic run: CPU slowed down 4× (closer to a modest laptop under load).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const throttled = stats(await measureSwitches(page, SWITCHES));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const result = { target: TARGET_MS, normal, throttled4x: throttled };
  console.log(`P-07 tab switch (ms): ${JSON.stringify(result)}`);
  writeFileSync(test.info().outputPath('p07.json'), JSON.stringify(result, null, 2));
  expect(normal.median).toBeLessThan(TARGET_MS);
  expect(normal.p95).toBeLessThan(TARGET_MS);
});
