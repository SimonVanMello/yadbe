import { expect, test, type Page } from '@playwright/test';

/**
 * Export of a result (M2-7) on the mock backend: the dialog with its live preview (CSV and JSON),
 * the selection-only option, progress with Cancel, and the final toast. Both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface MockControls {
  setLatency(ms: number): void;
  setQueryTick(ms: number): void;
  setExportTick(ms: number): void;
  getFile(path: string): string | undefined;
}

type MockWindow = Window & { __yadbeMock?: MockControls };

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`export-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });
const editorContent = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const results = (page: Page) => page.getByRole('region', { name: 'Results' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export the result' });

async function openQueryTab(page: Page, connection: string) {
  await sidebarItem(page, connection).dblclick();
  await expect(editorContent(page)).toBeVisible();
  await expect(sidebarItem(page, connection)).toHaveAccessibleName(/Connected/);
}

async function run(page: Page, sql: string) {
  await editorContent(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
  await page.keyboard.press('ControlOrMeta+Enter');
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setLatency(30);
        (window as MockWindow).__yadbeMock?.setQueryTick(5);
        (window as MockWindow).__yadbeMock?.setExportTick(0);
      });
    });

    test('the dialog previews CSV and JSON, then the file lands with a toast', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await run(page, 'select * from orders;');
      await expect(results(page).getByText('1,284 rows', { exact: true })).toBeVisible();
      await results(page).getByRole('button', { name: 'Export…' }).click();
      await expect(dialog(page)).toBeVisible();
      const preview = dialog(page).getByLabel('Preview of the file');
      await expect(preview).toContainText('id,');
      await capture(page, name, 'dialog-csv');

      await dialog(page).getByLabel('Delimiter').selectOption('semicolon');
      await expect(preview).toContainText(';');
      await dialog(page).getByRole('switch', { name: 'Header row' }).click();
      await dialog(page).getByRole('radio', { name: 'JSON', exact: true }).click();
      await expect(preview).toContainText('[');
      await expect(preview).toContainText('{"id":');
      await capture(page, name, 'dialog-json');

      await dialog(page).getByRole('button', { name: 'Export…' }).click();
      await expect(dialog(page)).toBeHidden();
      const done = page.getByText('Exported 1,284 rows', { exact: true });
      await expect(done).toBeVisible();
      await expect(page.getByText(/\/home\/ana\/Downloads\/Result_1\.json/).first()).toBeVisible();
      await capture(page, name, 'done');
      const file = await page.evaluate(() =>
        (window as MockWindow).__yadbeMock?.getFile('/home/ana/Downloads/Result_1.json'),
      );
      expect(file?.startsWith('[\n{"id":')).toBe(true);
    });

    test('SQL inserts, Markdown and Excel have their own options and previews', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await run(page, 'select * from orders;');
      await expect(results(page).getByText('1,284 rows', { exact: true })).toBeVisible();
      await results(page).getByRole('button', { name: 'Export…' }).click();
      const preview = dialog(page).getByLabel('Preview of the file');

      await dialog(page).getByRole('radio', { name: 'SQL inserts' }).click();
      await expect(preview).toContainText('INSERT INTO "table_name" ("id", "customer"');
      await dialog(page).getByLabel('Table', { exact: true }).fill('orders');
      await dialog(page).getByLabel('Schema').fill('shop');
      await dialog(page).getByLabel('Rows per INSERT').fill('2');
      await expect(preview).toContainText('INSERT INTO "shop"."orders" ("id", "customer"');
      await expect(preview).toContainText("(9000000003, NULL, 'user3@example.com'");
      await dialog(page).getByLabel('Write for').selectOption({ label: 'SQL Server' });
      await expect(preview).toContainText('INSERT INTO [shop].[orders] ([id], [customer]');
      await expect(preview).toContainText("N'user0@example.com'");
      await capture(page, name, 'dialog-sql');
      // A table is needed: the export waits for a name.
      await dialog(page).getByLabel('Table', { exact: true }).fill('');
      await expect(dialog(page).getByText('Name the table the rows go into.')).toBeVisible();
      await expect(dialog(page).getByRole('button', { name: 'Export…' })).toBeDisabled();
      await dialog(page).getByLabel('Table', { exact: true }).fill('orders');

      await dialog(page).getByRole('radio', { name: 'Markdown' }).click();
      await expect(preview).toContainText('| id | customer | email |');
      await expect(preview).toContainText('| ---: |');
      await dialog(page).getByRole('switch', { name: 'Right-align numbers' }).click();
      await expect(preview).not.toContainText('---:');
      await capture(page, name, 'dialog-markdown');

      await dialog(page).getByRole('radio', { name: 'Excel' }).click();
      await expect(dialog(page).getByLabel('Worksheet name')).toHaveValue('Result 1');
      await expect(preview).toContainText('id\tcustomer');
      await capture(page, name, 'dialog-excel');
      await dialog(page).getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Exported 1,284 rows', { exact: true })).toBeVisible();
      await expect(page.getByText(/\/home\/ana\/Downloads\/Result_1\.xlsx/).first()).toBeVisible();
    });

    test('the selection can be exported on its own, and the options are remembered', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await run(page, 'select * from orders;');
      await expect(results(page).getByText('1,284 rows', { exact: true })).toBeVisible();
      const grid = page.getByRole('grid');
      await grid.locator('[role=row][aria-rowindex="3"] [aria-colindex="1"]').hover();
      await page.mouse.down();
      await grid.locator('[role=row][aria-rowindex="6"] [aria-colindex="2"]').hover();
      await page.mouse.up();
      await expect(page.getByText('4 × 2 selected')).toBeVisible();
      await grid.locator('[role=row][aria-rowindex="4"] [aria-colindex="1"]').click({
        button: 'right',
      });
      await page.getByRole('menuitem', { name: 'Export…' }).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole('switch', { name: /Selection only/ })).toBeChecked();
      await dialog(page).getByLabel('Line ending').selectOption('crlf');
      await expect(dialog(page).getByLabel('Preview of the file')).toBeVisible();
      await capture(page, name, 'dialog-selection');
      await dialog(page).getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Exported 4 rows', { exact: true })).toBeVisible();

      // The options come back the next time.
      await results(page).getByRole('button', { name: 'Export…' }).click();
      await expect(dialog(page).getByLabel('Line ending')).toHaveValue('crlf');
    });

    test('a long export shows its progress and can be cancelled', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await run(page, 'select * from huge;');
      await expect(results(page).getByText('Paused at the row limit')).toBeVisible();
      await page.evaluate(() => (window as MockWindow).__yadbeMock?.setExportTick(120));
      await results(page).getByRole('button', { name: 'Export…' }).click();
      await expect(dialog(page).getByText(/stopped at its limit/)).toBeVisible();
      await capture(page, name, 'dialog-paused');
      await dialog(page).getByRole('button', { name: 'Export…' }).click();
      const progress = page.getByText(/^Exporting… [\d,]+ rows/);
      await expect(progress).toBeVisible();
      await expect(page.getByText(/^Exporting… [1-9][\d,]* rows/)).toBeVisible();
      await capture(page, name, 'progress');
      await page.getByRole('button', { name: 'Cancel' }).last().click();
      await expect(page.getByText('Export cancelled', { exact: true })).toBeVisible();
      await capture(page, name, 'cancelled');
      const file = await page.evaluate(() =>
        (window as MockWindow).__yadbeMock?.getFile('/home/ana/Downloads/Result_1.csv'),
      );
      expect(file).toBeUndefined();
    });
  });
}
