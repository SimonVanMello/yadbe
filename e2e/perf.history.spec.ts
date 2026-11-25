import { expect, test, type CDPSession, type Page } from '@playwright/test';

/**
 * History panel (M4-13, P-08 front side): scrolling a few thousand rows whose statements are
 * coloured in their engine's syntax, on the mock backend with a production build. Reported, not
 * gated, except for a generous ceiling.
 */
type MockWindow = Window & {
  __yadbeMock?: { setLatency: (ms: number) => void } & Record<string, unknown>;
};

const LOADED_ROWS = 3500;

async function taskSeconds(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) * 10) / 10
  );
}

async function prepare(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    const mock = (window as MockWindow).__yadbeMock;
    mock?.setLatency(0);
    (mock as unknown as { seedHistory: (count: number) => void }).seedHistory(20_000);
  });
  await page
    .getByRole('tablist', { name: 'Sidebar view' })
    .getByRole('tab', { name: 'History' })
    .click();
  const list = page.getByRole('listbox', { name: 'Statements run' });
  await expect(list.getByRole('option').first()).toBeVisible();
  // Page in the older entries until the list is long enough.
  for (let i = 0; i < 40; i++) {
    const height = await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollHeight;
    });
    if (height > LOADED_ROWS * 66) break;
    await page.waitForTimeout(150);
  }
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  return list;
}

test('P-08 front: scrolling a long coloured history', async ({ page }) => {
  test.setTimeout(180_000);
  const list = await prepare(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  for (const throttle of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const before = await taskSeconds(cdp);
    const result = await list.evaluate(
      (element) =>
        new Promise<{ frames: number[]; rows: number; height: number }>((resolve) => {
          element.scrollTop = 0;
          const seen = new Set<string>();
          const frames: number[] = [];
          let last = performance.now();
          const step = () => {
            const now = performance.now();
            frames.push(now - last);
            last = now;
            for (const row of element.querySelectorAll('[role="option"]')) {
              seen.add(row.id);
            }
            if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) {
              resolve({ frames, rows: seen.size, height: element.scrollHeight });
              return;
            }
            // About a screen and a half per frame: every frame renders rows never drawn before.
            element.scrollTop += 900;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    const cpu = (await taskSeconds(cdp)) - before;
    console.log(
      `CPU x${String(throttle)}: ${String(result.rows)} distinct rows drawn in ${String(result.frames.length)} frames; ` +
        `frame median ${String(quantile(result.frames, 0.5))} ms, p95 ${String(quantile(result.frames, 0.95))} ms, ` +
        `max ${String(quantile(result.frames, 1))} ms; main-thread CPU ${(cpu * 1000).toFixed(0)} ms ` +
        `(${((cpu * 1000) / Math.max(1, result.rows)).toFixed(2)} ms per row drawn)`,
    );
    expect(quantile(result.frames, 0.95)).toBeLessThan(throttle === 1 ? 250 : 600);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(300);
  }
});
