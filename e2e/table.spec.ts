import { expect, test, type Locator, type Page } from '@playwright/test';

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

test('explore', async ({ page }) => {
  test.use;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await item(page, /^local postgres,/).dblclick();
  await expect(item(page, /^local postgres,/)).toHaveAccessibleName(/Connected/);
  await expand(item(page, /^shop$/));
  await expand(item(page, /^Tables \(/));
  await item(page, /^orders$/).dblclick();
  await expect(page.getByRole('grid', { name: /Rows of shop.orders/ })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: test.info().outputPath('explore-1.png') });
  const grid = page.getByRole('grid', { name: /Rows of/ });
  const cell = grid.locator('[role=row][aria-rowindex="3"] [aria-colindex="3"]');
  await cell.dblclick();
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath('explore-2.png') });
  await page.keyboard.type('X');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath('explore-3.png') });
});
