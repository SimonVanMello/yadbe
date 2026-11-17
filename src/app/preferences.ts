import type { Locale } from '../i18n/i18n';
import type { Preferences as BackendPreferences, ThemeStyle } from '../ipc';
import { updatePreferences } from './backendPreferences';

export type ThemePreference = 'light' | 'dark' | 'system';
export type { ThemeStyle } from '../ipc';

/** What the first paint needs: the colors (mode, theme of each mode, style, contrast), the language. */
export interface Preferences {
  theme: ThemePreference;
  /** Color theme of the light mode and of the dark mode: ids of src/theme/catalog.ts. */
  lightTheme: string;
  darkTheme: string;
  style: ThemeStyle;
  highContrast: boolean;
  /** `null` follows the OS language. */
  locale: Locale | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  lightTheme: 'paper',
  darkTheme: 'graphite',
  style: 'standard',
  highContrast: false,
  locale: null,
};

/**
 * The backend store is the source of truth (it survives a reinstall of the webview). A copy
 * stays in local storage because `public/boot-theme.js` and `main.tsx` need the theme and the
 * language before the first paint, long before the backend answers. Keep the keys in sync.
 */
const KEYS = {
  theme: 'yadbe.theme',
  lightTheme: 'yadbe.lightTheme',
  darkTheme: 'yadbe.darkTheme',
  style: 'yadbe.style',
  highContrast: 'yadbe.highContrast',
  locale: 'yadbe.locale',
} as const;

/** What a theme id may look like (the backend's `is_theme_id`). */
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private window, blocked): the backend copy still holds the choice.
  }
}

function themeId(value: string | null, fallback: string): string {
  return value !== null && THEME_ID.test(value) ? value : fallback;
}

export function loadPreferences(): Preferences {
  const theme = read(KEYS.theme);
  const style = read(KEYS.style);
  const locale = read(KEYS.locale);
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
    lightTheme: themeId(read(KEYS.lightTheme), DEFAULT_PREFERENCES.lightTheme),
    darkTheme: themeId(read(KEYS.darkTheme), DEFAULT_PREFERENCES.darkTheme),
    style: style === 'terminal' ? 'terminal' : 'standard',
    highContrast: read(KEYS.highContrast) === 'true',
    locale: locale === 'en' || locale === 'fr' ? locale : null,
  };
}

/** Updates the first-paint copy only (no write to the backend). */
export function mirrorPreferences(patch: Partial<Preferences>): void {
  if (patch.theme !== undefined) write(KEYS.theme, patch.theme);
  if (patch.lightTheme !== undefined) write(KEYS.lightTheme, patch.lightTheme);
  if (patch.darkTheme !== undefined) write(KEYS.darkTheme, patch.darkTheme);
  if (patch.style !== undefined) write(KEYS.style, patch.style);
  if (patch.highContrast !== undefined) write(KEYS.highContrast, String(patch.highContrast));
  if (patch.locale !== undefined) write(KEYS.locale, patch.locale);
}

/** Saves a change of the colors or the language: first-paint copy now, backend store right after. */
export function savePreferences(patch: Partial<Preferences>): void {
  mirrorPreferences(patch);
  void updatePreferences((preferences) => ({ ...preferences, ...patch }));
}

/** Refreshes the first-paint copy from what the backend holds (no write to the backend). */
export function applyStoredPreferences(preferences: BackendPreferences): void {
  mirrorPreferences({
    theme: preferences.theme,
    lightTheme: preferences.lightTheme,
    darkTheme: preferences.darkTheme,
    style: preferences.style,
    highContrast: preferences.highContrast,
    locale: preferences.locale,
  });
}
