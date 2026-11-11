import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface MockControls {
  setLatency(ms: number): void;
  setQueryTick(ms: number): void;
  setHistoryDebounce(ms: number): void;
  clearSavedQueries(): void;
  getFile(path: string): string | undefined;
  commands: {
    createSavedQuery(query: {
      name: string;
      sql: string;
      description: string;
      tags: string[];
      folderId: string | null;
      connectionId: string | null;
      database: string | null;
      snippetTrigger: string | null;
    }): Promise<unknown>;
  };
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

const views = (page: Page) => page.getByRole('tablist', { name: 'Sidebar view' });
const panel = (page: Page) => page.getByRole('region', { name: 'Saved queries' });
const tree = (page: Page) => panel(page).getByRole('tree', { name: 'Saved queries and folders' });
const row = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}`) });
const search = (page: Page) =>
  panel(page).getByRole('textbox', { name: 'Search the saved queries' });
const detail = (page: Page) =>
  panel(page).getByRole('complementary', { name: 'Details of the saved query' });
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const tabList = (page: Page) => page.getByRole('tablist', { name: 'Tabs' });
const dialog = (page: Page) => page.getByRole('dialog');

async function openLibrary(page: Page) {
  await views(page).getByRole('tab', { name: 'Saved' }).click();
  await expect(panel(page)).toBeVisible();
  await expect(row(page, 'Reports')).toBeVisible();
}

/** Opens a connection from the sidebar and waits for its query tab. */
async function openQueryTab(page: Page, connection: string) {
  await sidebarItem(page, connection).dblclick();
  await expect(editor(page)).toBeVisible();
  await expect(sidebarItem(page, connection)).toHaveAccessibleName(/Connected/);
}

/** Replaces the editor's text (CodeMirror reads it from the input events). */
async function setScript(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  if (text !== '') await page.keyboard.insertText(text);
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
        (window as MockWindow).__yadbeMock?.setQueryTick(15);
        (window as MockWindow).__yadbeMock?.setHistoryDebounce(0);
      });
    });

    test('the Saved view lists folders and queries, the shortcut shows it with the search focused', async ({
      page,
    }) => {
      await page.keyboard.press('ControlOrMeta+Shift+b');
      await expect(panel(page)).toBeVisible();
      await expect(search(page)).toBeFocused();
      await expect(views(page).getByRole('tab', { name: 'Saved' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // Folders first, each sorted by name, nested ones under their parent; queries after.
      await expect(row(page, 'Reports')).toHaveAttribute('aria-expanded', 'true');
      await expect(row(page, 'Monthly')).toHaveAttribute('aria-level', '2');
      await expect(row(page, 'Revenue per month')).toHaveAttribute('aria-level', '3');
      await expect(row(page, 'Customers without orders')).toHaveAttribute('aria-level', '1');
      await row(page, 'Revenue per month').click();
      await expect(detail(page)).toContainText('date_trunc');
      await expect(detail(page)).toContainText('Everywhere');
      await capture(page, name, 'library-view');
      // Folding a folder hides what it holds.
      await row(page, 'Reports').click();
      await expect(row(page, 'Reports')).toHaveAttribute('aria-expanded', 'false');
      await expect(row(page, 'Revenue per month')).toHaveCount(0);
      await row(page, 'Reports').click();
      await expect(row(page, 'Revenue per month')).toBeVisible();
    });

    test('search: names match fuzzily, texts by prefix, both highlighted', async ({ page }) => {
      await openLibrary(page);
      await search(page).fill('rvn');
      // A fuzzy match on the name: its characters are emphasized in the row.
      await expect(row(page, 'Revenue per month').locator('mark').first()).toBeVisible();
      await search(page).fill('trunc');
      // Found in the statement only: the row is there, the words are marked in the detail.
      await expect(row(page, 'Revenue per month')).toBeVisible();
      await row(page, 'Revenue per month').click();
      await expect(detail(page).locator('mark').first()).toHaveText('trunc');
      await capture(page, name, 'library-search');
      await search(page).fill('zzzzzz');
      await expect(panel(page).getByText('No saved query matches.')).toBeVisible();
      await search(page).press('Escape');
      await expect(row(page, 'Reports')).toBeVisible();
    });

    test('the scope filter keeps the global queries and the connection’s', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await openLibrary(page);
      await expect(row(page, 'Stock below threshold')).toBeVisible();
      await expect(row(page, 'Table sizes')).toBeVisible();
      await panel(page).getByRole('radio', { name: 'This connection' }).click();
      // Bound to the reporting connection: gone. Bound to this one, or global: still there.
      await expect(row(page, 'Stock below threshold')).toHaveCount(0);
      await expect(row(page, 'Table sizes')).toBeVisible();
      await expect(row(page, 'Duplicate emails')).toBeVisible();
      await capture(page, name, 'library-scope');
      await panel(page).getByRole('radio', { name: 'All' }).click();
      await expect(row(page, 'Stock below threshold')).toBeVisible();
    });

    test('keyboard: arrows move, left and right fold, F2 renames in place, Delete confirms', async ({
      page,
    }) => {
      await openLibrary(page);
      await tree(page).focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      await expect(tree(page)).toHaveAttribute('aria-activedescendant', /.+/);
      // Folders come first, by name: Debugging is the first.
      await page.keyboard.press('Home');
      await expect(row(page, 'Debugging')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowLeft');
      await expect(row(page, 'Debugging')).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('ArrowRight');
      await expect(row(page, 'Debugging')).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(row(page, 'Blocking sessions')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('F2');
      const field = tree(page).getByRole('textbox', { name: /^Name of Blocking sessions/ });
      await expect(field).toBeFocused();
      await field.fill('Who blocks whom');
      await capture(page, name, 'library-rename');
      await field.press('Enter');
      await expect(row(page, 'Who blocks whom')).toBeVisible();
      await expect(row(page, 'Blocking sessions')).toHaveCount(0);
      // Esc leaves the name as it was.
      await tree(page).focus();
      await page.keyboard.press('F2');
      await tree(page)
        .getByRole('textbox', { name: /^Name of Who blocks whom/ })
        .fill('nope');
      await page.keyboard.press('Escape');
      await expect(row(page, 'Who blocks whom')).toBeVisible();
      await tree(page).focus();
      await page.keyboard.press('Delete');
      await expect(dialog(page)).toContainText('Delete “Who blocks whom”?');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(row(page, 'Who blocks whom')).toBeVisible();
      await tree(page).focus();
      await page.keyboard.press('Delete');
      await dialog(page).getByRole('button', { name: 'Delete' }).click();
      await expect(row(page, 'Who blocks whom')).toHaveCount(0);
    });

    test('a query is moved between folders by dragging, or with Move to', async ({ page }) => {
      await openLibrary(page);
      await row(page, 'Duplicate emails').dragTo(row(page, 'Maintenance'));
      await expect(row(page, 'Duplicate emails')).toHaveAttribute('aria-level', '2');
      // Dropped on the empty part of the list: back to the root.
      await row(page, 'Duplicate emails').dragTo(tree(page), {
        targetPosition: { x: 40, y: 560 },
      });
      await expect(row(page, 'Duplicate emails')).toHaveAttribute('aria-level', '1');
      // A folder cannot go into what it holds: the drop is refused.
      await row(page, 'Reports').dragTo(row(page, 'Monthly'));
      await expect(row(page, 'Reports')).toHaveAttribute('aria-level', '1');
      await row(page, 'Customers without orders').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Move to' }).hover();
      await page.getByRole('menuitem', { name: 'Reports / Monthly' }).click();
      await expect(row(page, 'Customers without orders')).toHaveAttribute('aria-level', '3');
    });

    test('a folder is created, renamed in place and deleted with its content counted', async ({
      page,
    }) => {
      await openLibrary(page);
      await panel(page).getByRole('button', { name: 'New folder' }).click();
      const field = tree(page).getByRole('textbox', { name: /^Name of New folder/ });
      await expect(field).toBeFocused();
      await field.fill('Scratch');
      await field.press('Enter');
      await expect(row(page, 'Scratch')).toBeVisible();
      await row(page, 'Reports').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(dialog(page)).toContainText('Delete the folder “Reports”?');
      await expect(dialog(page)).toContainText('1 subfolder');
      await expect(dialog(page)).toContainText('4 saved queries');
      await capture(page, name, 'library-delete-folder');
      await dialog(page).getByRole('button', { name: 'Delete' }).click();
      await expect(row(page, 'Reports')).toHaveCount(0);
      await expect(row(page, 'Revenue per month')).toHaveCount(0);
    });

    test('save from the editor, then update the saved query when the text changes', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '-- Late orders\nselect id from orders where shipped_at is null;');
      await page.keyboard.press('ControlOrMeta+Shift+l');
      await expect(dialog(page)).toBeVisible();
      // The name comes from the first comment.
      await expect(dialog(page).getByLabel('Name')).toHaveValue('Late orders');
      await dialog(page).getByLabel('Folder').selectOption({ label: 'Reports' });
      await dialog(page).getByLabel('Tags').fill('orders, ops');
      await capture(page, name, 'library-save-dialog');
      await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        page.getByText('Saved “Late orders” to the library.', { exact: true }),
      ).toBeVisible();
      // The tab now stands for that query: nothing to update yet.
      await expect(page.getByRole('button', { name: 'Update saved query' })).toHaveCount(0);
      await openLibrary(page);
      await expect(row(page, 'Late orders')).toBeVisible();

      await editor(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.insertText('\n-- and still open');
      const update = page.getByRole('button', { name: 'Update saved query' });
      await expect(update).toBeVisible();
      // A mark of its own on the tab, not the dot of a modified file.
      await expect(
        tabList(page).getByRole('tab', { name: /Changed from its saved query/ }),
      ).toBeVisible();
      await capture(page, name, 'library-update-saved');
      await update.click();
      await expect(page.getByText('Updated “Late orders”.', { exact: true })).toBeVisible();
      await expect(update).toHaveCount(0);
      await row(page, 'Late orders').click();
      await expect(detail(page)).toContainText('and still open');
    });

    test('Save to library saves only the selection when there is one', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 1;\nselect 2 as second;');
      await page.keyboard.press('Shift+Home');
      await page.keyboard.press('ControlOrMeta+Shift+l');
      await expect(dialog(page).getByLabel('Statement')).toHaveValue('select 2 as second;');
      await expect(dialog(page)).toContainText('Only the selected text is saved.');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    });

    test('a saved query opens in a tab that remembers it; its menu inserts and runs', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 0;\n');
      await openLibrary(page);
      await row(page, 'Duplicate emails').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Insert at the cursor' }).click();
      await expect(editor(page)).toContainText('HAVING count(*) > 1');
      await row(page, 'Customers without orders').dblclick();
      await expect(editor(page)).toContainText('NOT EXISTS');
      await expect(page.getByRole('button', { name: 'Update saved query' })).toHaveCount(0);
      await row(page, 'Duplicate emails').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Run/ }).click();
      await expect(page.getByTestId('run-status')).toContainText(/rows?/i, { timeout: 10_000 });
    });

    test('running a saved query goes through the dangerous statement guard', async ({ page }) => {
      await page.evaluate(() =>
        (window as MockWindow).__yadbeMock?.commands.createSavedQuery({
          name: 'Wipe orders',
          sql: 'DELETE FROM orders;',
          description: '',
          tags: [],
          folderId: null,
          connectionId: 'conn-local-pg',
          database: null,
          snippetTrigger: null,
        }),
      );
      await openLibrary(page);
      await row(page, 'Wipe orders').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Run/ }).click();
      await expect(dialog(page)).toContainText('DELETE without WHERE');
      await capture(page, name, 'library-run-guard');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    });

    test('details can be edited: scope, folder, tags and snippet trigger', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await openLibrary(page);
      await row(page, 'Duplicate emails').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit details…' }).click();
      await expect(dialog(page).getByLabel('Statement')).toHaveValue(/HAVING/);
      await dialog(page).getByRole('radio', { name: 'On local postgres' }).click();
      await dialog(page).getByLabel('Tags').fill('data quality');
      await dialog(page).getByRole('switch', { name: 'Use as a snippet' }).click();
      await dialog(page).getByRole('textbox', { name: 'Trigger word' }).fill('9bad');
      await expect(dialog(page)).toContainText('Letters, digits and _');
      await expect(dialog(page).getByRole('button', { name: 'Save' })).toBeDisabled();
      await dialog(page).getByRole('textbox', { name: 'Trigger word' }).fill('dupes');
      await capture(page, name, 'library-edit-dialog');
      await dialog(page).getByRole('button', { name: 'Save' }).click();
      await expect(row(page, 'Duplicate emails')).toContainText('dupes');
      await expect(row(page, 'Duplicate emails').getByTestId('scope-tag')).toHaveText(
        'local postgres',
      );
      await row(page, 'Duplicate emails').click();
      await expect(detail(page)).toContainText('data quality');
    });

    test('snippets expand in the editor and Tab moves between their fields', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await page.keyboard.type('lastr');
      const options = page.getByRole('listbox');
      await expect(options.getByRole('option', { name: /lastrows/ })).toBeVisible();
      await capture(page, name, 'library-snippet-completion');
      // The list settles once every source answered: `Tab` accepts only then.
      await page.waitForTimeout(300);
      await page.keyboard.press('Tab');
      await expect(editor(page)).toContainText('SELECT *');
      await expect(editor(page)).toContainText('FROM table');
      await expect(editor(page)).toContainText('LIMIT 50;');
      // The first field is selected: typing replaces it, Tab goes to the next one.
      await page.keyboard.type('orders');
      await page.keyboard.press('Tab');
      await page.keyboard.type('created_at');
      await page.keyboard.press('Tab');
      await page.keyboard.type('10');
      await expect(editor(page)).toContainText('FROM orders');
      await expect(editor(page)).toContainText('ORDER BY created_at DESC');
      await expect(editor(page)).toContainText('LIMIT 10;');
      await capture(page, name, 'library-snippet-expanded');
    });

    test('built-in snippets follow the dialect and are copied to be customized', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, '');
      await page.keyboard.type('selt');
      await expect(page.getByRole('listbox').getByRole('option', { name: /selt/ })).toBeVisible();
      await page.waitForTimeout(300);
      await page.keyboard.press('Tab');
      await expect(editor(page)).toContainText('LIMIT 100;');
      await openLibrary(page);
      await panel(page).getByText('Built-in snippets').click();
      await row(page, 'Count rows by column').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Copy to my library…' }).click();
      await expect(dialog(page).getByRole('textbox', { name: 'Trigger word' })).toHaveValue('cnt');
      await expect(dialog(page).getByLabel('Name')).toHaveValue('Count rows by column');
      await capture(page, name, 'library-builtin-copy');
      await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(row(page, 'Count rows by column').first()).toBeVisible();
    });

    test('the palette finds saved queries with *, opens them or inserts them', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 0;\n');
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox').fill('*rev');
      const option = page.getByRole('option', { name: /Revenue per month/ });
      await expect(option).toBeVisible();
      await capture(page, name, 'library-palette');
      // ⌘↵ inserts at the cursor, ↵ opens in a new tab.
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(editor(page)).toContainText('date_trunc');
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox').fill('*customers without');
      await page.keyboard.press('Enter');
      await expect(editor(page)).toContainText('NOT EXISTS');
      await expect(tabList(page).getByRole('tab')).toHaveCount(2);
    });

    test('a history entry is saved to the library with its star', async ({ page }) => {
      await views(page).getByRole('tab', { name: 'History' }).click();
      const entries = page
        .getByRole('region', { name: 'History' })
        .getByRole('listbox', { name: 'Statements run' })
        .getByRole('option');
      await entries.nth(3).click();
      const star = page.getByRole('button', { name: 'Save to the library…' });
      await star.click();
      await expect(dialog(page)).toBeVisible();
      await capture(page, name, 'library-from-history');
      await dialog(page).getByLabel('Name').fill('From the history');
      await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        page.getByText('Saved “From the history” to the library.', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Already in the library' })).toBeVisible();
      await openLibrary(page);
      await expect(row(page, 'From the history')).toBeVisible();
    });

    test('the library is exported to a file and imported back', async ({ page }) => {
      await openLibrary(page);
      await panel(page).getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Export the library…' }).click();
      await expect(page.getByText('Library exported.', { exact: true })).toBeVisible();
      const file = await page.evaluate(() =>
        (window as MockWindow).__yadbeMock?.getFile('/home/ana/exports/yadbe-library.json'),
      );
      expect(file).toContain('"format": "yadbe-library"');
      // No scope in the file: connection ids mean nothing elsewhere.
      expect(file).not.toContain('conn-local-pg');
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.clearSavedQueries();
      });
      await expect(panel(page).getByText(/No saved query yet/)).toBeVisible();
      await panel(page).getByRole('button', { name: 'More actions' }).click();
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('menuitem', { name: 'Import a library…' }).click();
      await (
        await chooser
      ).setFiles({
        name: 'yadbe-library.json',
        mimeType: 'application/json',
        buffer: Buffer.from(file ?? ''),
      });
      await expect(page.getByText(/^Imported \d+ queries and 4 folders/)).toBeVisible();
      await expect(row(page, 'Revenue per month')).toBeVisible();
      await capture(page, name, 'library-imported');
    });

    test('an empty library says how to fill it', async ({ page }) => {
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.clearSavedQueries();
      });
      await views(page).getByRole('tab', { name: 'Saved' }).click();
      await expect(panel(page).getByText(/No saved query yet/)).toBeVisible();
      await capture(page, name, 'library-empty');
    });
  });
}
