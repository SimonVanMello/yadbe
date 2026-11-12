import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * MongoDB on the mock backend (M4-2): the connection form, the explorer with sampled fields and
 * indexes, a collection tab in its grid and documents views; the mongosh editor (M4-3) with its
 * results, messages, an error placed in the text, a read-only refusal and a dangerous
 * operation's confirmation mid-script. Captures in both themes.
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

const editor = (page: Page) => page.getByTestId('script-editor').locator('.cm-content');

async function openScript(page: Page) {
  await connect(page);
  await item(page, MONGO).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New query' }).click();
  await expect(editor(page)).toBeVisible();
}

async function setScript(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
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

    test('the mongosh editor runs a script: documents, messages, the status bar', async ({
      page,
    }) => {
      await openScript(page);
      await setScript(page, "print('hello')\ndb.orders.find({ status: 'shipped' }).limit(5)");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('script-summary')).toContainText('5 documents');
      await expect(page.getByTestId('statusbar-script')).toContainText('5 documents');
      await expect(page.getByRole('radio', { name: 'Messages (1)' })).toBeVisible();
      await capture(page, name, 'script-documents');
      await page.getByRole('radio', { name: 'Grid' }).click();
      await expect(page.getByRole('grid').first()).toBeVisible();
      await capture(page, name, 'script-grid');
      await page.getByRole('radio', { name: 'Messages (1)' }).click();
      await expect(page.getByTestId('script-messages')).toContainText('hello');
      await capture(page, name, 'script-messages');

      // A scalar shows as text; the selection runs alone.
      await setScript(page, 'db.orders.countDocuments()\nthrow new Error("not selected")');
      await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press('ControlOrMeta+Enter');
      await page.getByRole('radio', { name: 'Result' }).click();
      await expect(page.getByTestId('script-text')).toHaveText('1300');
    });

    test('the palette runs the mongosh tab, and the tab comes back after a restart', async ({
      page,
    }) => {
      await openScript(page);
      await setScript(page, 'use catalog\nshow collections');
      await page.keyboard.press('Control+k');
      const palette = page.getByRole('combobox', { name: 'Command palette' });
      await expect(palette).toBeFocused();
      await palette.fill('Run the query');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('script-text')).toContainText('orders');
      // Autosave waits a moment after the last keystroke.
      await page.waitForTimeout(2000);
      await page.reload();
      await expect(editor(page)).toContainText('show collections');
      // A restored tab does not connect by itself.
      await expect(page.getByText(/is not connected: connect to run the script/)).toBeVisible();
    });

    test('a script stops at an error, marked in the editor', async ({ page }) => {
      await openScript(page);
      await setScript(page, "print('before')\nthrow new Error('boom')\nprint('after')");
      await page.keyboard.press('ControlOrMeta+Enter');
      const failure = page.getByTestId('script-failure');
      await expect(failure).toHaveAttribute('data-code', 'scriptError');
      await expect(failure).toContainText('Line 2, column 1');
      await expect(failure).toContainText('Error: boom');
      await expect(page.locator('.cm-error-range')).toHaveText('throw');
      await capture(page, name, 'script-error');
    });

    test('a dangerous operation pauses the script for a confirmation; read-only refuses writes', async ({
      page,
    }) => {
      await openScript(page);
      await setScript(page, 'db.orders.drop()');
      await page.keyboard.press('ControlOrMeta+Enter');
      const confirm = page.getByRole('dialog', { name: 'Run drop?' });
      await expect(confirm).toContainText('1,300 documents');
      await expect(page.getByTestId('script-running')).toBeVisible();
      await capture(page, name, 'script-danger');
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toBeHidden();
      await expect(page.getByTestId('script-failure')).toContainText('drop was not run');

      // Read-only: a write is refused before it is sent; the reads before it ran.
      await setReadOnly(page);
      await setScript(page, "print('read')\ndb.orders.insertOne({ x: 1 })");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('script-failure')).toHaveAttribute(
        'data-code',
        'readOnlyViolation',
      );
      await expect(page.getByTestId('script-failure')).toContainText('Line 2, column 11');
      await capture(page, name, 'script-read-only');
    });
  });
}
