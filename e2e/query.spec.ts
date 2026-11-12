import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface MockControls {
  setLatency(ms: number): void;
  setQueryTick(ms: number): void;
  setFile(path: string, text: string | null): void;
  getFile(path: string): string | undefined;
}

declare global {
  interface Window {
    __yadbeMock?: MockControls;
  }
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

const editorContent = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const results = (page: Page) => page.getByRole('region', { name: 'Results' });
const runStatus = (page: Page) => page.getByTestId('run-status');
const runButton = (page: Page) => page.getByRole('button', { name: /^Run( selection)?$/ });
const resultTabs = (page: Page) => results(page).getByRole('tablist', { name: 'Result sets' });

/** Opens a connection from the sidebar and waits for its query tab to be connected. */
async function openQueryTab(page: Page, connection: string) {
  await sidebarItem(page, connection).dblclick();
  await expect(editorContent(page)).toBeVisible();
  await expect(sidebarItem(page, connection)).toHaveAccessibleName(/Connected/);
}

/** Replaces the editor's text (CodeMirror reads it from the input events). */
async function setScript(page: Page, text: string) {
  await editorContent(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** Puts the cursor at the start of a line of the editor (1-based). */
async function placeCursor(page: Page, line: number) {
  await editorContent(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown');
}

const SCRIPT = `-- Orders of the day
select o.id, o.total, c.email
from orders o
join customers c on c.id = o.customer_id
where o.created_at > now() - interval '1 day';

select count(*) as orders from orders;

update orders set status = 'shipped' where id = 9412;`;

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await page.evaluate(() => {
        window.__yadbeMock?.setLatency(30);
        window.__yadbeMock?.setQueryTick(15);
      });
    });

    test('the editor highlights SQL and the statement under the cursor', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, SCRIPT);
      await placeCursor(page, 7);
      // One mark per line: until the cursor's move is painted, the four lines of the first
      // statement can still be marked. Waiting for the single line of the second one keeps
      // the text checks on one element.
      const highlight = page.locator('.cm-statement-highlight');
      await expect(highlight).toHaveCount(1);
      await expect(highlight).toContainText('select count(*)');
      await expect(highlight).not.toContainText('update orders');
      await capture(page, name, 'editor-statement-highlight');
    });

    test('editing: comment toggle, find and replace, multi-cursor', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 1 as a;\nselect 1 as b;\nselect 1 as c;');
      // Comment toggle on the current line.
      await placeCursor(page, 2);
      await page.keyboard.press('ControlOrMeta+/');
      await expect(page.locator('.cm-line').nth(1)).toHaveText('-- select 1 as b;');
      await page.keyboard.press('ControlOrMeta+/');
      await expect(page.locator('.cm-line').nth(1)).toHaveText('select 1 as b;');
      // Find and replace panel, with matches painted.
      await page.keyboard.press('ControlOrMeta+f');
      const find = page.getByRole('textbox', { name: 'Find' });
      await expect(find).toBeFocused();
      await find.pressSequentially('select');
      await expect(page.locator('.cm-searchMatch')).toHaveCount(3);
      await page.getByRole('textbox', { name: 'Replace' }).pressSequentially('SELECT');
      await capture(page, name, 'find-replace');
      await page.getByRole('button', { name: 'replace all' }).click();
      await expect(page.locator('.cm-line').first()).toHaveText('SELECT 1 as a;');
      await page.keyboard.press('Escape');
      // A second cursor with Alt+click types on two lines at once.
      await placeCursor(page, 1);
      await page.keyboard.press('End');
      const third = page.locator('.cm-line').nth(2);
      const box = await third.boundingBox();
      if (!box) throw new Error('the third line has no box');
      await third.click({ modifiers: ['Alt'], position: { x: box.width - 4, y: box.height / 2 } });
      await expect(page.locator('.cm-cursor')).toHaveCount(2);
      await page.keyboard.type(' -- x');
      await expect(page.locator('.cm-line').first()).toHaveText('SELECT 1 as a; -- x');
      await expect(page.locator('.cm-line').nth(2)).toHaveText('SELECT 1 as c; -- x');
      await capture(page, name, 'editing-multicursor');
    });

    test('run all: several results, then the messages', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, SCRIPT);
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('3 statements');
      await expect(resultTabs(page).getByRole('tab', { name: /Result 1/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(resultTabs(page).getByRole('tab', { name: /Result 2/ })).toBeVisible();
      await expect(resultTabs(page).getByRole('tab', { name: 'Messages' })).toBeVisible();
      // The result grid under the editor, with its footer and the run in the status bar.
      const grid = results(page).getByRole('grid', { name: 'Result 1' });
      await expect(grid).toHaveAttribute('aria-rowcount', '1285');
      await expect(results(page).getByText('1,284 rows', { exact: true })).toBeVisible();
      await expect(grid.getByRole('columnheader', { name: /^email\b/ })).toBeVisible();
      await expect(page.getByTestId('statusbar-run')).toContainText(/rows · /);
      await grid.locator('[aria-rowindex="3"] [aria-colindex="1"]').click();
      await grid.locator('[aria-rowindex="6"] [aria-colindex="3"]').click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('statusbar-run')).toContainText('12 cells selected');
      await capture(page, name, 'results-first');
      await resultTabs(page).getByRole('tab', { name: 'Messages' }).click();
      await expect(results(page)).toContainText('1 row affected');
      await expect(results(page)).toContainText('Statement 3');
      await capture(page, name, 'messages-completed');
    });

    test('a result paused at its limit offers Load more once, in the grid footer', async ({
      page,
    }) => {
      await page.evaluate(() => window.__yadbeMock?.setQueryTick(5));
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select * from huge;');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('Paused');
      await expect(results(page).getByText('Paused at the row limit')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Load all' })).toHaveCount(1);
      await expect(resultTabs(page).getByRole('tab', { name: /Result 1/ })).toContainText('+');
      // Paused, nothing runs: no spinner, and the time stands still.
      await expect(results(page).getByRole('status').locator('[class*="spinner"]')).toHaveCount(0);
      const paused = await runStatus(page).textContent();
      await page.waitForTimeout(400);
      await expect(runStatus(page)).toHaveText(paused ?? '');
      await capture(page, name, 'results-paused');
      await page.getByRole('button', { name: 'Load more' }).click();
      await expect(results(page).getByText('200,000 rows', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    });

    test('Run stays available on a paused result and replaces it without a prompt', async ({
      page,
    }) => {
      await page.evaluate(() => window.__yadbeMock?.setQueryTick(5));
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select * from huge;');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('Paused');
      const run = page.getByRole('button', { name: /^Run/ }).first();
      await expect(run).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      await setScript(page, 'select 1;');
      await run.click();
      await expect(runStatus(page)).not.toContainText('Paused');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    });

    test('an error is explained in Messages, underlined, and jumps to its position', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 1;\nselect * from nowhere\nwhere id = 3;\nselect 2;');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('Failed');
      const error = results(page).getByTestId('message-error');
      await expect(error).toContainText('relation "nowhere" does not exist');
      await expect(page.locator('.cm-error-range')).toHaveText('nowhere');
      await capture(page, name, 'messages-error');
      // Clicking the position puts the cursor where the server located the error.
      await placeCursor(page, 1);
      await error.getByRole('button', { name: /Line 2, column 15/ }).click();
      await expect(page.locator('.cm-activeLine')).toContainText('select * from nowhere');
      await expect(editorContent(page)).toBeFocused();
      // The status bar follows the cursor (SPEC §4).
      await expect(page.getByTestId('statusbar-cursor')).toHaveText('Ln 2, Col 15');
      await page.keyboard.press('Shift+End');
      await expect(page.getByTestId('statusbar-cursor')).toHaveText('Ln 2, Col 22 (7 selected)');
      await capture(page, name, 'statusbar-cursor');
    });

    test('a running query shows its elapsed time and can be cancelled', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select pg_sleep(30);');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('Running statement 1 of 1');
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      await expect(runButton(page)).toBeDisabled();
      const first = await runStatus(page).innerText();
      await expect.poll(() => runStatus(page).innerText()).not.toBe(first);
      await capture(page, name, 'running');
      await page.keyboard.press('ControlOrMeta+.');
      await expect(runStatus(page)).toContainText('Cancelled');
      await expect(results(page)).toContainText('Statement 1');
      await expect(runButton(page)).toBeEnabled();
    });

    test('run statement under cursor runs one statement', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, SCRIPT);
      await placeCursor(page, 9);
      await page.keyboard.press('ControlOrMeta+Shift+Enter');
      await expect(runStatus(page)).toContainText('1 statement');
      await resultTabs(page).getByRole('tab', { name: 'Messages' }).click();
      await expect(results(page)).toContainText('1 row affected');
      await expect(results(page)).not.toContainText('Statement 2');
    });

    test('run selection runs only what is selected', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 1 as one;\nselect 2 as two;');
      await placeCursor(page, 2);
      await page.keyboard.press('Shift+End');
      await expect(page.getByRole('button', { name: 'Run selection' })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('1 statement');
      await expect(
        results(page)
          .getByRole('grid')
          .getByRole('columnheader', { name: /^two\b/ }),
      ).toBeVisible();
    });

    test('manual transactions: open, commit, and a confirmation on close', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await page.getByRole('combobox', { name: 'Transaction mode' }).selectOption('manual');
      await setScript(page, "update orders set status = 'shipped' where id = 1;");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByRole('status').filter({ hasText: 'Transaction open' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Commit' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Rollback' })).toBeEnabled();
      await capture(page, name, 'transaction-open');
      // Closing the tab with the transaction open asks first.
      await page.getByRole('button', { name: /^Close Query 1/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Close with an open transaction?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Query 1 · local postgres');
      await capture(page, name, 'transaction-close-confirm');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('tab', { name: /Query 1/ })).toBeVisible();
      await page.getByRole('button', { name: 'Commit' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Transaction open' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Commit' })).toBeDisabled();
    });

    test('a read-only connection refuses a change, and Messages say so', async ({ page }) => {
      await openQueryTab(page, 'shop · prod');
      await setScript(page, "select 1;\nupdate orders set status = 'x' where id = 1;");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('Failed');
      const error = results(page).getByTestId('message-error');
      await expect(error).toBeVisible();
      await expect(error).toContainText(/read-only/i);
      await expect(page.locator('.cm-error-range')).toHaveCount(1);
      await capture(page, name, 'read-only-refusal');
    });

    test('a dangerous statement on a prod connection asks, showing what it does', async ({
      page,
    }) => {
      // `shop · staging` becomes a prod connection that is not read-only.
      await sidebarItem(page, 'shop · staging').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const form = page.getByRole('dialog', { name: 'Edit connection' });
      await form.getByRole('radio', { name: 'prod' }).click();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      await openQueryTab(page, 'shop · staging');
      await setScript(page, 'select 1;\ndelete from orders;\nupdate customers set vip = true;');
      await page.keyboard.press('ControlOrMeta+Enter');
      const dialog = page.getByRole('dialog', {
        name: 'Run 2 potentially destructive statements?',
      });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('shop · staging (prod)');
      await expect(dialog).toContainText('DELETE without WHERE');
      await expect(dialog).toContainText('UPDATE without WHERE');
      await capture(page, name, 'dangerous-confirm');
      // Declining runs nothing.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(runStatus(page)).toHaveCount(0);
      // Confirming runs everything, as written.
      await page.keyboard.press('ControlOrMeta+Enter');
      await page.getByRole('button', { name: 'Run anyway' }).click();
      await expect(runStatus(page)).toContainText('3 statements');
    });

    test('a harmless script runs without asking', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, "update orders set status = 'x' where id = 1;");
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('1 statement');
    });

    test('the script survives a restart, unsaved, with its cursor', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, SCRIPT);
      await placeCursor(page, 7);
      await expect(page.getByRole('tab', { name: /Query 1.*Unsaved changes/ })).toBeVisible();
      // Autosave waits a moment after the last keystroke.
      await page.waitForTimeout(2000);
      await page.reload();
      await expect(editorContent(page)).toContainText('select count(*) as orders from orders;');
      await expect(page.getByRole('tab', { name: /Query 1.*Unsaved changes/ })).toBeVisible();
      await expect(page.locator('.cm-activeLine')).toContainText('select count(*)');
    });

    test('a closed tab comes back with its text', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(page, 'select 42 as answer;');
      await page.keyboard.press('ControlOrMeta+w');
      await expect(page.getByRole('tab', { name: /Query 1/ })).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+Shift+t');
      await expect(editorContent(page)).toContainText('select 42 as answer;');
      await expect(page.getByRole('tab', { name: /Query 1.*Unsaved changes/ })).toBeVisible();
    });

    test('the split between editor and results is remembered', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      const separator = page.getByRole('separator', { name: 'Resize the results area' });
      const before = Number(await separator.getAttribute('aria-valuenow'));
      await separator.focus();
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
      const after = Number(await separator.getAttribute('aria-valuenow'));
      expect(after).toBeGreaterThan(before);
      await page.waitForTimeout(600);
      await page.reload();
      await expect(editorContent(page)).toBeVisible();
      await expect(
        page.getByRole('separator', { name: 'Resize the results area' }),
      ).toHaveAttribute('aria-valuenow', String(after));
    });

    test('open a script, edit it, save it, and notice a change on disk', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Open a SQL file' }).click();
      await (
        await chooser
      ).setFiles({
        name: 'weekly.sql',
        mimeType: 'application/sql',
        buffer: Buffer.from('select 1 as week;\n'),
      });
      await expect(page.getByRole('tab', { name: /^weekly\.sql/ })).toBeVisible();
      await expect(editorContent(page)).toContainText('select 1 as week;');
      await expect(page.getByRole('tab', { name: /Unsaved changes/ })).toHaveCount(0);
      await editorContent(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.insertText('select 2 as month;');
      await expect(page.getByRole('tab', { name: /^weekly\.sql.*Unsaved changes/ })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByText('Saved weekly.sql', { exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: /Unsaved changes/ })).toHaveCount(0);
      expect(
        await page.evaluate(() => window.__yadbeMock?.getFile('/home/ana/queries/weekly.sql')),
      ).toContain('select 2 as month;');

      // Someone else rewrites the file: the next time the window gets the focus, we notice.
      await page.evaluate(() => {
        window.__yadbeMock?.setFile('/home/ana/queries/weekly.sql', 'select 99 as other;\n');
        window.dispatchEvent(new Event('focus'));
      });
      const banner = page.getByRole('alert').filter({ hasText: 'weekly.sql changed on disk' });
      await expect(banner).toBeVisible();
      await capture(page, name, 'file-changed');
      await banner.getByRole('button', { name: 'Reload from disk' }).click();
      await expect(editorContent(page)).toContainText('select 99 as other;');
      await expect(banner).toBeHidden();
    });

    test('switching the connection of a tab changes the dialect and the chip', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await page.getByTestId('connection-switcher').click();
      await capture(page, name, 'connection-switcher');
      await page.getByRole('radio', { name: /app\.sqlite/ }).click();
      await expect(page.getByTestId('connection-switcher')).toContainText('app.sqlite');
      await expect(page.getByRole('toolbar')).toContainText('app.sqlite');
    });
  });
}

test.describe('query tab in French', () => {
  test.use({ colorScheme: 'dark', locale: 'fr-FR' });

  test('the toolbar, the results and the messages are translated', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.__yadbeMock?.setLatency(30);
      window.__yadbeMock?.setQueryTick(15);
    });
    await page
      .getByRole('tree', { name: 'Connexions' })
      .getByRole('treeitem', { name: /^local postgres,/ })
      .dblclick();
    const editor = page.getByRole('textbox', { name: 'Éditeur SQL' });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.insertText('select * from nowhere;');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByTestId('run-status')).toContainText('Échec');
    await expect(page.getByRole('region', { name: 'Résultats' })).toContainText(
      'Ligne 1, colonne 15',
    );
    await expect(page.getByRole('button', { name: 'Exécuter', exact: true })).toBeVisible();
  });
});
