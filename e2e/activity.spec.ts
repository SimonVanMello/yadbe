import { expect, test, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
  setActivityFault: (connectionId: string, fault: 'insufficientPrivilege' | null) => void;
  startActivitySession: (
    connectionId: string,
    session: { id: string; [key: string]: unknown },
  ) => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`activity-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });

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

async function openMenu(page: Page, name: RegExp) {
  await item(page, name).click({ button: 'right' });
}

/** Connects "local postgres" and opens its activity monitor from the connection menu. */
async function openMonitor(page: Page, connection = /^local postgres,/) {
  await connect(page, connection);
  await openMenu(page, connection);
  await page.getByRole('menuitem', { name: 'Activity monitor' }).click();
  await expect(page.getByRole('tab', { name: /^Activity/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

const sessions = (page: Page) => page.getByRole('grid', { name: 'Sessions' });
const row = (page: Page, id: string) => page.locator(`#session-${id}`);

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 900 } });

    test.beforeEach(async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^shop · prod,/)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(20);
        (window as MockWindow).__yadbeMock?.setLatency(30);
      });
    });

    test('the monitor lists the sessions, the blocker first and the session it blocks', async ({
      page,
    }) => {
      await openMonitor(page);
      await expect(sessions(page)).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'sessions' })).toContainText(
        '1 blocked',
      );
      // Blockers come first, then what waits, then what runs.
      const ids = await sessions(page)
        .locator('[role="row"][id^="session-"]')
        .evaluateAll((rows) => rows.map((r) => r.id));
      expect(ids.slice(0, 3)).toEqual(['session-4821', 'session-4902', 'session-4950']);
      await expect(row(page, '4821')).toContainText('Blocks 1 session');
      await expect(row(page, '4902')).toContainText('Blocked · 4821');
      await expect(row(page, '5200')).toContainText('yadbe');
      // Background sessions stay out until asked for.
      await expect(row(page, '61')).toHaveCount(0);
      await page.getByRole('switch', { name: 'Background sessions' }).click();
      await expect(row(page, '61')).toBeVisible();
      await page.getByRole('switch', { name: 'Background sessions' }).click();
      await capture(page, name, 'monitor');

      await row(page, '4902').click();
      const detail = page.getByRole('region', { name: 'Session 4902' });
      await expect(detail).toContainText("UPDATE shop.orders SET status = 'shipped'");
      await expect(detail.getByRole('button', { name: 'Go to session 4821' })).toBeVisible();
      await detail.getByRole('button', { name: 'Go to session 4821' }).click();
      await expect(page.getByRole('region', { name: 'Session 4821' })).toBeVisible();
      await capture(page, name, 'detail');
    });

    test('filters by text and by state, and refreshes on demand', async ({ page }) => {
      await openMonitor(page);
      const filter = page.getByRole('textbox', { name: 'Filter the activity' });
      await filter.fill('analyst');
      await expect(row(page, '4950')).toBeVisible();
      await expect(row(page, '4821')).toHaveCount(0);
      await filter.fill('nobody');
      await expect(page.getByText('No session matches the filter.')).toBeVisible();
      await page.getByRole('button', { name: 'Clear the filter' }).click();
      await expect(row(page, '4821')).toBeVisible();
      await page.getByRole('radio', { name: 'Blocked', exact: true }).click();
      await expect(row(page, '4902')).toBeVisible();
      await expect(row(page, '4950')).toHaveCount(0);
      await page.getByRole('radio', { name: 'All', exact: true }).click();

      // A session the server started since shows up when the list is read again.
      await expect(row(page, '7000')).toHaveCount(0);
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.startActivitySession('conn-local-pg', {
          id: '7000',
          statement: 'SELECT pg_sleep(60)',
          runningSecs: 1,
        });
      });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(row(page, '7000')).toBeVisible();
      await page.getByRole('radio', { name: 'Locks' }).click();
      const locks = page.getByRole('grid', { name: 'Locks' });
      await expect(locks.getByRole('row').nth(1)).toContainText('Waiting');
      await capture(page, name, 'locks');
    });

    test('ending a blocker asks first, names the session and rolls the wait away', async ({
      page,
    }) => {
      await openMonitor(page);
      await row(page, '4821').click();
      await page.getByRole('button', { name: 'End the session' }).click();
      const dialog = page.getByRole('dialog', { name: 'End this session?' });
      await expect(dialog).toContainText('Session 4821');
      await expect(dialog).toContainText('shop_app from 10.0.4.17:51234');
      await expect(dialog).toContainText('Transaction open for');
      await expect(dialog).toContainText('Blocks 1 session');
      await expect(dialog).toContainText('SELECT * FROM shop.orders WHERE id = 1042 FOR UPDATE');
      await capture(page, name, 'kill-confirm');

      // Cancelling the dialog sends nothing.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(row(page, '4821')).toBeVisible();

      await page.getByRole('button', { name: 'End the session' }).click();
      await page
        .getByRole('dialog', { name: 'End this session?' })
        .getByRole('button', { name: 'End the session' })
        .click();
      await expect(row(page, '4821')).toHaveCount(0);
      await expect(page.getByText('Session ended', { exact: true })).toBeVisible();
      const toasts = page.getByRole('region', { name: /^Notifications/ });
      await expect(toasts.getByText('SELECT pg_terminate_backend(4821)')).toBeVisible();
      // What it blocked is released.
      await expect(row(page, '4902')).not.toContainText('Blocked');
      // The kill is in the statement log (the panel at the bottom).
      await expect(
        page.getByRole('code').filter({ hasText: 'pg_terminate_backend(4821)' }),
      ).toBeVisible();
    });

    test('cancelling a query keeps the session, on an engine that can', async ({ page }) => {
      await openMonitor(page);
      await row(page, '4950').click();
      await page.getByRole('button', { name: 'Cancel the query' }).click();
      const dialog = page.getByRole('dialog', { name: 'Cancel this query?' });
      await expect(dialog).toContainText('The session stays connected');
      await dialog.getByRole('button', { name: 'Cancel the query' }).click();
      await expect(page.getByText('Query cancelled', { exact: true })).toBeVisible();
      await expect(row(page, '4950')).toContainText('Idle');
      // An idle session has nothing to cancel.
      await expect(page.getByRole('button', { name: 'Cancel the query' })).toBeDisabled();
    });

    test('a read-only connection watches but cannot stop anything, and says why', async ({
      page,
    }) => {
      await openMonitor(page, /^shop · prod,/);
      await expect(page.getByRole('note').filter({ hasText: 'pg_read_all_stats' })).toBeVisible();
      await row(page, '4950').click();
      const end = page.getByRole('button', { name: 'End the session' });
      await expect(end).toBeDisabled();
      await end.locator('xpath=..').hover();
      await expect(page.getByRole('tooltip').first()).toContainText('This connection is read-only');
      await capture(page, name, 'read-only');
    });

    test('a user who may not see other sessions gets an explanation, not an empty list', async ({
      page,
    }) => {
      await connect(page, /^local postgres,/);
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setActivityFault(
          'conn-local-pg',
          'insufficientPrivilege',
        );
      });
      await openMenu(page, /^local postgres,/);
      await page.getByRole('menuitem', { name: 'Activity monitor' }).click();
      const alert = page.getByRole('alert').filter({ hasText: 'The activity could not be read' });
      await expect(alert).toContainText('needs the privilege');
      await capture(page, name, 'denied');
    });

    test('SQLite has no sessions: the entry is disabled and says so', async ({ page }) => {
      await openMenu(page, /^app\.sqlite,/);
      const entry = page.getByRole('menuitem', { name: 'SQLite has no sessions to watch' });
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAttribute('aria-disabled', 'true');
    });

    test('the history table opens as a migrations timeline, from the explorer and the palette', async ({
      page,
    }) => {
      await connect(page, /^local postgres,/);
      await expand(item(page, /^public$/));
      await expand(item(page, /^Tables \(/));
      await item(page, /^__EFMigrationsHistory$/).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Show the migrations timeline' }).click();
      const tab = page.getByRole('tab', { name: /^Migrations/ });
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const list = page.getByRole('list', { name: 'Migrations, newest first' });
      await expect(
        page.getByRole('status').filter({ hasText: 'migrations applied' }),
      ).toContainText('From Feb 14, 2023 to Oct 3, 2024');
      await expect(list.getByRole('listitem').first()).toContainText('SplitAddresses');
      await expect(list.getByRole('listitem').first()).toContainText(
        '20241003101010_SplitAddresses',
      );
      await expect(list.getByRole('listitem').first()).toContainText('EF Core 8.0.10');
      await expect(list).toContainText('October 2024');
      await capture(page, name, 'migrations');

      // The palette reaches it too, and brings the open tab back instead of a second one.
      await page
        .getByRole('tab', { name: /^Query|^New tab|^shop|^app/ })
        .first()
        .click()
        .catch(() => undefined);
      await page.keyboard.press('Control+Shift+P');
      await page.getByRole('combobox').fill('migrations timeline');
      await page.getByRole('option', { name: /Open the EF Core migrations timeline/ }).click();
      await expect(page.getByRole('tab', { name: /^Migrations/ })).toHaveCount(1);
      await expect(page.getByRole('tab', { name: /^Migrations/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    test('copies a connection as an ADO.NET string without its password, with it only after a confirmation', async ({
      page,
    }) => {
      await openMenu(page, /^local postgres,/);
      await page.getByRole('menuitem', { name: 'Copy as' }).hover();
      await expect(
        page.getByRole('menuitem', { name: 'ADO.NET connection string', exact: true }),
      ).toBeVisible();
      await capture(page, name, 'copy-menu');
      await page.getByRole('menuitem', { name: 'ADO.NET connection string', exact: true }).click();
      await expect(
        page.getByText('ADO.NET connection string copied', { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: /^Notifications/ })
          .getByText('For Npgsql. The password is not included.'),
      ).toBeVisible();
      const plain = await page.evaluate(() => navigator.clipboard.readText());
      expect(plain).toBe(
        'Host=localhost;Database=app_dev;Username=postgres;SSL Mode=Prefer;Trust Server Certificate=true',
      );
      expect(plain).not.toContain('Password');

      await openMenu(page, /^local postgres,/);
      await page.getByRole('menuitem', { name: 'Copy as' }).hover();
      await page.getByRole('menuitem', { name: 'EF Core configuration, with password…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Copy the password in clear text?' });
      await expect(dialog).toContainText('local postgres');
      await capture(page, name, 'copy-confirm');
      // Declining copies nothing more.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(plain);

      await openMenu(page, /^local postgres,/);
      await page.getByRole('menuitem', { name: 'Copy as' }).hover();
      await page.getByRole('menuitem', { name: 'EF Core configuration, with password…' }).click();
      await page
        .getByRole('dialog', { name: 'Copy the password in clear text?' })
        .getByRole('button', { name: 'Copy with password' })
        .click();
      await expect(page.getByText('EF Core configuration copied', { exact: true })).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: /^Notifications/ })
          .getByText(/The password is in the clipboard, in clear text\./),
      ).toBeVisible();
      const withPassword = await page.evaluate(() => navigator.clipboard.readText());
      expect(withPassword).toContain('Password=secret');
      expect(withPassword).toContain('options.UseNpgsql(connectionString);');
      // The toast and the page never show it.
      await expect(page.locator('body')).not.toContainText('Password=secret');
    });
  });
}
