import { expect, test, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setMetaCatalog: (
    kind: 'shop' | 'large',
    options?: {
      schemas: number;
      tablesPerSchema: number;
      columnsPerTable: number;
      viewsPerSchema: number;
      functionsPerSchema: number;
    },
  ) => void;
  commands: { getTableDetails: (...args: unknown[]) => Promise<unknown> };
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`explorer-${state}-${theme}.png`),
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
  // A connection that needs a password would open the prompt: none of these do.
  await expect(item(page, name)).toHaveAccessibleName(/Connected/);
}

/** PostgreSQL ("local postgres"): the database opens by itself, then shop → Tables → orders. */
async function openOrders(page: Page) {
  await connect(page, /^local postgres,/);
  await expand(item(page, /^shop$/));
  await expand(item(page, /^Tables \(/));
  await expand(item(page, /^orders$/));
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 1000 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
      await page.evaluate(() => (window as MockWindow).__yadbeMock?.setMetaLatency(40));
    });

    test('PostgreSQL: database, schema, kinds, table, columns and keys', async ({ page }) => {
      await openOrders(page);
      await expand(item(page, /^Columns \(/));
      await expand(item(page, /^Keys \(/));
      await expand(item(page, /^Foreign keys \(/));
      await expect(item(page, /^id, /)).toBeVisible();
      await expect(item(page, /^customer_id, /)).toBeVisible();
      // The levels nest: a column sits two levels under its table (column group in between).
      const level = async (row: Locator) => Number(await row.getAttribute('aria-level'));
      expect(await level(item(page, /^id, /))).toBe((await level(item(page, /^orders$/))) + 2);
      await capture(page, name, 'postgres');
    });

    test('SQLite: no database and no schema level', async ({ page }) => {
      await connect(page, /^app\.sqlite,/);
      await expect(item(page, /^Tables \(/)).toBeVisible();
      await expect(item(page, /^main$/)).toHaveCount(0);
      await expand(item(page, /^Tables \(/));
      await expand(item(page, /^notes$/));
      await expand(item(page, /^Columns \(/));
      await expect(item(page, /^title, TEXT/)).toBeVisible();
      await capture(page, name, 'sqlite');
    });

    test('MySQL: databases are the namespaces, no schema level', async ({ page }) => {
      await connect(page, /^wordpress,/);
      await expand(item(page, /^wordpress$/));
      // System databases are hidden by default.
      await expect(item(page, /^information_schema$/)).toHaveCount(0);
      await expand(item(page, /^Tables \(/));
      await expand(item(page, /^wp_posts$/));
      await expand(item(page, /^Columns \(/));
      await expect(item(page, /^ID, bigint unsigned/)).toBeVisible();
      await capture(page, name, 'mysql');
    });

    test('the filter keeps the ancestors of the loaded matches', async ({ page }) => {
      await openOrders(page);
      await page.getByRole('textbox', { name: 'Filter connections' }).fill('ord');
      await expect(item(page, /^orders$/)).toBeVisible();
      await expect(item(page, /^shop$/)).toBeVisible();
      await expect(item(page, /^app_dev$/)).toBeVisible();
      await expect(item(page, /^local postgres,/)).toBeVisible();
      await expect(item(page, /^products$/)).toHaveCount(0);
      await capture(page, name, 'filter');
      await page.getByRole('textbox', { name: 'Filter connections' }).fill('');
      await expect(item(page, /^products$/)).toBeVisible();
    });

    test('system objects are hidden until asked for', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await expect(item(page, /^shop$/)).toBeVisible();
      await expect(item(page, /^information_schema$/)).toHaveCount(0);
      await expect(item(page, /^template1$/)).toHaveCount(0);
      await page.getByRole('button', { name: 'Show system objects' }).click();
      await expect(item(page, /^information_schema$/)).toBeVisible();
      await expect(item(page, /^template1$/)).toBeVisible();
      await expand(item(page, /^pg_catalog$/));
      await capture(page, name, 'system');
      await page.getByRole('button', { name: 'Hide system objects' }).click();
      await expect(item(page, /^pg_catalog$/)).toHaveCount(0);
    });

    test('a node that fails shows its error and retries', async ({ page }) => {
      await page.evaluate(() => {
        const mock = (window as MockWindow).__yadbeMock;
        if (!mock) return;
        const original = mock.commands.getTableDetails;
        mock.commands.getTableDetails = () =>
          Promise.resolve({
            status: 'error' as const,
            error: {
              code: 'objectNotFound' as const,
              message: {
                en: '"shop"."orders" no longer exists. Refresh the explorer to see the current objects.',
                fr: '« shop.orders » n’existe plus.',
              },
              action: null,
              detail: null,
            },
          });
        (window as unknown as { __restoreDetails: () => void }).__restoreDetails = () => {
          mock.commands.getTableDetails = original;
        };
      });
      await openOrders(page);
      const error = page.getByRole('treeitem', { name: /no longer exists/ });
      await expect(error).toBeVisible();
      await capture(page, name, 'error');
      await page.evaluate(() => {
        (window as unknown as { __restoreDetails: () => void }).__restoreDetails();
      });
      await error.getByRole('button', { name: 'Retry' }).click();
      await expect(error).toHaveCount(0);
      await expect(item(page, /^Columns \(/)).toBeVisible();
    });

    test('keyboard: arrows, type-ahead, expand, collapse, menu key', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await expect(item(page, /^analytics$/)).toBeVisible();
      const active = () =>
        page.evaluate(() => {
          const element = document.querySelector('[role="tree"]');
          const id = element?.getAttribute('aria-activedescendant');
          const row = id ? document.getElementById(id) : null;
          return row ? (row.getAttribute('aria-label') ?? row.textContent) : null;
        });
      await tree(page).focus();
      await page.keyboard.press('Home');
      await expect.poll(active).toMatch(/^Clients/);
      // Type-ahead: the next row whose name starts with the letters typed.
      await page.keyboard.type('local');
      await expect.poll(active).toMatch(/^Local/);
      await page.keyboard.press('ArrowDown');
      await expect.poll(active).toMatch(/^local postgres,/);
      // → on an open node goes to its first child, → on a closed one opens it.
      await page.keyboard.press('ArrowRight');
      await expect.poll(active).toBe('analytics_archive');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await expect.poll(active).toBe('analytics');
      await page.keyboard.press('ArrowRight');
      await expect(item(page, /^analytics$/)).toHaveAttribute('aria-expanded', 'true');
      await expect(item(page, /^Tables \(/).first()).toBeVisible();
      // ← closes an open node, then goes to the parent.
      await page.keyboard.press('ArrowLeft');
      await expect(item(page, /^analytics$/)).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('ArrowLeft');
      await expect.poll(active).toBe('app_dev');
      await page.keyboard.press('End');
      await expect.poll(active).toMatch(/^auth failure demo,/);
      await page.keyboard.press('Home');
      await expect.poll(active).toMatch(/^Clients/);
      // The menu key opens the context menu of the active row.
      // A pause ends the run of letters typed before.
      await page.waitForTimeout(800);
      await page.keyboard.type('local postgres');
      await page.keyboard.press('ContextMenu');
      await expect(page.getByRole('menuitem', { name: 'Refresh' })).toBeVisible();
      await page.keyboard.press('Escape');
    });

    test('context menu: Script as opens a query tab', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await expand(item(page, /^shop$/));
      await expand(item(page, /^Tables \(/));
      const tabs = page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab');
      await expect(tabs).toHaveCount(1);
      await item(page, /^orders$/).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Open data' })).toBeEnabled();
      await page.getByRole('menuitem', { name: 'Script as' }).hover();
      await expect(page.getByRole('menuitem', { name: 'UPDATE' })).toBeVisible();
      await capture(page, name, 'menu');
      await page.getByRole('menuitem', { name: 'SELECT' }).click();
      await expect(tabs).toHaveCount(2);
      // The script lands in the new tab's editor, which runs in the table's database.
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toContainText(/SELECT/);
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toContainText(/orders/);
      await capture(page, name, 'script');
    });
  });
}

test.describe('large catalog', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US', viewport: { width: 1280, height: 1000 } });

  for (const { name, colorScheme } of THEMES) {
    test(`10 000 objects stay navigable (${name})`, async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme,
        viewport: { width: 1280, height: 1000 },
      });
      const page = await context.newPage();
      await page.goto('/');
      await expect(item(page, /^shop · prod,/)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(0);
        (window as MockWindow).__yadbeMock?.setMetaCatalog('large');
      });
      await connect(page, /^local postgres,/);
      // Bottom up, so that the schemas still to open stay at the top, where they are drawn.
      for (let schema = 9; schema >= 0; schema--) {
        await expand(item(page, new RegExp(`^schema_0${String(schema)}$`)));
        await expand(item(page, /^Tables \(/).first());
      }
      // Every schema is open down to its tables: thousands of rows, a few dozen in the DOM.
      const rendered = await tree(page).getByRole('treeitem').count();
      expect(rendered).toBeLessThan(120);
      await tree(page).focus();
      await page.keyboard.press('End');
      await expect(item(page, /^Types \(/).last()).toBeVisible();
      await page.evaluate(() => {
        const element = document.querySelector('[role="tree"]');
        if (element) element.scrollTop = element.scrollHeight / 2;
      });
      await capture(page, name, 'large');
      await context.close();
    });
  }
});
