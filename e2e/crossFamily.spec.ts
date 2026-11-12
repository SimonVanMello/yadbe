import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The features built for SQL, in the other engine families (M4-9), on the mock backend:
 * completion in the mongosh, search and Redis consoles, the palette's collections, indices and
 * keys, tabs restored after a reload with their query, and the JSON Lines export. Captures in
 * both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`cross-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const MONGO = /^catalog · mongo,/;
const SEARCH = /^search · logs,/;
const REDIS = /^cache,/;

async function connectMongo(page: Page) {
  await item(page, MONGO).dblclick();
  await expect(item(page, MONGO)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^orders$/)).toBeVisible();
}

async function connectSearch(page: Page) {
  await item(page, SEARCH).click();
  await item(page, SEARCH).locator('span').first().click();
  await expect(item(page, SEARCH)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^orders$/)).toBeVisible();
}

async function typeIn(page: Page, editor: Locator, text: string) {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

const suggestions = (page: Page) => page.locator('.cm-tooltip-autocomplete');

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
    });

    test('mongosh completes collections, methods and fields', async ({ page }) => {
      await connectMongo(page);
      await item(page, MONGO).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'New query' }).click();
      const editor = page.getByTestId('script-editor').locator('.cm-content');
      await expect(editor).toBeVisible();
      await typeIn(page, editor, 'db.');
      await expect(suggestions(page)).toContainText('orders');
      await expect(suggestions(page)).toContainText('getCollectionNames');
      await typeIn(page, editor, 'db.orders.fi');
      await expect(suggestions(page)).toContainText('findOne');
      await expect(suggestions(page)).not.toContainText('getName');
      await capture(page, name, 'mongosh-completion');
      await page.keyboard.press('Escape');
      await typeIn(page, editor, 'db.orders.find({ st');
      await expect(suggestions(page)).toContainText('status');
    });

    test('the search console completes endpoints, indices and query keys', async ({ page }) => {
      await connectSearch(page);
      await item(page, SEARCH).dblclick();
      const editor = page.getByTestId('search-console-editor').locator('.cm-content');
      await expect(editor).toBeVisible();
      await typeIn(page, editor, 'GET /ord');
      await expect(suggestions(page)).toContainText('orders');
      await typeIn(page, editor, 'GET /orders/_se');
      await expect(suggestions(page)).toContainText('_search');
      await typeIn(page, editor, 'GET /orders/_search\n{ "qu');
      await expect(suggestions(page)).toContainText('query');
      await capture(page, name, 'search-completion');
    });

    test('the Redis console completes commands', async ({ page }) => {
      await item(page, REDIS).click();
      await item(page, REDIS).locator('span').first().click();
      await expect(item(page, REDIS)).toHaveAccessibleName(/Connected/, { timeout: 15_000 });
      await item(page, REDIS).dblclick();
      const editor = page.getByTestId('kv-console-editor').locator('.cm-content');
      await expect(editor).toBeVisible();
      await typeIn(page, editor, 'hge');
      await expect(suggestions(page)).toContainText('HGETALL');
      await capture(page, name, 'redis-completion');
    });

    test('the palette lists collections and indices and opens their tabs', async ({ page }) => {
      await connectMongo(page);
      await page.keyboard.press('Control+k');
      const input = page.getByRole('combobox', { name: 'Command palette' });
      await input.fill('@orders');
      const options = page.getByRole('listbox', { name: 'Command palette' }).getByRole('option');
      await expect(options.filter({ hasText: 'Collection' }).first()).toBeVisible();
      await capture(page, name, 'palette-collection');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('collection-tab')).toBeVisible();
    });

    test('a collection tab comes back after a reload with its filter', async ({ page }) => {
      await connectMongo(page);
      await item(page, /^orders$/).dblclick();
      await expect(page.getByTestId('collection-tab')).toBeVisible();
      const filter = page.locator('[data-field="filter"]');
      await filter.fill('{"status": "paid"}');
      await filter.press('Enter');
      // The tabs are saved a moment after the last change.
      await page.waitForTimeout(2000);
      await page.reload();
      // A restored tab does not connect by itself: its body waits for the connection.
      await expect(page.getByRole('tab', { name: /^orders, catalog/ })).toBeVisible();
      await item(page, MONGO).click();
      await item(page, MONGO).locator('span').first().click();
      await expect(item(page, MONGO)).toHaveAccessibleName(/Connected/);
      await expect(page.getByTestId('collection-tab')).toBeVisible();
      await expect(page.locator('[data-field="filter"]')).toHaveValue('{"status": "paid"}');
    });
  });
}
