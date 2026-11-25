import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface SavedDraft {
  name: string;
  sql: string;
  description: string;
  tags: string[];
  folderId: string | null;
  connectionId: string | null;
  database: string | null;
  snippetTrigger: string | null;
  family: 'sql' | 'document' | 'keyValue' | 'search';
}

interface MockControls {
  setLatency(ms: number): void;
  commands: { createSavedQuery(query: SavedDraft): Promise<unknown> };
}

type MockWindow = Window & { __yadbeMock?: MockControls };

const MIXED: Pick<SavedDraft, 'name' | 'sql' | 'family' | 'connectionId'>[] = [
  {
    name: 'Large orders',
    sql: 'db.orders.find({ total: { $gt: 1000 } }).sort({ total: -1 })',
    family: 'document',
    connectionId: null,
  },
  {
    name: 'Cached sessions',
    sql: 'SCAN 0 MATCH session:* COUNT 100',
    family: 'keyValue',
    connectionId: 'conn-cache',
  },
  {
    name: 'Failed logins last hour',
    sql: 'GET logs-*/_search\n{ "query": { "match": { "event": "login_failed" } } }',
    family: 'search',
    connectionId: null,
  },
];

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

const panel = (page: Page) => page.getByRole('region', { name: 'Saved queries' });
const tree = (page: Page) => panel(page).getByRole('tree', { name: 'Saved queries and folders' });
const row = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}`) });
const familyFilter = (page: Page) =>
  panel(page).getByRole('combobox', { name: 'Show the queries of one kind of database' });

async function seedMixedLibrary(page: Page) {
  await page.evaluate(async (queries) => {
    for (const query of queries) {
      await (window as MockWindow).__yadbeMock?.commands.createSavedQuery({
        ...query,
        description: '',
        tags: [],
        folderId: null,
        database: null,
        snippetTrigger: null,
      });
    }
  }, MIXED);
  await page
    .getByRole('tablist', { name: 'Sidebar view' })
    .getByRole('tab', { name: 'Saved' })
    .click();
  await expect(panel(page)).toBeVisible();
  await expect(row(page, 'Large orders')).toBeVisible();
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
      });
    });

    test('the Saved view marks the family of each query and filters by it', async ({ page }) => {
      await seedMixedLibrary(page);
      // SQL is the default and goes unmarked; the other families carry their kind.
      await expect(row(page, 'Large orders').getByTestId('family-tag')).toHaveText('Documents');
      await expect(row(page, 'Cached sessions').getByTestId('family-tag')).toHaveText('Key-value');
      await expect(row(page, 'Failed logins last hour').getByTestId('family-tag')).toHaveText(
        'Search',
      );
      await expect(row(page, 'Duplicate emails').getByTestId('family-tag')).toHaveCount(0);
      await row(page, 'Large orders').click();
      await expect(panel(page).getByRole('complementary')).toContainText('Documents');
      await capture(page, name, 'library-families');

      await familyFilter(page).selectOption({ label: 'Documents' });
      await expect(row(page, 'Large orders')).toBeVisible();
      await expect(row(page, 'Cached sessions')).toHaveCount(0);
      await expect(row(page, 'Duplicate emails')).toHaveCount(0);
      await capture(page, name, 'library-families-filtered');

      await familyFilter(page).selectOption({ label: 'All kinds of database' });
      await expect(row(page, 'Duplicate emails')).toBeVisible();
    });

    test('the save dialog says what the text is written for', async ({ page }) => {
      await seedMixedLibrary(page);
      await row(page, 'Cached sessions').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit details…' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('save-family')).toHaveText('Key-value');
      // A key-value query is not a snippet of the SQL editor.
      await expect(dialog.getByRole('switch', { name: 'Use as a snippet' })).toHaveCount(0);
      await capture(page, name, 'library-save-family');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    });

    test('a global script opens on a connection of its own kind of database', async ({ page }) => {
      await sidebarItem(page, 'local postgres').dblclick();
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toBeVisible();
      await seedMixedLibrary(page);
      await row(page, 'Large orders').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Open in a new tab' }).click();
      await expect(page.getByText(/^Opened on catalog · mongo/)).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveCount(0);
    });
  });
}
