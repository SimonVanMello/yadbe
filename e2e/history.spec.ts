import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

/** Calls a control of the mock backend (`window.__yadbeMock`) in the page. */
async function mockControl(page: Page, name: string, ...args: number[]) {
  await page.evaluate(
    ([method, values]) => {
      const mock = (window as unknown as { __yadbeMock?: Record<string, (...a: number[]) => void> })
        .__yadbeMock;
      mock?.[method]?.(...values);
    },
    [name, args] as const,
  );
}

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

const historyTab = (page: Page) =>
  page.getByRole('tablist', { name: 'Sidebar view' }).getByRole('tab', { name: 'History' });
const panel = (page: Page) => page.getByRole('region', { name: 'History' });
const list = (page: Page) => panel(page).getByRole('listbox', { name: 'Statements run' });
const rows = (page: Page) => list(page).getByRole('option');
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });

async function openHistory(page: Page) {
  await historyTab(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await mockControl(page, 'setLatency', 30);
      await mockControl(page, 'setQueryTick', 15);
    });

    test('the panel lists the statements, newest first, by day', async ({ page }) => {
      await openHistory(page);
      await expect(historyTab(page)).toHaveAttribute('aria-selected', 'true');
      await expect(list(page).getByText('Today', { exact: true })).toBeVisible();
      // The newest seeded statements: a failed one, a cancelled one, one the read-only
      // connection refused.
      await expect(rows(page).first()).toContainText('c.nmae');
      await expect(rows(page).first().getByRole('img', { name: 'Failed' })).toBeVisible();
      await expect(rows(page).nth(1).getByRole('img', { name: 'Cancelled' })).toBeVisible();
      await expect(rows(page).nth(2).getByRole('img', { name: 'Refused' })).toBeVisible();
      await capture(page, name, 'history-panel');
    });

    test('the shortcut shows the view and focuses the search', async ({ page }) => {
      await page.keyboard.press('ControlOrMeta+Shift+h');
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByRole('textbox', { name: 'Search the history' })).toBeFocused();
      await page
        .getByRole('tablist', { name: 'Sidebar view' })
        .getByRole('tab', { name: 'Connections' })
        .click();
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
    });

    test('search: words match by prefix and are highlighted', async ({ page }) => {
      await openHistory(page);
      const total = await rows(page).count();
      await panel(page).getByRole('textbox', { name: 'Search the history' }).fill('custom');
      await expect(panel(page).locator('mark').first()).toBeVisible();
      await expect.poll(() => rows(page).count()).toBeLessThan(total);
      for (const row of await rows(page).all()) {
        await expect(row.locator('mark').first()).toHaveText(/^custom/i);
      }
      await capture(page, name, 'history-search');
      await panel(page).getByRole('textbox', { name: 'Search the history' }).fill('zzzzzz');
      await expect(panel(page).getByText('No statement matches.')).toBeVisible();
      await panel(page).getByRole('button', { name: 'Reset filters' }).click();
      await expect(rows(page).first()).toBeVisible();
    });

    test('filters: connection and result', async ({ page }) => {
      await openHistory(page);
      await panel(page).getByRole('button', { name: 'Filters' }).click();
      await panel(page).getByLabel('Result').selectOption('error');
      await expect(panel(page).getByRole('button', { name: 'Filters (1)' })).toBeVisible();
      await expect
        .poll(async () => rows(page).first().getByRole('img', { name: 'Failed' }).count())
        .toBe(1);
      await panel(page).getByLabel('Connection').selectOption({ label: 'shop · staging' });
      await expect(panel(page).getByRole('button', { name: 'Filters (2)' })).toBeVisible();
      for (const row of await rows(page).all()) {
        await expect(row.getByRole('img', { name: 'Failed' })).toBeVisible();
        await expect(row).toContainText('shop · staging');
      }
      await capture(page, name, 'history-filters');
    });

    test('an entry opens its whole statement and its error', async ({ page }) => {
      await openHistory(page);
      await rows(page).first().click();
      const detail = panel(page).getByRole('complementary', { name: 'Statement details' });
      await expect(detail).toBeVisible();
      await expect(detail.getByRole('alert', { name: 'Error' })).toContainText('c.nmae');
      await expect(detail.locator('pre')).toContainText('JOIN customers c');
      await capture(page, name, 'history-detail-error');
    });

    test('Enter opens the statement in a new tab on its connection', async ({ page }) => {
      await openHistory(page);
      await rows(page).first().click();
      await list(page).press('Enter');
      await expect(page.getByRole('tab', { name: /Query 1.*shop · staging/ })).toBeVisible();
      await expect(editor(page)).toContainText('SELECT o.id, c.nmae');
    });

    test('Mod+Enter inserts the statement at the cursor of the editor', async ({ page }) => {
      await sidebarItem(page, 'local postgres').dblclick();
      await expect(editor(page)).toBeVisible();
      await editor(page).click();
      await page.keyboard.insertText('-- before\n');
      await openHistory(page);
      await rows(page).nth(1).click();
      await list(page).press('ControlOrMeta+Enter');
      await expect(editor(page)).toContainText('-- before');
      await expect(editor(page)).toContainText('SELECT pg_sleep(30);');
    });

    test('a statement that runs shows up in the history, and a private connection leaves none', async ({
      page,
    }) => {
      await sidebarItem(page, 'local postgres').dblclick();
      await expect(editor(page)).toBeVisible();
      await editor(page).click();
      await page.keyboard.insertText('select 7771 as marker');
      await page.keyboard.press('ControlOrMeta+Enter');
      await openHistory(page);
      await expect(rows(page).first()).toContainText('select 7771 as marker');
      await expect(rows(page).first().getByRole('img', { name: 'Succeeded' })).toBeVisible();
    });

    test('delete one entry', async ({ page }) => {
      await openHistory(page);
      const first = (await rows(page).first().textContent()) ?? '';
      await rows(page).first().click();
      await panel(page).getByRole('button', { name: 'Delete this entry' }).click();
      await expect.poll(async () => (await rows(page).first().textContent()) ?? '').not.toBe(first);
    });

    test('clearing says how many entries go', async ({ page }) => {
      await openHistory(page);
      await panel(page).getByRole('button', { name: 'Clear history…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Clear the history' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/entries will be deleted/)).toBeVisible();
      await capture(page, name, 'history-clear');
      await dialog.getByLabel('Period').selectOption('today');
      const confirm = dialog.getByRole('button', { name: /^Delete \d+ entr/ });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(list(page).getByText('Today', { exact: true })).toBeHidden();
    });

    test('the connection dialog can turn the history off', async ({ page }) => {
      await sidebarItem(page, 'local postgres').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const dialog = page.getByRole('dialog', { name: /Edit/ });
      const toggle = dialog.getByRole('switch', { name: 'Record the history' });
      await expect(toggle).toBeChecked();
      await toggle.scrollIntoViewIfNeeded();
      await capture(page, name, 'connection-history-toggle');
      await toggle.click();
      await expect(toggle).not.toBeChecked();
    });
  });
}

test.describe('long history', () => {
  test.use({ locale: 'en-US' });

  test('100 000 entries scroll and search without waiting', async ({ page }) => {
    await page.goto('/');
    await expect(sidebarItem(page, 'local postgres')).toBeVisible();
    await mockControl(page, 'seedHistory', 100_000);
    await openHistory(page);
    await list(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    // Older pages load as the end comes into view.
    await expect
      .poll(() => list(page).evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(30_000);
    const started = Date.now();
    await panel(page).getByRole('textbox', { name: 'Search the history' }).fill('orders');
    await expect(panel(page).locator('mark').first()).toBeVisible();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
