import { create } from 'zustand';

import { savePreferences } from '../app/preferences';

import en from './en.json';
import fr from './fr.json';

export type Locale = 'en' | 'fr';
/** English is the reference catalog: every key must exist in every locale (checked by tests). */
export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;

export const catalogs: Record<Locale, Record<MessageKey, string>> = { en, fr };
export const locales: readonly Locale[] = ['en', 'fr'];

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'fr';
}

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

function isMessageKey(key: string): key is MessageKey {
  return key in catalogs.en;
}

/**
 * Translates `key`, interpolating `{name}` placeholders. When `params.count` is 1 and a
 * `<key>.one` variant exists, it is used (French also treats 0 as singular).
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const count = params?.count;
  const singular = `${key}.one`;
  const useSingular =
    typeof count === 'number' && (count === 1 || (locale === 'fr' && count === 0));
  const template =
    useSingular && isMessageKey(singular) ? catalogs[locale][singular] : catalogs[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

interface I18nState {
  /** Effective UI language. */
  locale: Locale;
  /** User choice; `null` follows the OS language. */
  preference: Locale | null;
  setLocale: (locale: Locale) => void;
  setPreference: (preference: Locale | null) => void;
}

function apply(preference: Locale | null): Locale {
  const locale = preference ?? detectLocale(navigator.languages);
  document.documentElement.lang = locale;
  return locale;
}

export const useI18nStore = create<I18nState>()((set, get) => ({
  locale: detectLocale(navigator.languages),
  preference: null,
  setLocale: (locale) => {
    get().setPreference(locale);
  },
  setPreference: (preference) => {
    set({ locale: apply(preference), preference });
    savePreferences({ locale: preference });
  },
}));

/** `stored` is the saved choice; `null` follows the OS language. */
export function initI18n(stored: Locale | null): void {
  const preference = isLocale(stored) ? stored : null;
  useI18nStore.setState({ locale: apply(preference), preference });
}
