import type { Locale } from '../i18n/i18n';

export type ThemePreference = 'light' | 'dark' | 'system';

/** Per-viewer UI preferences. Local storage for now; the SQLite store replaces it in M0-2/M0-3. */
export interface Preferences {
  theme: ThemePreference;
  /** `null` follows the OS language. */
  locale: Locale | null;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', locale: null };

/** Keys read by `public/boot-theme.js` before the first paint: keep them in sync. */
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
    // Storage unavailable (private window, blocked): the choice lasts for the session only.
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

export function savePreferences(patch: Partial<Preferences>): void {
  if (patch.theme !== undefined) write(KEYS.theme, patch.theme);
  if (patch.locale !== undefined) write(KEYS.locale, patch.locale);
}
