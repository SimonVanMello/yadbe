import { expect, test, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`keyvalue-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) =>
  tree(page).getByRole('treeitem', typeof name === 'string' ? { name, exact: true } : { name });

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Connects a Redis connection of the mock: its saved database opens in the tree. */
async function connect(page: Page, name: RegExp) {
  await item(page, name).click();
  await item(page, name).locator('span').first().click();
  await expect(item(page, name)).toHaveAccessibleName(/Connected/);
}

/** Opens a key of db0 of "cache" by its path in the tree. */
async function openKey(page: Page, path: string[]) {
  for (const part of path.slice(0, -1)) await expand(item(page, part).first());
  await item(page, path.at(-1) ?? '')
    .first()
    .dblclick();
}

/** The console of a connection: its query tab, with the commands typed in. */
async function typeInConsole(page: Page, connection: RegExp, commands: string) {
  await item(page, connection).dblclick();
  const editor = page.getByTestId('kv-console-editor').locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(commands);
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test.beforeEach(async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^cache,/)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(10);
        (window as MockWindow).__yadbeMock?.setLatency(20);
      });
    });

    test('the connection form of Redis shows its own fields', async ({ page }) => {
      await page.getByRole('button', { name: 'New connection' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByRole('radio', { name: 'Redis / Valkey' }).click();
      await expect(dialog.getByRole('textbox', { name: 'ACL user' })).toBeVisible();
      await expect(dialog.getByLabel('Database index')).toHaveAttribute('placeholder', '0');
      await expect(dialog.getByLabel('Key delimiter')).toHaveAttribute('placeholder', ':');
      await dialog.getByLabel('Database index').fill('3');
      await dialog.getByLabel('Host').fill('cache.example.com');
      await dialog.getByRole('switch', { name: 'Read-only' }).click();
      await expect(dialog.getByText('ACL user limited to reads')).toBeVisible();
      await capture(page, name, 'form');
    });

    test('the explorer groups keys by namespace, with type and time to live', async ({ page }) => {
      await connect(page, /^cache,/);
      const db0 = item(page, 'db0');
      await expect(db0).toHaveAttribute('aria-expanded', 'true');
      await expect(item(page, 'session')).toBeVisible();
      await expand(item(page, 'user'));
      await expand(item(page, '1'));
      await expect(item(page, 'profile').first()).toBeVisible();
      await expect(tree(page).getByText('hash').first()).toBeVisible();
      await expand(item(page, 'session'));
      await expect(
        tree(page)
          .getByText(/^\d+ min \d\d s$/)
          .first(),
      ).toBeVisible();
      await capture(page, name, 'tree');

      // A pattern scans again with MATCH: only the matching keys remain.
      await tree(page).getByRole('textbox', { name: 'Keys of db0 matching' }).fill('config:*');
      await expect(item(page, 'session')).toHaveCount(0);
      await expect(item(page, 'config')).toBeVisible();
    });

    test('a large keyspace pauses its scan and loads more on demand', async ({ page }) => {
      await connect(page, /^cache,/);
      await expand(item(page, 'db3'));
      const state = tree(page).getByRole('treeitem', { name: 'Key scan' });
      await expect(state).toContainText('10,000 of ~60,000 keys listed');
      await expect(item(page, 'metrics')).toBeVisible();
      await capture(page, name, 'scan-paused');
      await state.getByRole('button', { name: '10,000 more' }).click();
      await expect(state).toContainText('20,000 of ~60,000 keys listed');
      await state.getByRole('button', { name: 'All' }).click();
      await expect(state).toHaveCount(0, { timeout: 20_000 });
    });

    test('each key type has its viewer', async ({ page }) => {
      await connect(page, /^cache,/);
      // Hash: its fields in the grid.
      await openKey(page, ['user', '1', 'profile']);
      await expect(page.getByRole('heading', { name: 'user:1:profile' })).toBeVisible();
      await expect(page.getByText('5 fields')).toBeVisible();
      await expect(page.getByRole('grid', { name: 'user:1:profile' })).toBeVisible();
      await capture(page, name, 'viewer-hash');

      // String holding JSON: pretty JSON by default.
      await openKey(page, ['config', 'app']);
      await expect(page.getByTestId('kv-json')).toContainText('regions');
      await capture(page, name, 'viewer-string-json');
      await page.getByRole('radio', { name: 'Hex' }).click();
      await expect(page.getByTestId('kv-string')).toContainText('00000000  7b 22');

      // A long list: read a page at a time.
      await openKey(page, ['queue', 'emails']);
      await expect(page.getByText('1,000 of 2,400 rows read')).toBeVisible();
      await page.getByRole('button', { name: 'Read 1,000 more' }).click();
      await expect(page.getByText('2,000 of 2,400 rows read')).toBeVisible();
      await capture(page, name, 'viewer-list');

      await openKey(page, ['leaderboard', 'global']);
      await expect(page.getByRole('columnheader', { name: /score/ })).toBeVisible();
      await capture(page, name, 'viewer-zset');

      await openKey(page, ['events', 'orders']);
      await expect(page.getByRole('columnheader', { name: /fields/ })).toBeVisible();
      await capture(page, name, 'viewer-stream');

      await openKey(page, ['doc', 'product', '42']);
      await expect(page.getByTestId('kv-json')).toContainText('Mechanical keyboard');
      await capture(page, name, 'viewer-json-document');

      await openKey(page, ['bloom', 'signups']);
      await expect(page.getByText('no viewer for keys of type MBbloom--')).toBeVisible();

      await openKey(page, ['bin', 'thumb', '\\xff\\xd8\\xff\\xe0']);
      await expect(page.getByText('binary key')).toBeVisible();
      await expect(page.getByTestId('kv-string')).toContainText('ff d8 ff e0');
      await capture(page, name, 'viewer-binary');

      // The keys of user 3 only, through the scan's MATCH pattern.
      await tree(page).getByRole('textbox', { name: 'Keys of db0 matching' }).fill('user:3:*');
      await expect(item(page, 'session')).toHaveCount(0);
      await expand(item(page, 'user'));
      await expand(item(page, '3'));
      await item(page, 'roles').dblclick();
      await expect(page.getByRole('columnheader', { name: /member/ })).toBeVisible();
      await capture(page, name, 'viewer-set');
    });

    test('the console runs redis-cli lines and shapes the replies', async ({ page }) => {
      await connect(page, /^cache,/);
      await typeInConsole(
        page,
        /^cache,/,
        'PING\nHGETALL user:1:profile\n# a comment\nLRANGE queue:jobs:high 0 -1\nZRANGE leaderboard:weekly:2026-45 0 2 WITHSCORES\nXRANGE events:orders - +\nGET nothing\nINCR counter:visits\nSELECT 1\nDBSIZE',
      );
      await page.keyboard.press('ControlOrMeta+Enter');
      const output = page.getByLabel('Replies');
      await expect(output.getByText('PONG')).toBeVisible();
      await expect(output.getByText('(nil)')).toBeVisible();
      await expect(output.getByText('(integer) 1048577')).toBeVisible();
      await expect(output.getByText('db1>')).toBeVisible();
      await capture(page, name, 'console');

      // Streaming commands are not supported yet; nothing after them runs.
      await typeInConsole(page, /^cache,/, 'MONITOR\nPING');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(output.getByText('MONITOR is not supported yet')).toBeVisible();
      await expect(output.getByText('1 line not run.')).toBeVisible();
    });

    test('dangerous commands are confirmed with their effect', async ({ page }) => {
      await connect(page, /^cache,/);
      await typeInConsole(page, /^cache,/, 'DBSIZE\nFLUSHDB');
      await page.keyboard.press('ControlOrMeta+Enter');
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await expect(dialog.getByText('Run a dangerous command?')).toBeVisible();
      await expect(dialog.getByText(/Deletes every key of database 0: \d+ keys\./)).toBeVisible();
      await capture(page, name, 'danger');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByLabel('Replies').getByText('FLUSHDB')).toHaveCount(0);
    });

    test('a read-only connection refuses writes in the backend', async ({ page }) => {
      await connect(page, /^sessions · prod,/);
      await typeInConsole(page, /^sessions · prod,/, 'GET k\nSET k v');
      await page.keyboard.press('ControlOrMeta+Enter');
      const output = page.getByLabel('Replies');
      await expect(
        output.getByText('This connection is read-only: SET changes data'),
      ).toBeVisible();
      await capture(page, name, 'read-only');
    });
  });
}
