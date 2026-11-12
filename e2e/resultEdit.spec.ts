import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Editable query results (M3-7, F-087) on the mock backend: a SELECT of one table holding its
 * key is edited in place (cells, NULL, deletions), previewed as SQL and applied; a result that
 * cannot be edited says why in its footer. Captures in both themes.
 */

interface MockControls {
  setLatency(ms: number): void;
  setQueryTick(ms: number): void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`result-edit-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });
const editorContent = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const results = (page: Page) => page.getByRole('region', { name: 'Results' });
const grid = (page: Page) => results(page).getByRole('grid', { name: 'Result 1' });
const status = (page: Page) => results(page).getByTestId('result-edit-status');
const pending = (page: Page) => results(page).getByTestId('result-pending');

function cell(page: Page, row: number, col: number): Locator {
  return grid(page).locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

async function run(page: Page, sql: string) {
  await editorContent(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(grid(page)).toBeVisible();
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await page.evaluate(() => {
        const mock = (window as MockWindow).__yadbeMock;
        mock?.setLatency(30);
        mock?.setQueryTick(15);
      });
      await sidebarItem(page, 'local postgres').dblclick();
      await expect(editorContent(page)).toBeVisible();
      await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);
    });

    test('a result of one table with its key is edited and applied in place', async ({ page }) => {
      await run(
        page,
        'select id, full_name, email, upper(full_name) as loud from shop.customers limit 50',
      );
      await expect(status(page)).toHaveAttribute('data-editable', 'true');
      await expect(status(page)).toContainText('Editable');
      await expect(status(page)).toContainText('shop.customers');
      const loud = (await cell(page, 0, 3).textContent()) ?? '';

      // A cell, a NULL, a deletion; the computed column says why it cannot be changed.
      await cell(page, 0, 1).dblclick();
      await page.getByRole('textbox', { name: 'Edit full_name, row 1' }).fill('Ada Lovelace');
      await page.keyboard.press('Enter');
      await expect(cell(page, 0, 1)).toHaveText('Ada Lovelace');
      await cell(page, 2, 0).click();
      await page.keyboard.press('ControlOrMeta+Delete');
      await expect(pending(page)).toHaveText('2 pending');
      await cell(page, 1, 3).dblclick();
      await expect(
        page
          .getByRole('region', { name: /^Notifications/ })
          .getByText('loud cannot be changed.', { exact: false }),
      ).toBeVisible();
      await capture(page, name, 'pending');

      // The SQL first, then Apply: one transaction, rows read back in place.
      await results(page).getByRole('button', { name: 'Preview SQL' }).click();
      const preview = page.getByRole('dialog', { name: 'Preview SQL' });
      const sql = preview.getByRole('textbox', { name: 'Statements to apply' });
      await expect(sql).toContainText(`UPDATE "shop"."customers" SET "full_name" = 'Ada Lovelace'`);
      await expect(sql).toContainText(`DELETE FROM "shop"."customers" WHERE "id" = 3`);
      await capture(page, name, 'preview');
      await preview.getByRole('button', { name: /^Apply/ }).click();
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      await expect(pending(page)).toHaveCount(0);
      await expect(cell(page, 0, 1)).toHaveText('Ada Lovelace');
      // The query's own column keeps what it read; the deleted row left the grid.
      await expect(cell(page, 0, 3)).toHaveText(loud);
      await expect(cell(page, 2, 0)).toHaveText('4');
      await capture(page, name, 'applied');
    });

    test('Mod+S in the result grid applies its changes', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.clear();
      });
      await run(page, 'select id, phone from shop.customers limit 10');
      await expect(status(page)).toHaveAttribute('data-editable', 'true');
      await cell(page, 1, 1).click();
      await page.keyboard.press('ControlOrMeta+Backspace');
      await expect(pending(page)).toHaveText('1 pending');
      await cell(page, 1, 0).click();
      await page.keyboard.press('ControlOrMeta+s');
      const preview = page.getByRole('dialog', { name: 'Preview SQL' });
      if (await preview.isVisible()) await preview.getByRole('button', { name: /^Apply/ }).click();
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      await expect(cell(page, 1, 1)).toHaveText('NULL');
    });

    test('a sorted or filtered result waits read-only, its edits go to the rows they were made on', async ({
      page,
    }) => {
      await run(page, 'select id, full_name from shop.customers limit 20');
      await expect(status(page)).toHaveAttribute('data-editable', 'true');
      await cell(page, 0, 1).dblclick();
      await page.getByRole('textbox', { name: 'Edit full_name, row 1' }).fill('First');
      await page.keyboard.press('Enter');
      await expect(pending(page)).toHaveText('1 pending');

      // Sorted: read-only, the change waits.
      const id = results(page).getByRole('columnheader', { name: /^id\b/ });
      await id.click();
      await id.click();
      await expect(id).toHaveAttribute('aria-sort', 'descending');
      await expect(status(page)).toHaveAttribute('data-editable', 'false');
      await expect(status(page)).toContainText('1 pending change waits');
      await expect(status(page)).toHaveAttribute('title', /sorted or filtered/);
      await expect(cell(page, 0, 0)).toHaveText('20');
      await cell(page, 0, 1).dblclick();
      await expect(page.getByRole('textbox', { name: /^Edit / })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await capture(page, name, 'sorted');

      // Back to the stored order: the change is still on its row.
      await id.click();
      await expect(status(page)).toHaveAttribute('data-editable', 'true');
      await expect(pending(page)).toHaveText('1 pending');
      await expect(cell(page, 0, 1)).toHaveText('First');
      await cell(page, 2, 0).click();
      await page.keyboard.press('ControlOrMeta+Delete');
      await expect(pending(page)).toHaveText('2 pending');
      await page.keyboard.press('ControlOrMeta+s');
      const preview = page.getByRole('dialog', { name: 'Preview SQL' });
      if (await preview.isVisible()) await preview.getByRole('button', { name: /^Apply/ }).click();
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      await expect(cell(page, 2, 0)).toHaveText('4');

      // The filter bar keeps the keyboard while the grid turns read-only under it.
      await cell(page, 0, 0).click();
      await page.keyboard.press('Control+Shift+f');
      const bar = page.getByRole('search', { name: 'Filter the rows of the result' });
      const value = bar.getByRole('textbox', { name: 'Value' });
      // Typed a key at a time: the first one already turns the grid read-only.
      await value.pressSequentially('Firs', { delay: 120 });
      await expect(value).toHaveValue('Firs');
      await expect(value).toBeFocused();
      await expect(results(page).getByText('1 of 19 rows')).toBeVisible();
      await expect(cell(page, 0, 0)).toHaveText('1');
      await expect(status(page)).toHaveAttribute('data-editable', 'false');
      await capture(page, name, 'filtered');

      // Sorted after the apply: the deleted row is gone, the changed one shows its new value.
      await bar.getByRole('button', { name: 'Clear sort and filter' }).click();
      await bar.getByRole('button', { name: 'Hide the filter' }).click();
      await id.click();
      await expect(id).toHaveAttribute('aria-sort', 'ascending');
      await expect(results(page).getByText('19 of 19 rows')).toBeVisible();
      await expect(cell(page, 0, 1)).toHaveText('First');
      await expect(cell(page, 1, 0)).toHaveText('2');
      await expect(cell(page, 2, 0)).toHaveText('4');
      await id.click();
      await expect(id).toHaveAttribute('aria-sort', 'descending');
      await expect(cell(page, 0, 0)).toHaveText('20');
      await id.click();
      await expect(status(page)).toHaveAttribute('data-editable', 'true');

      // What the table holds.
      await run(page, 'select id, full_name from shop.customers limit 3');
      await expect(cell(page, 0, 1)).toHaveText('First');
      await expect(cell(page, 2, 0)).toHaveText('4');
    });

    test('a result that cannot be edited says why', async ({ page }) => {
      await run(
        page,
        'select o.id, c.email from shop.orders o join shop.customers c on c.id = o.customer_id',
      );
      await expect(status(page)).toHaveAttribute('data-editable', 'false');
      await expect(status(page)).toContainText('Read-only');
      await expect(status(page)).toContainText('plain SELECT of one table');
      await capture(page, name, 'read-only-join');

      await run(page, 'select full_name, email from shop.customers');
      await expect(status(page)).toContainText("does not hold the table's key (id)");
      await cell(page, 0, 0).dblclick();
      // Read-only: a double-click shows the cell instead of editing it.
      await expect(page.getByRole('textbox', { name: /^Edit / })).toHaveCount(0);
      await capture(page, name, 'read-only-key');
    });
  });
}
