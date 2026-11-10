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

const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });

/** Opens the connection from the sidebar, as a double click does. */
async function openFromSidebar(page: Page, name: string) {
  await sidebarItem(page, name).dblclick();
}

const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name });
// The tabs of the title bar only: a query tab's results area has sub-tabs of its own.
const strip = (page: Page) => page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab');
const newConnection = (page: Page) =>
  page.getByRole('button', { name: 'New connection' }).first().click();

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'shop · prod')).toBeVisible();
    });

    test('welcome screen', async ({ page }) => {
      await expect(
        page.getByRole('heading', { level: 1, name: 'Connect to a database' }),
      ).toBeVisible();
      await expect(page.getByRole('option', { name: /local postgres/ })).toBeVisible();
      await capture(page, name, 'welcome');
    });

    test('connection list with groups and environments', async ({ page }) => {
      await sidebarItem(page, 'shop · prod').click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Connect' })).toBeVisible();
      await capture(page, name, 'connection-menu');
      await page.keyboard.press('Escape');
      // The name, but also the database: "auth failure demo" connects to `shop`.
      await page.getByRole('textbox', { name: 'Filter connections' }).fill('shop');
      await expect(page.getByRole('treeitem')).toHaveCount(3);
      await capture(page, name, 'connection-filter');
    });

    test('groups fold and the backend remembers it', async ({ page }) => {
      const group = page.getByRole('treeitem', { name: /^Local/ });
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await group.click();
      await expect(sidebarItem(page, 'local postgres')).toBeHidden();
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await group.click();
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
    });

    test('connection dialog: PostgreSQL', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('TLS')).toHaveValue('prefer');
      await dialog.getByLabel('Host').fill('db-eu.example.com');
      // A remote host checks the certificate by default (SPEC §9).
      await expect(dialog.getByLabel('TLS')).toHaveValue('verifyFull');
      await expect(dialog).toContainText('the default for a remote host');
      await dialog.getByLabel('Database', { exact: true }).fill('shop');
      await dialog.getByLabel('User').fill('shop_ro');
      await dialog.getByRole('textbox', { name: 'Password' }).fill('s3cret');
      await dialog.getByRole('radio', { name: 'prod' }).click();
      await capture(page, name, 'dialog-postgres');
    });

    test('connection dialog: SQL Server, read-only without an engine guard', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByRole('radio', { name: 'SQL Server' }).click();
      await expect(dialog.getByRole('note')).toHaveCount(0);
      await expect(dialog.getByLabel('Port')).toHaveValue('1433');
      await expect(dialog.getByLabel('User')).toHaveValue('sa');
      await dialog.getByLabel('Host').fill('sql.example.com');
      await dialog.getByRole('switch', { name: 'Read-only' }).click();
      await expect(dialog.getByText('SQL Server has no read-only session')).toBeVisible();
      await capture(page, name, 'dialog-mssql-read-only');
    });

    test('connection dialog: SQLite', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByRole('radio', { name: 'SQLite' }).click();
      await expect(dialog.getByLabel('Host')).toHaveCount(0);
      await dialog.getByLabel('Database file').fill('/home/ana/data/app.sqlite');
      await capture(page, name, 'dialog-sqlite');
    });

    test('connection dialog: an engine this build cannot connect to, a custom environment', async ({
      page,
    }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByRole('radio', { name: 'MySQL / MariaDB' }).click();
      await expect(dialog.getByRole('note')).toContainText('MySQL / MariaDB is not available');
      await expect(dialog.getByLabel('Port')).toHaveValue('3306');
      await expect(dialog.getByLabel('User')).toHaveValue('root');
      await dialog.getByRole('radio', { name: 'Custom' }).click();
      await dialog.getByLabel('Environment name').fill('QA');
      await dialog.getByRole('radio', { name: 'Purple' }).click();
      await dialog.getByLabel('Host').fill('sql.example.com');
      await capture(page, name, 'dialog-custom-environment');
    });

    test('without a keychain the dialog says passwords are session-only', async ({ page }) => {
      await page.evaluate(() => {
        const mock = (
          window as unknown as { __yadbeMock?: { setKeychainAvailable(on: boolean): void } }
        ).__yadbeMock;
        mock?.setKeychainAvailable(false);
      });
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await expect(dialog.getByRole('note').filter({ hasText: 'No keychain' })).toBeVisible();
      await expect(dialog.getByRole('switch', { name: /Remember password/ })).toBeDisabled();
      await capture(page, name, 'dialog-no-keychain');
    });

    test('pasting a connection string fills the form', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog
        .getByLabel('Connection string')
        .fill('postgres://ana:pw@db.example.com:6543/shop?sslmode=verify-full&foo=1');
      await dialog.getByRole('button', { name: 'Fill the form' }).click();
      await expect(dialog.getByLabel('Host')).toHaveValue('db.example.com');
      await expect(dialog.getByLabel('Port')).toHaveValue('6543');
      await expect(dialog.getByLabel('Database', { exact: true })).toHaveValue('shop');
      await expect(dialog.getByLabel('User')).toHaveValue('ana');
      await expect(dialog.getByLabel('TLS')).toHaveValue('verifyFull');
      // The password stays with the backend: the field is empty and says where it comes from.
      await expect(dialog.getByRole('textbox', { name: 'Password' })).toHaveValue('');
      await expect(dialog.getByRole('textbox', { name: 'Password' })).toHaveAttribute(
        'placeholder',
        'Password from the connection string',
      );
      await expect(dialog.getByText('Left out of the form: foo')).toBeVisible();
      // The held password is enough to test the connection.
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      await expect(dialog.getByRole('status')).toContainText('Connected to PostgreSQL 16.4');
      await capture(page, name, 'dialog-pasted');
    });

    test('test connection: success and typed failure with its action', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByLabel('Host').fill('db.example.com');
      await dialog.getByRole('textbox', { name: 'Password' }).fill('secret');
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      await expect(dialog.getByRole('status')).toContainText('Connected to PostgreSQL 16.4');
      await capture(page, name, 'dialog-test-ok');

      await dialog.getByLabel('Host').fill('fail-refused');
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      const alert = dialog.getByRole('alert').filter({ hasText: 'The connection test failed' });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole('button', { name: 'Edit the connection' })).toBeVisible();
      await capture(page, name, 'dialog-test-failed');
      // The suggested action leads to the field to fix.
      await alert.getByRole('button', { name: 'Edit the connection' }).click();
      await expect(dialog.getByLabel('Host')).toBeFocused();
    });

    test('a running test can be cancelled', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByLabel('Host').fill('fail-timeout');
      await dialog.getByRole('textbox', { name: 'Password' }).fill('secret');
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      await expect(dialog.getByRole('status')).toContainText('Testing the connection');
      await dialog.getByRole('button', { name: 'Cancel the test' }).click();
      await expect(dialog.getByRole('status')).toBeHidden();
      await expect(dialog.getByRole('alert')).toBeHidden();
      await expect(dialog.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    });

    test('saving a connection adds it to the list', async ({ page }) => {
      await newConnection(page);
      const dialog = page.getByRole('dialog', { name: 'New connection' });
      await dialog.getByLabel('Host').fill('reports.example.com');
      await dialog.getByLabel('Database', { exact: true }).fill('reports');
      await dialog.getByRole('textbox', { name: 'Password' }).fill('secret');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(sidebarItem(page, 'reports@reports\\.example\\.com')).toBeVisible();
    });

    test('editing a connection never shows its password', async ({ page }) => {
      await sidebarItem(page, 'shop · prod').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit connection' });
      await expect(dialog.getByLabel('Host')).toHaveValue('db-eu.example.com');
      const password = dialog.getByRole('textbox', { name: 'Password' });
      await expect(password).toHaveValue('');
      await expect(password).toHaveAttribute('placeholder', 'Leave empty to keep it');
      await expect(dialog.getByText(/stored in the keychain/)).toBeVisible();
      await capture(page, name, 'dialog-edit');
    });

    test('a connected tab is tinted by its environment', async ({ page }) => {
      await openFromSidebar(page, 'shop · prod');
      await expect(tab(page, /Query 1/)).toBeVisible();
      await expect(page.getByRole('toolbar')).toContainText('shop · prod');
      await expect(sidebarItem(page, 'shop · prod')).toHaveAccessibleName(/Connected/);
      await expect(page.locator('[data-environment="prod"]').first()).toBeVisible();
      await expect(page.getByText('PostgreSQL 16.4')).toBeVisible();
      await capture(page, name, 'tab-prod');
    });

    test('the statement log lists what yadbe ran', async ({ page }) => {
      await openFromSidebar(page, 'local postgres');
      await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);
      await page.getByRole('button', { name: /Statement log/ }).click();
      const log = page.getByRole('region', { name: 'Statement log' });
      await expect(log.getByRole('option').first()).toBeVisible();
      await log.getByRole('option').filter({ hasText: 'SHOW server_version' }).click();
      await expect(log.getByRole('complementary', { name: 'Statement details' })).toBeVisible();
      await capture(page, name, 'statement-log');
    });

    test('a connection without a stored password asks for it, a wrong one is explained', async ({
      page,
    }) => {
      await openFromSidebar(page, 'auth failure demo');
      const dialog = page.getByRole('dialog', { name: 'Password for auth failure demo' });
      await expect(dialog).toBeVisible();
      await capture(page, name, 'password-prompt');
      await dialog.getByRole('textbox', { name: 'Password' }).fill('wrong');
      await dialog.getByRole('button', { name: 'Connect' }).click();
      await expect(page.getByText('Could not connect to auth failure demo').first()).toBeVisible();
      await expect(page.getByText(/rejected|password/i).first()).toBeVisible();
      await capture(page, name, 'connect-failed');
    });

    test('a connection the build cannot open shows the typed error in its tab', async ({
      page,
    }) => {
      await openFromSidebar(page, 'wordpress');
      const panel = page.getByRole('tabpanel').getByRole('alert');
      await expect(panel).toContainText('Could not connect to wordpress');
      await expect(panel).toContainText('not supported');
      await capture(page, name, 'tab-connect-error');
    });
  });
}

