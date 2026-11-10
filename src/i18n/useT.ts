import { useCallback } from 'react';

import { translate, useI18nStore, type MessageKey, type MessageParams } from './i18n';

/** Returns the translation function for the current locale; re-renders on locale change. */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const locale = useI18nStore((state) => state.locale);
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}
