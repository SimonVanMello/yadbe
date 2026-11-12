import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Elasticsearch document edits on the mock backend (M4-8): the editor of a hit's `_source`,
 * the pending strip, the apply preview with the requests and why they are sent one at a time,
 * the journal entry and its revert, a conflict with the server's version, the reasons a
 * document cannot be changed (data stream, read-only connection), the error marked in the
 * console and the welcome screen's family-neutral text. Captures in both themes.
 */

interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
}
type MockWindow = Window & {
  __yadbeMock?: MockControls;
  __YADBE_MOCK_SEARCH__?: { touch: (index: string, id: string) => boolean };
};

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`search-edit-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const SEARCH = /^search · logs,/;

function cell(grid: Locator, row: number, col: number): Locator {
  return grid.locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function connect(page: Page) {
  await item(page, SEARCH).click();
  await item(page, SEARCH).locator('span').first().click();
  await expect(item(page, SEARCH)).toHaveAccessibleName(/Connected/);
  await expect(item(page, /^orders$/)).toBeVisible();
}

async function openIndex(page: Page, name: RegExp, label: RegExp) {
  await item(page, name).dblclick();
  await expect(page.getByTestId('index-tab')).toBeVisible();
  const grid = page.getByRole('grid', { name: label });
  await expect(cell(grid, 0, 1)).toBeVisible();
  return grid;
}

async function rowMenu(page: Page, grid: Locator, row: number) {
  await cell(grid, row, 1).click({ button: 'right' });
  return page.getByRole('menu');
}

const sourceEditor = (page: Page) => page.getByTestId('search-json-editor').locator('.cm-content');

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, SEARCH)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(10);
        (window as MockWindow).__yadbeMock?.setLatency(20);
      });
    });

    test('documents are edited, deleted, added, applied one by one and reverted', async ({
      page,
    }) => {
      await connect(page);
      const grid = await openIndex(page, /^orders$/, /^Documents of orders/);
      await expect(page.getByRole('toolbar', { name: 'Document edits' })).toBeVisible();

      // Edit the first hit: its whole _source, read again by id.
      await (
        await rowMenu(page, grid, 0)
      )
        .getByRole('menuitem', { name: /Edit the document/ })
        .click();
      const editor = page.getByTestId('search-doc-editor');
      await expect(sourceEditor(page)).toContainText('"status": "paid"');
      await expect(editor).toContainText('_seq_no 0');
      await capture(page, name, 'editor');
      await sourceEditor(page).click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText('{\n  "status": "refunded",\n  "total": 12.50\n}');
      await page.getByRole('button', { name: 'Stage the change' }).click();
      await expect(editor).toBeHidden();

      // Delete the second hit.
      await (
        await rowMenu(page, grid, 1)
      )
        .getByRole('menuitem', { name: 'Delete the document' })
        .click();

      // Add a document; invalid JSON is marked before anything is staged.
      await page.getByRole('button', { name: 'Add a document' }).click();
      await page.locator('[data-field="id"]').fill('o-new-1');
      await sourceEditor(page).click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText('{\n  "status": \n}');
      await expect(editor.getByRole('alert')).toContainText('Not valid JSON: line 3');
      await expect(page.getByRole('button', { name: 'Stage the change' })).toBeDisabled();
      await capture(page, name, 'editor-invalid');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(
        '{\n  "status": "pending",\n  "big": 123456789012345678901234567890\n}',
      );
      await page.getByRole('button', { name: 'Stage the change' }).click();

      await expect(page.getByTestId('search-pending')).toHaveText('3 documents to apply');
      await capture(page, name, 'pending');

      await page.getByRole('button', { name: /Review and apply \(3\)/ }).click();
      const dialog = page.getByTestId('search-apply-dialog');
      await expect(page.getByTestId('search-not-atomic')).toContainText(
        'no transaction across documents',
      );
      await expect(dialog).toContainText(
        'PUT /orders/_doc/o-10000?if_seq_no=0&if_primary_term=1&refresh=wait_for',
      );
      await expect(dialog).toContainText('DELETE /orders/_doc/o-10001?if_seq_no=0');
      await expect(dialog).toContainText('PUT /orders/_doc/o-new-1?op_type=create');
      await capture(page, name, 'preview');
      await page.getByRole('button', { name: 'Apply (3)' }).click();
      await expect(dialog).toBeHidden();
      const toasts = page.getByRole('region', { name: /Notifications/ });
      await expect(toasts).toContainText('3 documents changed');
      await expect(page.getByTestId('search-pending')).toHaveCount(0);
      // The tab shows the new state.
      await expect(cell(grid, 0, 1)).toBeVisible();
      await expect(grid).toContainText('refunded');

      // The journal entry and its revert.
      await toasts.getByRole('button', { name: 'Journal' }).click();
      const detail = page.getByRole('complementary', { name: 'Change set' });
      await expect(detail).toContainText('orders');
      await expect(page.getByTestId('journal-statements')).toContainText(
        'DELETE /orders/_doc/o-10001',
      );
      await capture(page, name, 'journal-entry');
      await detail.getByRole('button', { name: 'Revert this change set…' }).click();
      await expect(dialog).toContainText('DELETE /orders/_doc/o-new-1?if_seq_no=1');
      await expect(dialog).toContainText('PUT /orders/_doc/o-10001?op_type=create');
      await capture(page, name, 'revert');
      await page.getByRole('button', { name: 'Revert (3)' }).click();
      await expect(toasts).toContainText('Change set reverted (3 documents)');
    });

    test('a change made meanwhile is a conflict shown against the server version', async ({
      page,
    }) => {
      await connect(page);
      const grid = await openIndex(page, /^orders$/, /^Documents of orders/);
      await (
        await rowMenu(page, grid, 0)
      )
        .getByRole('menuitem', { name: /Edit the document/ })
        .click();
      await expect(sourceEditor(page)).toContainText('"status": "paid"');
      await sourceEditor(page).click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText('{ "status": "mine" }');
      await page.getByRole('button', { name: 'Stage the change' }).click();
      // Someone else writes the document.
      expect(
        await page.evaluate(() =>
          (window as MockWindow).__YADBE_MOCK_SEARCH__?.touch('orders', 'o-10000'),
        ),
      ).toBe(true);
      await page.getByRole('button', { name: /Review and apply \(1\)/ }).click();
      await page.getByRole('button', { name: 'Apply (1)' }).click();
      const conflict = page.getByTestId('search-conflict');
      await expect(conflict).toContainText('"touched": true');
      await expect(conflict).toContainText('"status": "mine"');
      await expect(page.getByTestId('search-stopped')).toContainText(
        'the document changed on the server',
      );
      await capture(page, name, 'conflict');
      await page.getByRole('button', { name: 'Keep mine, overwrite theirs' }).click();
      await expect(page.getByTestId('search-apply-dialog')).toContainText('if_seq_no=1');
      await page.getByRole('button', { name: 'Apply (1)' }).click();
      await expect(page.getByRole('region', { name: /Notifications/ })).toContainText(
        '1 document changed',
      );
    });

    test('data streams and read-only connections say why documents stay as they are', async ({
      page,
    }) => {
      await connect(page);
      await expand(item(page, /^Data streams/));
      const grid = await openIndex(page, /^logs-web$/, /^Documents of logs-web/);
      await expect(page.getByTestId('search-data-stream')).toBeVisible();
      const menu = await rowMenu(page, grid, 0);
      await expect(menu.getByRole('menuitem', { name: /Edit the document/ })).toBeDisabled();
      await expect(menu).toContainText('a data stream is append-only');
      await expect(menu.getByRole('menuitem', { name: /Duplicate/ })).toBeEnabled();
      await capture(page, name, 'data-stream');
      await page.keyboard.press('Escape');

      await item(page, SEARCH).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const form = page.getByRole('dialog', { name: 'Edit connection' });
      await form.getByRole('switch', { name: /Read-only/ }).click();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      const orders = await openIndex(page, /^orders$/, /^Documents of orders/);
      await expect(page.getByTestId('search-read-only')).toContainText('Read-only connection');
      await expect(page.getByRole('button', { name: 'Add a document' })).toBeDisabled();
      const readOnlyMenu = await rowMenu(page, orders, 0);
      await expect(
        readOnlyMenu.getByRole('menuitem', { name: 'Delete the document' }),
      ).toBeDisabled();
      await capture(page, name, 'read-only');
    });

    test('the console marks where the server says a request is wrong', async ({ page }) => {
      await expect(page.getByText('MongoDB, Redis or Valkey, Elasticsearch')).toBeVisible();
      await connect(page);
      await item(page, SEARCH).dblclick();
      const text = page.getByTestId('search-console-editor').locator('.cm-content');
      await expect(text).toBeVisible();
      await text.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText('POST /orders/_search\n{\n  "size": 1,\n}\n');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.locator('.cm-error-range')).toHaveCount(1);
      await capture(page, name, 'console-mark');
      // Typing clears the mark: it belongs to the text that ran.
      await page.keyboard.insertText(' ');
      await expect(page.locator('.cm-error-range')).toHaveCount(0);
    });
  });
}