test.describe('tabs', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(sidebarItem(page, 'shop · prod')).toBeVisible();
  });

  test('open, switch, reorder and close with the keyboard and the mouse', async ({ page }) => {
    await openFromSidebar(page, 'shop · prod');
    await expect(tab(page, /Query 1/)).toHaveAttribute('aria-selected', 'true');
    // Cmd/Ctrl+T opens a welcome tab.
    await page.keyboard.press('Control+t');
    await expect(tab(page, 'New tab')).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('option', { name: /local postgres/ }).click();
    await expect(tab(page, /Query 2/)).toHaveAttribute('aria-selected', 'true');
    // Cmd/Ctrl+1 and Ctrl+Tab move between tabs.
    await page.keyboard.press('Control+1');
    await expect(tab(page, /Query 1/)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Tab');
    await expect(tab(page, /Query 2/)).toHaveAttribute('aria-selected', 'true');
    // Drag the second tab before the first.
    const first = await tab(page, /Query 1/).boundingBox();
    const second = await tab(page, /Query 2/).boundingBox();
    if (!first || !second) throw new Error('tabs not laid out');
    await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 8, first.y + first.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(strip(page).first()).toContainText('Query 2');
    // Cmd/Ctrl+W closes the active tab, and Cmd/Ctrl+Shift+T brings it back.
    await page.keyboard.press('Control+w');
    await expect(strip(page)).toHaveCount(1);
    await page.keyboard.press('Control+Shift+t');
    await expect(strip(page)).toHaveCount(2);
    await expect(tab(page, /Query 2/)).toHaveAttribute('aria-selected', 'true');
    // The close button of a tab.
    await tab(page, /Query 1/)
      .getByRole('button', { name: /Close Query 1/ })
      .click({ force: true });
    await expect(tab(page, /Query 1/)).toHaveCount(0);
  });

  test('a pinned tab has no close button and the menu can unpin it', async ({ page }) => {
    await openFromSidebar(page, 'shop · prod');
    await tab(page, /Query 1/).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin tab' }).click();
    await expect(tab(page, /Query 1/).getByRole('button')).toHaveCount(0);
    await tab(page, /Query 1/).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Unpin tab' })).toBeVisible();
  });

  test('tabs are restored after a restart', async ({ page }) => {
    await openFromSidebar(page, 'shop · prod');
    await page.keyboard.press('Control+t');
    await page.getByRole('option', { name: /local postgres/ }).click();
    await expect(tab(page, /Query 2/)).toBeVisible();
    await tab(page, /Query 1/).click();
    await expect(tab(page, /Query 1/)).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(strip(page)).toHaveCount(2);
    await expect(tab(page, /Query 1/)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, /Query 2/)).toBeVisible();
    // The restored tab shows its connection, which reconnects on demand.
    await expect(page.getByRole('toolbar')).toContainText('shop · prod');
  });

  test('deleting a connection closes its tabs after a confirmation that shows the effect', async ({
    page,
  }) => {
    await openFromSidebar(page, 'local postgres');
    await expect(tab(page, /Query 1/)).toBeVisible();
    await sidebarItem(page, 'local postgres').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete local postgres?' });
    await expect(dialog).toContainText('1 open tab');
    await dialog.getByRole('button', { name: 'Delete connection' }).click();
    await expect(sidebarItem(page, 'local postgres')).toHaveCount(0);
    await expect(tab(page, 'New tab')).toBeVisible();
  });
});

