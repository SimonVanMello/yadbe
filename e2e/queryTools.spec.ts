import { expect, test, type Page } from '@playwright/test';

/**
 * Query tools (M3-9) on the mocked backend, in both themes: the parameter prompt (F-048), the
 * SQL formatter (F-049), the hover card and go to definition (F-052), the plan tree (F-053).
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

interface MockControls {
  setLatency: (ms: number) => void;
  setQueryTick: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

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
const runStatus = (page: Page) => page.getByTestId('run-status');
const dialog = (page: Page) => page.getByRole('dialog');

async function openQueryTab(page: Page, connection: string) {
  await sidebarItem(page, connection).dblclick();
  await expect(editor(page)).toBeVisible();
  await expect(sidebarItem(page, connection)).toHaveAccessibleName(/Connected/);
}

async function setScript(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  if (text !== '') await page.keyboard.insertText(text);
}

const editorText = (page: Page) =>
  page
    .locator('.cm-content')
    .evaluate((node) =>
      [...node.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
    );

/** Puts the pointer on the `nth` occurrence of `word` in the editor. */
async function hoverWord(page: Page, word: string, nth = 0) {
  const point = await page.locator('.cm-content').evaluate(
    (node, [target, index]) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const at = (text.textContent ?? '').indexOf(target);
        if (at < 0) continue;
        if (seen++ < index) continue;
        const range = document.createRange();
        range.setStart(text, at + 1);
        range.setEnd(text, at + 2);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
    },
    [word, nth] as const,
  );
  if (!point) throw new Error(`"${word}" is not in the editor`);
  await page.mouse.move(point.x, point.y);
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(sidebarItem(page, 'local postgres')).toBeVisible();
      await page.evaluate(() => {
        const mock = (window as MockWindow).__yadbeMock;
        mock?.setLatency(0);
        mock?.setQueryTick(10);
        mock?.setMetaLatency(0);
      });
    });

    test('parameters are asked for, typed, remembered and sent with the run', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(
        page,
        "select * from shop.orders\nwhere status = :status and total > :min_total -- :not_a_parameter\n  and note <> ':no' and created_at::date < :before",
      );
      await page.keyboard.press('ControlOrMeta+Enter');
      const form = page.getByTestId('parameter-form');
      await expect(dialog(page)).toContainText('Values for 3 query parameters');
      await expect(form.locator('code')).toHaveText([':status', ':min_total', ':before']);
      await form.getByRole('textbox').nth(0).fill('shipped');
      await page.getByRole('combobox', { name: 'Type of :min_total' }).selectOption('number');
      await form.getByRole('textbox').nth(1).fill('12.5x');
      await expect(form.getByRole('alert')).toContainText('Not a number');
      await expect(dialog(page).getByRole('button', { name: 'Run' })).toBeDisabled();
      await form.getByRole('textbox').nth(1).fill('12.50');
      await page.getByRole('combobox', { name: 'Type of :before' }).selectOption('dateTime');
      await form.getByRole('textbox').nth(2).fill('2026-01-01');
      await capture(page, name, 'parameter-prompt');
      await page.keyboard.press('Enter');
      await expect(dialog(page)).toBeHidden();
      await expect(runStatus(page)).toContainText('1 statement');

      // The next run starts from the values given: Enter runs again with them.
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(form.getByRole('textbox').nth(0)).toHaveValue('shipped');
      await expect(page.getByRole('combobox', { name: 'Type of :min_total' })).toHaveValue(
        'number',
      );
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
    });

    test('Format SQL lays the script out, keeps strings and comments, undoes in one step', async ({
      page,
    }) => {
      await openQueryTab(page, 'local postgres');
      const script =
        "select o.id, o.total, c.email from shop.orders o join shop.customers c on c.id = o.customer_id where o.status = 'from where' and o.total between 10 and 20 -- keep me\norder by o.id desc limit 10;";
      await setScript(page, script);
      await page.keyboard.press('Shift+Alt+F');
      await expect.poll(() => editorText(page)).toContain('\nFROM shop.orders o');
      const text = await editorText(page);
      expect(text).toContain("'from where'");
      expect(text).toContain('-- keep me');
      expect(text).toContain('  JOIN shop.customers c ON c.id = o.customer_id');
      expect(text).toContain('BETWEEN 10 AND 20');
      await capture(page, name, 'formatted-script');
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => editorText(page)).toBe(script);
    });

    test('hovering a name shows its card; F12 reveals it in the explorer', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(
        page,
        'select o.total, o.status\nfrom shop.orders o\nwhere o.customer_id = 1',
      );
      await hoverWord(page, 'orders');
      const card = page.getByTestId('hover-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Table');
      await expect(card).toContainText('shop.orders');
      await expect(card).toContainText('customer_id');
      await expect(card.getByText('PK').first()).toBeVisible();
      await capture(page, name, 'hover-table');
      await hoverWord(page, 'total');
      await expect(card).toContainText('Column');
      await expect(card).toContainText('numeric(12,2)');
      await capture(page, name, 'hover-column');

      // F12 at the cursor: the explorer opens on the table.
      await page.mouse.move(0, 0);
      await editor(page).click();
      await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('F12');
      const tree = page.getByRole('tree', { name: 'Connections' });
      const row = tree.getByRole('treeitem', { name: /^orders$/ });
      await expect(row).toBeVisible();
      await expect(tree).toBeFocused();
      await expect(tree).toHaveAttribute(
        'aria-activedescendant',
        (await row.getAttribute('id')) ?? '',
      );
      await capture(page, name, 'go-to-definition');
    });

    test('Explain shows the plan as a tree with the costly nodes highlighted', async ({ page }) => {
      await openQueryTab(page, 'local postgres');
      await setScript(
        page,
        'select * from shop.orders o join shop.customers c on c.id = o.customer_id order by o.total desc',
      );
      await page.keyboard.press('ControlOrMeta+l');
      const plan = page.getByTestId('plan-view');
      await expect(plan).toBeVisible();
      await expect(plan).toContainText('Estimated plan');
      await expect(page.getByRole('tab', { name: 'Plan' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const rows = page.getByTestId('plan-row');
      await expect(rows).toHaveCount(4);
      await expect(
        page.locator('[data-testid="plan-row"][data-heat="high"]').first(),
      ).toBeVisible();
      // The heaviest operation is selected, its facts on the side.
      await expect(page.getByTestId('plan-facts')).toContainText('Hash Join');
      await capture(page, name, 'plan-estimated');

      // Explain analyze from the toolbar menu: a read runs without asking.
      await page.getByRole('button', { name: 'Explain options' }).click();
      await page.getByRole('menuitem', { name: /Explain analyze/ }).click();
      await expect(plan).toContainText('Actual plan');
      await expect(page.getByRole('tab', { name: 'Actual plan' })).toBeVisible();
      await capture(page, name, 'plan-actual');
      await plan.getByRole('radio', { name: 'Raw' }).click();
      await expect(page.getByTestId('plan-raw')).toContainText('EXPLAIN (ANALYZE, BUFFERS');

      // A write asks first: the plan runs the statement.
      await setScript(page, 'delete from shop.orders where id = 1');
      await page.keyboard.press('ControlOrMeta+Alt+l');
      await expect(dialog(page)).toContainText('Run the statement to measure its plan?');
      await page.keyboard.press('Escape');

      // Running the script gives the results back their place.
      await setScript(page, 'select 1');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(runStatus(page)).toContainText('1 statement');
      await expect(page.getByTestId('plan-view')).toBeHidden();
    });
  });
}
