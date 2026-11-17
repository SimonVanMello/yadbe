import { expect, test, type Page } from '@playwright/test';

/** Color themes: the gallery of the preferences (preview, slots), the palette picker, the style. */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`themes-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const prefs = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });
const html = (page: Page) => page.locator('html');
const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });

/** A query with a result, so that the screens behind show the editor and the grid. */
async function runQuery(page: Page) {
  await sidebarItem(page, 'local postgres').dblclick();
  const editor = page.getByRole('textbox', { name: 'SQL editor' });
  await expect(editor).toBeVisible();
  await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);
  await editor.click();
  await page.keyboard.insertText('select * from orders;');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('[role=grid]')).toBeVisible();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1440, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(html(page)).toHaveAttribute('data-theme', theme);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
    });

    test('gallery: hover previews, a click applies, leaving restores', async ({ page }) => {
      await runQuery(page);
      await page.keyboard.press('Control+,');
      await expect(prefs(page).locator('[data-theme-id]')).toHaveCount(25);
      await page.mouse.move(0, 0);
      await capture(page, theme, 'prefs-appearance');

      await prefs(page).locator('[data-theme-id="mocha"]').hover();
      await expect(html(page)).toHaveAttribute('data-theme', 'mocha');
      await expect(
        prefs(page).getByRole('status').filter({ hasText: 'Preview: Catppuccin Mocha' }),
      ).toBeVisible();
      await capture(page, theme, 'prefs-preview');
      await page.mouse.move(0, 0);
      await expect(html(page)).toHaveAttribute('data-theme', theme);

      // Keyboard: the arrows preview, Esc ends the preview and keeps the dialog.
      await prefs(page).locator('[data-theme-id="graphite"]').focus();
      await page.keyboard.press('ArrowRight');
      await expect(html(page)).toHaveAttribute('data-theme', 'paper');
      await page.keyboard.press('Escape');
      await expect(html(page)).toHaveAttribute('data-theme', theme);
      await expect(prefs(page)).toBeVisible();

      await prefs(page).getByRole('textbox', { name: 'Filter themes' }).fill('latte');
      await prefs(page).locator('[data-theme-id="latte"]').click();
      await expect(html(page)).toHaveAttribute('data-theme', 'latte');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(prefs(page)).toBeHidden();
      await capture(page, theme, 'app-latte');

      // Saved, and applied before the first paint of the next launch.
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-theme', 'latte');
    });

    test('a search of the dialog that names a theme filters the gallery', async ({ page }) => {
      await page.keyboard.press('Control+,');
      await prefs(page).getByRole('searchbox', { name: 'Search the settings' }).fill('dracula');
      await expect(prefs(page).locator('[data-theme-id]')).toHaveCount(1);
      await expect(prefs(page).locator('[data-theme-id="dracula"]')).toBeVisible();
    });

    test('following the system: one theme per mode', async ({ page }) => {
      await page.keyboard.press('Control+,');
      const follow = prefs(page).getByRole('switch', { name: /Follow the system theme/ });
      await expect(follow).toBeChecked();
      const [same, other] =
        colorScheme === 'dark' ? ['dracula', 'github-light'] : ['github-light', 'dracula'];

      // A theme of the mode the OS is in: still following.
      await prefs(page).locator(`[data-theme-id="${same}"]`).click();
      await expect(html(page)).toHaveAttribute('data-theme', same);
      await expect(follow).toBeChecked();
      await page.mouse.move(0, 0);
      await capture(page, theme, 'prefs-slots');

      // One of the other mode is shown, and the OS is no longer followed.
      await prefs(page).locator(`[data-theme-id="${other}"]`).click();
      await expect(html(page)).toHaveAttribute('data-theme', other);
      await expect(follow).not.toBeChecked();

      // Following again: each mode has its theme.
      await follow.click();
      await expect(html(page)).toHaveAttribute('data-theme', same);
      await page.emulateMedia({ colorScheme: colorScheme === 'dark' ? 'light' : 'dark' });
      await expect(html(page)).toHaveAttribute('data-theme', other);
    });

    test('interface style and high contrast', async ({ page }) => {
      await runQuery(page);
      await page.keyboard.press('Control+,');
      await prefs(page).getByRole('radio', { name: 'Terminal' }).click();
      await expect(html(page)).toHaveAttribute('data-style', 'terminal');
      await prefs(page)
        .getByRole('switch', { name: /High contrast/ })
        .click();
      await expect(html(page)).toHaveAttribute('data-contrast', 'high');
      await page.keyboard.press('Escape');
      await expect(prefs(page)).toBeHidden();
      await capture(page, theme, 'app-terminal-high-contrast');

      await page.reload();
      await expect(html(page)).toHaveAttribute('data-style', 'terminal');
      await expect(html(page)).toHaveAttribute('data-contrast', 'high');
    });

    test('palette: "theme" then Enter lists the themes, Esc goes back', async ({ page }) => {
      await runQuery(page);
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: 'Command palette' }).fill('>color theme');
      await expect(page.getByRole('option').first()).toContainText('Theme: choose a color theme…');
      await page.keyboard.press('Enter');
      const picker = page.getByRole('combobox', { name: 'Color theme' });
      await expect(picker).toBeFocused();
      await expect(page.getByRole('option', { selected: true })).toContainText(
        theme === 'graphite' ? 'Graphite' : 'Paper',
      );
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(html(page)).not.toHaveAttribute('data-theme', theme);
      await capture(page, theme, 'palette-themes');
      await page.keyboard.press('Escape');
      await expect(html(page)).toHaveAttribute('data-theme', theme);

      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: 'Command palette' }).fill('>color theme');
      await page.keyboard.press('Enter');
      await picker.fill('tokyo');
      await page.keyboard.press('Enter');
      await expect(html(page)).toHaveAttribute('data-theme', 'tokyo-night');
      await capture(page, theme, 'app-tokyo-night');
    });
  });
}
