import { expect, test, type Page } from '@playwright/test';

import type { MockUpdateSetup } from '../src/ipc/mock/updates';
import type { MockBackend } from '../src/ipc/mockClient';

type MockWindow = Window & { __yadbeMock?: Pick<MockBackend, 'updates'> };

/**
 * Update check and upgrade (F-127) on the mocked backend: opt-in question, notice, the dialog of
 * each install channel (updater, package manager, release page), failures, a build without the
 * updater key.
 */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`updates-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

/** Starts the app with the update setup and the `checkUpdates` preference already saved. */
async function start(page: Page, setup: MockUpdateSetup, checkUpdates?: 'on' | 'off') {
  await page.addInitScript(
    ({ updates, preference }) => {
      (globalThis as { __YADBE_MOCK_UPDATES__?: unknown }).__YADBE_MOCK_UPDATES__ = updates;
      if (preference) {
        // The mock keeps the preferences across a reload (session storage): seed them there.
        sessionStorage.setItem(
          'yadbe.mock.reload',
          JSON.stringify({
            preferences: {
              theme: 'system',
              locale: null,
              density: 'comfortable',
              historyEnabled: true,
              historyMaxEntries: 50_000,
              historyMaxAgeDays: 365,
              connectTimeoutSecs: 15,
              journalMaxEntries: 1000,
              journalMaxAgeDays: 90,
              uiState: JSON.stringify({
                prefs: { version: 1, values: { checkUpdates: preference } },
              }),
            },
          }),
        );
      }
    },
    { updates: setup, preference: checkUpdates ?? null },
  );
  await page.goto('/');
  await expect(
    page.getByRole('tree', { name: 'Connections' }).getByRole('treeitem').first(),
  ).toBeVisible();
}

const counts = (page: Page) =>
  page.evaluate(() => ({ ...(window as MockWindow).__yadbeMock?.updates.counts }));
const toastWith = (page: Page, text: string) =>
  page.getByRole('listitem').filter({ hasText: text });
const dialog = (page: Page, version = '0.2.0') =>
  page.getByRole('dialog', { name: `yadbe ${version} is available` });

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 800 } });

    test('a build without the updater key asks nothing and says why', async ({ page }) => {
      await start(page, {});
      await expect(toastWith(page, 'Check for updates at startup?')).toHaveCount(0);

      await page.keyboard.press('Control+,');
      const prefs = page.getByRole('dialog', { name: 'Preferences' });
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'About' })
        .click();
      const toggle = prefs.getByRole('switch', { name: 'Check for updates at startup' });
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toBeChecked();
      await expect(prefs).toContainText('Not available in this build');
      await capture(page, name, 'not-configured-preferences');

      await prefs.getByRole('button', { name: 'Check for updates' }).click();
      // Over the modal preferences, the toast is out of the accessibility tree.
      await expect(
        page.getByText('Updates are not available in this build', { exact: true }),
      ).toBeVisible();
      expect((await counts(page)).checks).toBe(0);
      await capture(page, name, 'not-configured');
    });

    test('asks once at the first launch, and checks nothing before a yes', async ({ page }) => {
      await start(page, { configured: true, channel: 'selfUpdate', latest: '0.2.0' });
      const question = toastWith(page, 'Check for updates at startup?');
      await expect(question).toBeVisible();
      await expect(question).toContainText('send nothing else');
      expect((await counts(page)).checks).toBe(0);
      await capture(page, name, 'opt-in');

      await question.getByRole('button', { name: 'Check for updates' }).click();
      await expect(dialog(page)).toBeVisible();
      expect((await counts(page)).checks).toBe(1);
    });

    test('updates a release install in place, with progress', async ({ page }) => {
      await start(
        page,
        { configured: true, channel: 'selfUpdate', latest: '0.2.0', holdDownloads: true },
        'on',
      );
      const notice = toastWith(page, 'yadbe 0.2.0 is available');
      await expect(notice).toContainText('You have 0.1.0.');
      await capture(page, name, 'notice');
      await notice.getByRole('button', { name: 'See the update' }).click();

      const offer = dialog(page);
      await expect(offer).toContainText('Published on November 20, 2026. You have 0.1.0.');
      await expect(offer).toContainText('checks its signature');
      await capture(page, name, 'dialog-self');

      await offer.getByRole('button', { name: 'Update and restart' }).click();
      await expect(offer.getByRole('status')).toContainText('Downloading… 42%');
      await expect(offer.getByRole('button', { name: 'Close' })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(offer).toBeVisible();
      await capture(page, name, 'downloading');

      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.updates.finishDownload();
      });
      await expect(offer.getByRole('status')).toContainText('yadbe is restarting');
      expect((await counts(page)).installs).toBe(1);
    });

    test('gives a .deb install its checked package and the apt command', async ({ page }) => {
      await start(page, { configured: true, channel: 'deb', latest: '0.2.0' }, 'on');
      await toastWith(page, 'yadbe 0.2.0 is available')
        .getByRole('button', { name: 'See the update' })
        .click();
      const offer = dialog(page);
      await expect(offer).toContainText('installed from a .deb');
      await capture(page, name, 'dialog-deb');

      await offer.getByRole('button', { name: 'Download' }).click();
      const command = offer.getByTestId('upgrade-command');
      await expect(command).toHaveText(
        'sudo apt install /home/me/.cache/dev.tropico.yadbe/update/yadbe_0.2.0_amd64.deb',
      );
      await expect(offer).toContainText('checked against the checksums of the release');
      await capture(page, name, 'command');

      await offer.getByRole('button', { name: 'Restart yadbe' }).click();
      await expect.poll(async () => (await counts(page)).restarts).toBe(1);
    });

    test('an AUR install gets its helper command at once', async ({ page }) => {
      await start(page, { configured: true, channel: 'aur', latest: '0.2.0' }, 'on');
      await toastWith(page, 'yadbe 0.2.0 is available')
        .getByRole('button', { name: 'See the update' })
        .click();
      await dialog(page).getByRole('button', { name: 'Show the command' }).click();
      await expect(dialog(page).getByTestId('upgrade-command')).toHaveText('yay -S yadbe-bin');
    });

    test('a failed install says so and can be retried', async ({ page }) => {
      await start(page, { configured: true, channel: 'selfUpdate', latest: '0.2.0' }, 'on');
      await toastWith(page, 'yadbe 0.2.0 is available')
        .getByRole('button', { name: 'See the update' })
        .click();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.updates.failNext({
          code: 'updateInstallFailed',
          message: {
            en: 'The update could not be installed.',
            fr: "La mise à jour n'a pas pu être installée.",
          },
          action: 'retry',
          detail: 'the signature of the bundle does not match the public key',
        });
      });
      const offer = dialog(page);
      await offer.getByRole('button', { name: 'Update and restart' }).click();
      await expect(offer.getByRole('alert')).toContainText('The update did not go through');
      await capture(page, name, 'failed');

      await offer.getByRole('button', { name: 'Retry' }).first().click();
      await expect(offer.getByRole('status')).toContainText('yadbe is restarting');
    });

    test('sends a development build to the release page', async ({ page }) => {
      await start(page, { configured: true, channel: 'manual', latest: '0.2.0' }, 'on');
      await toastWith(page, 'yadbe 0.2.0 is available')
        .getByRole('button', { name: 'See the update' })
        .click();
      await dialog(page).getByRole('button', { name: 'Open the release page' }).click();
      await expect.poll(async () => (await counts(page)).releasePageOpens).toBe(1);
    });

    test('the palette and the preferences check on demand', async ({ page }) => {
      await start(page, { configured: true, channel: 'selfUpdate', latest: null }, 'off');
      expect((await counts(page)).checks).toBe(0);

      await page.keyboard.press('Control+k');
      await page.keyboard.type('>check for updates');
      await page.keyboard.press('Enter');
      const answer = toastWith(page, 'yadbe is up to date');
      await expect(answer).toBeVisible();
      await expect(answer).toContainText('You have the latest version, 0.1.0.');

      await page.keyboard.press('Control+,');
      const prefs = page.getByRole('dialog', { name: 'Preferences' });
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'About' })
        .click();
      const toggle = prefs.getByRole('switch', { name: 'Check for updates at startup' });
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await capture(page, name, 'preferences');
      await prefs.getByRole('button', { name: 'Check for updates' }).click();
      await expect.poll(async () => (await counts(page)).checks).toBe(2);
    });
  });
}
