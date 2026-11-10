import { translate, type Locale, type MessageKey, type MessageParams } from '../../i18n/i18n';

/** A `{count}` message with the number grouped for the locale (`1 284 lignes`). */
export function formatCount(
  locale: Locale,
  key: MessageKey,
  count: number,
  params: MessageParams = {},
): string {
  return translate(locale, key, { ...params, count });
}
