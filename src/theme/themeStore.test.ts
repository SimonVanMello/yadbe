import { beforeEach, describe, expect, it } from 'vitest';

import { resetBackendPreferences } from '../app/backendPreferences';
import { DEFAULT_PREFERENCES, loadPreferences } from '../app/preferences';
import { mockBackend } from '../ipc/mockClient';
import { initTheme, resolveTheme, useThemeStore } from './themeStore';

const selection = { lightTheme: 'latte', darkTheme: 'mocha' };

const stored = async () => {
  const result = await mockBackend.commands.getPreferences();
  if (result.status !== 'ok') throw new Error('getPreferences failed');
  return result.data;
};

describe('resolveTheme', () => {
  it('shows the theme of the explicit mode', () => {
    expect(resolveTheme({ preference: 'dark', ...selection }, false)).toBe('mocha');
    expect(resolveTheme({ preference: 'light', ...selection }, true)).toBe('latte');
  });

  it('follows the OS for the system preference', () => {
    expect(resolveTheme({ preference: 'system', ...selection }, true)).toBe('mocha');
    expect(resolveTheme({ preference: 'system', ...selection }, false)).toBe('latte');
  });

  it('falls back to the default of the mode for an unknown or mismatched id', () => {
    const odd = { lightTheme: 'removed-theme', darkTheme: 'latte' };
    expect(resolveTheme({ preference: 'light', ...odd }, false)).toBe('paper');
    expect(resolveTheme({ preference: 'dark', ...odd }, false)).toBe('graphite');
  });
});

describe('useThemeStore', () => {
  beforeEach(() => {
    mockBackend.reset();
    resetBackendPreferences();
    localStorage.clear();
    initTheme({ ...DEFAULT_PREFERENCES, theme: 'light' });
  });

  it('applies the stored selection at startup', () => {
    initTheme({ ...DEFAULT_PREFERENCES, theme: 'dark', darkTheme: 'nord' });
    expect(useThemeStore.getState()).toMatchObject({ preference: 'dark', theme: 'nord' });
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(loadPreferences().darkTheme).toBe('nord');
  });

  it('applies and persists the chosen mode', async () => {
    useThemeStore.getState().setPreference('dark');
    expect(document.documentElement.dataset.theme).toBe('graphite');
    expect(loadPreferences().theme).toBe('dark');
    await expect.poll(async () => (await stored()).theme).toBe('dark');
    useThemeStore.getState().setPreference('light');
    expect(useThemeStore.getState().theme).toBe('paper');
  });

  it('puts a chosen theme in the slot of its mode and switches to that mode', async () => {
    useThemeStore.getState().chooseTheme('mocha');
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'dark',
      darkTheme: 'mocha',
      lightTheme: 'paper',
      theme: 'mocha',
    });
    expect(loadPreferences().darkTheme).toBe('mocha');
    await expect.poll(async () => (await stored()).darkTheme).toBe('mocha');
    expect(await stored()).toMatchObject({ theme: 'dark', lightTheme: 'paper' });
  });

  it('keeps following the OS for a theme of the mode the OS is in', () => {
    // The test environment's OS is in light mode.
    useThemeStore.getState().setPreference('system');
    useThemeStore.getState().chooseTheme('latte');
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'system',
      lightTheme: 'latte',
      theme: 'latte',
    });
  });

  it('shows a theme of the other mode, which stops following the OS', () => {
    useThemeStore.getState().setPreference('system');
    useThemeStore.getState().chooseTheme('nord');
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'dark',
      darkTheme: 'nord',
      lightTheme: 'paper',
      theme: 'nord',
    });
  });

  it('previews a theme without saving it, then restores', async () => {
    useThemeStore.getState().setPreview('dracula');
    expect(document.documentElement.dataset.theme).toBe('dracula');
    expect(useThemeStore.getState()).toMatchObject({ theme: 'dracula', resolved: 'paper' });
    expect(loadPreferences()).toMatchObject({ lightTheme: 'paper', darkTheme: 'graphite' });
    expect(await stored()).toMatchObject({ lightTheme: 'paper', darkTheme: 'graphite' });
    useThemeStore.getState().setPreview(null);
    expect(document.documentElement.dataset.theme).toBe('paper');
  });

  it('ignores an unknown theme', () => {
    useThemeStore.getState().chooseTheme('nope');
    useThemeStore.getState().setPreview('nope');
    expect(useThemeStore.getState().theme).toBe('paper');
  });
});

describe('Terminal interface style', () => {
  beforeEach(() => {
    mockBackend.reset();
    resetBackendPreferences();
    initTheme({ ...DEFAULT_PREFERENCES, theme: 'light' });
  });

  it('only changes the shape: the color theme stays', async () => {
    useThemeStore.getState().setStyle('terminal');
    expect(document.documentElement.dataset.style).toBe('terminal');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(loadPreferences().style).toBe('terminal');
    await expect.poll(async () => (await stored()).style).toBe('terminal');
    useThemeStore.getState().setStyle('standard');
    expect(document.documentElement.dataset.style).toBeUndefined();
  });
});
