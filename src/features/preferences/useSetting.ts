import { useI18nStore } from '../../i18n/i18n';
import { defaultOf, type PreferenceKey } from './preferenceSchema';
import { resetPreference, usePreference, usePreferenceStore } from './preferenceStore';

/** Whether `key` is at its default; the language's default is "follow the OS". */
export function useIsDefault(key: PreferenceKey): boolean {
  const value = usePreference(key);
  const followsSystem = useI18nStore((state) => state.preference === null);
  return key === 'locale' ? followsSystem : value === defaultOf(key);
}

/** Every one of `keys` is at its default. */
export function useAllDefault(keys: readonly PreferenceKey[]): boolean {
  const followsSystem = useI18nStore((state) => state.preference === null);
  const values = usePreferenceStore((state) => state.values);
  return keys.every((key) => (key === 'locale' ? followsSystem : values[key] === defaultOf(key)));
}

export function resetAll(keys: readonly PreferenceKey[]): void {
  for (const key of keys) resetPreference(key);
}
