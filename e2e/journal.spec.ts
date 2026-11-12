import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Optimistic concurrency and the change journal (M3-6) on the mock backend: a row changed by
 * someone else is a conflict resolved per row (F-089); applied change sets are listed in the
 * Journal view and reverted after a preview (F-090). Captures in both themes.
 */

type Table = { database: string; schema: string | null; name: string };
interface MockControls {
  changeRowElsewhere: (
    connectionId: string,
    table: Table,
    key: unknown[],
    column: string,
    value: unknown,
  ) => boolean;
  deleteRowElsewhere: (connectionId: string, table: Table, key: unknown[]) => boolean;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

const CUSTOMERS: Table = { database: 'app_dev', schema: 'shop', name: 'customers' };

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`journal-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const grid = (page: Page) => page.getByRole('grid', { name: /^Rows of / });
const pending = (page: Page) => page.getByTestId('toolbar-pending');
const entries = (journal: Locator) =>
  journal.getByRole('listbox', { name: 'Applied change sets' }).getByRole('option');

function cell(page: Page, row: number, col: number): Locator {
  return grid(page).locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function openCustomers(page: Page) {
  await item(page, /^local postgres,/).dblclick();
  await expect(item(page, /^local postgres,/)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^public$/).first()).toBeVisible();
  await expand(item(page, /^shop$/).last());
  await expand(item(page, /^Tables \(/).last());
  await item(page, /^customers$/).dblclick();
  await expect(grid(page)).toBeVisible();
  await expect(cell(page, 0, 0)).not.toHaveText('');
}

/** Types a value into a cell (phone is column 3). */
async function edit(page: Page, row: number, col: number, column: string, value: string) {
  await cell(page, row, col).dblclick();
  await page.getByRole('textbox', { name: `Edit ${column}, row ${String(row + 1)}` }).fill(value);
  await page.keyboard.press('Enter');
}

/** Ctrl+S, then Apply in the SQL preview. */
async function apply(page: Page) {
  await page.keyboard.press('ControlOrMeta+s');
  await page
    .getByRole('dialog', { name: 'Preview SQL' })
    .getByRole('button', { name: /^Apply/ })
    .click();
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
    });

    test('rows changed by someone else are conflicts, resolved row by row', async ({ page }) => {
      await openCustomers(page);
      await edit(page, 0, 3, 'phone', '+33 1 11 11 11 11');
      await edit(page, 1, 3, 'phone', '+33 2 22 22 22 22');
      await page.evaluate((table) => {
        const mock = (window as MockWindow).__yadbeMock;
        mock?.changeRowElsewhere('conn-local-pg', table, [{ kind: 'int', value: '1' }], 'phone', {
          kind: 'text',
          value: '+1 555 0100',
        });
        mock?.deleteRowElsewhere('conn-local-pg', table, [{ kind: 'int', value: '2' }]);
      }, CUSTOMERS);
      await apply(page);

      const conflict = page.getByRole('dialog', { name: '2 rows were changed by someone else' });
      await expect(conflict).toBeVisible();
      const changed = conflict.getByRole('region', { name: 'id = 1' });
      await expect(changed).toContainText('changed since you read it');
      await expect(changed.getByRole('row', { name: /^phone/ })).toContainText('+1 555 0100');
      await expect(changed.getByRole('row', { name: /^phone/ })).toContainText('+33 1 11 11 11 11');
      await expect(conflict.getByRole('region', { name: 'id = 2' })).toContainText(
        'deleted by someone else',
      );
      await expect(pending(page)).toHaveText('2 pending');
      await capture(page, name, 'conflict');

      // Keep mine on row 1 (row 2 is gone): the change applies over theirs, after a preview.
      await changed.getByRole('radio', { name: 'Keep mine' }).click();
      await conflict.getByRole('button', { name: 'Resolve and apply' }).click();
      const preview = page.getByRole('dialog', { name: 'Preview SQL' });
      await expect(preview.getByRole('textbox', { name: 'Statements to apply' })).toContainText(
        `"phone" = '+1 555 0100'`,
      );
      await preview.getByRole('button', { name: /^Apply/ }).click();
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      await expect(cell(page, 0, 3)).toHaveText('+33 1 11 11 11 11');
      await expect(pending(page)).toHaveText('No changes');
    });

    test('applied change sets are journaled and reverted after a preview', async ({ page }) => {
      await openCustomers(page);
      const before = (await cell(page, 2, 3).textContent()) ?? '';
      await edit(page, 2, 3, 'phone', '+33 3 33 33 33 33');
      await apply(page);
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      // The toast leads to the change set in the Journal view.
      await page.getByRole('button', { name: 'Journal', exact: true }).first().click();
      const journal = page.getByRole('region', { name: 'Change journal' });
      await expect(journal).toBeVisible();
      const entry = entries(journal).first();
      await expect(entry).toContainText('shop.customers');
      await expect(entry).toContainText('1 updated');
      await expect(entry).toHaveAttribute('aria-selected', 'true');
      const detail = journal.getByRole('complementary', { name: 'Change set' });
      await expect(detail.getByTestId('journal-statements')).toContainText(
        `UPDATE "shop"."customers" SET "phone" = '+33 3 33 33 33 33' WHERE "id" = 3 AND "phone"`,
      );
      await expect(detail.getByTestId('journal-inverse')).toContainText(`"phone" = '${before}'`);
      await capture(page, name, 'journal');

      await detail.getByRole('button', { name: 'Revert this change set…' }).click();
      const revert = page.getByRole('dialog', { name: /^Revert change set #/ });
      await expect(revert.getByRole('textbox', { name: 'Statements of the revert' })).toContainText(
        `SET "phone" = '${before}' WHERE "id" = 3 AND "phone" = '+33 3 33 33 33 33'`,
      );
      await capture(page, name, 'revert');
      await revert.getByRole('button', { name: /^Revert \(1\)/ }).click();
      await expect(revert).toBeHidden();
      await expect(page.getByText('Change set reverted', { exact: true })).toBeVisible();
      await expect(cell(page, 2, 3)).toHaveText(before);
      await expect(entries(journal).first()).toContainText('revert of #');
      await expect(entries(journal).nth(1)).toContainText('reverted');

      // Searched and filtered by table.
      await journal.getByRole('textbox', { name: 'Search the change journal' }).fill('33 3 33');
      await expect(entries(journal)).toHaveCount(2);
      await journal.getByRole('textbox', { name: 'Search the change journal' }).fill('nothing');
      await expect(journal.getByText('No change set matches these filters.')).toBeVisible();
      await journal.getByRole('button', { name: 'Clear the filters' }).click();
      await expect(entries(journal)).toHaveCount(2);
      await capture(page, name, 'journal-reverted');
    });

    test('a revert of a row changed since is stopped, theirs kept', async ({ page }) => {
      await openCustomers(page);
      await edit(page, 4, 3, 'phone', '+33 5 55 55 55 55');
      await apply(page);
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      await page.evaluate(
        (table) =>
          (window as MockWindow).__yadbeMock?.changeRowElsewhere(
            'conn-local-pg',
            table,
            [{ kind: 'int', value: '5' }],
            'phone',
            { kind: 'text', value: '+1 555 0199' },
          ),
        CUSTOMERS,
      );
      await page.getByRole('tab', { name: 'Journal' }).click();
      const journal = page.getByRole('region', { name: 'Change journal' });
      await entries(journal).first().click();
      await journal.getByRole('button', { name: 'Revert this change set…' }).click();
      const revert = page.getByRole('dialog', { name: /^Revert change set #/ });
      await revert.getByRole('button', { name: /^Revert \(1\)/ }).click();
      await expect(revert.getByRole('alert')).toContainText('1 row changed since this change set');
      await expect(revert.getByRole('alert')).toContainText('id = 5 was changed since');
      await capture(page, name, 'revert-conflict');
      await revert.getByRole('button', { name: 'Close' }).click();
      await expect(revert).toBeHidden();
    });
  });
}
