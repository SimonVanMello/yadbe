import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Foreign key navigation (M3-2, F-088) on the mock backend: the button of a foreign key cell,
 * the peek of the referenced row, the jump and its filter chip, back and forward, the rows
 * referencing a row, and the foreign key cell editor with its lookup (composite key
 * included). Captures in both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`fk-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const grid = (page: Page) => page.getByRole('grid', { name: /^Rows of / });
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name: new RegExp(`^${name}\\b`) });
const chips = (page: Page) => page.getByRole('search', { name: 'Filter' });

/** A data cell by 0-based row and display column. */
function cell(page: Page, row: number, col: number): Locator {
  return grid(page).locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

async function col(page: Page, name: string): Promise<number> {
  return Number(await header(page, name).getAttribute('aria-colindex')) - 1;
}

async function focusCell(page: Page, row: number, column: number) {
  await grid(page).focus();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < row; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < column; i++) await page.keyboard.press('ArrowRight');
  await expect(cell(page, row, column)).toHaveAttribute('data-focused', '');
}

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function openTable(page: Page, schema: string, table: string) {
  await item(page, /^local postgres,/).dblclick();
  await expect(item(page, /^local postgres,/)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^public$/).first()).toBeVisible();
  await expand(item(page, new RegExp(`^${schema}$`)).last());
  await expand(item(page, /^Tables \(/).last());
  await item(page, new RegExp(`^${table}$`)).dblclick();
  await expect(grid(page)).toBeVisible();
  await expect(cell(page, 0, 0)).not.toHaveText('');
}

const activeTab = (page: Page) =>
  page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab', { selected: true });

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
    });

    test('a foreign key cell peeks at its row, jumps to it, and the trail goes back', async ({
      page,
    }) => {
      await openTable(page, 'shop', 'orders');
      await expect(header(page, 'customer_id')).toHaveAttribute('title', /Foreign key/);
      const customer = await col(page, 'customer_id');
      await focusCell(page, 2, customer);
      const id = (await cell(page, 2, customer).textContent()) ?? '';
      expect(id).toMatch(/^\d+$/);
      const button = page.getByTestId('fk-cell-button').first();
      await expect(button).toBeVisible();
      await button.click();
      const peek = page.getByRole('dialog', { name: 'Referenced row of shop.customers' });
      await expect(peek).toBeVisible();
      await expect(peek).toContainText(`id = ${id}`);
      await expect(peek.getByText('full_name')).toBeVisible();
      await capture(page, name, 'peek');

      await peek.getByRole('button', { name: 'Open in table' }).click();
      await expect(activeTab(page)).toContainText('customers');
      await expect(chips(page)).toContainText(`id = ${id}`);
      await expect(page.getByTestId('table-range')).toHaveText('Rows 1–1');
      await expect(cell(page, 0, 0)).toHaveText(id);
      await expect(cell(page, 0, 0)).toHaveAttribute('data-focused', '');
      await expect(page.getByTestId('fk-nav')).toBeVisible();
      await capture(page, name, 'jump');

      // Alt+← returns to the order, on the row it left.
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(activeTab(page)).toContainText('orders');
      await expect(cell(page, 2, customer)).toHaveAttribute('data-focused', '');
      await page.keyboard.press('Alt+ArrowRight');
      await expect(activeTab(page)).toContainText('customers');

      // F12 and Mod+click jump directly; the filter chip can be removed like any other.
      await chips(page)
        .getByRole('button', { name: /^Remove the filter/ })
        .click();
      await expect(page.getByTestId('table-range')).toHaveText('Rows 1–500');
    });

    test('lists the rows referencing a row with bounded counts and opens them', async ({
      page,
    }) => {
      await openTable(page, 'shop', 'customers');
      await focusCell(page, 0, 0);
      await page.keyboard.press('Shift+F12');
      const panel = page.getByTestId('fk-referencing');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: /^shop\.orders/ })).toContainText(/\d+ rows?/);
      await expect(panel.getByRole('button', { name: /^shop\.addresses/ })).toContainText(
        /\d+ rows?/,
      );
      await capture(page, name, 'referencing');
      await panel.getByRole('button', { name: /^shop\.orders/ }).click();
      await expect(activeTab(page)).toContainText('orders');
      await expect(chips(page)).toContainText('customer_id = 1');
    });

    test('a foreign key cell edits through a lookup of the referenced table', async ({ page }) => {
      await openTable(page, 'shop', 'orders');
      const customer = await col(page, 'customer_id');
      await focusCell(page, 0, customer);
      await page.keyboard.press('Enter');
      const lookup = page.getByRole('listbox', { name: 'Choose a row of shop.customers' });
      await expect(lookup.getByRole('option').first()).toBeVisible();
      await expect(lookup.getByRole('option').first()).toContainText(/^1/);
      await capture(page, name, 'lookup');

      await page.keyboard.type('chloé');
      await expect(lookup.getByRole('option').first()).toContainText('Chloé');
      const chosen = (await lookup.getByRole('option').first().textContent()) ?? '';
      await page.keyboard.press('ArrowDown');
      await expect(lookup.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(lookup).toBeHidden();
      await expect(cell(page, 0, customer)).toHaveText(chosen.split(/\D/)[0] ?? '');
      await expect(page.getByTestId('table-pending')).toHaveText('1 pending');
    });

    test('a composite foreign key fills all its columns from one choice', async ({ page }) => {
      await openTable(page, 'sales', 'refunds');
      await expect(header(page, 'line_no')).toHaveAttribute('title', /Foreign key/);
      const line = await col(page, 'line_no');
      const invoice = await col(page, 'invoice_id');
      const before = [
        await cell(page, 1, invoice).textContent(),
        await cell(page, 1, line).textContent(),
      ];
      // Invoice lines are listed by key, four lines an invoice: option n is invoice
      // ⌊n / 4⌋ + 1, line n mod 4 + 1. Pick one that changes both columns.
      const pick = [9, 10, 13, 14].find(
        (n) => before[0] !== String(Math.floor(n / 4) + 1) && before[1] !== String((n % 4) + 1),
      );
      if (pick === undefined) throw new Error('no option to pick');
      await focusCell(page, 1, line);
      await page.keyboard.press('Enter');
      const lookup = page.getByRole('listbox', { name: 'Choose a row of sales.invoice_lines' });
      await expect(lookup.getByRole('option').nth(5)).toBeVisible();
      await expect(page.getByTestId('fk-lookup')).toContainText('Fills invoice_id, line_no');
      await capture(page, name, 'composite');
      await lookup.getByRole('option').nth(pick).click();
      await expect(lookup).toBeHidden();
      await expect(cell(page, 1, invoice)).toHaveText(String(Math.floor(pick / 4) + 1));
      await expect(cell(page, 1, line)).toHaveText(String((pick % 4) + 1));
      await expect(page.getByTestId('table-pending')).toHaveText('1 pending');
    });
  });
}
