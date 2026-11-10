import { beforeEach, describe, expect, it } from 'vitest';

import { loadUiSlice, resetBackendPreferences, saveUiSlice } from '../../app/backendPreferences';
import { initI18n, useI18nStore } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { initTheme, useThemeStore } from '../../theme/themeStore';
import { defaultValues } from './preferenceSchema';
import {
  getPreference,
  resetPreference,
  restoreAndPersistPreferences,
  setPreference,
  usePreferenceStore,
} from './preferenceStore';
import { resultLimits } from './resultLimits';

async function backendRecord() {
  const result = await mockBackend.commands.getPreferences();
  if (result.status !== 'ok') throw new Error('getPreferences failed');
  return result.data;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  stop?.();
  stop = undefined;
  mockBackend.reset();
  resetBackendPreferences();
  localStorage.clear();
  initTheme('system');
  initI18n('en');
  usePreferenceStore.setState({ values: defaultValues() });
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-density');
});

describe('restoring the settings', () => {
  it('starts from the defaults when nothing was saved', async () => {
    stop = await restoreAndPersistPreferences();
    expect(usePreferenceStore.getState().values).toEqual({ ...defaultValues(), locale: 'en' });
  });

  it('migrates the settings of the old query slice and writes the new slice once', async () => {
    await saveUiSlice('query', { resultsRatio: 0.6, confirmDangerous: false });
    stop = await restoreAndPersistPreferences();
    expect(getPreference('confirmDangerous')).toBe(false);
    expect(getPreference('completeAsYouType')).toBe(true);
    await expect
      .poll(async () => (await loadUiSlice('prefs')) as { version: number })
      .toMatchObject({ version: 1 });
  });

  it('reads the backend share from the backend record', async () => {
    await mockBackend.commands.setPreferences({
      ...(await backendRecord()),
      density: 'compact',
      historyMaxEntries: 777,
      connectTimeoutSecs: 30,
    });
    resetBackendPreferences();
    stop = await restoreAndPersistPreferences();
    expect(getPreference('density')).toBe('compact');
    expect(getPreference('historyMaxEntries')).toBe(777);
    expect(getPreference('connectTimeoutSecs')).toBe(30);
    expect(document.documentElement.dataset.density).toBe('compact');
  });
});

describe('changing a setting', () => {
  beforeEach(async () => {
    stop = await restoreAndPersistPreferences();
  });

  it('applies the look at once', () => {
    setPreference('density', 'compact');
    setPreference('uiFontSize', 16);
    setPreference('editorFontFamily', 'Fira Code');
    setPreference('nullStyle', 'plain');
    const root = document.documentElement;
    expect(root.dataset.density).toBe('compact');
    expect(root.style.getPropertyValue('--font-scale')).toBe(String(16 / 13));
    expect(root.style.getPropertyValue('--editor-font-family')).toBe('Fira Code, var(--font-code)');
    expect(root.style.getPropertyValue('--grid-null-font-style')).toBe('normal');
    resetPreference('uiFontSize');
    expect(root.style.getPropertyValue('--font-scale')).toBe('');
  });

  it('saves a frontend setting in the prefs slice, a backend one in the backend record', async () => {
    setPreference('tabSize', 4);
    setPreference('historyMaxAgeDays', 90);
    await expect.poll(async () => (await backendRecord()).historyMaxAgeDays).toBe(90);
    await expect
      .poll(
        async () =>
          ((await loadUiSlice('prefs')) as { values: { tabSize: number } }).values.tabSize,
      )
      .toBe(4);
    expect((await backendRecord()).uiState).not.toContain('historyMaxAgeDays');
  });

  it('keeps the value valid', () => {
    setPreference('resultMaxMb', 999_999);
    expect(getPreference('resultMaxMb')).toBe(2048);
  });

  it('goes through the theme and language stores', () => {
    setPreference('theme', 'dark');
    expect(useThemeStore.getState().preference).toBe('dark');
    useThemeStore.getState().setPreference('light');
    expect(getPreference('theme')).toBe('light');
    setPreference('locale', 'fr');
    expect(useI18nStore.getState().locale).toBe('fr');
    useI18nStore.getState().setLocale('en');
    expect(getPreference('locale')).toBe('en');
  });

  it('resets one setting, and the language to "follow the OS"', () => {
    setPreference('lineWrapping', true);
    resetPreference('lineWrapping');
    expect(getPreference('lineWrapping')).toBe(false);
    setPreference('locale', 'fr');
    resetPreference('locale');
    expect(useI18nStore.getState().preference).toBeNull();
  });
});

describe('what the consumers read', () => {
  it('gives the result limits of a run from the settings', () => {
    setPreference('resultMaxRows', 5000);
    setPreference('resultMaxMb', 32);
    expect(resultLimits()).toEqual({ maxRows: 5000, maxBytes: 32 * 1024 * 1024 });
  });
});
