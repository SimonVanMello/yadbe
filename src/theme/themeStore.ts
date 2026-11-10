import { create } from 'zustand';

import { savePreferences, type ThemePreference } from '../app/preferences';

export type { ThemePreference } from '../app/preferences';
/** Value of `data-theme` on `<html>`. */
export type ThemeName = 'graphite' | 'paper';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Graphite is the dark theme, Paper the light one. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemeName {
  const dark = preference === 'system' ? systemPrefersDark : preference === 'dark';
  return dark ? 'graphite' : 'paper';
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

interface ThemeState {
  preference: ThemePreference;
  /** Theme on screen. */
  theme: ThemeName;
  setPreference: (preference: ThemePreference) => void;
}

function apply(preference: ThemePreference): ThemeName {
  const theme = resolveTheme(preference, systemPrefersDark());
  document.documentElement.dataset.theme = theme;
  return theme;
}

export const useThemeStore = create<ThemeState>()((set) => ({
  preference: 'system',
  theme: 'graphite',
  setPreference: (preference) => {
    set({ preference, theme: apply(preference) });
    savePreferences({ theme: preference });
  },
}));

let followingSystem = false;

/** Applies the stored preference and follows OS changes while it is `system`. */
export function initTheme(preference: ThemePreference): void {
  useThemeStore.setState({ preference, theme: apply(preference) });
  if (followingSystem) return;
  followingSystem = true;
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    const { preference: current } = useThemeStore.getState();
    if (current === 'system') useThemeStore.setState({ theme: apply(current) });
  });
}
