import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { fileDialog } from '../../ipc/fileDialog';

/** Asks for a database file with the native picker; `null` when dismissed (or when it failed, after saying so). */
export async function pickDatabaseFile(): Promise<string | null> {
  const { locale } = useI18nStore.getState();
  try {
    return await fileDialog.pickDatabaseFile({
      title: translate(locale, 'connection.file.pick'),
      sqliteFiles: translate(locale, 'connection.file.sqliteFiles'),
      allFiles: translate(locale, 'connection.file.allFiles'),
    });
  } catch (error) {
    showError(error, { title: translate(locale, 'connection.file.pickFailed') });
    return null;
  }
}
