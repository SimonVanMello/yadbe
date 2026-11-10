import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Table tabs (M2-3) on the mock backend: browsing, filter and sort, cell editors, pending
 * changes, the SQL preview, apply (success and rollbacks), read-only tables and restore.
 * Captures in both themes.
 */

interface MockControls {
  setTableDataLatency: (ms: number) => void;
  setExportTick: (ms: number) => void;
  getFile: (path: string) => string | undefined;
  events: { emit: (name: string, payload: unknown) => void };
  deleteRowElsewhere: (
    connectionId: string,
    table: { database: string; schema: string | null; name: string },
    key: unknown[],
  ) => boolean;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`table-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab');
const grid = (page: Page) => page.getByRole('grid', { name: /^Rows of / });
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name: new RegExp(`^${name}\\b`) });

/** A data cell by 0-based row and display column. */
function cell(page: Page, row: number, col: number): Locator {
  return grid(page).locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

/** The display column of a header (it must be drawn: near the left edge). */
async function col(page: Page, name: string): Promise<number> {
  return Number(await header(page, name).getAttribute('aria-colindex')) - 1;
}

/** Moves the keyboard to a cell far to the right (columns are drawn as they come into view). */
async function focusCell(page: Page, row: number, column: number) {
  await grid(page).focus();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < row; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < column; i++) await page.keyboard.press('ArrowRight');
  await expect(cell(page, row, column)).toHaveAttribute('data-focused', '');
}

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

/** Opens `schema.table` of a connected PostgreSQL connection in a table tab. */
async function openTable(page: Page, schema: string, table: string) {
  // The schemas are listed (every PostgreSQL database has `public`); `.last()`: a database can
  // have the name of a schema (`shop`).
  await expect(item(page, /^public$/).first()).toBeVisible();
  await expand(item(page, new RegExp(`^${schema}$`)).last());
  await expand(item(page, /^Tables \(/).last());
  await item(page, new RegExp(`^${table}$`)).dblclick();
  await expect(grid(page)).toBeVisible();
  await expect(cell(page, 0, 0)).not.toHaveText('');
}

async function openOrders(page: Page) {
  await connect(page, /^local postgres,/);
  await openTable(page, 'shop', 'orders');
}

async function openSamples(page: Page) {
  await connect(page, /^local postgres,/);
  await openTable(page, 'public', 'type_samples');
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

const pending = (page: Page) => page.getByTestId('toolbar-pending');

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
    });

    test('a table tab shows its rows, pages and count; headers sort, Shift adds a key', async ({
      page,
    }) => {
      await openOrders(page);
      await expect(tabs(page).filter({ hasText: 'orders' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByTestId('table-range')).toHaveText('Rows 1–500');
      await expect(page.getByTestId('table-count')).toContainText(/≈ [\d,]+ rows/);
      await capture(page, name, 'data');

      await page.getByTestId('table-count').getByRole('button', { name: 'Count' }).click();
      await expect(page.getByTestId('table-count')).toContainText(/^[\d,]+ rows$/);
      await page.getByRole('button', { name: 'Next page' }).click();
      await expect(page.getByTestId('table-range')).toHaveText('Rows 501–1,000');

      await header(page, 'status').click();
      await expect(header(page, 'status')).toHaveAttribute('aria-sort', 'ascending');
      await expect(page.getByTestId('table-range')).toHaveText('Rows 1–500');
      await header(page, 'subtotal').click({ modifiers: ['Shift'] });
      await header(page, 'subtotal').click({ modifiers: ['Shift'] });
      await expect(header(page, 'subtotal').getByLabel('Descending, sort key 2')).toBeVisible();
      await expect(cell(page, 0, 2)).toHaveText('cancelled');
      await capture(page, name, 'sort');
    });

    test('filter chips and a raw WHERE the engine refuses', async ({ page }) => {
      await openOrders(page);
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      const form = page.getByRole('form', { name: 'Filter condition' });
      await form.getByLabel('Column').selectOption('status');
      await form.getByLabel('Condition').selectOption('in');
      await form.getByLabel('Values, one per line').fill('paid\nshipped');
      await form.getByRole('button', { name: 'Apply' }).click();
      await expect(
        page.getByRole('button', { name: 'status in (paid, shipped)', exact: true }),
      ).toBeVisible();
      await expect(cell(page, 0, 2)).toHaveText(/paid|shipped/);

      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      await form.getByLabel('Column').selectOption('subtotal');
      await form.getByLabel('Condition').selectOption('between');
      await form.getByLabel('From').fill('100');
      await form.getByLabel('To').fill('abc');
      await form.getByRole('button', { name: 'Apply' }).click();
      await expect(form.getByRole('alert')).toHaveText('Not a number.');
      await form.getByLabel('To').fill('50000');
      await form.getByRole('button', { name: 'Apply' }).click();
      await expect(
        page.getByRole('button', { name: 'subtotal between 100 and 50000', exact: true }),
      ).toBeVisible();

      const where = page.getByRole('textbox', { name: /WHERE condition/ });
      await where.fill('nope === 1');
      await where.press('Enter');
      await expect(page.getByRole('search').getByRole('alert')).toContainText('syntax error');
      await capture(page, name, 'filter');
    });

    test('type-aware editors on type_samples', async ({ page }) => {
      await openSamples(page);
      // flag: true / false / NULL.
      await cell(page, 0, 1).dblclick();
      await expect(page.getByRole('radiogroup', { name: 'Edit flag, row 1' })).toBeVisible();
      await capture(page, name, 'editor-bool');
      await page.keyboard.press('Escape');

      // big: 64-bit integer, checked as typed.
      await cell(page, 0, 3).click();
      await page.keyboard.type('92233720368547758070');
      const big = page.getByRole('textbox', { name: 'Edit big, row 1' });
      await expect(big).toHaveValue('92233720368547758070');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: 'Out of range' })).toBeVisible();
      await capture(page, name, 'editor-number-invalid');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Enter');
      await expect(cell(page, 0, 3)).toHaveText('9223372036854775807');

      // at: timestamp with time zone, format shown and checked.
      await focusCell(page, 0, 11);
      await page.keyboard.press('F2');
      const at = page.getByRole('textbox', { name: 'Edit at, row 1' });
      await at.fill('2025-02-30 10:00:00+00');
      await at.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: 'Not a timestamp' })).toBeVisible();
      await capture(page, name, 'editor-timestamp');
      await at.fill('2025-02-28T10:00:00Z');
      await at.press('Enter');
      await expect(cell(page, 0, 11)).toHaveText('2025-02-28 10:00:00+00');

      // doc: JSON on several lines.
      await focusCell(page, 1, 14);
      await page.keyboard.press('Enter');
      const doc = page.getByRole('textbox', { name: 'Edit doc, row 2' });
      await doc.fill('{\n  "a": 12345678901234567890.5\n}');
      await capture(page, name, 'editor-json');
      await doc.press('ControlOrMeta+Enter');
      await expect(cell(page, 1, 14)).toContainText('12345678901234567890.5');

      // ref: uuid.
      await focusCell(page, 2, 13);
      await page.keyboard.press('Enter');
      await page.getByRole('textbox', { name: 'Edit ref, row 3' }).fill('not-a-uuid');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: 'Not a UUID' })).toBeVisible();
      await page.keyboard.press('Escape');

      // label: text; Tab commits and moves right.
      await focusCell(page, 3, 6);
      await page.keyboard.press('Enter');
      await page.getByRole('textbox', { name: 'Edit label, row 4' }).fill('édité');
      await capture(page, name, 'editor-text');
      await page.keyboard.press('Tab');
      await expect(cell(page, 3, 6)).toHaveText('édité');
      await expect(cell(page, 3, 7)).toHaveAttribute('data-focused', '');
    });

    test('enum editor, NULL and the empty string stay distinct', async ({ page }) => {
      await openOrders(page);
      const note = await col(page, 'note');
      await cell(page, 1, 2).dblclick();
      const list = page.getByRole('listbox', { name: 'Edit status, row 2' });
      await expect(list).toBeVisible();
      await capture(page, name, 'editor-enum');
      await list.selectOption('paid');
      await list.press('Enter');
      await expect(cell(page, 1, 2)).toHaveText('paid');

      // note (text, nullable): NULL with Mod+Backspace, then the empty string.
      await cell(page, 0, note).click();
      await page.keyboard.press('ControlOrMeta+Backspace');
      await expect(cell(page, 0, note)).toHaveText('NULL');
      await cell(page, 1, note).dblclick();
      const editor = page.getByRole('textbox', { name: 'Edit note, row 2' });
      await editor.fill('');
      await expect(page.getByText('empty string')).toBeVisible();
      await editor.press('Enter');
      await expect(cell(page, 1, note)).toHaveText('empty');
      await expect(cell(page, 0, note)).toHaveAttribute('data-state', 'modified');
      await expect(cell(page, 1, note)).toHaveAttribute('data-state', 'modified');
      await capture(page, name, 'null-empty');
    });

    test('pending changes of the three kinds, counted and revertible', async ({ page }) => {
      await openOrders(page);
      // A short page: the new row (drawn after the others) stays in view with them.
      const where = page.getByRole('textbox', { name: /WHERE condition/ });
      await where.fill('id <= 12');
      await where.press('Enter');
      await expect(page.getByTestId('table-range')).toHaveText('Rows 1–12');
      const note = await col(page, 'note');
      await cell(page, 0, note).dblclick();
      await page.getByRole('textbox', { name: 'Edit note, row 1' }).fill('checked by hand');
      await page.keyboard.press('Enter');
      await cell(page, 2, 1).click();
      await page.keyboard.press('ControlOrMeta+Delete');
      await page.keyboard.press('ControlOrMeta+i');
      await expect(pending(page)).toHaveText('3 pending');
      await expect(page.getByTestId('statusbar-table')).toContainText('3 pending');
      const row = (index: number) =>
        grid(page).locator(`[role=row][aria-rowindex="${String(index + 2)}"]:not([hidden])`);
      await expect(row(0)).toHaveAttribute('data-state', 'modified');
      await expect(row(2)).toHaveAttribute('data-state', 'deleted');
      await expect(row(12)).toHaveAttribute('data-state', 'inserted');
      await expect(cell(page, 12, 1)).toHaveText('DEFAULT');
      await expect(cell(page, 0, note)).toHaveAttribute('title', /^Was: /);
      await capture(page, name, 'pending');

      // Revert the deletion from the menu; the tab asks before closing with changes.
      await cell(page, 2, 3).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Revert rows' }).click();
      await expect(pending(page)).toHaveText('2 pending');
      await page.keyboard.press('ControlOrMeta+w');
      const ask = page.getByRole('dialog', { name: 'Discard 2 pending changes?' });
      await expect(ask).toBeVisible();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      await expect(tabs(page).filter({ hasText: 'orders' })).toBeVisible();
    });

    test('a production connection always previews the SQL; apply shows the server values', async ({
      page,
    }) => {
      await makeStagingProd(page);
      await connect(page, /^shop · staging,/);
      await openTable(page, 'shop', 'orders');
      const note = await col(page, 'note');
      await cell(page, 0, note).dblclick();
      await page.getByRole('textbox', { name: 'Edit note, row 1' }).fill('verified');
      await page.keyboard.press('Enter');
      // A copy of row 2: its identity is left to the server.
      await cell(page, 1, 2).click();
      await page.keyboard.press('ControlOrMeta+d');
      await expect(cell(page, 500, 0)).toHaveText('DEFAULT');
      await page.keyboard.press('ControlOrMeta+s');
      const preview = page.getByRole('dialog', { name: 'Preview SQL' });
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('2 statements run in one transaction');
      await expect(preview).toContainText('Production connection');
      await expect(preview.getByRole('textbox', { name: 'Statements to apply' })).toContainText(
        'UPDATE "shop"."orders" SET "note" = \'verified\'',
      );
      await expect(preview.getByRole('textbox', { name: 'Statements to apply' })).toContainText(
        'INSERT INTO "shop"."orders"',
      );
      await capture(page, name, 'preview-prod');

      // The Apply button's own shortcut works inside the dialog.
      await page.keyboard.press('ControlOrMeta+s');
      await expect(preview).toBeHidden();
      await expect(page.getByText('Changes applied', { exact: true })).toBeVisible();
      await expect(pending(page)).toHaveText('No changes');
      // The new row as the server stored it: its identity and defaults filled in.
      await expect(cell(page, 500, 0)).not.toHaveText('DEFAULT');
      await expect(cell(page, 500, 0)).not.toHaveText('');
      await capture(page, name, 'applied');
      await grid(page).focus();
      await page.keyboard.press('ControlOrMeta+Home');
      await expect(cell(page, 0, note)).toHaveText('verified');
      await expect(cell(page, 0, note)).not.toHaveAttribute('data-state', /.*/);
    });

    test('a rolled-back apply keeps the changes and points at what failed', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await openTable(page, 'shop', 'customers');
      // Row 2 changed elsewhere: deleted by another session.
      await cell(page, 1, 3).dblclick();
      await page.getByRole('textbox', { name: 'Edit phone, row 2' }).fill('+33 1 00 00 00 00');
      await page.keyboard.press('Enter');
      await page.evaluate(() =>
        (window as MockWindow).__yadbeMock?.deleteRowElsewhere(
          'conn-local-pg',
          { database: 'app_dev', schema: 'shop', name: 'customers' },
          [{ kind: 'int', value: '2' }],
        ),
      );
      await page.keyboard.press('ControlOrMeta+s');
      await page
        .getByRole('dialog', { name: 'Preview SQL' })
        .getByRole('button', { name: /^Apply/ })
        .click();
      const failure = page.getByTestId('table-failure');
      await expect(failure).toContainText('Nothing was applied');
      await expect(failure).toContainText(/someone else|another session|no longer/i);
      await expect(pending(page)).toHaveText('1 pending');
      await expect(cell(page, 1, 3)).toHaveAttribute('data-state', 'failed');
      await capture(page, name, 'rollback-row-not-found');

      // Revert it, then duplicate row 1: its email is unique.
      await failure.getByRole('button', { name: 'Revert this change' }).click();
      await expect(failure).toBeHidden();
      await cell(page, 0, 2).click();
      await page.keyboard.press('ControlOrMeta+d');
      await page.keyboard.press('ControlOrMeta+s');
      await page
        .getByRole('dialog', { name: 'Preview SQL' })
        .getByRole('button', { name: /^Apply/ })
        .click();
      await expect(failure).toContainText('Unique constraint');
      await expect(failure).toContainText('email');
      await expect(pending(page)).toHaveText('1 pending');
      await capture(page, name, 'rollback-unique');
    });

    test('a keyless table is read-only, with the reason', async ({ page }) => {
      await connect(page, /^local postgres,/);
      await openTable(page, 'analytics', 'page_views');
      await expect(page.getByTestId('table-readonly')).toContainText(
        'neither a primary key nor a unique key',
      );
      await expect(grid(page)).toHaveAttribute('aria-readonly', 'true');
      await capture(page, name, 'keyless');
    });

    test('a read-only connection: rows shown, editing refused with the reason', async ({
      page,
    }) => {
      await connect(page, /^shop · prod,/);
      await openTable(page, 'shop', 'orders');
      await expect(page.getByTestId('table-readonly')).toContainText(
        'The connection is read-only.',
      );
      await cell(page, 0, 3).click();
      await page.keyboard.press('Enter');
      await expect(page.getByText('The connection is read-only.').last()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Insert row' })).toBeDisabled();
      await capture(page, name, 'read-only-connection');
    });

    test('Mod+F opens the filter form on the grid, not the browser search', async ({ page }) => {
      await openOrders(page);
      await grid(page).focus();
      await page.keyboard.press('ControlOrMeta+f');
      const form = page.getByRole('form', { name: 'Filter condition' });
      await expect(form).toBeVisible();
      await form.getByLabel('Column').selectOption('status');
      await form.getByLabel('Condition').selectOption('eq');
      await form.getByLabel('Value').selectOption('paid');
      await form.getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByRole('button', { name: 'status = paid', exact: true })).toBeVisible();
      await expect(cell(page, 0, 2)).toHaveText('paid');
    });

    test('changes applied elsewhere mark the rows as old until a refresh', async ({ page }) => {
      await openOrders(page);
      await expect(page.getByText('Changed from another tab: refresh to see it.')).toBeHidden();
      // One tab per table: the event stands for another tab of the same table (F-087, later).
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.events.emit('tableDataChanged', {
          connectionId: 'conn-local-pg',
          table: { database: 'app_dev', schema: 'shop', name: 'orders' },
          tabId: 'another-tab',
          updated: 1,
          inserted: 0,
          deleted: 0,
        });
      });
      const notice = page.getByText('Changed from another tab: refresh to see it.');
      await expect(notice).toBeVisible();
      await capture(page, name, 'stale');
      await page.getByRole('button', { name: 'Refresh rows' }).click();
      await expect(notice).toBeHidden();
    });

    test('Export the table writes every row under the filter, not only the page', async ({
      page,
    }) => {
      await page.evaluate(() => (window as MockWindow).__yadbeMock?.setExportTick(0));
      await openOrders(page);
      const where = page.getByRole('textbox', { name: /WHERE condition/ });
      await where.fill("status = 'paid'");
      await where.press('Enter');
      await expect(cell(page, 0, 2)).toHaveText('paid');
      await page.getByRole('button', { name: 'Export the table…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Export the table' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/Only the rows matching the tab/)).toBeVisible();
      await expect(dialog.getByLabel('Preview of the file')).toContainText('paid');
      await capture(page, name, 'export-dialog');
      await dialog.getByRole('button', { name: 'Export…' }).click();
      const done = page.getByText(/^Exported [\d,]+ rows$/);
      await expect(done).toBeVisible();
      const path = await page
        .getByText(/\/home\/ana\/Downloads\/[^ ]+\.csv/)
        .first()
        .textContent();
      const file = await page.evaluate(
        (p) => (window as MockWindow).__yadbeMock?.getFile(p),
        /\/home\/ana\/Downloads\/[^ ]+\.csv/.exec(path ?? '')?.[0] ?? '',
      );
      const lines = (file ?? '').trim().split('\n');
      const rows = Number(
        /Exported ([\d,]+) rows/.exec((await done.textContent()) ?? '')?.[1]?.replace(/,/g, ''),
      );
      expect(lines.length - 1).toBe(rows);
      expect(rows).toBeGreaterThan(0);
      expect(lines.slice(1).every((line) => line.includes(',paid,'))).toBe(true);
    });

    test('a restored table tab keeps its filter and sort, and waits to connect', async ({
      page,
    }) => {
      await openOrders(page);
      await header(page, 'subtotal').click();
      await header(page, 'subtotal').click();
      const where = page.getByRole('textbox', { name: /WHERE condition/ });
      await where.fill("status = 'paid'");
      await where.press('Enter');
      await expect(cell(page, 0, 2)).toHaveText('paid');
      // Tabs are saved a moment after the last change.
      await page.waitForTimeout(2000);
      await page.reload();
      await expect(tabs(page).filter({ hasText: 'orders' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByText('Connect to see and edit its rows.')).toBeVisible();
      await capture(page, name, 'restored');
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(cell(page, 0, 2)).toHaveText('paid');
      await expect(header(page, 'subtotal')).toHaveAttribute('aria-sort', 'descending');
      await expect(where).toHaveValue("status = 'paid'");
    });
  });
}
