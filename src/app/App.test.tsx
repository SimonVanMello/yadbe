import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useSessions } from '../features/connections/connectionStore';
import { initI18n } from '../i18n/i18n';
import { mockBackend } from '../ipc/mockClient';
import { initTheme } from '../theme/themeStore';
import { App } from './App';
import { useLayoutStore } from './layout/layoutStore';
import { DEFAULT_PANELS } from './layout/panels';
import { queryClient } from './queryClient';
import { createTabsStore, useTabsStore } from './tabs/tabsStore';

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
});

describe('App', () => {
  it('opens on the welcome screen with the saved connections', async () => {
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Connect to a database' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('listbox', { name: 'Connections' });
    expect(within(list).getByRole('option', { name: /shop · prod/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'New tab' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens a connection from the welcome list in a query tab and connects', async () => {
    const user = userEvent.setup();
    render(<App />);
    const list = await screen.findByRole('listbox', { name: 'Connections' });
    await user.click(within(list).getByRole('option', { name: /local postgres/ }));
    expect(await screen.findByRole('tab', { name: /Query 1, local postgres/ })).toBeInTheDocument();
    expect(await screen.findByText('PostgreSQL 16.4')).toBeInTheDocument();
    expect(await screen.findByTestId('sql-editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // Renders the whole shell and connects: about 3 s alone, which a loaded machine doubles.
  }, 15_000);

  it('filters the sidebar with the fuzzy search', async () => {
    const user = userEvent.setup();
    render(<App />);
    const tree = await screen.findByRole('tree', { name: 'Connections' });
    await within(tree).findByRole('treeitem', { name: /^shop · prod,/ });
    await user.type(screen.getByRole('textbox', { name: 'Filter connections' }), 'wpress');
    const items = within(tree).getAllByRole('treeitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAccessibleName(/^wordpress,/);
  });

  it('shows the unavailable engines of this build with a notice in the connection form', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('tree', { name: 'Connections' });
    await user.click(screen.getAllByRole('button', { name: 'New connection' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New connection' });
    await user.click(await within(dialog).findByRole('radio', { name: 'SQL Server' }));
    expect(within(dialog).getByRole('note')).toHaveTextContent(/SQL Server is not available/);
    expect(within(dialog).getByRole('textbox', { name: 'Port' })).toHaveValue('1433');
  });

  it('shows the primitives page on #primitives', async () => {
    window.location.hash = '#primitives';
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'UI primitives' })).toBeVisible();
  });
});
