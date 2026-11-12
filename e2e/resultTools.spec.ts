import { expect, test, type Page } from '@playwright/test';

/**
 * Result comfort (M3-12) in the whole app on the mock backend: aggregates of the selection in
 * the status bar (F-065), the row detail panel (F-068). Captures in both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`result-tools-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });

/** A data cell by 0-based row and display column. */
function cell(page: Page, row: number, col: number) {
  return page
    .getByRole('grid')
    .locator(`[role=row][aria-rowindex="${String(row + 2)}"] [aria-colindex="${String(col + 1)}"]`);
}

/** Runs `select * from orders` in a new query tab and waits for the rows. */
async function openOrders(page: Page) {
  await page.goto('/');
  await sidebarItem(page, 'local postgres').dblclick();
  const editor = page.getByRole('textbox', { name: 'SQL editor' });
  await expect(editor).toBeVisible();
  await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);
  await editor.click();
  await page.keyboard.insertText('select * from orders;');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell(page, 0, 0)).toHaveText('9000000000');
  await expect(page.getByText('1,284 rows').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('the status bar adds up the selected cells exactly', async ({ page }) => {
      await openOrders(page);
      // `total` (decimal) and `quantity` (int) of rows 0 to 2: 0.00 12.97 25.94 and 1 2 3.
      await cell(page, 0, 3).click();
      await cell(page, 2, 4).click({ modifiers: ['Shift'] });
      const figures = page.getByTestId('selection-aggregate');
      await expect(figures).toContainText('Count 6');
      await expect(figures).toContainText('Sum 44.91');
      await expect(figures).toContainText('Avg 7.485');
      await expect(figures).toContainText('Min 0');
      await expect(figures).toContainText('Max 25.94');
      await capture(page, name, 'aggregates');

      // A column of text: only the count; NULLs are not counted.
      await page.getByRole('columnheader', { name: /^customer\b/ }).click();
      await expect(figures).toContainText('Count 1,167');
      await expect(figures).not.toContainText('Sum');

      // A whole column of 1 284 decimals, summed in the backend.
      await page.getByRole('columnheader', { name: /^total\b/ }).click();
      await expect(figures).toContainText('Count 1,284');
      await expect(figures).toContainText('Sum ');
      await expect(figures).toContainText('Max 999');

      // A float in the selection makes the figures approximate.
      await page.getByRole('columnheader', { name: /^ratio\b/ }).click();
      await expect(figures).toContainText('Sum ≈ ');
    });

    test('the row detail shows the focused row, one line per column', async ({ page }) => {
      await openOrders(page);
      await cell(page, 3, 2).click();
      await page.keyboard.press('Control+Shift+d');
      const panel = page.getByRole('complementary', { name: 'Row detail' });
      await expect(panel).toBeVisible();
      await expect(panel.getByText('Row 4 of 1,284')).toBeVisible();
      // `customer` of row 3 is NULL, `email` of row 3 is user3@example.com.
      await expect(panel.locator('[data-column="customer"]')).toContainText('NULL');
      await expect(panel.locator('[data-column="email"]')).toContainText('user3@example.com');
      await expect(panel.locator('[data-column="id"]')).toContainText('9000000003');
      await capture(page, name, 'row-detail');

      await panel.getByRole('button', { name: 'Next row' }).click();
      await expect(panel.getByText('Row 5 of 1,284')).toBeVisible();
      await expect(panel.locator('[data-column="id"]')).toContainText('9000000004');
      // The grid follows: the focused cell is on row 5.
      await expect(cell(page, 4, 2)).toHaveAttribute('aria-selected', 'true');

      // A cut value opens the cell viewer on that column.
      await panel.getByRole('button', { name: 'Previous row' }).click();
      await page.keyboard.press('Control+Shift+d');
      await expect(panel).toBeHidden();
    });

    test('the row detail follows the keyboard in the grid and opens a long value in the cell viewer', async ({
      page,
    }) => {
      await openOrders(page);
      await cell(page, 7, 0).click();
      await cell(page, 7, 0).press('Control+Shift+d');
      const panel = page.getByRole('complementary', { name: 'Row detail' });
      await expect(panel.getByText('Row 8 of 1,284')).toBeVisible();
      await panel
        .locator('[data-column="notes"]')
        .getByRole('button', { name: 'Show the whole value' })
        .click();
      await expect(page.getByRole('complementary', { name: 'Cell viewer' })).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Cell viewer' })).toContainText(
        'Long note 7',
      );
      await page.getByRole('radio', { name: 'Row' }).click();
      await expect(panel).toBeVisible();
    });
  });
}
