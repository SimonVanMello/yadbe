import { expect, test } from '@playwright/test';

for (const { name, colorScheme } of [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('the shell shows the app name and version from app_info', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(page.getByRole('heading', { level: 1, name: 'yadbe' })).toBeVisible();
      await expect(page.getByTestId('app-info')).toHaveText('Version 0.1.0 · linux x86_64');
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: test.info().outputPath(`shell-${name}.png`),
        animations: 'disabled',
      });
    });
  });
}

test('the shell links to the primitives page and back', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'UI primitives' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'UI primitives' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the app' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'yadbe' })).toBeVisible();
});
