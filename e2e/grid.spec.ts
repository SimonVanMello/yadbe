import { expect, test, type Page } from '@playwright/test';

/**
 * The result grid (M1-5) on its development page (`#grid`), mock backend. Captures in both
 * themes: typed values (NULL, empty string, whitespace, cut values), selections, the copy menu,
 * the cell viewer (JSON, binary), a paused streaming result and a wide result.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.screenshot({
    path: test.info().outputPath(`grid-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

/** Opens the page on a query and waits for the result to be complete. */
async function open(page: Page, sql: string, status = 'succeeded') {
  await page.goto(`/#grid?sql=${encodeURIComponent(sql)}&tick=5`);
  await expect(page.getByTestId('grid-demo-status')).toHaveText(status, { timeout: 15_000 });
  await expect(cell(page, 0, 0)).not.toHaveText('');
  await page.evaluate(() => document.fonts.ready);
}

/** A data cell by 0-based row and display column. */
function cell(page: Page, row: number, col: number) {
  return page
    .getByRole('grid')
    .locator(`[role=row][aria-rowindex="${String(row + 2)}"] [aria-colindex="${String(col + 1)}"]`);
}

function header(page: Page, name: string) {
  return page.getByRole('columnheader', { name: new RegExp(`^${name}\\b`) });
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('typed result: NULL, empty string, whitespace and cut values', async ({ page }) => {
      await open(page, 'select * from orders');
      const grid = page.getByRole('grid');
      await expect(grid).toHaveAttribute('aria-rowcount', '1285');
      await expect(page.getByText('1,284 rows')).toBeVisible();
      // customer of row 3 is NULL, email of row 5 the empty string.
      await expect(cell(page, 3, 1)).toHaveText('NULL');
      await expect(cell(page, 5, 2)).toHaveText('empty');
      // Exact 64-bit integers, right-aligned.
      await expect(cell(page, 0, 0)).toHaveText('9000000000');
      await expect(cell(page, 0, 0)).toHaveCSS('text-align', 'right');
      await capture(page, name, 'typed');

      // The right part: arrays as JSON, whitespace-only notes, a cut note, mixed kinds.
      await grid.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect(cell(page, 1, 11)).toHaveText('["t1", null]');
      await expect(cell(page, 0, 12)).toHaveText('··');
      await expect(cell(page, 7, 12)).toHaveAttribute('data-truncated', '');
      await capture(page, name, 'typed-right');
    });

    test('range selection with the mouse', async ({ page }) => {
      await open(page, 'select * from orders');
      await cell(page, 2, 1).hover();
      await page.mouse.down();
      await cell(page, 6, 3).hover();
      await page.mouse.up();
      await expect(cell(page, 4, 2)).toHaveAttribute('aria-selected', 'true');
      await expect(cell(page, 7, 2)).toHaveAttribute('aria-selected', 'false');
      await expect(page.getByText('5 × 3 selected')).toBeVisible();
      await capture(page, name, 'range');
    });

    test('column selection from the headers', async ({ page }) => {
      await open(page, 'select * from orders');
      await header(page, 'email').click();
      await header(page, 'quantity').click({ modifiers: ['Shift'] });
      await expect(header(page, 'total')).toHaveAttribute('aria-selected', 'true');
      await expect(cell(page, 100, 3)).toHaveCount(0);
      await expect(cell(page, 10, 3)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('1,284 × 3 selected')).toBeVisible();
      await capture(page, name, 'columns');
    });

    test('copy as menu', async ({ page }) => {
      await open(page, 'select * from orders');
      await cell(page, 1, 1).click();
      await cell(page, 2, 3).click({ modifiers: ['Shift'] });
      await cell(page, 2, 2).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Copy as' }).click();
      await expect(page.getByRole('menuitem', { name: 'Markdown table' })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Markdown table' }).hover();
      await capture(page, name, 'copy-menu');
    });

    test('cell viewer: JSON', async ({ page }) => {
      await open(page, 'select * from orders');
      await cell(page, 2, 10).dblclick();
      const viewer = page.getByRole('complementary', { name: 'Cell viewer' });
      await expect(viewer).toContainText('payload');
      // The number keeps all its digits (JSON.parse would round it).
      await expect(viewer).toContainText('12345678901234567890.25');
      await expect(viewer.getByRole('radio', { name: 'JSON' })).toBeChecked();
      await capture(page, name, 'viewer-json');
    });

    test('cell viewer: binary', async ({ page }) => {
      await open(page, 'select * from orders');
      await cell(page, 3, 0).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Space');
      const viewer = page.getByRole('complementary', { name: 'Cell viewer' });
      await expect(viewer).toContainText('blob');
      await expect(viewer).toContainText('4 bytes');
      await expect(viewer.getByRole('radio', { name: 'Hex' })).toBeChecked();
      await expect(viewer).toContainText('00000000  00 02 3c cd');
      await capture(page, name, 'viewer-binary');
      // Saved through the backend's `writeValueFile` (the mock disk keeps the hex form).
      await viewer.getByRole('button', { name: 'Save to a file…' }).click();
      await expect(
        page.getByText('Saved to /home/ana/Downloads/blob-4.bin', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() =>
          (
            window as unknown as {
              __yadbeMock: { getFile: (path: string) => string | undefined };
            }
          ).__yadbeMock.getFile('/home/ana/Downloads/blob-4.bin'),
        ),
      ).toBe('00023ccd');
    });

    test('streaming result paused at the row limit', async ({ page }) => {
      await open(page, 'select * from huge', 'paused');
      await expect(page.getByText('Paused at the row limit')).toBeVisible();
      await expect(page.getByText('100,000 rows')).toBeVisible();
      await capture(page, name, 'paused');
    });

    test('wide result scrolled horizontally', async ({ page }) => {
      await open(page, 'select * from big_table');
      const grid = page.getByRole('grid');
      await expect(grid).toHaveAttribute('aria-colcount', '50');
      await grid.evaluate((el) => {
        el.scrollLeft = 2400;
        el.scrollTop = 24 * 50_000;
      });
      await expect(page.getByRole('columnheader', { name: /^col_20\b/ })).toBeVisible();
      await expect(grid.locator('[aria-rowindex="50002"]')).toHaveCount(1);
      await expect(grid.locator('[data-loading]')).toHaveCount(0);
      // Only visible cells exist in the DOM.
      expect(await grid.getByRole('gridcell').count()).toBeLessThan(1500);
      await capture(page, name, 'wide');
    });

    test('columns widen when later rows are longer', async ({ page }) => {
      await open(page, 'select * from long_tail');
      const grid = page.getByRole('grid');
      const label = header(page, 'label');
      const width = async () => (await label.boundingBox())?.width ?? 0;
      // The first rows are short (`row 20`): the column is narrow.
      const before = await width();
      expect(before).toBeLessThan(120);
      await grid.evaluate((el) => {
        el.scrollTop = 24 * 2600;
      });
      // Once the scroll settles, the column fits what loaded: no cut `…` in the new rows.
      await expect.poll(width).toBeGreaterThan(before + 100);
      await expect(grid.locator('[data-loading]')).toHaveCount(0);
      await capture(page, name, 'widened');
      // Never narrower once seen: back at the top the column keeps its width.
      const widened = await width();
      await grid.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(400);
      expect(await width()).toBeGreaterThanOrEqual(widened);
    });
  });
}

