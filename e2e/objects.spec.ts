import { expect, test, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`objects-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });

/** Opens a node by its twisty, whatever the row does on a click. */
async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function connect(page: Page, name: RegExp) {
  await item(page, name).dblclick();
  await expect(item(page, name)).toHaveAccessibleName(/Connected/);
}

const schema = (page: Page, name: string) =>
  tree(page).locator(`[data-type="schema"][aria-label="${name}"]`);

/** PostgreSQL ("local postgres"): the database opens by itself, then shop → Tables. */
async function openShopTables(page: Page) {
  await connect(page, /^local postgres,/);
  await expand(item(page, /^shop$/));
  await expand(item(page, /^Tables \(/));
}

/** `shop · staging` becomes a prod connection that is not read-only. */
async function makeStagingProd(page: Page) {
  await item(page, /^shop · staging,/).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const form = page.getByRole('dialog', { name: 'Edit connection' });
  await form.getByRole('radio', { name: 'prod' }).click();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
}

async function menuOf(page: Page, name: string | RegExp) {
  await item(page, name).click({ button: 'right' });
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(20);
        (window as MockWindow).__yadbeMock?.setLatency(30);
      });
    });

    test('a table opens its definition, read-only, with where it comes from', async ({ page }) => {
      await openShopTables(page);
      await menuOf(page, /^orders$/);
      await page.getByRole('menuitem', { name: 'Show DDL' }).click();

      const tab = page.getByRole('tab', { name: /^orders/ });
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const text = page.getByRole('textbox', { name: 'Definition of orders' });
      await expect(text).toContainText('CREATE TABLE');
      await expect(text).toContainText('"shop"."orders"');
      await expect(page.getByText('Rebuilt by yadbe from the catalog')).toBeVisible();
      await expect(text).toHaveAttribute('aria-readonly', 'true');
      await capture(page, name, 'ddl');

      // The same object again activates the tab already showing it.
      await item(page, /^orders$/).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Show DDL' }).click();
      await expect(page.getByRole('tab', { name: /^orders/ })).toHaveCount(1);

      await page.getByRole('button', { name: 'Open in a query tab' }).click();
      await expect(page.getByRole('tab', { name: /^Query \d+, Unsaved/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toContainText('CREATE TABLE');
    });

    test('properties show what the engine exposes and hide what it does not', async ({ page }) => {
      await openShopTables(page);
      await menuOf(page, /^orders$/);
      await page.getByRole('menuitem', { name: 'Properties' }).click();
      const dialog = page.getByRole('dialog', { name: 'Properties of shop.orders' });
      const facts = dialog.getByTestId('properties-facts');
      await expect(facts).toContainText('Rows (estimate)');
      await expect(facts).toContainText('Owner');
      await expect(facts).toContainText('Total size');
      await expect(facts).toContainText('Last analyzed');
      // PostgreSQL does not tell when a table was created.
      await expect(facts).not.toContainText('Created');
      await expect(dialog.getByTestId('properties-structure')).toContainText('Foreign keys');
      await capture(page, name, 'properties');
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toBeHidden();
    });

    test('dropping shows the statement and what depends on the table, and runs nothing before the button', async ({
      page,
    }) => {
      await openShopTables(page);
      await menuOf(page, /^customers$/);
      await page.getByRole('menuitem', { name: 'Drop…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Drop shop.customers?' });
      await expect(dialog.getByTestId('action-dependents')).toContainText('shop.orders');
      await expect(dialog.getByTestId('action-dependents')).toContainText('foreign key');
      await expect(dialog.getByRole('textbox', { name: 'Statement' })).toContainText(
        'DROP TABLE "shop"."customers"',
      );
      await expect(dialog).not.toContainText('CASCADE;');
      await capture(page, name, 'drop');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(item(page, /^customers$/)).toBeVisible();
    });

    test('a table is truncated and then dropped; the tree follows', async ({ page }) => {
      await openShopTables(page);
      await menuOf(page, /^suppliers$/);
      await page.getByRole('menuitem', { name: 'Truncate…' }).click();
      const truncate = page.getByRole('dialog', { name: 'Truncate shop.suppliers?' });
      await expect(truncate.getByTestId('action-rows')).toContainText('About 41 rows');
      await truncate.getByRole('button', { name: 'Truncate' }).click();
      await expect(truncate).toBeHidden();
      await expect(page.getByText('Truncated: shop.suppliers', { exact: true })).toBeVisible();

      await menuOf(page, /^suppliers$/);
      await page.getByRole('menuitem', { name: 'Drop…' }).click();
      const drop = page.getByRole('dialog', { name: 'Drop shop.suppliers?' });
      await drop.getByRole('button', { name: 'Drop' }).click();
      await expect(drop).toBeHidden();
      await expect(item(page, /^suppliers$/)).toHaveCount(0);
    });

    test('on a production connection the name must be typed', async ({ page }) => {
      await makeStagingProd(page);
      await connect(page, /^shop · staging,/);
      await expand(schema(page, 'shop'));
      await expand(item(page, /^Tables \(/));
      await menuOf(page, /^warehouses$/);
      await page.getByRole('menuitem', { name: 'Drop…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Drop shop.warehouses?' });
      const confirm = dialog.getByRole('button', { name: 'Drop' });
      await expect(dialog.getByTestId('connection-banner')).toContainText('prod');
      await expect(confirm).toBeDisabled();
      await dialog.getByRole('textbox', { name: 'Name to type' }).fill('ware');
      await expect(confirm).toBeDisabled();
      await capture(page, name, 'drop-prod');
      await dialog.getByRole('textbox', { name: 'Name to type' }).fill('warehouses');
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(item(page, /^warehouses$/)).toHaveCount(0);
    });

    test('a read-only connection offers the tools disabled', async ({ page }) => {
      await connect(page, /^shop · prod,/);
      await expand(schema(page, 'shop'));
      await expand(item(page, /^Tables \(/));
      await menuOf(page, /^customers$/);
      await expect(page.getByRole('menuitem', { name: 'Drop…' })).toBeDisabled();
      await expect(page.getByRole('menuitem', { name: /^Truncate…/ })).toBeDisabled();
      await expect(page.getByRole('menuitem', { name: /^Rename…/ })).toBeDisabled();
      await expect(page.getByRole('menuitem', { name: 'Show DDL' })).toBeEnabled();
      await capture(page, name, 'read-only-menu');
      await page.keyboard.press('Escape');
    });

    test('F2 renames in the tree, after a confirmation that shows the statement', async ({
      page,
    }) => {
      await openShopTables(page);
      const row = item(page, /^warehouses$/);
      await row.click();
      await page.keyboard.press('F2');
      const field = tree(page).getByRole('textbox', { name: 'New name of warehouses' });
      await expect(field).toBeFocused();
      await page.keyboard.type('depots');
      await capture(page, name, 'rename-inline');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Rename shop.warehouses?' });
      await expect(dialog.getByRole('textbox', { name: 'Statement' })).toContainText(
        'ALTER TABLE "shop"."warehouses" RENAME TO "depots"',
      );
      await dialog.getByRole('button', { name: 'Rename' }).click();
      await expect(dialog).toBeHidden();
      await expect(item(page, /^depots$/)).toBeVisible();
      await expect(item(page, /^warehouses$/)).toHaveCount(0);
    });

    test('a table tab follows its table when it is renamed and is told when it is dropped', async ({
      page,
    }) => {
      await openShopTables(page);
      await item(page, /^warehouses$/).dblclick();
      await expect(page.getByRole('tab', { name: /^warehouses/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('grid', { name: /^Rows of / })).toBeVisible();

      await menuOf(page, /^warehouses$/);
      await page.getByRole('menuitem', { name: 'Rename…' }).click();
      await page.keyboard.type('depots');
      await page.keyboard.press('Enter');
      await page
        .getByRole('dialog', { name: 'Rename shop.warehouses?' })
        .getByRole('button', { name: 'Rename' })
        .click();
      const renamed = page.getByRole('tab', { name: /^depots/ });
      await expect(renamed).toBeVisible();
      await expect(page.getByRole('tab', { name: /^warehouses/ })).toHaveCount(0);

      await menuOf(page, /^depots$/);
      await page.getByRole('menuitem', { name: 'Drop…' }).click();
      await page
        .getByRole('dialog', { name: 'Drop shop.depots?' })
        .getByRole('button', { name: 'Drop' })
        .click();
      await expect(item(page, /^depots$/)).toHaveCount(0);
      // The tab stays, and says the table is gone instead of showing old rows.
      await renamed.click();
      await expect(page.getByRole('alert').filter({ hasText: /no longer exists/ })).toBeVisible();
      await capture(page, name, 'dropped-tab');
    });

    test('pinned objects sit at the top of their connection and survive a reload', async ({
      page,
    }) => {
      await openShopTables(page);
      await menuOf(page, /^orders$/);
      await page.getByRole('menuitem', { name: 'Pin to the top' }).click();
      await menuOf(page, /^customers$/);
      await page.getByRole('menuitem', { name: 'Pin to the top' }).click();
      const group = item(page, /^Pinned \(2\)/);
      await expect(group).toBeVisible();
      // The group comes before the databases and schemas.
      const labels = await tree(page).getByRole('treeitem').allTextContents();
      const connection = labels.findIndex((text) => text.includes('local postgres'));
      expect(labels[connection + 1]).toContain('Pinned');
      await tree(page).evaluate((element) => {
        element.scrollTop = 0;
      });
      await capture(page, name, 'pinned');

      await page.reload();
      await expect(item(page, /^shop · prod,/)).toBeVisible();
      await connect(page, /^local postgres,/);
      await expect(item(page, /^Pinned \(2\)/)).toBeVisible();

      // A pinned table opens like the one in the tree; unpinning removes it.
      const pinned = tree(page).locator('[data-type="pinned"]').filter({ hasText: 'orders' });
      await pinned.dblclick();
      await expect(page.getByRole('tab', { name: /^orders/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await pinned.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Unpin' }).click();
      await expect(item(page, /^Pinned \(1\)/)).toBeVisible();
    });

    test('the palette pins and unpins an object with Alt+Enter', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type('@orders');
      const option = page.getByRole('option', { name: /shop\.orders/ }).first();
      await expect(option).toBeVisible();
      await page.keyboard.press('Alt+Enter');
      await expect(option.getByRole('img', { name: 'Pinned' })).toBeVisible();
      await capture(page, name, 'palette-pin');
      await page.keyboard.press('Alt+Enter');
      await expect(option.getByRole('img', { name: 'Pinned' })).toHaveCount(0);
    });
  });
}
