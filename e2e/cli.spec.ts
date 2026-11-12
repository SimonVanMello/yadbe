import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

/** What the backend hands the frontend for a command line (F-126), in the browser mock. */
async function launchWith(page: Page, requests: unknown[]) {
  await page.addInitScript((injected) => {
    (globalThis as { __YADBE_MOCK_LAUNCH__?: unknown[] }).__YADBE_MOCK_LAUNCH__ = injected;
  }, requests);
  await page.goto('/');
}

const parsed = (fields: Record<string, unknown>) => ({
  format: 'url',
  engine: 'postgres',
  host: null,
  port: null,
  database: null,
  username: null,
  filePath: null,
  tlsMode: null,
  caCertPath: null,
  options: [],
  passwordId: null,
  ignoredKeys: [],
  ...fields,
});

for (const { name, colorScheme } of THEMES) {
  test.describe(`command line, ${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('a script opens in a query tab on a connection, and is not run', async ({ page }) => {
      await launchWith(page, [{ kind: 'sqlFile', path: '/home/ana/queries/orders-report.sql' }]);
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      const editor = page.getByRole('textbox', { name: 'SQL editor' });
      await expect(editor).toContainText('Orders of the last week');
      await expect(page.getByRole('tab', { name: /orders-report/ })).toBeVisible();
      await expect(page.getByText('Run a query to see its results here.')).toBeVisible();
      await capture(page, name, 'cli-script');
    });

    test('a URL of a saved connection opens it', async ({ page }) => {
      await launchWith(page, [
        {
          kind: 'connection',
          parsed: parsed({ host: 'localhost', database: 'app_dev', username: 'postgres' }),
          passwordIgnored: false,
        },
      ]);
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(
        page.getByRole('tree', { name: 'Connections' }).getByRole('treeitem', {
          name: /^local postgres,/,
        }),
      ).toHaveAccessibleName(/Connected/);
    });

    test('another URL fills the connection form, without its password', async ({ page }) => {
      await launchWith(page, [
        {
          kind: 'connection',
          parsed: parsed({ host: 'db.example.com', port: 6543, database: 'shop', username: 'app' }),
          passwordIgnored: true,
        },
      ]);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Host')).toHaveValue('db.example.com');
      await expect(dialog.getByLabel('Port')).toHaveValue('6543');
      await expect(dialog.getByLabel('Database', { exact: true })).toHaveValue('shop');
      await expect(dialog.getByLabel('User')).toHaveValue('app');
      await expect(dialog.getByRole('textbox', { name: 'Password' })).toHaveValue('');
      await expect(
        page.getByText('The password in the command line was ignored').first(),
      ).toBeVisible();
      await capture(page, name, 'cli-url-form');
    });

    test('an unusable argument is explained', async ({ page }) => {
      await launchWith(page, [{ kind: 'rejected', reason: 'notAScript', argument: 'data.csv' }]);
      await expect(
        page.getByText(/data\.csv from the command line is not a script/).first(),
      ).toBeVisible();
    });
  });
}
