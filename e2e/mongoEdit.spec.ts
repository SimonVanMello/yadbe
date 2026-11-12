import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * MongoDB edits on the mock backend (M4-4): pending changes marked in the grid and the documents
 * view, the typed field editor and the JSON editor, the preview in one transaction (replica set)
 * and one by one (standalone, with why), a conflict and its resolution, the journal entry and
 * its revert, and why a collection cannot be edited. Captures in both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`mongo-edit-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const MONGO = /^catalog · mongo,/;

async function connect(page: Page) {
  await item(page, MONGO).dblclick();
  await expect(item(page, MONGO)).toHaveAccessibleName(/Connected/);
}

async function openCollection(page: Page, name: string) {
  await connect(page);
  await expect(item(page, new RegExp(`^${name}$`))).toBeVisible();
  await item(page, new RegExp(`^${name}$`)).dblclick();
  await expect(page.getByTestId('collection-tab')).toBeVisible();
  await expect(page.getByTestId('collection-range')).toHaveText(/^1–/);
}

const grid = (page: Page) => page.getByRole('grid', { name: /^Documents of catalog\.customers/ });

/** A cell of the grid (row 0 is the first document; column 0 is `_id`). */
function cell(g: Locator, row: number, col: number): Locator {
  return g.locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

async function editName(page: Page, row: number, value: string) {
  await cell(grid(page), row, 1).dblclick();
  const form = page.getByTestId('doc-field-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Value').fill(value);
  await page.getByRole('button', { name: 'Keep change' }).click();
  await expect(form).toBeHidden();
}

async function setStandalone(page: Page) {
  await item(page, MONGO).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const form = page.getByRole('dialog', { name: 'Edit connection' });
  await form.locator('[data-field="replicaSet"]').fill('');
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

    test('edits are marked in both views, previewed in one transaction, journaled and reverted', async ({
      page,
    }) => {
      await openCollection(page, 'customers');
      // A few documents, so every mark fits on screen.
      await page.locator('[data-field="filter"]').fill('{ "vip": true }');
      await page.locator('[data-field="filter"]').press('Enter');
      await expect(page.getByTestId('collection-range')).toHaveText('1–12');
      await editName(page, 0, 'Ana Z.');
      // The field editor keeps the type: vip stays a boolean.
      await cell(grid(page), 2, 4).dblclick();
      const form = page.getByTestId('doc-field-form');
      await expect(form.getByLabel('Type')).toHaveValue('bool');
      await capture(page, name, 'field-editor');
      await form.getByLabel('Value').selectOption('false');
      await page.getByRole('button', { name: 'Keep change' }).click();
      // Delete a document from its context menu.
      await cell(grid(page), 1, 1).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Delete document' }).click();
      // Add one.
      await page.getByRole('button', { name: 'Add document' }).click();
      const json = page.getByTestId('doc-json-form');
      await json
        .getByRole('textbox')
        .fill('{ "name": "Zoé N.", "email": "zoe@example.com", "vip": false }');
      await capture(page, name, 'json-editor');
      await page.getByRole('button', { name: 'Keep change' }).click();
      await expect(page.getByTestId('doc-pending')).toHaveText('4 documents changed');
      await expect(grid(page).locator('[data-state="modified"]').first()).toBeVisible();
      await expect(grid(page).locator('[data-state="deleted"]').first()).toBeVisible();
      await expect(grid(page).locator('[data-state="inserted"]').first()).toBeVisible();
      await capture(page, name, 'pending-grid');

      await page.getByRole('radio', { name: 'Documents' }).click();
      const documents = page.getByRole('tree', { name: /^Documents of catalog\.customers/ });
      await expect(documents.locator('[data-state="modified"]').first()).toBeVisible();
      await expect(documents.locator('[data-state="deleted"]').first()).toBeVisible();
      await capture(page, name, 'pending-documents');

      await page.getByRole('button', { name: 'Review and apply…' }).click();
      const dialog = page.getByTestId('doc-apply-dialog');
      await expect(dialog.getByTestId('doc-operations')).toContainText(
        'session.startTransaction()',
      );
      await expect(dialog.getByTestId('doc-operations')).toContainText('coll.updateOne(');
      await expect(dialog.getByTestId('doc-operations')).toContainText('coll.deleteOne(');
      await expect(dialog.getByTestId('doc-operations')).toContainText('coll.insertOne(');
      await expect(dialog.getByTestId('doc-not-atomic')).toHaveCount(0);
      await capture(page, name, 'preview-atomic');
      await page.getByRole('button', { name: 'Apply (4)' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('doc-pending')).toHaveText('No changes');

      // The journal has the entry; its revert goes through the same dialog.
      await page.getByRole('button', { name: 'Journal', exact: true }).first().click();
      const entry = page.getByTestId('journal-statements');
      await expect(entry).toContainText('coll.updateOne(');
      await capture(page, name, 'journal');
      await page.getByRole('button', { name: 'Revert this change set…' }).click();
      await expect(dialog.getByTestId('doc-operations')).toContainText('coll.deleteOne(');
      await capture(page, name, 'revert');
      await page.getByRole('button', { name: 'Revert (4)' }).click();
      await expect(dialog).toBeHidden();
    });

    test('a document changed on the server conflicts: keep mine applies over it', async ({
      page,
    }) => {
      await openCollection(page, 'customers');
      await cell(grid(page), 1, 2).dblclick();
      await page.getByTestId('doc-field-form').getByLabel('Value').fill('bruno@example.org');
      await page.getByRole('button', { name: 'Keep change' }).click();
      await page.getByRole('button', { name: 'Review and apply…' }).click();
      await page.getByRole('button', { name: 'Apply (1)' }).click();
      const conflicts = page.getByTestId('doc-conflicts');
      await expect(conflicts).toContainText('The document changed on the server.');
      await expect(conflicts).toContainText('theirs@example.com');
      await capture(page, name, 'conflict');
      await conflicts.getByRole('radio', { name: 'Keep mine' }).click();
      await page.getByRole('button', { name: 'Resolve' }).click();
      await expect(page.getByTestId('doc-operations')).toContainText('theirs@example.com');
      await page.getByRole('button', { name: 'Apply (1)' }).click();
      await expect(page.getByTestId('doc-apply-dialog')).toBeHidden();
      await expect(page.getByTestId('doc-pending')).toHaveText('No changes');
    });

    test('a standalone server applies one by one and says why', async ({ page }) => {
      await setStandalone(page);
      await openCollection(page, 'customers');
      await editName(page, 0, 'Ana Z.');
      await page.getByRole('button', { name: 'Review and apply…' }).click();
      const dialog = page.getByTestId('doc-apply-dialog');
      await expect(dialog.getByTestId('doc-not-atomic')).toContainText(
        'no multi-document transactions',
      );
      await expect(dialog.getByTestId('doc-operations')).not.toContainText('startTransaction');
      await capture(page, name, 'preview-standalone');
    });

    test('views, projections and read-only connections say why they cannot be edited', async ({
      page,
    }) => {
      await openCollection(page, 'topRated');
      await expect(page.getByTestId('doc-edit-blocked')).toHaveText(
        'A view: its documents cannot be changed',
      );
      await capture(page, name, 'blocked-view');
      await item(page, /^customers$/).dblclick();
      await page.locator('[data-field="projection"]').fill('{ "name": 1 }');
      await page.locator('[data-field="projection"]').press('Enter');
      await expect(page.getByTestId('doc-edit-blocked')).toHaveText(
        'A projection hides fields: clear it to change documents',
      );
      await capture(page, name, 'blocked-projection');
      await page.locator('[data-field="projection"]').fill('');
      await page.locator('[data-field="projection"]').press('Enter');
      await expect(page.getByRole('button', { name: 'Add document' })).toBeVisible();
      await item(page, MONGO).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const form = page.getByRole('dialog', { name: 'Edit connection' });
      await form.getByRole('switch', { name: /Read-only/ }).click();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      await expect(page.getByTestId('doc-edit-blocked')).toHaveText(
        'Read-only connection: documents cannot be changed',
      );
    });
  });
}
