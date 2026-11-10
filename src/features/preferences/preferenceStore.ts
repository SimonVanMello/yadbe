import { create } from 'zustand';

import { applyAppearance } from '../../app/appearance';
import {
  loadPreferences,
  loadUiSlice,
  saveUiSlice,
  updatePreferences,
} from '../../app/backendPreferences';
import { useI18nStore } from '../../i18n/i18n';
import { useThemeStore } from '../../theme/themeStore';
import {
  UI_KEYS,
  backendValues,
  defaultOf,
  defaultValues,
  hasSavedUiPreferences,
  isBackendKey,
  normalize,
  readUiPreferences,
  toBackend,
  writeUiPreferences,
  type PreferenceKey,
  type PreferenceValues,
} from './preferenceSchema';

interface PreferenceState {
  values: PreferenceValues;
}

/**
 * Every setting of the preferences screen in one store. Reading goes through `usePreference` (in
 * components) or `getPreference` (anywhere else). Theme and language stay owned by their stores
 * (the first paint and the palette read them): this store mirrors them.
 */
export const usePreferenceStore = create<PreferenceState>()(() => ({
  values: defaultValues(),
}));

function patch(change: Partial<PreferenceValues>): void {
  usePreferenceStore.setState((state) => ({ values: { ...state.values, ...change } }));
}

useThemeStore.subscribe((state) => {
  if (usePreferenceStore.getState().values.theme !== state.preference) {
    patch({ theme: state.preference });
  }
});
useI18nStore.subscribe((state) => {
  if (usePreferenceStore.getState().values.locale !== state.locale) {
    patch({ locale: state.locale });
  }
});

/** The current value of a setting, for code outside React. */
export function getPreference<K extends PreferenceKey>(key: K): PreferenceValues[K] {
  return usePreferenceStore.getState().values[key];
}

/** The current value of a setting; re-renders the component when it changes. */
export function usePreference<K extends PreferenceKey>(key: K): PreferenceValues[K] {
  return usePreferenceStore((state) => state.values[key]);
}

/** Changes a setting: applied at once, saved right after. An invalid value is made valid. */
export function setPreference<K extends PreferenceKey>(key: K, value: PreferenceValues[K]): void {
  const next = normalize(key, value);
  if (key === 'theme') useThemeStore.getState().setPreference(normalize('theme', next));
  else if (key === 'locale') useI18nStore.getState().setLocale(normalize('locale', next));
  patch({ [key]: next });
}

/** Puts a setting back to its default. */
export function resetPreference(key: PreferenceKey): void {
  // The default language is the OS one: forgetting the choice lets the store find it again.
  if (key === 'locale') {
    useI18nStore.getState().setPreference(null);
    return;
  }
  setPreference(key, defaultOf(key));
}

const SAVE_DELAY_MS = 300;

/**
 * Loads the settings (backend record, saved `prefs` slice, old `query` slice on the first run
 * after the upgrade), applies them, then applies and saves every change.
 */
export async function restoreAndPersistPreferences(): Promise<() => void> {
  try {
    const [backend, saved, legacy] = await Promise.all([
      loadPreferences(),
      loadUiSlice('prefs'),
      loadUiSlice('query'),
    ]);
    usePreferenceStore.setState({
      values: {
        ...defaultValues(),
        ...backendValues(backend),
        ...readUiPreferences(saved, legacy),
        theme: useThemeStore.getState().preference,
        locale: useI18nStore.getState().locale,
      },
    });
    if (!hasSavedUiPreferences(saved)) {
      void saveUiSlice('prefs', writeUiPreferences(usePreferenceStore.getState().values));
    }
  } catch (error) {
    console.warn('Saved preferences unavailable, using the defaults', error);
  }
  applyAppearance(usePreferenceStore.getState().values);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = usePreferenceStore.subscribe((state, previous) => {
    if (state.values === previous.values) return;
    applyAppearance(state.values);
    const changed = (Object.keys(state.values) as PreferenceKey[]).filter(
      (key) => state.values[key] !== previous.values[key],
    );
    if (changed.some(isBackendKey)) {
      void updatePreferences((backend) => toBackend(backend, usePreferenceStore.getState().values));
    }
    if (changed.some((key) => (UI_KEYS as readonly string[]).includes(key))) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void saveUiSlice('prefs', writeUiPreferences(usePreferenceStore.getState().values));
      }, SAVE_DELAY_MS);
    }
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