test.describe('behaviour', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('copies TSV and the other formats, exactly', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'select * from orders');
    await cell(page, 3, 0).click();
    await cell(page, 5, 2).click({ modifiers: ['Shift'] });
    await page.keyboard.press('Control+C');
    await expect(
      page.getByText('Copied 3 rows as TSV (tab-separated)', { exact: true }),
    ).toBeVisible();
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    expect(await clip()).toBe(
      '9000000003\t\tuser3@example.com\n9000000004\tEun-ji\tuser4@example.com\n9000000005\tFarah\t',
    );
    await page.keyboard.press('Control+Shift+C');
    await expect.poll(clip).toMatch(/^id\tcustomer\temail\n9000000003/);

    await cell(page, 4, 1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy as' }).click();
    await page.getByRole('menuitem', { name: 'JSON' }).click();
    await expect
      .poll(clip)
      .toBe(
        '[\n  {"id": 9000000003, "customer": null, "email": "user3@example.com"},\n' +
          '  {"id": 9000000004, "customer": "Eun-ji", "email": "user4@example.com"},\n' +
          '  {"id": 9000000005, "customer": "Farah", "email": ""}\n]',
      );

    await cell(page, 4, 1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy as' }).click();
    await page.getByRole('menuitem', { name: 'SQL IN (…) list' }).click();
    await expect
      .poll(clip)
      .toBe(
        "(9000000003, NULL, 'user3@example.com', 9000000004, 'Eun-ji', 'user4@example.com', 9000000005, 'Farah', '')",
      );
  });

  test('copying rows not loaded yet and cut values fetches them', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'select * from orders');
    // The notes column, whole: 1 284 rows, some of them cut in the windows.
    await page.getByRole('grid').evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await header(page, 'notes').click();
    await page.keyboard.press('Control+C');
    await expect(
      page.getByText('Copied 1,284 rows as TSV (tab-separated)', { exact: true }),
    ).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const lines = text.split('\n');
    expect(lines).toHaveLength(1284);
    expect(lines[7]?.length).toBeGreaterThan(3000);
    expect(lines[1283]).toBe('  ');
  });

  test('keyboard navigation and ARIA under virtualization', async ({ page }) => {
    await open(page, 'select * from big_table');
    const grid = page.getByRole('grid');
    await cell(page, 0, 0).click();
    await page.keyboard.press('Control+End');
    await expect(grid).toHaveAttribute('aria-activedescendant', /focus$/);
    const focused = grid.locator('[data-focused]');
    await expect(focused).toHaveAttribute('aria-colindex', '50');
    await expect(focused.locator('xpath=..')).toHaveAttribute('aria-rowindex', '100001');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(page.getByText('2 × 2 selected')).toBeVisible();
    await page.keyboard.press('Control+Home');
    await expect(cell(page, 0, 0)).toHaveAttribute('data-focused', '');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+Space');
    await expect(page.getByText('2 × 50 selected')).toBeVisible();
    await page.keyboard.press('Control+Space');
    await expect(page.getByText('100,000 × 1 selected')).toBeVisible();
    await page.keyboard.press('Control+A');
    await expect(page.getByText('100,000 × 50 selected')).toBeVisible();
  });

  test('columns resize, fit and move', async ({ page }) => {
    await open(page, 'select * from orders');
    const email = header(page, 'email');
    const before = (await email.boundingBox())?.width ?? 0;
    const handle = page.getByRole('separator', { name: 'Resize column email' });
    const box = await handle.boundingBox();
    if (!box) throw new Error('no resize handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => (await email.boundingBox())?.width ?? 0)
      .toBeGreaterThan(before + 60);
    await handle.dblclick();
    await expect
      .poll(async () => (await email.boundingBox())?.width ?? 0)
      .toBeLessThan(before + 10);

    // Drag `id` after `email`.
    const id = await header(page, 'id').boundingBox();
    const target = await email.boundingBox();
    if (!id || !target) throw new Error('no header');
    await page.mouse.move(id.x + 10, id.y + id.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width - 5, id.y + id.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('columnheader').first()).toHaveAccessibleName(/^customer/);
    await expect(cell(page, 0, 2)).toHaveText('9000000000');
  });

  test('a streaming result grows and resumes', async ({ page }) => {
    await open(page, 'select * from huge', 'paused');
    const grid = page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '100001');
    await grid.evaluate((el) => {
      el.scrollTop = 10_000;
    });
    const top = await grid.evaluate((el) => el.scrollTop);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('grid-demo-status')).toHaveText('paused', { timeout: 15_000 });
    await expect(page.getByText('200,000 rows')).toBeVisible({ timeout: 15_000 });
    // The rows on screen stay where they were.
    expect(await grid.evaluate((el) => el.scrollTop)).toBe(top);
  });
});
