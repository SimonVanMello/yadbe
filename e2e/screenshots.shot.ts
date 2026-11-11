import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * README screenshots (`pnpm screenshots`): the mocked backend, a fixed 1440×900 viewport at
 * twice the pixel density, both themes, written to `docs/assets/<name>-<theme>.png`. Not part of
 * `pnpm test:ui` (`.shot.ts`, see playwright.screenshots.config.ts).
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function shoot(page: Page, theme: string, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/assets/${name}-${theme}.png`, animations: 'disabled' });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const grid = (page: Page) => page.getByRole('grid', { name: /^Rows of / });

function cell(page: Page, row: number, col: number): Locator {
  return grid(page).locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

async function connect(page: Page, name: RegExp) {
  await item(page, name).dblclick();
  await expect(item(page, name)).toHaveAccessibleName(/Connected/);
}

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Opens `shop.<table>` of a connected PostgreSQL connection in the explorer. */
async function revealTables(page: Page) {
  await expect(item(page, /^public$/).first()).toBeVisible();
  await expand(item(page, /^shop$/).last());
  await expand(item(page, /^Tables \(/).last());
}

async function openTable(page: Page, table: string) {
  await revealTables(page);
  await item(page, new RegExp(`^${table}$`)).dblclick();
  await expect(grid(page)).toBeVisible();
  await expect(cell(page, 0, 0)).not.toHaveText('');
}

async function setScript(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

const SCRIPT = `-- Latest orders and who placed them
select o.id, o.status, o.subtotal, o.total, c.email
from shop.orders o
join shop.customers c on c.id = o.customer_id
where o.status <> 'cancelled'
order by o.id
limit 200;`;

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({
      colorScheme,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
    });

    test('welcome and connections', async ({ page }) => {
      await shoot(page, name, 'welcome');
    });

    test('editor with results', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await expect(editor(page)).toBeVisible();
      await setScript(page, SCRIPT);
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('run-status')).toContainText(/rows/);
      await shoot(page, name, 'editor-results');
    });

    test('explorer', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await revealTables(page);
      await item(page, /^orders$/).click();
      await shoot(page, name, 'explorer');
    });

    test('table editing with pending changes', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await openTable(page, 'orders');
      const where = page.getByRole('textbox', { name: /WHERE condition/ });
      await where.fill('id <= 14');
      await where.press('Enter');
      await expect(page.getByTestId('table-range')).toHaveText('Rows 1–14');
      const note = Number(
        await grid(page)
          .getByRole('columnheader', { name: /^note\b/ })
          .getAttribute('aria-colindex'),
      );
      await cell(page, 0, note - 1).dblclick();
      await page.getByRole('textbox', { name: 'Edit note, row 1' }).fill('checked by hand');
      await page.keyboard.press('Enter');
      await cell(page, 3, 1).click();
      await page.keyboard.press('ControlOrMeta+Delete');
      await page.keyboard.press('ControlOrMeta+i');
      await expect(page.getByTestId('toolbar-pending')).toHaveText('3 pending');
      await shoot(page, name, 'table-pending');
    });

    test('preview SQL on a production connection', async ({ page }) => {
      // `shop · staging` becomes a production connection that is not read-only.
      await item(page, /^shop · staging,/).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const form = page.getByRole('dialog', { name: 'Edit connection' });
      await form.getByRole('radio', { name: 'prod' }).click();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      await connect(page, /^shop · staging,/);
      await openTable(page, 'orders');
      const note = Number(
        await grid(page)
          .getByRole('columnheader', { name: /^note\b/ })
          .getAttribute('aria-colindex'),
      );
      await cell(page, 0, note - 1).dblclick();
      await page.getByRole('textbox', { name: 'Edit note, row 1' }).fill('verified');
      await page.keyboard.press('Enter');
      await page.keyboard.press('ControlOrMeta+s');
      const preview = page.getByRole('dialog', { name: 'Preview SQL' });
      await expect(preview).toContainText('Production connection');
      await shoot(page, name, 'preview-sql');
    });

    test('command palette', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.insertText('orders');
      await expect(page.getByRole('option').first()).toContainText('orders');
      await shoot(page, name, 'palette');
    });

    test('preferences', async ({ page }) => {
      await page.keyboard.press('Control+,');
      await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
      await shoot(page, name, 'preferences');
    });
  });
}
