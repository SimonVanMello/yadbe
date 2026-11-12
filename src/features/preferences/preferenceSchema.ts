import type { Locale } from '../../i18n/i18n';
import type { Preferences as BackendPreferences } from '../../ipc';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
export type NullStyle = 'italic' | 'plain';

/** Every setting of the preferences screen, by key (F-125). */
export interface PreferenceValues {
  // Appearance
  theme: ThemeChoice;
  locale: Locale;
  density: Density;
  /** Base text size of the UI, in px. */
  uiFontSize: number;
  /** CSS font family; empty: the bundled JetBrains Mono. */
  editorFontFamily: string;
  editorFontSize: number;
  gridFontFamily: string;
  gridFontSize: number;
  // Editor
  completeAsYouType: boolean;
  tabSize: number;
  indentWithSpaces: boolean;
  lineWrapping: boolean;
  lineNumbers: boolean;
  highlightStatement: boolean;
  confirmDangerous: boolean;
  // Results and data
  /** Rows after which a result pauses, and its memory in MB: the default `limits` of a run. */
  resultMaxRows: number;
  resultMaxMb: number;
  /** Rows per page of a table tab. */
  defaultPageSize: number;
  nullText: string;
  nullStyle: NullStyle;
  copyHeaders: boolean;
  /** Show the SQL of the pending changes before applying them on a non-prod connection. */
  previewBeforeApply: boolean;
  // History
  historyEnabled: boolean;
  historyMaxEntries: number;
  historyMaxAgeDays: number;
  /** Change journal bounds (F-090): change sets kept, and their age in days. */
  journalMaxEntries: number;
  journalMaxAgeDays: number;
  // Connections
  connectTimeoutSecs: number;
}

export type PreferenceKey = keyof PreferenceValues;

interface Definition<T> {
  default: T;
  /** The valid form of `raw` (clamped, trimmed), `undefined` when it is not usable. */
  parse: (raw: unknown) => T | undefined;
}

function flag(fallback: boolean): Definition<boolean> {
  return { default: fallback, parse: (raw) => (typeof raw === 'boolean' ? raw : undefined) };
}

function oneOf<T extends string>(fallback: T, allowed: readonly T[]): Definition<T> {
  return {
    default: fallback,
    parse: (raw) => allowed.find((value) => value === raw),
  };
}

export interface NumberDefinition extends Definition<number> {
  min: number;
  max: number;
}

function amount(fallback: number, min: number, max: number): NumberDefinition {
  return {
    default: fallback,
    min,
    max,
    parse: (raw) =>
      typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(max, Math.max(min, Math.round(raw)))
        : undefined,
  };
}

function numberFrom(allowed: readonly number[], fallback: number): Definition<number> {
  return { default: fallback, parse: (raw) => allowed.find((value) => value === raw) };
}

/** Characters a font-family list may hold: nothing that could close a CSS declaration. */
const FONT_FAMILY = /^[\p{L}\p{N} ,'"._-]*$/u;
const MAX_FONT_FAMILY = 200;

function fontFamily(): Definition<string> {
  return {
    default: '',
    parse: (raw) => {
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      return trimmed.length <= MAX_FONT_FAMILY && FONT_FAMILY.test(trimmed) ? trimmed : undefined;
    },
  };
}

function shortText(fallback: string, max: number): Definition<string> {
  return {
    default: fallback,
    parse: (raw) => {
      if (typeof raw !== 'string') return undefined;
      const text = raw.trim();
      return text.length >= 1 && text.length <= max ? text : undefined;
    },
  };
}

export const PAGE_SIZES = [100, 250, 500, 1000, 5000] as const;
export const TAB_SIZES = [2, 4, 8] as const;

/** Defaults and validation of every key. */
export const DEFINITIONS = {
  theme: oneOf<ThemeChoice>('system', ['light', 'dark', 'system']),
  locale: oneOf<Locale>('en', ['en', 'fr']),
  density: oneOf<Density>('comfortable', ['comfortable', 'compact']),
  uiFontSize: amount(13, 11, 18),
  editorFontFamily: fontFamily(),
  editorFontSize: amount(13, 10, 24),
  gridFontFamily: fontFamily(),
  gridFontSize: amount(12, 10, 18),
  completeAsYouType: flag(true),
  tabSize: numberFrom(TAB_SIZES, 2),
  indentWithSpaces: flag(true),
  lineWrapping: flag(false),
  lineNumbers: flag(true),
  highlightStatement: flag(true),
  confirmDangerous: flag(true),
  resultMaxRows: amount(100_000, 1000, 10_000_000),
  resultMaxMb: amount(256, 16, 2048),
  defaultPageSize: numberFrom(PAGE_SIZES, 500),
  nullText: shortText('NULL', 12),
  nullStyle: oneOf<NullStyle>('italic', ['italic', 'plain']),
  copyHeaders: flag(true),
  previewBeforeApply: flag(true),
  historyEnabled: flag(true),
  historyMaxEntries: amount(50_000, 100, 1_000_000),
  historyMaxAgeDays: amount(365, 1, 3650),
  journalMaxEntries: amount(1000, 10, 100_000),
  journalMaxAgeDays: amount(90, 1, 3650),
  connectTimeoutSecs: amount(15, 1, 600),
} satisfies { [K in PreferenceKey]: Definition<PreferenceValues[K]> };

export const PREFERENCE_KEYS = Object.keys(DEFINITIONS) as PreferenceKey[];

export function defaultOf<K extends PreferenceKey>(key: K): PreferenceValues[K] {
  return DEFINITIONS[key].default as PreferenceValues[K];
}

/** `value` made valid for `key` (clamped, trimmed); the default when it cannot be. */
export function normalize<K extends PreferenceKey>(key: K, value: unknown): PreferenceValues[K] {
  const parsed = (DEFINITIONS[key] as Definition<PreferenceValues[K]>).parse(value);
  return parsed ?? defaultOf(key);
}

export function defaultValues(): PreferenceValues {
  return Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, defaultOf(key)])) as never;
}

