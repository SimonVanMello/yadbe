import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap, type ConnectionStringFlavor, type ConnectionStringNote } from '../../ipc';
import { toast } from '../../ui/toastStore';
import type { ConnectionSummary } from './model';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** What a copy could not say, in words (the password has its own sentence). */
export function noteTexts(notes: readonly ConnectionStringNote[]): string[] {
  return notes
    .filter((note) => note !== 'passwordLeftOut')
    .map((note) => t(`copyString.note.${note}`));
}

/**
 * Copies a saved connection as an ADO.NET connection string or as the EF Core call that uses it
 * (F-143). The password is left out unless `includePassword`: that is an explicit choice, asked
 * for again here with the environment of the connection in view, and the backend then reads it
 * from the keychain. It reaches the clipboard through this call and nowhere else: it is not kept
 * in a store, a query cache, a toast or a log.
 */
export async function copyConnectionString(
  connection: ConnectionSummary,
  flavor: ConnectionStringFlavor,
  includePassword: boolean,
): Promise<void> {
  if (includePassword) {
    const confirmed = await confirm({
      title: t('copyString.confirm.title'),
      description: t('copyString.confirm.description', { name: connection.name }),
      confirmLabel: t('copyString.confirm.action'),
      danger: true,
      connection,
    });
    if (!confirmed) return;
  }
  try {
    const copy = await unwrap(
      ipc.commands.copyConnectionString(connection.id, flavor, includePassword),
    );
    await navigator.clipboard.writeText(copy.text);
    const lines = [
      t('copyString.provider', {
        provider: flavor === 'efCore' ? copy.provider.efCore : copy.provider.adoNet,
      }),
      copy.includesPassword ? t('copyString.withPassword') : t('copyString.withoutPassword'),
      ...noteTexts(copy.notes),
    ];
    toast({
      variant: copy.includesPassword ? 'warning' : 'success',
      title: t(flavor === 'efCore' ? 'copyString.copied.efCore' : 'copyString.copied.adoNet'),
      description: lines.join(' '),
      duration: 8000,
    });
  } catch (error) {
    showError(error, { title: t('copyString.failed'), connectionId: connection.id });
  }
}
