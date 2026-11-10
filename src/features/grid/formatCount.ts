import { translate, type Locale, type MessageKey, type MessageParams } from '../../i18n/i18n';

/**
 * A `{count}` message with the number grouped for the locale (`1 284 lignes`). Counts of 0 and
 * 1 go in as numbers so `translate` still picks the singular form where the language uses it.
 */
export function formatCount(
  locale: Locale,
  key: MessageKey,
  count: number,
  params: MessageParams = {},
): string {
  return translate(locale, key, {
    ...params,
    count: count <= 1 ? count : new Intl.NumberFormat(locale).format(count),
  });
}
