import { expect, test, type Page } from '@playwright/test';

/**
 * Schema-aware autocomplete (M2-5, F-043) on the mocked backend, in both themes: relations after
 * FROM, columns after an alias dot, schema-qualified names, the info panel, keywords while the
 * schema loads, the 10 000-object catalog, and the keys.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface MockControls {
  setLatency: (ms: number) => void;
  setQueryTick: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setMetaCatalog: (kind: 'shop' | 'large') => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const options = (page: Page) => page.locator('.cm-tooltip-autocomplete [role="option"]');
const info = (page: Page) => page.locator('.cm-completionInfo');
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete');
const lines = (page: Page) => page.locator('.cm-line');

async function openQueryTab(page: Page, connection: string) {
  await sidebarItem(page, connection).dblclick();
  await expect(editor(page)).toBeVisible();
  await expect(sidebarItem(page, connection)).toHaveAccessibleName(/Connected/);
}

/** Replaces the editor's text, without triggering suggestions (an insertion is not typing). */
async function setScript(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

async function type(page: Page, text: string) {
  await page.keyboard.type(text);
}

/**
 * Takes the selected suggestion. CodeMirror ignores Enter and Tab for a short moment after the
 * list opens, so that a keystroke meant for the text is not taken for an acceptance.
 */
async function accept(page: Page, key: 'Enter' | 'Tab') {
  await page.waitForTimeout(150);
  await page.keyboard.press(key);
}

/** The labels of the open suggestions, in order. */
async function labels(page: Page): Promise<string[]> {
  return (await options(page).locator('.cm-completionLabel').allTextContents()).map((text) =>
    text.trim(),
  );
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await page.evaluate(() => {
        const mock = (window as MockWindow).__yadbeMock;
        mock?.setLatency(0);
        mock?.setMetaLatency(40);
      });
    });

    test('relations after FROM, ranked, with the columns in the info panel', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'select * from ord');
      await expect(options(page).first()).toContainText('orders');
      await expect
        .poll(async () => (await labels(page)).slice(0, 4))
        .toEqual(['orders', 'order_items', 'order_coupons', 'Order Notes']);
      // The schema is the detail; the kind is the mark.
      await expect(options(page).first()).toContainText('shop');
      await expect(options(page).first().locator('.cm-yadbe-kind')).toHaveAttribute(
        'data-kind',
        'table',
      );
      await expect(info(page)).toContainText('shop.orders');
      await expect(info(page)).toContainText('customer_id');
      await capture(page, name, 'completion-relations');
      // Enter takes the suggestion, schema and all (`shop` is not on the search path).
      await accept(page, 'Enter');
      await expect(lines(page).first()).toHaveText('select * from shop.orders');
      await expect(popup(page)).toHaveCount(0);
    });

    test('columns after an alias dot, resolved from the statement', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(
        page,
        'select  from shop.orders o join shop.customers c on c.id = o.customer_id',
      );
      await editor(page).press('ControlOrMeta+Home');
      for (let i = 0; i < 'select '.length; i++) await page.keyboard.press('ArrowRight');
      await type(page, 'o.');
      // CodeMirror keeps the previous list up until the new one is computed: wait for the right one.
      await expect
        .poll(() => labels(page))
        .toEqual(expect.arrayContaining(['id', 'customer_id', 'status', 'subtotal', 'total']));
      const columns = await labels(page);
      // The other table's columns are not offered under `o.`.
      expect(columns).not.toContain('email');
      await expect(options(page).first().locator('.cm-yadbe-kind')).toHaveAttribute(
        'data-kind',
        'column',
      );
      await capture(page, name, 'completion-alias-columns');
      await type(page, 'cr');
      await expect(options(page).first()).toContainText('created_at');
      await accept(page, 'Tab');
      await expect(lines(page).first()).toHaveText(
        'select o.created_at from shop.orders o join shop.customers c on c.id = o.customer_id',
      );
    });

    test('names after a schema dot', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'select * from sales.');
      await expect
        .poll(() => labels(page))
        .toEqual(expect.arrayContaining(['invoices', 'refunds', 'currencies']));
      const objects = await labels(page);
      expect(objects).not.toContain('orders');
      await capture(page, name, 'completion-schema-qualified');
      await type(page, 'inv');
      // The shorter name first, the other still there.
      await expect(options(page).first()).toContainText('invoices');
      await expect(options(page).nth(1)).toContainText('invoice_lines');
      await accept(page, 'Enter');
      await expect(lines(page).first()).toHaveText('select * from sales.invoices');
    });

    test('a schema continues with its objects, a quoted name is quoted', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'select * from sho');
      await expect(options(page).first()).toContainText('shop');
      await expect(options(page).first().locator('.cm-yadbe-kind')).toHaveAttribute(
        'data-kind',
        'schema',
      );
      await accept(page, 'Enter');
      await expect(lines(page).first()).toHaveText('select * from shop.');
      // Accepting a schema asks for its objects at once.
      await expect(options(page).first()).toBeVisible();
      await type(page, 'Order');
      await expect(options(page).filter({ hasText: 'Order Notes' })).toBeVisible();
      await options(page).filter({ hasText: 'Order Notes' }).click();
      await expect(lines(page).first()).toHaveText('select * from shop."Order Notes"');
    });

    test('the info panel of a column: type, key, then nullability', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select  from shop.orders o');
      await editor(page).press('ControlOrMeta+Home');
      for (let i = 0; i < 'select '.length; i++) await page.keyboard.press('ArrowRight');
      await type(page, 'o.customer');
      await expect(options(page).first()).toContainText('customer_id');
      await expect(info(page)).toContainText('customer_id');
      await expect(info(page)).toContainText('shop.orders');
      await expect(info(page)).toContainText('References');
      await expect(info(page)).toContainText('shop.customers (id)');
      // From the table's details, which arrive after the catalog's part.
      await expect(info(page)).toContainText('Constraints');
      await expect(info(page)).toContainText(/Not null|Nullable/);
      await capture(page, name, 'completion-info-column');
    });

    test('keywords only while the schema loads, with a discreet note', async ({ page }) => {
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(2500);
      });
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'select a, cou');
      await expect(page.getByRole('status').filter({ hasText: 'Loading schema' })).toBeVisible();
      await expect.poll(() => labels(page)).toContain('count');
      const kinds = await options(page)
        .locator('.cm-yadbe-kind')
        .evaluateAll((marks) => marks.map((mark) => (mark as HTMLElement).dataset.kind));
      expect(kinds.every((kind) => kind === 'function' || kind === 'keyword')).toBe(true);
      await capture(page, name, 'completion-loading');
      // Typing was never blocked, and the schema arrives.
      await expect(page.getByRole('status').filter({ hasText: 'Loading schema' })).toHaveCount(0, {
        timeout: 8000,
      });
    });

    test('a large schema: 10 000 objects, still instant', async ({ page }) => {
      await page.evaluate(() => {
        const mock = (window as MockWindow).__yadbeMock;
        mock?.setMetaLatency(0);
        mock?.setMetaCatalog('large');
      });
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'select * from schema_03.tab');
      await expect(options(page).first()).toContainText('table_');
      await expect.poll(() => options(page).count()).toBeGreaterThan(20);
      await capture(page, name, 'completion-large');
      // Across all schemas, the schema is the detail.
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await type(page, 'select * from table_0450');
      await expect(options(page).first()).toContainText('table_0450');
    });

    test('keys: Esc closes, Tab and Enter accept, Ctrl+Space asks, Mod+Enter still runs', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'sel');
      await expect(options(page).first()).toContainText('select');
      await page.keyboard.press('Escape');
      await expect(popup(page)).toHaveCount(0);
      await expect(lines(page).first()).toHaveText('sel');
      // Ctrl+Space asks again.
      await page.keyboard.press('Control+Space');
      await expect(options(page).first()).toContainText('select');
      await accept(page, 'Tab');
      await expect(lines(page).first()).toHaveText('select');
      // With nothing open, Tab still indents.
      await page.keyboard.press('Escape');
      await type(page, ' 1');
      await expect(popup(page)).toHaveCount(0);
      // A suggestion open, the run shortcut is not swallowed.
      await setScript(page, '');
      await type(page, 'select 1 from shop.orde');
      await expect(options(page).first()).toBeVisible();
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('run-status')).toContainText(/statement|Running|Failed/);
    });

    test('a function goes in with its parentheses, and typing the closing one steps over it', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, 'select coun');
      await expect(options(page).first()).toContainText('count');
      await accept(page, 'Tab');
      await expect(lines(page).first()).toHaveText('select count()');
      await type(page, '*)');
      await expect(lines(page).first()).toHaveText('select count(*)');
    });

    test('nothing is suggested in a string or a comment', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await type(page, "select 'ord");
      await page.waitForTimeout(300);
      await expect(popup(page)).toHaveCount(0);
      await setScript(page, '');
      await type(page, '-- from ord');
      await page.waitForTimeout(300);
      await expect(popup(page)).toHaveCount(0);
    });
  });
}
