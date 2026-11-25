import { expect, test, type Page } from '@playwright/test';

/**
 * Export of a whole collection or index (M4-11) on the mock backend: from a collection tab or an
 * index tab (toolbar, documents view), the dialog says what is exported (every document under
 * the tab's query, with the count the tab knows), JSON Lines writes the documents whole, and the
 * file holds every document, not the page shown. Captures of the dialog in both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface MockControls {
  setLatency(ms: number): void;
  setMetaLatency(ms: number): void;
  setExportTick(ms: number): void;
  getFile(path: string): string | undefined;
}

type MockWindow = Window & { __yadbeMock?: MockControls };

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`family-export-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const MONGO = /^catalog · mongo,/;
const SEARCH = /^search · logs,/;

const fileLines = (page: Page, path: string) =>
  page.evaluate(
    (file) => ((window as MockWindow).__yadbeMock?.getFile(file) ?? '').split('\n').filter(Boolean),
    path,
  );

async function openOrders(page: Page) {
  await item(page, MONGO).dblclick();
  await expect(item(page, MONGO)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^orders$/)).toBeVisible();
  await item(page, /^orders$/).dblclick();
  await expect(page.getByTestId('collection-tab')).toBeVisible();
  await expect(page.getByTestId('collection-range')).toHaveText('1–100');
}

async function openOrdersIndex(page: Page) {
  await item(page, SEARCH).click();
  await item(page, SEARCH).locator('span').first().click();
  await expect(item(page, SEARCH)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^orders$/)).toBeVisible();
  await item(page, /^orders$/).dblclick();
  await expect(page.getByTestId('index-tab')).toBeVisible();
  await expect(page.getByTestId('index-count')).toHaveText('1,240 documents');
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, MONGO)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(10);
        (window as MockWindow).__yadbeMock?.setLatency(20);
        (window as MockWindow).__yadbeMock?.setExportTick(0);
      });
    });

    test('a collection tab exports every document, not the page shown', async ({ page }) => {
      await openOrders(page);
      await page.getByRole('button', { name: 'Export the collection…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Export the collection' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('not only the page shown');
      await expect(dialog.getByTestId('export-count')).toHaveText(
        "About 1,300 documents will be written (the collection's estimated size).",
      );
      await expect(dialog).toContainText('The columns are the fields of the first 1,000 documents');
      await expect(dialog.getByLabel('Preview of the file')).toContainText('_id,');
      await capture(page, name, 'collection-csv');

      await dialog.getByRole('radio', { name: 'JSON Lines' }).click();
      await expect(dialog).toContainText('Each line is a whole document, not a grid row.');
      await expect(dialog.getByLabel('Preview of the file')).toContainText('{"_id":{"$oid":');
      await capture(page, name, 'collection-jsonl');
      await dialog.getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Exported 1,300 documents', { exact: true })).toBeVisible();
      const lines = await fileLines(page, '/home/ana/Downloads/orders.jsonl');
      expect(lines).toHaveLength(1300);
      expect(lines.every((line) => line.startsWith('{"_id":{"$oid":'))).toBe(true);

      // The documents view exports the same: the whole collection under the tab's filter.
      await page.locator('[data-field="filter"]').fill('{ "status": "paid" }');
      await page.locator('[data-field="filter"]').press('Enter');
      await expect(page.getByTestId('collection-range')).toHaveText('1–100');
      await page.getByRole('radio', { name: 'Documents' }).click();
      const documents = page.getByRole('tree', { name: /^Documents of catalog\.orders/ });
      await documents
        .getByRole('treeitem', { name: /Document 1\b/ })
        .first()
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Export…' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Only the documents matching the tab's filter");
      await expect(dialog.getByTestId('export-count')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Exported 320 documents', { exact: true })).toBeVisible();
      const paid = await fileLines(page, '/home/ana/Downloads/orders.jsonl');
      expect(paid).toHaveLength(320);
      expect(paid.every((line) => line.includes('"status":"paid"'))).toBe(true);
    });

    test('an index tab exports every hit of its query', async ({ page }) => {
      await openOrdersIndex(page);
      await page.getByRole('button', { name: 'Export the index…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Export the index' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('export-count')).toHaveText(
        '1,240 documents will be written.',
      );
      await dialog.getByRole('radio', { name: 'CSV', exact: true }).click();
      await expect(dialog.getByLabel('Preview of the file')).toContainText('_index,_id,_score');
      await capture(page, name, 'index-csv');
      await dialog.getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Exported 1,240 documents', { exact: true })).toBeVisible();
      const lines = await fileLines(page, '/home/ana/Downloads/orders.csv');
      expect(lines).toHaveLength(1241);
      expect(lines[0]?.startsWith('_index,_id,_score')).toBe(true);

      // From the grid's footer of the page: the same whole-index export.
      await page
        .getByRole('grid', { name: /^Documents of orders/ })
        .getByRole('gridcell')
        .first()
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Export…' }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('radio', { name: 'JSON Lines' }).click();
      await dialog.getByRole('switch', { name: 'Write the _id of each hit' }).click();
      await expect(dialog.getByLabel('Preview of the file')).toContainText('{"_id":"');
      await capture(page, name, 'index-jsonl');
    });
  });
}
