import { expect, test, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setMetaCatalog: (kind: 'shop' | 'large') => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`palette-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const input = (page: Page) => page.getByRole('combobox', { name: 'Command palette' });
const options = (page: Page) =>
  page.getByRole('listbox', { name: 'Command palette' }).getByRole('option');
const option = (page: Page, name: string | RegExp) => options(page).filter({ hasText: name });
const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const treeItem = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  await expect(input(page)).toBeFocused();
}

async function connectLocalPostgres(page: Page) {
  await treeItem(page, /^local postgres,/).dblclick();
  await expect(treeItem(page, /^local postgres,/)).toHaveAccessibleName(/Connected/);
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        // Opened often before: the empty palette lists these first.
        if (!localStorage.getItem('yadbe.palette.recents')) {
          localStorage.setItem(
            'yadbe.palette.recents',
            JSON.stringify([
              'action:view.history',
              'connection:conn-local-pg',
              'action:connection.new',
            ]),
          );
        }
      });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(treeItem(page, /^local postgres,/)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setLatency(0);
        (window as MockWindow).__yadbeMock?.setMetaLatency(0);
      });
    });

    test('empty palette: recent items first, then the actions, with the mode hints', async ({
      page,
    }) => {
      await openPalette(page);
      await expect(options(page).first()).toContainText('Show the history');
      await expect(options(page).nth(1)).toContainText('local postgres');
      await expect(options(page).nth(2)).toContainText('New connection');
      await expect(page.getByRole('button', { name: 'Objects' })).toBeVisible();
      await capture(page, name, 'empty');
      // The shortcut toggles the palette, and Esc closes it.
      await page.keyboard.press('Control+k');
      await expect(input(page)).toBeHidden();
      await page.keyboard.press('Control+p');
      await expect(input(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(input(page)).toBeHidden();
    });

    test('actions: shortcuts shown, unavailable ones say why, Enter runs one', async ({ page }) => {
      await page.getByRole('button', { name: 'Search commands, objects and tabs' }).click();
      await page.keyboard.type('>');
      await expect(option(page, 'New tab')).toContainText('Ctrl');
      // An action that needs a query tab says so (the list shows only its first rows).
      await expect(option(page, 'Run the query')).toContainText('Needs a query tab');
      await expect(option(page, 'Run the query')).toHaveAttribute('aria-disabled', 'true');
      await capture(page, name, 'actions');
      await page.keyboard.type('toggle sidebar');
      await expect(options(page).first()).toContainText('Toggle the sidebar');
      await capture(page, name, 'actions-filtered');
      await page.keyboard.press('Enter');
      await expect(input(page)).toBeHidden();
      await expect(tree(page)).toBeHidden();
      // The same action again brings it back, from the keyboard alone.
      await page.keyboard.press('Control+Shift+p');
      await expect(input(page)).toHaveValue('>');
      await page.keyboard.type('sidebar');
      await page.keyboard.press('Enter');
      await expect(tree(page)).toBeVisible();
    });

    test('objects: fuzzy search with highlights, reveal in the explorer, Script as SELECT', async ({
      page,
    }) => {
      await connectLocalPostgres(page);
      await openPalette(page);
      await page.keyboard.type('ord');
      await expect(options(page).first()).toBeVisible();
      await expect(option(page, 'shop.orders').first()).toBeVisible();
      await expect(options(page).first().locator('mark').first()).toBeVisible();
      await capture(page, name, 'objects');

      // A schema-qualified query narrows to that schema.
      await page.keyboard.press('Control+a');
      await page.keyboard.type('@sho.ord');
      await expect(option(page, 'shop.orders')).toHaveCount(1);
      await expect(option(page, 'sales.')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(input(page)).toBeHidden();
      // The tree opened down to the table and focused it.
      const row = treeItem(page, /^orders$/);
      await expect(row).toBeVisible();
      await expect(tree(page)).toBeFocused();
      await expect(tree(page)).toHaveAttribute(
        'aria-activedescendant',
        (await row.getAttribute('id')) ?? '',
      );
      await capture(page, name, 'revealed');

      // ⌘↵: the table as a SELECT in a new tab.
      await openPalette(page);
      await page.keyboard.type('@shop.orders');
      await expect(options(page).first()).toContainText('shop.orders');
      await expect(page.getByText('Script as SELECT')).toBeVisible();
      await page.keyboard.press('Control+Enter');
      await expect(input(page)).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toContainText('SELECT');
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toContainText('orders');
    });

    test('tabs and connections: switch to a tab, open a connection', async ({ page }) => {
      await connectLocalPostgres(page);
      await treeItem(page, /^local postgres,/).dblclick();
      const tabs = page.getByRole('tablist', { name: 'Tabs' });
      await expect(tabs.getByRole('tab')).toHaveCount(2);
      await tabs.getByRole('tab').first().click();
      await openPalette(page);
      await page.keyboard.type('#');
      await expect(options(page)).toHaveCount(2);
      await expect(options(page).first()).toContainText('Query 1');
      await capture(page, name, 'tabs');
      await options(page).nth(1).click();
      await expect(input(page)).toBeHidden();
      await expect(tabs.getByRole('tab', { selected: true })).toHaveAccessibleName(/Query 2/);

      await openPalette(page);
      await page.keyboard.type(':wordpress');
      await expect(options(page)).toHaveCount(1);
      await page.keyboard.press('Enter');
      await expect(tabs.getByRole('tab', { name: /wordpress/ })).toBeVisible();
    });

    test('history: statements found by words, opened in a new tab', async ({ page }) => {
      await openPalette(page);
      await page.keyboard.type('!');
      await expect(options(page).first()).toBeVisible();
      await capture(page, name, 'history-all');
      await page.keyboard.type('select');
      // The search runs once the typing pauses: wait for the statement that does not match to go.
      await expect(option(page, 'DELETE FROM orders')).toHaveCount(0);
      await expect(options(page).first()).toContainText(/select/i);
      await capture(page, name, 'history');
      await page.keyboard.press('Enter');
      await expect(input(page)).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toContainText(/select/i);
    });

    test('10 000 objects: searched without waiting', async ({ page }) => {
      test.setTimeout(60_000);
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaCatalog('large');
      });
      await connectLocalPostgres(page);
      await openPalette(page);
      await page.keyboard.type('@');
      await expect(page.getByText(/^1\d,\d{3} results$|^\d{4,5} results$|results$/)).toBeVisible();
      await expect(page.getByText(/\d+ results/)).toContainText(/10,\d{3}/);
      await page.keyboard.type('table_0345');
      await expect(options(page).first()).toContainText('table_0345');
      await expect(options(page).first().locator('mark').first()).toBeVisible();
      await capture(page, name, 'large');
      // Typed qualified: the schema and the name.
      await page.keyboard.press('Control+a');
      await page.keyboard.type('@schema_03.table_02');
      await expect(options(page).first()).toContainText('schema_03.table_02');
    });
  });
}

test.describe('keyboard', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('arrows skip headings, the mouse and the keyboard share the active row', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(treeItem(page, /^local postgres,/)).toBeVisible();
    await openPalette(page);
    const active = (): Locator => options(page).and(page.locator('[data-active]'));
    await expect(active()).toHaveCount(1);
    const first = await active().innerText();
    await page.keyboard.press('ArrowDown');
    expect(await active().innerText()).not.toBe(first);
    await page.keyboard.press('ArrowUp');
    expect(await active().innerText()).toBe(first);
    // Wraps around.
    await page.keyboard.press('ArrowUp');
    expect(await active().innerText()).not.toBe(first);
    await expect(input(page)).toHaveAttribute('aria-activedescendant', /.+/);
  });
});
