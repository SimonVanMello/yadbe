import type { Locale } from '../i18n/i18n';
import type { Preferences as BackendPreferences } from '../ipc';
import { updatePreferences } from './backendPreferences';

export type ThemePreference = 'light' | 'dark' | 'system';

/** Per-viewer UI preferences. */
export interface Preferences {
  theme: ThemePreference;
  /** `null` follows the OS language. */
  locale: Locale | null;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', locale: null };

/**
 * The backend store is the source of truth (it survives a reinstall of the webview). A copy
 * stays in local storage because `public/boot-theme.js` and `main.tsx` need the theme and the
 * language before the first paint, long before the backend answers. Keep the keys in sync.
 */
const KEYS = { theme: 'yadbe.theme', locale: 'yadbe.locale' } as const;

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

export function loadPreferences(): Preferences {
  const theme = read(KEYS.theme);
  const locale = read(KEYS.locale);
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
    locale: locale === 'en' || locale === 'fr' ? locale : null,
  };
}

function mirror(patch: Partial<Preferences>): void {
  if (patch.theme !== undefined) write(KEYS.theme, patch.theme);
  if (patch.locale !== undefined) write(KEYS.locale, patch.locale);
}

/** Saves a change of theme or language: first-paint copy now, backend store right after. */
export function savePreferences(patch: Partial<Preferences>): void {
  mirror(patch);
  void updatePreferences((preferences) => ({
    ...preferences,
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
  }));
}

/** Refreshes the first-paint copy from what the backend holds (no write to the backend). */
export function applyStoredPreferences(preferences: BackendPreferences): void {
  mirror({ theme: preferences.theme, locale: preferences.locale });
}
