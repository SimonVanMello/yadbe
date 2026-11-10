import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { initI18n } from '../i18n/i18n';
import { mockBackend } from '../ipc/mockClient';
import { initTheme } from '../theme/themeStore';
import { App } from './App';
import { queryClient } from './queryClient';

beforeEach(() => {
  mockBackend.reset();
  queryClient.clear();
  window.location.hash = '';
  initTheme('dark');
  initI18n('en');
});

describe('App', () => {
  it('shows the app name and the version reported by the backend', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'yadbe' })).toBeInTheDocument();
    expect(await screen.findByText('Version 0.1.0 · linux x86_64')).toBeInTheDocument();
  });

  it('switches the theme from the toggle', async () => {
    render(<App />);
    await screen.findByText('Version 0.1.0 · linux x86_64');
    screen.getByRole('radio', { name: 'Light' }).click();
    expect(document.documentElement.dataset.theme).toBe('paper');
  });
});
