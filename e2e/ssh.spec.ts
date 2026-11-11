import { expect, test, type Locator, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

/** Opens the connection dialog and turns its SSH tunnel section on. */
async function newTunnelledConnection(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'New connection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Host', { exact: true }).fill('db.internal');
  await dialog.getByRole('textbox', { name: 'Password', exact: true }).fill('secret');
  const section = dialog.getByRole('button', { name: /^SSH tunnel/ });
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await section.click();
  await dialog.getByRole('switch', { name: 'Connect through an SSH tunnel' }).click();
  return dialog;
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
    });

    test('SSH tunnel section with a jump host', async ({ page }) => {
      const dialog = await newTunnelledConnection(page);
      await dialog.getByLabel('SSH host').fill('bastion.example.com');
      await dialog.getByLabel('SSH user').fill('deploy');
      await dialog.getByLabel('Private key file').fill('~/.ssh/id_ed25519');
      await dialog.getByRole('switch', { name: 'Go through a jump host first' }).click();
      const jump = dialog.getByRole('group', { name: 'Jump host' });
      await jump.getByLabel('SSH host').fill('jump.example.com');
      await jump.getByLabel('SSH user').fill('ops');
      await jump.getByRole('radio', { name: 'SSH agent' }).click();
      await expect(dialog.getByRole('button', { name: /^SSH tunnel/ })).toContainText(
        'ops@jump.example.com:22 → deploy@bastion.example.com:22',
      );
      await dialog.getByLabel('SSH host').first().scrollIntoViewIfNeeded();
      await capture(page, name, 'ssh-section');

      // Saved, the connection shows its tunnel; the form keeps no secret.
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
    });

    test('an unknown host key is shown with its fingerprint, then trusted', async ({ page }) => {
      const dialog = await newTunnelledConnection(page);
      await dialog.getByLabel('SSH host').fill('new-bastion.example.com');
      await dialog.getByLabel('SSH user').fill('deploy');
      await dialog.getByRole('radio', { name: 'SSH agent' }).click();
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      const prompt = page.getByRole('dialog', { name: 'Unknown SSH host key' });
      await expect(prompt).toBeVisible();
      await expect(prompt.getByTestId('host-key-fingerprint')).toContainText(/^SHA256:/);
      await expect(prompt).toContainText('new-bastion.example.com:22');
      await capture(page, name, 'ssh-host-key');

      await prompt.getByRole('button', { name: 'Trust this key' }).click();
      await expect(prompt).toBeHidden();
      const ok = dialog.getByRole('status').filter({ hasText: 'Connected to PostgreSQL' });
      await expect(ok).toBeVisible();
      await expect(ok.getByRole('list', { name: 'Route of the test' })).toContainText('Database');
      await capture(page, name, 'ssh-test-ok');
    });

    test('a failed test names the hop that failed', async ({ page }) => {
      const dialog = await newTunnelledConnection(page);
      await dialog.getByLabel('SSH host').fill('fail-ssh-refused');
      await dialog.getByLabel('SSH user').fill('deploy');
      await dialog.getByRole('radio', { name: 'SSH agent' }).click();
      await dialog.getByRole('switch', { name: 'Go through a jump host first' }).click();
      const jump = dialog.getByRole('group', { name: 'Jump host' });
      await jump.getByLabel('SSH host').fill('bastion.example.com');
      await jump.getByLabel('SSH user').fill('ops');
      await jump.getByRole('radio', { name: 'SSH agent' }).click();
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      const alert = dialog.getByRole('alert').filter({ hasText: 'The connection test failed' });
      await expect(alert).toContainText('SSH tunnel: the SSH server fail-ssh-refused:22');
      const route = dialog.getByRole('list', { name: 'Route of the test' });
      await expect(route.getByRole('listitem').filter({ hasText: 'SSH server' })).toContainText(
        'failed here',
      );
      await expect(route.getByRole('listitem').filter({ hasText: 'Jump host' })).toContainText(
        'reached',
      );
      await capture(page, name, 'ssh-test-failed-hop');
    });

    test('preferences list the trusted host keys', async ({ page }) => {
      await page.keyboard.press('Control+,');
      const preferences = page.getByRole('dialog', { name: /Preferences/ });
      await expect(preferences).toBeVisible();
      await preferences.getByRole('searchbox').fill('known hosts');
      const hosts = preferences.getByRole('list', { name: 'SSH known hosts' });
      await expect(hosts).toContainText('bastion.example.com:22');
      await capture(page, name, 'ssh-known-hosts');
    });
  });
}
