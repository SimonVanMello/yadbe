import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { fileDialog } from '../../ipc/fileDialog';

/**
 * Asks for an SSH private key (or, with `title`, another PEM file such as a TLS client
 * certificate) with the native picker; `null` when dismissed (or after saying it failed).
 */
export async function pickKeyFile(
  title: MessageKey = 'connection.ssh.keyPath.pick',
): Promise<string | null> {
  const { locale } = useI18nStore.getState();
  try {
    return await fileDialog.pickKeyFile({
      title: translate(locale, title),
      allFiles: translate(locale, 'connection.file.allFiles'),
    });
  } catch (error) {
    showError(error, { title: translate(locale, 'connection.file.pickFailed') });
    return null;
  }
}