/** Keys the backend stores itself (its `Preferences` record); it needs them. */
export const BACKEND_KEYS = [
  'density',
  'historyEnabled',
  'historyMaxEntries',
  'historyMaxAgeDays',
  'journalMaxEntries',
  'journalMaxAgeDays',
  'connectTimeoutSecs',
] as const satisfies readonly PreferenceKey[];
/** Theme and language are owned by their stores (first paint, palette actions). */
export const EXTERNAL_KEYS = ['theme', 'locale'] as const satisfies readonly PreferenceKey[];

type BackendKey = (typeof BACKEND_KEYS)[number];
type ExternalKey = (typeof EXTERNAL_KEYS)[number];
export type UiKey = Exclude<PreferenceKey, BackendKey | ExternalKey>;

export const UI_KEYS = PREFERENCE_KEYS.filter(
  (key): key is UiKey =>
    !(BACKEND_KEYS as readonly string[]).includes(key) &&
    !(EXTERNAL_KEYS as readonly string[]).includes(key),
);

export function isBackendKey(key: PreferenceKey): key is BackendKey {
  return (BACKEND_KEYS as readonly string[]).includes(key);
}

export function isExternalKey(key: PreferenceKey): key is ExternalKey {
  return (EXTERNAL_KEYS as readonly string[]).includes(key);
}

/** The backend's share of the settings, from its record (values it holds are already valid). */
export function backendValues(backend: BackendPreferences): Pick<PreferenceValues, BackendKey> {
  return {
    density: normalize('density', backend.density),
    historyEnabled: backend.historyEnabled,
    historyMaxEntries: normalize('historyMaxEntries', backend.historyMaxEntries),
    historyMaxAgeDays: normalize('historyMaxAgeDays', backend.historyMaxAgeDays),
    journalMaxEntries: normalize('journalMaxEntries', backend.journalMaxEntries),
    journalMaxAgeDays: normalize('journalMaxAgeDays', backend.journalMaxAgeDays),
    connectTimeoutSecs: normalize('connectTimeoutSecs', backend.connectTimeoutSecs),
  };
}

/** `backend` with the settings the backend stores replaced by `values`'. */
export function toBackend(
  backend: BackendPreferences,
  values: PreferenceValues,
): BackendPreferences {
  return {
    ...backend,
    density: values.density,
    historyEnabled: values.historyEnabled,
    historyMaxEntries: values.historyMaxEntries,
    historyMaxAgeDays: values.historyMaxAgeDays,
    journalMaxEntries: values.journalMaxEntries,
    journalMaxAgeDays: values.journalMaxAgeDays,
    connectTimeoutSecs: values.connectTimeoutSecs,
  };
}

/** Version of the saved `prefs` slice: bump it with a step in `readUiPreferences`. */
export const PREFERENCES_VERSION = 1;

export interface SavedUiPreferences {
  version: number;
  values: Partial<Record<UiKey, unknown>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The frontend-only settings from the saved `prefs` slice. Tolerant: unknown keys and invalid
 * values are dropped (the default stands in). A slice that does not exist yet (version 0, before
 * the preferences screen) is built from the old `query` slice, which held two of them.
 */
export function readUiPreferences(
  prefsSlice: unknown,
  legacyQuerySlice: unknown,
): Pick<PreferenceValues, UiKey> {
  const result: Record<string, unknown> = {};
  const saved = record(prefsSlice);
  const source = record(saved?.values);
  if (source) {
    for (const key of UI_KEYS) {
      const parsed = DEFINITIONS[key].parse(source[key]);
      if (parsed !== undefined) result[key] = parsed;
    }
  } else {
    const legacy = record(legacyQuerySlice);
    for (const key of ['confirmDangerous', 'completeAsYouType'] as const) {
      const parsed = DEFINITIONS[key].parse(legacy?.[key]);
      if (parsed !== undefined) result[key] = parsed;
    }
  }
  for (const key of UI_KEYS) result[key] ??= defaultOf(key);
  return result as Pick<PreferenceValues, UiKey>;
}

export function writeUiPreferences(values: PreferenceValues): SavedUiPreferences {
  return {
    version: PREFERENCES_VERSION,
    values: Object.fromEntries(UI_KEYS.map((key) => [key, values[key]])),
  };
}

/** Whether a saved `prefs` slice exists (else the first run after the upgrade writes it). */
export function hasSavedUiPreferences(prefsSlice: unknown): boolean {
  return record(record(prefsSlice)?.values) !== null;
}
