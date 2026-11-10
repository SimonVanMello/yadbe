import { expect, test } from '@playwright/test';

// Scratch micro-benchmark (not committed): script + style + layout per scroll step.
test('bench', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/#grid?sql=select * from big_table&tick=1');
  await expect(page.getByTestId('grid-demo-status')).toHaveText('succeeded', { timeout: 30_000 });
  const grid = page.getByRole('grid');
  await expect(grid.getByRole('gridcell').first()).toBeVisible();
  await page.waitForTimeout(500);
  for (const axis of ['v', 'h', 'v', 'h']) {
    const r = await grid.evaluate(
      async (el, axis) => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
        await new Promise((r) => setTimeout(r, 300));
        const steps: number[] = [];
        for (let i = 0; i < 400; i++) {
          const t0 = performance.now();
          if (axis === 'v') el.scrollTop = ((i * 100) % 12000);
          else el.scrollLeft = ((i * 100) % (el.scrollWidth - el.clientWidth));
          el.dispatchEvent(new Event('scroll'));
          void document.body.offsetHeight;
          steps.push(performance.now() - t0);
        }
        steps.sort((a, b) => a - b);
        return { median: steps[200], p90: steps[360] };
      },
      axis,
    );
    console.log(axis, JSON.stringify(r));
  }
});
