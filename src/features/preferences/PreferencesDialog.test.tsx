import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from 'radix-ui';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetBackendPreferences } from '../../app/backendPreferences';
import { shortcutFor } from '../../app/actions';
import { useKeybindingsStore } from '../../app/keybindingsStore';
import { queryClient } from '../../app/queryClient';
import { useShellStore } from '../../app/shellStore';
import { initI18n } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { initTheme } from '../../theme/themeStore';
import { defaultValues } from './preferenceSchema';
import { getPreference, usePreferenceStore } from './preferenceStore';
import { PreferencesDialog } from './PreferencesDialog';

beforeEach(() => {
  mockBackend.reset();
  resetBackendPreferences();
  queryClient.clear();
  initTheme('dark');
  initI18n('en');
  usePreferenceStore.setState({ values: defaultValues() });
  useShellStore.setState({ preferences: null });
  useKeybindingsStore.getState().resetAll();
});

function openDialog() {
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <PreferencesDialog />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  act(() => {
    useShellStore.getState().openPreferences();
  });
}

describe('the preferences screen', () => {
  it('opens on Appearance, with a section per group of settings', async () => {
    openDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Preferences' });
    const nav = within(dialog).getByRole('navigation', { name: 'Preference sections' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'Appearance',
      'Editor',
      'Results and data',
      'Keyboard shortcuts',
      'History',
      'Connections',
      'About',
    ]);
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens on the section it was asked for', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesDialog />
      </QueryClientProvider>,
    );
    act(() => {
      useShellStore.getState().openPreferences('history');
    });
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
  });

  it('applies a change at once and offers its reset only when it differs from the default', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.click(await screen.findByRole('button', { name: 'Editor' }));
    expect(screen.queryByRole('button', { name: /^Reset “/ })).toBeNull();
    await user.click(screen.getByRole('switch', { name: /Wrap long lines/ }));
    expect(getPreference('lineWrapping')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reset “Wrap long lines” to default' }));
    expect(getPreference('lineWrapping')).toBe(false);
  });

  it('resets a whole section', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.click(await screen.findByRole('button', { name: 'Editor' }));
    const reset = screen.getByRole('button', { name: 'Reset section to default' });
    expect(reset).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: /Line numbers/ }));
    await user.click(screen.getByRole('radio', { name: '4' }));
    expect(getPreference('tabSize')).toBe(4);
    await user.click(reset);
    expect(getPreference('lineNumbers')).toBe(true);
    expect(getPreference('tabSize')).toBe(2);
  });

  it('commits a number on blur, clamped to its range', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.click(await screen.findByRole('button', { name: 'History' }));
    const field = screen.getByRole('spinbutton', { name: 'Most entries kept' });
    await user.clear(field);
    await user.type(field, '5');
    await user.tab();
    expect(getPreference('historyMaxEntries')).toBe(100);
    expect(field).toHaveValue(100);
  });

  it('searches every section and shows the matches under their section', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.type(await screen.findByRole('searchbox', { name: 'Search the settings' }), 'wrap');
    expect(await screen.findByRole('heading', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Wrap long lines/ })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Line numbers/ })).toBeNull();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(await screen.findByText(/No setting matches/)).toBeInTheDocument();
  });

  it('rebinds an action from the shortcuts section, and warns before taking a used shortcut', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.click(await screen.findByRole('button', { name: 'Keyboard shortcuts' }));
    await user.click(screen.getByRole('button', { name: 'Change the shortcut of New tab' }));
    await user.keyboard('{Control>}{Alt>}j{/Alt}{/Control}');
    expect(shortcutFor('tab.new')).toBe('Mod+Alt+J');

    // `Ctrl+W` closes a tab: taking it asks first.
    await user.click(screen.getByRole('button', { name: 'Change the shortcut of New tab' }));
    await user.keyboard('{Control>}w{/Control}');
    expect(await screen.findByText(/Already used by Close the tab/)).toBeInTheDocument();
    expect(shortcutFor('tab.new')).toBe('Mod+Alt+J');
    await user.click(screen.getByRole('button', { name: 'Take it over' }));
    expect(shortcutFor('tab.new')).toBe('Mod+W');
    expect(shortcutFor('tab.close')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(shortcutFor('tab.new')).toBe('Mod+T');
    expect(shortcutFor('tab.close')).toBe('Mod+W');
  }, 20_000);

  it('finds the shortcuts section by searching for a shortcut', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.type(
      await screen.findByRole('searchbox', { name: 'Search the settings' }),
      'rebind',
    );
    expect(await screen.findByTestId('keybindings')).toBeInTheDocument();
  });

  it('says that the production guard cannot be turned off', async () => {
    const user = userEvent.setup();
    openDialog();
    await user.click(await screen.findByRole('button', { name: 'Editor' }));
    expect(screen.getByText(/Always on for connections tagged prod/)).toBeInTheDocument();
  });
});
