import { expect, test } from '@playwright/test';

// Scratch profiler (not committed): main-thread phases per frame while scrolling.
interface TraceEvent {
  name: string;
  dur?: number;
  ph: string;
  tid: number;
  pid: number;
}

test('profile', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto('/#grid?sql=select * from big_table&tick=1');
  await expect(page.getByTestId('grid-demo-status')).toHaveText('succeeded', { timeout: 30_000 });
  const grid = page.getByRole('grid');
  await expect(grid.getByRole('gridcell').first()).toBeVisible();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.RATE ?? 1) });
  const layers = new Promise<string>((resolve) => {
    cdp.on('LayerTree.layerTreeDidChange', (e: { layers?: { layerId: string; width: number; height: number; drawsContent: boolean }[] }) => {
      if (e.layers) resolve(e.layers.map((l) => `${String(l.width)}x${String(l.height)}${l.drawsContent ? '' : '(empty)'}`).join(', '));
    });
  });
  await cdp.send('LayerTree.enable');
  await grid.evaluate((el) => { el.scrollTop = 10; });
  console.log('layers', await layers);
  for (const movement of ['vertical', 'horizontal']) {
    await grid.evaluate((el) => {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    });
    await page.waitForTimeout(500);
    const events: TraceEvent[] = [];
    const onData = (e: { value: object[] }) => {
      events.push(...(e.value as TraceEvent[]));
    };
    cdp.on('Tracing.dataCollected', onData);
    const done = new Promise<void>((resolve) => {
      cdp.once('Tracing.tracingComplete', () => {
        resolve();
      });
    });
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
      transferMode: 'ReportEvents',
    });
    await grid.evaluate(
      (el, mv) =>
        new Promise<void>((resolve) => {
          const start = performance.now();
          const maxLeft = el.scrollWidth - el.clientWidth;
          const tick = (now: number) => {
            const elapsed = now - start;
            if (mv === 'vertical') el.scrollTop = (elapsed / 1000) * 6000;
            else el.scrollLeft = ((elapsed / 1000) * 3000) % maxLeft;
            if (elapsed < 3000) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        }),
      movement,
    );
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    const count = new Map<string, number>();
    for (const e of events) {
      if (e.name === 'FireAnimationFrame') {
        const key = `${String(e.pid)}:${String(e.tid)}`;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    const [main, frames] = [...count.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 1];
    const totals = new Map<string, number>();
    for (const e of events) {
      if (`${String(e.pid)}:${String(e.tid)}` !== main || e.ph !== 'X' || !e.dur) continue;
      totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
    }
    const pick = ['RunTask', 'FunctionCall', 'EventDispatch', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit'];
    console.log(
      movement,
      `frames ${String(frames)}`,
      pick.map((n) => `${n} ${((totals.get(n) ?? 0) / frames).toFixed(2)}`).join(' | '),
    );
  }
  await context.close();
});