test.describe('layout', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('the sidebar and the bottom panel resize, collapse and are remembered', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.getByRole('complementary', { name: 'Connections' });
    await expect(sidebar).toBeVisible();
    const before = await sidebar.boundingBox();
    if (!before) throw new Error('sidebar not laid out');

    // Drag the sidebar edge 80 px to the right.
    const handle = page.getByRole('separator', { name: 'Resize the sidebar' });
    const edge = await handle.boundingBox();
    if (!edge) throw new Error('resizer not laid out');
    await page.mouse.move(edge.x + 1, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + 81, edge.y + 200, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width)
      .toBeCloseTo(before.width + 80, -1);

    // Open the bottom panel and resize it with the keyboard.
    await page.keyboard.press('Control+j');
    const log = page.getByRole('region', { name: 'Statement log' });
    await expect(log).toBeVisible();
    const logBefore = await log.boundingBox();
    await page.getByRole('separator', { name: 'Resize the bottom panel' }).focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect
      .poll(async () => (await log.boundingBox())?.height)
      .toBeGreaterThan((logBefore?.height ?? 0) + 20);

    // Collapse the sidebar with the shortcut.
    await page.keyboard.press('Control+b');
    await expect(sidebar).toBeHidden();

    // The layout is saved a moment after the last change.
    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Statement log' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Connections' })).toBeHidden();
    await page.keyboard.press('Control+b');
    const restored = await page.getByRole('complementary', { name: 'Connections' }).boundingBox();
    expect(restored?.width).toBeCloseTo(before.width + 80, -1);
  });
});

test.describe('french', () => {
  test.use({ colorScheme: 'dark', locale: 'fr-FR' });

  test('the shell and the connection dialog follow the browser language', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Connectez-vous à une base de données' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Nouvelle connexion' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle connexion' });
    await expect(dialog.getByLabel('Hôte')).toBeVisible();
    await dialog.getByRole('radio', { name: 'SQLite' }).click();
    await expect(dialog.getByLabel('Fichier de base de données')).toBeVisible();
    await dialog.getByLabel('Fichier de base de données').fill('/home/ana/data/app.sqlite');
    await capture(page, 'graphite', 'french-dialog');
  });
});

test('the primitives page stays reachable', async ({ page }) => {
  await page.goto('/#primitives');
  await expect(page.getByRole('heading', { level: 1, name: 'UI primitives' })).toBeVisible();
});
