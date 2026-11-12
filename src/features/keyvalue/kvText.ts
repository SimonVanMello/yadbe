import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';

/** A message in the current UI language, outside React (actions, dialogs). */
export function tr(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}
