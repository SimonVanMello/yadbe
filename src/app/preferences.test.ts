import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend } from '../ipc/mockClient';
import { loadUiSlice, resetBackendPreferences, saveUiSlice } from './backendPreferences';
import { applyStoredPreferences, loadPreferences, savePreferences } from './preferences';

beforeEach(() => {
  mockBackend.reset();
  resetBackendPreferences();
  localStorage.clear();
});

const stored = async () => {
  const result = await mockBackend.commands.getPreferences();
  if (result.status !== 'ok') throw new Error('getPreferences failed');
  return result.data;
};

describe('theme and language preferences', () => {
  it('keep a copy for the first paint and save to the backend', async () => {
    savePreferences({ theme: 'light', locale: 'fr' });
    expect(loadPreferences()).toEqual({ theme: 'light', locale: 'fr' });
    await expect.poll(async () => (await stored()).theme).toBe('light');
    expect((await stored()).locale).toBe('fr');
  });

  it('refresh the first-paint copy from the backend without writing back', () => {
    applyStoredPreferences({
      theme: 'dark',
      locale: null,
      density: 'comfortable',
      uiState: null,
      historyEnabled: true,
      historyMaxEntries: 50_000,
      historyMaxAgeDays: 365,
      connectTimeoutSecs: 15,
    });
    expect(loadPreferences()).toEqual({ theme: 'dark', locale: null });
  });

  it('fall back to the defaults when the copy is missing or unknown', () => {
    localStorage.setItem('yadbe.theme', 'neon');
    localStorage.setItem('yadbe.locale', 'de');
    expect(loadPreferences()).toEqual({ theme: 'system', locale: null });
  });
});

describe('frontend-owned ui state', () => {
  it('keeps each slice apart and does not disturb the theme', async () => {
    savePreferences({ theme: 'dark' });
    await saveUiSlice('layout', { sidebar: { size: 300 } });
    await saveUiSlice('other', 'x');
    expect(await loadUiSlice('layout')).toEqual({ sidebar: { size: 300 } });
    expect(await loadUiSlice('other')).toBe('x');
    expect(await loadUiSlice('missing')).toBeUndefined();
    expect((await stored()).theme).toBe('dark');
  });

  it('survives writes that overlap', async () => {
    const slices = Promise.all([saveUiSlice('a', 1), saveUiSlice('b', 2)]);
    savePreferences({ locale: 'en' });
    await slices;
    expect(await loadUiSlice('a')).toBe(1);
    expect(await loadUiSlice('b')).toBe(2);
    await expect.poll(async () => (await stored()).locale).toBe('en');
  });

  it('starts empty when the stored state is not JSON', async () => {
    await mockBackend.commands.setPreferences({
      theme: 'system',
      locale: null,
      density: 'comfortable',
      uiState: '{oops',
      historyEnabled: true,
      historyMaxEntries: 50_000,
      historyMaxAgeDays: 365,
      connectTimeoutSecs: 15,
    });
    resetBackendPreferences();
    expect(await loadUiSlice('layout')).toBeUndefined();
  });
});
