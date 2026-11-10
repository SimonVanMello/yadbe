import { beforeEach, describe, expect, it } from 'vitest';

import { loadPreferences } from '../app/preferences';
import { initTheme, resolveTheme, useThemeStore } from './themeStore';

describe('resolveTheme', () => {
  it('shows the theme of the explicit mode', () => {
    expect(resolveTheme('dark', false)).toBe('graphite');
    expect(resolveTheme('light', true)).toBe('paper');
  });

  it('follows the OS for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('graphite');
    expect(resolveTheme('system', false)).toBe('paper');
  });
});

describe('useThemeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    initTheme('light');
  });

  it('applies the stored preference at startup', () => {
    initTheme('dark');
    expect(useThemeStore.getState()).toMatchObject({ preference: 'dark', theme: 'graphite' });
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('applies and persists the chosen mode', () => {
    useThemeStore.getState().setPreference('dark');
    expect(document.documentElement.dataset.theme).toBe('graphite');
    expect(loadPreferences().theme).toBe('dark');
    useThemeStore.getState().setPreference('light');
    expect(useThemeStore.getState().theme).toBe('paper');
    expect(loadPreferences().theme).toBe('light');
  });
});
