import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app/App';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { DEFAULT_PANELS } from '../../app/layout/panels';
import { queryClient } from '../../app/queryClient';
import { useShellStore } from '../../app/shellStore';
import { createTabsStore, useTabsStore } from '../../app/tabs/tabsStore';
import { useSessions } from '../connections/connectionStore';
import { initI18n } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { initTheme } from '../../theme/themeStore';
import { usePaletteStore } from './paletteStore';
import { loadLazyModules } from '../../app/lazyModule';

// The dialogs and views loaded after startup are there, as in the app once it has settled.
beforeAll(() => loadLazyModules(), 60_000);

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  queryClient.clear();
  window.location.hash = '';
  initTheme('dark');
  initI18n('en');
  const { tabs, activeTabId, closedTabs, lastOrdinal } = createTabsStore().getState();
  useTabsStore.setState({ tabs, activeTabId, closedTabs, lastOrdinal });
  useLayoutStore.setState({ panels: DEFAULT_PANELS });
  useSessions.setState({ sessions: {}, errors: {} });
  useShellStore.setState({ connectionDialog: null });
  usePaletteStore.setState({ open: false, initialQuery: '', recents: [] });
});

const field = () => screen.findByRole('combobox', { name: 'Command palette' });

describe('command palette', () => {
  it('opens with the shortcut, lists the actions and runs one with Enter', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Connect to a database' });

    await user.keyboard('{Control>}k{/Control}');
    const input = await field();
    expect(input).toHaveFocus();
    const list = screen.getByRole('listbox', { name: 'Command palette' });
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(5);

    await user.keyboard('>new conn');
    const first = within(list).getAllByRole('option')[0];
    expect(first).toHaveTextContent('New connection');
    expect(first).toHaveTextContent('Ctrl');
    expect(input).toHaveAttribute('aria-activedescendant', first?.id ?? '');

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'New connection' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Command palette' })).not.toBeInTheDocument();
  }, 15_000);

  it('closes with Escape and with the shortcut, and explains an action that cannot run', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Connect to a database' });

    await user.keyboard('{Control>}k{/Control}');
    await field();
    await user.keyboard('>cancel');
    const [option] = await screen.findAllByRole('option');
    expect(option).toHaveTextContent('Cancel the running query');
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(option).toHaveTextContent('Nothing is running');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Command palette' })).not.toBeInTheDocument();

    await user.keyboard('{Control>}p{/Control}');
    await field();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('combobox', { name: 'Command palette' })).not.toBeInTheDocument();
  }, 15_000);

  it('narrows to one kind with a prefix and moves with the arrows, skipping headings', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Connect to a database' });

    await user.keyboard('{Control>}k{/Control}');
    const input = await field();
    await user.keyboard(':');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(3);
    for (const option of options) expect(option).toHaveAttribute('data-kind', 'connection');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]?.id);
  }, 15_000);
});
