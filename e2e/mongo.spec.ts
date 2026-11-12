import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * MongoDB on the mock backend (M4-2): the connection form, the explorer with sampled fields and
 * indexes, a collection tab in its grid and documents views, the JSON console with a read-only
 * refusal and a dangerous command's confirmation. Captures in both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`mongo-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const MONGO = /^catalog · mongo,/;

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function connect(page: Page) {
  await item(page, MONGO).dblclick();
  await expect(item(page, MONGO)).toHaveAccessibleName(/Connected/);
}

async function openOrders(page: Page) {
  await connect(page);
  // The connection's database opens by itself.
  await expect(item(page, /^orders$/)).toBeVisible();
  await item(page, /^orders$/).dblclick();
  await expect(page.getByTestId('collection-tab')).toBeVisible();
  await expect(page.getByTestId('collection-range')).toHaveText('1–100');
}

async function setReadOnly(page: Page) {
  await item(page, MONGO).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const form = page.getByRole('dialog', { name: 'Edit connection' });
  await form.getByRole('switch', { name: /Read-only/ }).click();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, MONGO)).toBeVisible();
    });

    test('the connection form has the MongoDB fields and fills itself from a URI', async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'New connection' }).first().click();
      const form = page.getByRole('dialog', { name: 'New connection' });
      await form.getByRole('radio', { name: 'MongoDB' }).click();
      await expect(form.getByText('Replica set', { exact: true })).toBeVisible();
      const hosts = form.locator('[data-field="host"]');
      await hosts.focus();
      await page.evaluate(() => {
        const input = document.activeElement as HTMLInputElement;
        const data = new DataTransfer();
        data.setData(
          'text',
          'mongodb://app:s3cret@db1:27017,db2:27017/shop?replicaSet=rs0&authSource=admin',
        );
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
      });
      await expect(hosts).toHaveValue('db1:27017,db2:27017');
      await expect(form.locator('[data-field="replicaSet"]')).toHaveValue('rs0');
      // The password stays in the backend: the field only says one came with the string.
      await expect(form.locator('[data-field="password"]')).toHaveValue('');
      await capture(page, name, 'form');
      // Through an SSH tunnel only one host can be reached: the form says so.
      await form.getByRole('button', { name: /^SSH tunnel/ }).click();
      await form.getByRole('switch', { name: 'Connect through an SSH tunnel' }).click();
      await form.getByTestId('mongo-tunnel-note').scrollIntoViewIfNeeded();
      await expect(form.getByTestId('mongo-tunnel-note')).toContainText('one host');
      await capture(page, name, 'form-tunnel');
    });

    test('the explorer lists databases, collections, sampled fields and indexes', async ({
      page,
    }) => {
      await connect(page);
      await expect(item(page, /^orders$/)).toBeVisible();
      await expect(item(page, /^topRated$/)).toBeVisible();
      await expand(item(page, /^orders$/));
      await expand(item(page, /^Fields$/).first());
      await expect(item(page, /^customer\.address\.city$/)).toBeVisible();
      await expand(item(page, /^Indexes$/).first());
      await expect(item(page, /^status_1_placedAt_-1$/)).toBeVisible();
      await capture(page, name, 'explorer');
    });

    test('a collection tab pages its documents in a grid and as documents', async ({ page }) => {
      await openOrders(page);
      const grid = page.getByRole('grid', { name: /^Documents of catalog\.orders/ });
      await expect(grid).toBeVisible();
      await expect(page.getByTestId('collection-count')).toHaveText('≈ 1,300 documents');
      await capture(page, name, 'collection-grid');
      // A field some documents lack reads "missing", not NULL.
      await page.locator('[data-field="projection"]').fill('{ "notes": 1 }');
      await page.locator('[data-field="projection"]').press('Enter');
      await expect(grid.getByRole('columnheader')).toHaveCount(2);
      await expect(grid.getByText('missing').first()).toBeVisible();
      await capture(page, name, 'collection-missing');
      await page.locator('[data-field="projection"]').fill('');

      await page.locator('[data-field="filter"]').fill('{ "status": "paid" }');
      await page.locator('[data-field="filter"]').press('Enter');
      await expect(page.getByTestId('collection-range')).toHaveText('1–100');
      await page.getByRole('button', { name: 'Count', exact: true }).click();
      await expect(page.getByTestId('collection-count')).toHaveText(/documents match/);
      await page.getByRole('button', { name: 'Next page' }).click();
      await expect(page.getByTestId('collection-range')).toHaveText('101–200');

      await page.getByRole('radio', { name: 'Documents' }).click();
      const documents = page.getByRole('tree', { name: /^Documents of catalog\.orders/ });
      await expect(documents.getByRole('treeitem', { name: /Document 1\b/ }).first()).toBeVisible();
      await documents.getByRole('treeitem').filter({ hasText: 'customer' }).first().click();
      await expect(documents.getByText('address').first()).toBeVisible();
      await capture(page, name, 'collection-documents');
    });

    test('the console runs a JSON command, refuses writes when read-only, confirms drops', async ({
      page,
    }) => {
      await connect(page);
      await item(page, MONGO).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'New query' }).click();
      const command = page.getByTestId('console-command');
      await expect(command).toBeVisible();
      await command.fill('{ "find": "orders", "filter": { "status": "shipped" }, "limit": 5 }');
      await command.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('console-summary')).toContainText('5 documents');
      await capture(page, name, 'console');

      // A dangerous command waits for a confirmation that says what it would do.
      await command.fill('{ "drop": "orders" }');
      await command.press('ControlOrMeta+Enter');
      const confirm = page.getByRole('dialog', { name: 'Run drop?' });
      await expect(confirm).toContainText('1,300 documents');
      await capture(page, name, 'console-danger');
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toBeHidden();

      // Read-only: a write is refused before it is sent.
      await setReadOnly(page);
      await command.fill('{ "insert": "orders", "documents": [{ "x": 1 }] }');
      await command.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('console-error')).toHaveAttribute(
        'data-code',
        'readOnlyViolation',
      );
      await capture(page, name, 'console-read-only');
    });
  });
}
