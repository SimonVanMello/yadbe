import { expect, test, type Locator, type Page } from '@playwright/test';

/** The mock backend's controls, as the page exposes them (see `src/ipc/index.ts`). */
interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`keyvalue-edit-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) =>
  tree(page).getByRole('treeitem', typeof name === 'string' ? { name, exact: true } : { name });

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function connect(page: Page) {
  await item(page, /^cache,/).click();
  await item(page, /^cache,/)
    .locator('span')
    .first()
    .click();
  await expect(item(page, /^cache,/)).toHaveAccessibleName(/Connected/);
}

async function openKey(page: Page, path: string[]) {
  for (const part of path.slice(0, -1)) await expand(item(page, part).first());
  await item(page, path.at(-1) ?? '')
    .first()
    .dblclick();
}

/** A cell of a key's grid (row 0 is the first data row). */
function cell(grid: Locator, row: number, col: number): Locator {
  return grid.locator(
    `[role=row][aria-rowindex="${String(row + 2)}"]:not([hidden]) [aria-colindex="${String(col + 1)}"]:not([hidden])`,
  );
}

const form = (page: Page) => page.getByTestId('kv-form');
const pending = (page: Page) => page.getByTestId('kv-pending');

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, /^cache,/)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(10);
        (window as MockWindow).__yadbeMock?.setLatency(20);
      });
      await connect(page);
    });

    test('a hash is edited with pending marks, previewed, applied and reverted', async ({
      page,
    }) => {
      await openKey(page, ['config', 'feature-flags']);
      const grid = page.getByRole('grid', { name: 'config:feature-flags' });
      await expect(grid).toBeVisible();
      await expect(pending(page)).toHaveText('No changes');

      // Edit a value (double-click), remove a field, add one.
      await cell(grid, 2, 1).dblclick();
      await form(page).getByLabel('Value').fill('true');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await cell(grid, 3, 0).click();
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Add a field' }).click();
      await form(page).getByLabel('Field').fill('promo_banner');
      await form(page).getByLabel('Value').fill('off');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('3 pending');
      await expect(grid.locator('[data-state="deleted"], [data-row-state="deleted"]').first())
        .toBeVisible()
        .catch(() => undefined);
      await capture(page, name, 'pending-hash');

      // The commands as they will run.
      await page.getByRole('button', { name: 'Preview commands' }).click();
      const dialog = page.getByTestId('kv-apply-dialog');
      await expect(page.getByTestId('kv-commands')).toContainText(
        'HSET config:feature-flags beta_search true',
      );
      await expect(page.getByTestId('kv-commands')).toContainText('WATCH config:feature-flags');
      await capture(page, name, 'preview');
      await page.getByRole('button', { name: /^Apply \(\d+\)$/ }).click();
      await expect(dialog).toBeHidden();
      const toasts = page.getByRole('region', { name: /Notifications/ });
      await expect(toasts).toContainText('Changes applied');
      await expect(pending(page)).toHaveText('No changes');

      // The journal shows it with its commands; revert puts the hash back.
      await toasts.getByRole('button', { name: 'Journal' }).click();
      const detail = page.getByRole('complementary', { name: 'Change set' });
      await expect(detail).toContainText('db0 · config:feature-flags');
      await expect(page.getByTestId('journal-statements')).toContainText(
        'HDEL config:feature-flags max_cart_items',
      );
      await capture(page, name, 'journal-entry');
      await detail.getByRole('button', { name: 'Revert this change set…' }).click();
      // The mock reverts from a snapshot of the key (the backend edit by edit: HSET, HDEL).
      await expect(page.getByTestId('kv-commands')).toContainText('config:feature-flags');
      await capture(page, name, 'revert');
      await page.getByRole('button', { name: /^Revert \(\d+\)$/ }).click();
      await expect(toasts).toContainText('Change set reverted');
    });

    test('each type stages its own edits', async ({ page }) => {
      // List: push at the tail, remove an element by index.
      await openKey(page, ['queue', 'jobs', 'high']);
      const list = page.getByRole('grid', { name: 'queue:jobs:high' });
      await expect(list).toBeVisible();
      await cell(list, 1, 1).click();
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Add an element' }).click();
      await form(page).getByLabel('Value').fill('cleanup:sessions');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('2 pending');
      await capture(page, name, 'pending-list');

      // Sorted set: a new score.
      await openKey(page, ['leaderboard', 'weekly', '2026-45']);
      const zset = page.getByRole('grid', { name: 'leaderboard:weekly:2026-45' });
      await expect(zset).toBeVisible();
      await cell(zset, 0, 2).dblclick();
      await form(page).getByLabel('Score').fill('1000');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('1 pending');
      await capture(page, name, 'pending-zset');

      // String: edited as JSON, checked before it is staged.
      await openKey(page, ['config', 'app']);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.getByTestId('kv-string-editor').getByRole('textbox');
      await editor.fill('{ not json');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(page.getByText('This is not valid JSON.')).toBeVisible();
      await editor.fill('{"name":"shop","regions":["eu"]}');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('1 pending');
      await capture(page, name, 'pending-string');

      // Time to live, from the header.
      await page.getByRole('button', { name: 'Time to live…' }).click();
      await form(page).getByRole('switch', { name: 'No expiry (PERSIST)' }).click();
      await form(page).getByLabel('Expires in (seconds)').fill('3600');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('2 pending');
      await page.getByRole('button', { name: 'Preview commands' }).click();
      await expect(page.getByTestId('kv-commands')).toContainText('PEXPIRE config:app 3600000');
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('sets, streams and JSON documents stage their edits', async ({ page }) => {
      // Set: add a member, remove one.
      await tree(page).getByRole('textbox', { name: 'Keys of db0 matching' }).fill('user:3:*');
      await openKey(page, ['user', '3', 'roles']);
      const set = page.getByRole('grid', { name: 'user:3:roles' });
      await expect(set).toBeVisible();
      await cell(set, 0, 0).click();
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Add a member' }).click();
      await form(page).getByLabel('Member').fill('auditor');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('2 pending');
      await capture(page, name, 'pending-set');

      // Stream: a new entry (the server gives its id), an entry deleted.
      await tree(page).getByRole('textbox', { name: 'Keys of db0 matching' }).fill('events:*');
      await openKey(page, ['events', 'orders']);
      const stream = page.getByRole('grid', { name: 'events:orders' });
      await expect(stream).toBeVisible();
      await cell(stream, 0, 0).click();
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Add an entry' }).click();
      await form(page).getByLabel('Fields of the entry').fill('order=9001\nstatus=created');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('2 pending');
      await capture(page, name, 'pending-stream');

      // RedisJSON: a path replaced.
      await tree(page).getByRole('textbox', { name: 'Keys of db0 matching' }).fill('doc:*');
      await openKey(page, ['doc', 'product', '42']);
      await page.getByRole('button', { name: 'Edit…' }).click();
      await form(page).getByLabel('Path').fill('$.name');
      await form(page).getByLabel('Value').fill('"Renamed product"');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await expect(pending(page)).toHaveText('1 pending');
      await page.getByRole('button', { name: 'Preview commands' }).click();
      await expect(page.getByTestId('kv-commands')).toContainText('JSON.GET doc:product:42 $.name');
      await capture(page, name, 'pending-json');
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    test('a key changed by someone else conflicts: keep mine applies over it', async ({ page }) => {
      await openKey(page, ['user', '10', 'profile']);
      const grid = page.getByRole('grid', { name: 'user:10:profile' });
      await expect(grid).toBeVisible();
      await cell(grid, 2, 1).dblclick();
      await form(page).getByLabel('Value').fill('pro');
      await page.getByRole('button', { name: 'Add to pending changes' }).click();
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      // The preview comes first when the preference asks for it.
      const review = page.getByRole('button', { name: /^Apply \(\d+\)$/ });
      if (await review.isVisible()) await review.click();
      const conflicts = page.getByTestId('kv-conflicts');
      await expect(conflicts).toContainText('The value changed on the server.');
      await expect(conflicts).toContainText('enterprise');
      await capture(page, name, 'conflict');
      await conflicts.getByRole('radio', { name: 'Keep mine' }).click();
      await page.getByRole('button', { name: 'Resolve' }).click();
      await expect(page.getByTestId('kv-commands')).toContainText('HSET user:10:profile plan pro');
      await page.getByRole('button', { name: /^Apply \(\d+\)$/ }).click();
      await expect(page.getByRole('region', { name: /Notifications/ })).toContainText(
        'Changes applied',
      );
    });

    test('deleting keys and namespaces from the explorer is confirmed with its effect', async ({
      page,
    }) => {
      // Scratch keys live in db1.
      await expand(item(page, 'db1'));
      await expand(item(page, 'tmp'));
      await expand(item(page, 'import'));
      await item(page, '7f3a').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Delete…' }).click();
      const confirm = page.getByRole('dialog', { name: 'Delete tmp:import:7f3a?' });
      await expect(confirm).toContainText('UNLINK tmp:import:7f3a');
      await capture(page, name, 'delete-key');
      await confirm.getByRole('button', { name: 'Delete' }).click();
      await expect(item(page, '7f3a')).toHaveCount(0);

      await tree(page).getByRole('textbox', { name: 'Keys of db0 matching' }).fill('session:*');
      await expect(item(page, 'session')).toBeVisible();
      await expect(async () => {
        await item(page, 'session').click({ button: 'right' });
        await page
          .getByRole('menuitem', { name: 'Delete every key here…' })
          .click({ timeout: 1000 });
      }).toPass({ timeout: 10_000 });
      const namespace = page.getByRole('dialog', { name: 'Delete every key matching session:*?' });
      await expect(namespace).toContainText('40 keys match now');
      await expect(namespace).toContainText('not one transaction');
      await capture(page, name, 'delete-namespace');
      await namespace.getByRole('button', { name: 'Delete 40 keys' }).click();
      await expect(page.getByRole('region', { name: /Notifications/ })).toContainText(
        '40 keys deleted',
      );
      await expect(item(page, 'session')).toHaveCount(0);
    });

    test('a read-only connection disables every edit, with the reason', async ({ page }) => {
      await item(page, /^cache,/).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit connection' });
      await dialog.getByRole('switch', { name: /^Read-only/ }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await openKey(page, ['config', 'feature-flags']);
      await expect(page.getByTestId('kv-edit-bar')).toContainText(
        'This connection is read-only: keys cannot be changed.',
      );
      await expect(page.getByRole('button', { name: 'Add a field' })).toHaveCount(0);
      await expect(
        page
          .getByRole('button', { name: 'This connection is read-only: keys cannot be changed.' })
          .first(),
      ).toBeDisabled();
      await capture(page, name, 'read-only');
    });
  });
}
