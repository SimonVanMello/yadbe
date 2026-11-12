import { render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { useSessions } from '../features/connections/connectionStore';
import { initI18n } from '../i18n/i18n';
import { mockBackend } from '../ipc/mockClient';
import { initTheme } from '../theme/themeStore';
import { ACTION_IDS, registeredActions } from './actions';
import { App } from './App';
import { queryClient } from './queryClient';
import { loadLazyModules } from './lazyModule';

// The dialogs and views loaded after startup are there, as in the app once it has settled.
beforeAll(() => loadLazyModules(), 60_000);

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  queryClient.clear();
  window.location.hash = '';
  initTheme('dark');
  initI18n('en');
  useSessions.setState({ sessions: {}, errors: {} });
});

describe('action registry', () => {
  it('has something to run for every action once the app is up', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Connect to a database' });
    const registered = registeredActions();
    const missing = ACTION_IDS.filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  }, 15_000);
});
