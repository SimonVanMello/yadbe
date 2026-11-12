import { create } from 'zustand';

import { savePreferences } from '../app/preferences';

import type en from './en.json';

export type Locale = 'en' | 'fr';
/** English is the reference catalog: every key must exist in every locale (checked by tests). */
export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;
export type Catalog = Record<MessageKey, string>;

export const locales: readonly Locale[] = ['en', 'fr'];

// One catalog per chunk (P-01): the startup reads only the language it shows.
const loaders: Record<Locale, () => Promise<{ default: Catalog }>> = {
  en: () => import('./en.json'),
  fr: () => import('./fr.json'),
};
const loaded: Partial<Record<Locale, Catalog>> = {};
const loading = new Map<Locale, Promise<void>>();

/** Reads a locale's catalog once; the UI switches to a locale only after this. */
export function loadLocale(locale: Locale): Promise<void> {
  if (loaded[locale]) return Promise.resolve();
  let pending = loading.get(locale);
  if (!pending) {
    pending = loaders[locale]().then(
      (module) => {
        loaded[locale] = module.default;
      },
      (error: unknown) => {
        loading.delete(locale);
        throw error;
      },
    );
    loading.set(locale, pending);
  }
  return pending;
}

/** A loaded catalog (tests); throws for one not loaded yet. */
export function catalogOf(locale: Locale): Catalog {
  const catalog = loaded[locale];
  if (!catalog) throw new Error(`The ${locale} catalog is not loaded`);
  return catalog;
}

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

function isMessageKey(catalog: Catalog, key: string): key is MessageKey {
  return key in catalog;
}

const numberFormats = new Map<Locale, Intl.NumberFormat>();

/** `1284` as the locale writes it: `1,284` in English, `1 284` in French. */
export function formatNumber(locale: Locale, value: number): string {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

/**
 * Translates `key`, interpolating `{name}` placeholders. When `params.count` is 1 and a
 * `<key>.one` variant exists, it is used (French also treats 0 as singular). A numeric `count`
 * is grouped for the locale (`1 284 lignes`); other numbers go in as they are (ports, lines…).
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  // The store only switches to a loaded locale; the key itself is a last resort.
  const catalog = loaded[locale] ?? loaded.en;
  if (!catalog) return key;
  const count = params?.count;
  const singular = `${key}.one`;
  const useSingular =
    typeof count === 'number' && (count === 1 || (locale === 'fr' && count === 0));
  const template =
    useSingular && isMessageKey(catalog, singular) ? catalog[singular] : catalog[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return name === 'count' && typeof value === 'number'
      ? formatNumber(locale, value)
      : String(value);
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

/** The last preference asked for. */
let latest: Locale | null = null;

function effective(preference: Locale | null): Locale {
  return preference ?? detectLocale(navigator.languages);
}

/** Switches to `preference` once its catalog is there (at once when it already is). */
function apply(preference: Locale | null): Promise<void> {
  const locale = effective(preference);
  const set = () => {
    // A later choice made while this catalog loaded wins.
    if (latest !== preference) return;
    document.documentElement.lang = locale;
    useI18nStore.setState({ locale, preference });
  };
  latest = preference;
  if (loaded[locale]) {
    set();
    return Promise.resolve();
  }
  return loadLocale(locale).then(set);
}

export const useI18nStore = create<I18nState>()((_set, get) => ({
  locale: detectLocale(navigator.languages),
  preference: null,
  setLocale: (locale) => {
    get().setPreference(locale);
  },
  setPreference: (preference) => {
    savePreferences({ locale: preference });
    apply(preference).catch((error: unknown) => {
      console.warn('Could not load the language', error);
    });
  },
}));

/**
 * `stored` is the saved choice; `null` follows the OS language. Resolves once the language is
 * shown (at once when its catalog is already loaded).
 */
export function loadI18n(stored: Locale | null): Promise<void> {
  return apply(isLocale(stored) ? stored : null);
}

/** `loadI18n` without waiting: immediate when the catalog is loaded (tests load both). */
export function initI18n(stored: Locale | null): void {
  loadI18n(stored).catch((error: unknown) => {
    console.warn('Could not load the language', error);
  });
}
