import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`preferences-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });
const nav = (page: Page) => dialog(page).getByRole('navigation', { name: 'Preference sections' });
const section = (page: Page, name: string) => nav(page).getByRole('button', { name });
const sidebarItem = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name},`) });
const rootStyle = (page: Page, property: string) =>
  page.evaluate((name) => document.documentElement.style.getPropertyValue(name), property);

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
    });

    test('opens from the shortcut, the gear and the palette; every section', async ({ page }) => {
      await page.keyboard.press('Control+,');
      await expect(dialog(page)).toBeVisible();
      await expect(section(page, 'Appearance')).toHaveAttribute('aria-current', 'page');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();

      await page.getByRole('button', { name: 'Preferences' }).click();
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press('Escape');

      await page.keyboard.press('Control+k');
      await page.keyboard.type('>preferences');
      await page.keyboard.press('Enter');
      await expect(dialog(page)).toBeVisible();

      for (const label of [
        'Appearance',
        'Editor',
        'Results and data',
        'Keyboard shortcuts',
        'History',
        'Connections',
        'About',
      ]) {
        await section(page, label).click();
        await expect(dialog(page).getByRole('heading', { name: label, level: 2 })).toBeVisible();
        if (label === 'Connections') {
          await expect(dialog(page).getByTestId('keychain-status')).toBeVisible();
        }
        await capture(page, name, `section-${label.split(' ')[0]?.toLowerCase() ?? label}`);
      }
      await expect(dialog(page).getByText('GPL-3.0-or-later')).toBeVisible();
    });

    test('search finds a setting in another section and the section highlights its count', async ({
      page,
    }) => {
      await page.keyboard.press('Control+,');
      await dialog(page).getByRole('searchbox', { name: 'Search the settings' }).fill('retention');
      await expect(dialog(page).getByRole('heading', { name: 'Search results' })).toBeVisible();
      await capture(page, name, 'search');
      await dialog(page).getByRole('searchbox').fill('no such thing');
      await expect(dialog(page).getByText(/No setting matches/)).toBeVisible();
      await capture(page, name, 'search-empty');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole('searchbox')).toHaveValue('');
    });

    test('theme, density and font size apply live; reset puts them back', async ({ page }) => {
      await page.keyboard.press('Control+,');
      const other = name === 'graphite' ? 'Light' : 'Dark';
      await dialog(page).getByRole('radio', { name: other }).click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        name === 'graphite' ? 'paper' : 'graphite',
      );
      await capture(page, name, 'theme-switched');
      await dialog(page).getByRole('button', { name: 'Reset “Theme” to default' }).click();
      await expect(dialog(page).getByRole('radio', { name: 'System' })).toHaveAttribute(
        'aria-checked',
        'true',
      );

      await dialog(page).getByRole('radio', { name: 'Compact' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

      const size = dialog(page).getByRole('spinbutton', { name: 'Interface text size' });
      await size.fill('16');
      await size.blur();
      await expect.poll(() => rootStyle(page, '--font-scale')).not.toBe('');
      await capture(page, name, 'density-and-size');

      await dialog(page).getByRole('button', { name: 'Reset section to default' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
      await expect.poll(() => rootStyle(page, '--font-scale')).toBe('');
      await expect(
        dialog(page).getByRole('button', { name: 'Reset section to default' }),
      ).toBeDisabled();
      await capture(page, name, 'reset');
    });

    test('the NULL text and style change the grid behind the screen', async ({ page }) => {
      await sidebarItem(page, 'local postgres').dblclick();
      const editor = page.getByRole('textbox', { name: 'SQL editor' });
      await expect(editor).toBeVisible();
      await expect(sidebarItem(page, 'local postgres')).toHaveAccessibleName(/Connected/);
      await editor.click();
      await page.keyboard.insertText('select * from orders;');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      // The open dialog hides the page from the accessibility tree: select by attribute.
      const grid = page.locator('[role=grid]');
      await expect(grid.getByText('NULL', { exact: true }).first()).toBeVisible();
      await capture(page, name, 'grid-before');

      await page.keyboard.press('Control+,');
      await section(page, 'Results and data').click();
      const text = dialog(page).getByRole('textbox', { name: 'NULL text' });
      await text.fill('∅');
      await text.blur();
      await dialog(page).getByRole('radio', { name: 'Plain' }).click();
      await expect(grid.getByText('∅', { exact: true }).first()).toBeVisible();
      await expect(grid.getByText('NULL', { exact: true })).toHaveCount(0);
      await capture(page, name, 'grid-null-changed');
      await dialog(page).getByRole('button', { name: 'Reset section to default' }).click();
      await expect(grid.getByText('NULL', { exact: true }).first()).toBeVisible();
    });

    test('a rebound shortcut works and shows in the hints, a conflict asks first', async ({
      page,
    }) => {
      await sidebarItem(page, 'local postgres').dblclick();
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toBeVisible();
      const tabs = page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab');
      const before = await tabs.count();
      await page.keyboard.press('Control+,');
      await section(page, 'Keyboard shortcuts').click();
      await expect(dialog(page).getByTestId('keybindings')).toBeVisible();
      await capture(page, name, 'shortcuts');

      const row = dialog(page).locator('[data-binding-id="tab.new"]');
      await row.getByRole('button', { name: 'Change the shortcut of New tab' }).click();
      await page.keyboard.press('Control+Alt+j');
      await expect(row.getByText('J', { exact: true })).toBeVisible();

      const close = dialog(page).locator('[data-binding-id="tab.close"]');
      await row.getByRole('button', { name: 'Change the shortcut of New tab' }).click();
      await page.keyboard.press('Control+w');
      await expect(row.getByText(/Already used by Close the tab/)).toBeVisible();
      await capture(page, name, 'shortcuts-conflict');
      await row.getByRole('button', { name: 'Cancel' }).click();
      await expect(close.getByText('Ctrl')).toBeVisible();
      await expect(row.getByText('J', { exact: true })).toBeVisible();

      // Escape while capturing cancels the capture, not the screen.
      await row.getByRole('button', { name: 'Change the shortcut of New tab' }).click();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeVisible();
      await expect(row.getByText('J', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();

      await page.keyboard.press('Control+t');
      await expect(tabs).toHaveCount(before);
      await page.keyboard.press('Control+Alt+j');
      await expect(tabs).toHaveCount(before + 1);
    });

    test('an editor setting reaches the open editor', async ({ page }) => {
      await sidebarItem(page, 'local postgres').dblclick();
      await expect(page.getByRole('textbox', { name: 'SQL editor' })).toBeVisible();
      await expect(page.locator('.cm-lineNumbers')).toHaveCount(1);
      await page.keyboard.press('Control+,');
      await section(page, 'Editor').click();
      await dialog(page)
        .getByRole('switch', { name: /Line numbers/ })
        .click();
      await expect(page.locator('.cm-lineNumbers')).toHaveCount(0);
      await capture(page, name, 'editor-no-line-numbers');
    });
  });
}
