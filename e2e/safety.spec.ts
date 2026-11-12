import { expect, test, type Page } from '@playwright/test';

/**
 * Safety surfaces of M2-4, mock backend: the environment on every confirmation, the guard
 * listing each statement once, a failed history entry without a row count, the lost-connection
 * panel, the read-only badge hint. Captures in both themes.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

type Mock = {
  setLatency(ms: number): void;
  setQueryTick(ms: number): void;
  dropConnection(id: string, stayLost?: boolean): Promise<void>;
};

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
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });

async function openQueryTab(page: Page, connection: string) {
  await sidebarItem(page, connection).dblclick();
  await expect(editor(page)).toBeVisible();
  await expect(sidebarItem(page, connection)).toHaveAccessibleName(/Connected/);
}

async function setScript(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** `shop · staging` becomes a prod connection that is not read-only. */
async function makeStagingProd(page: Page) {
  await sidebarItem(page, 'shop · staging').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const form = page.getByRole('dialog', { name: 'Edit connection' });
  await form.getByRole('radio', { name: 'prod' }).click();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await page.evaluate(() => {
        const mock = (window as unknown as { __yadbeMock: Mock }).__yadbeMock;
        mock.setLatency(30);
        mock.setQueryTick(15);
      });
    });

    test('the guard shows PROD, lists each statement once and marks the flagged ones', async ({
      page,
    }) => {
      await makeStagingProd(page);
      await openQueryTab(page, 'shop · staging');
      await setScript(
        page,
        'select 1;\ndelete from orders;\nselect 2;\nalter table t drop column c;',
      );
      await page.keyboard.press('ControlOrMeta+Enter');
      const dialog = page.getByRole('dialog', {
        name: 'Run 2 potentially destructive statements?',
      });
      await expect(dialog).toBeVisible();
      const banner = dialog.getByTestId('connection-banner');
      await expect(banner).toContainText('shop · staging');
      await expect(banner).toContainText('prod');
      // Each statement once, whole, with what it does (or that it is not flagged).
      await expect(dialog.getByText('delete from orders')).toHaveCount(1);
      await expect(dialog.getByText('alter table t drop column c')).toHaveCount(1);
      await expect(dialog).toContainText('Statement 2 · DELETE without WHERE');
      await expect(dialog).toContainText('Statement 1 · runs as written');
      await expect(dialog).toContainText('ALTER … DROP');
      await capture(page, name, 'guard-mixed-prod');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    });

    test('a transaction confirmation on a prod connection shows PROD', async ({ page }) => {
      await makeStagingProd(page);
      await openQueryTab(page, 'shop · staging');
      await page.getByRole('combobox', { name: 'Transaction mode' }).selectOption('manual');
      await setScript(page, "update orders set status = 'x' where id = 1;");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByRole('status').filter({ hasText: 'Transaction open' })).toBeVisible();
      await page.getByRole('button', { name: /^Close Query 1/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Close with an open transaction?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('connection-banner')).toContainText('prod');
      await capture(page, name, 'transaction-confirm-prod');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Rollback' }).click();
    });

    test('read-only applies to an open connection at once; other settings offer a reconnect', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await sidebarItem(page, 'local postgres').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const form = page.getByRole('dialog', { name: 'Edit connection' });
      await form.getByRole('switch', { name: /^Read-only/ }).click();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      // Nothing waits for a reconnection: a plain confirmation, and writes are refused now.
      const toasts = page.getByRole('region', { name: /Notifications/ });
      await expect(toasts).toContainText('local postgres saved');
      await expect(toasts.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
      await setScript(page, "update orders set status = 'x' where id = 1;");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('run-status')).toContainText('Failed');

      await sidebarItem(page, 'local postgres').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      await form.getByLabel('Port').fill('5433');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      const reconnect = toasts.getByRole('button', { name: 'Reconnect' });
      await expect(reconnect).toBeVisible();
      await expect(toasts).toContainText('keeps its previous settings until it reconnects');
      await capture(page, name, 'saved-reconnect');
      await reconnect.click();
      await expect(reconnect).toBeHidden();
      await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);
    });

    test('a failed history entry has no row count', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select * from nowhere;');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('run-status')).toContainText('Failed');
      await page
        .getByRole('tablist', { name: 'Sidebar view' })
        .getByRole('tab', { name: 'History' })
        .click();
      const row = page.getByRole('option').filter({ hasText: 'select * from nowhere' }).first();
      await expect(row.getByRole('img', { name: 'Failed' })).toBeVisible();
      await expect(row).not.toContainText(/\d+ rows?/);
      await capture(page, name, 'history-failed-no-rows');
    });

    test('a lost link offers Reconnect first', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await page.evaluate(() => {
        void (window as unknown as { __yadbeMock: Mock }).__yadbeMock.dropConnection(
          'conn-local-pg',
          true,
        );
      });
      const notice = page.getByTestId('connection-notice');
      await expect(notice).toBeVisible();
      await expect(notice.getByRole('button', { name: 'Reconnect' }).first()).toBeVisible();
      await expect(notice.getByRole('button', { name: 'Edit the connection' })).toBeVisible();
      await capture(page, name, 'connection-lost');
    });

    test('the read-only badge explains what protects the connection', async ({ page }) => {
      await openQueryTab(page, 'shop · prod');
      const badge = page.getByTestId('read-only-badge');
      await badge.hover();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await expect(page.getByRole('tooltip')).toContainText('read-only');
      await capture(page, name, 'read-only-badge');
    });
  });
}
