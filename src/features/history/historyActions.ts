import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { connectTo } from '../connections/connectionActions';
import { findConnection } from '../query/connectionLookup';
import { insertIntoActiveEditor, openQueryTabWithText } from '../query/openWithText';
import type { HistoryEntry } from './historyModel';
import { useHistoryUi } from './historyStore';
import { refreshHistory } from './useHistory';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** The whole statement: a list row holds it cut when it is long. */
export async function fullStatement(entry: HistoryEntry): Promise<string> {
  if (!entry.sqlTruncated) return entry.sql;
  const whole = await unwrap(ipc.commands.getHistoryEntry(entry.id));
  return whole?.sql ?? entry.sql;
}

/** The statement in a new query tab on the same connection and database (F-101: Enter). */
export async function openEntry(entry: HistoryEntry): Promise<void> {
  const connection = findConnection(entry.connectionId);
  if (!connection) {
    toast({ variant: 'warning', title: t('history.open.noConnection') });
    return;
  }
  try {
    const text = await fullStatement(entry);
    // The tab's own database is only set when it is not the connection's.
    const database =
      entry.database === null || entry.database === connection.definition.database
        ? null
        : entry.database;
    openQueryTabWithText({ connectionId: connection.id, database, text });
    void connectTo(connection);
  } catch (error) {
    showError(error);
  }
}

/** The statement at the cursor of the active editor (F-101: Mod+Enter). */
export async function insertEntry(entry: HistoryEntry): Promise<void> {
  try {
    const text = await fullStatement(entry);
    if (!insertIntoActiveEditor(text)) {
      toast({ variant: 'info', title: t('history.insert.noEditor') });
    }
  } catch (error) {
    showError(error);
  }
}

export async function copyEntry(entry: HistoryEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(await fullStatement(entry));
    toast({ variant: 'success', title: t('history.copied') });
  } catch (error) {
    showError(error);
  }
}

export async function deleteEntry(entry: HistoryEntry): Promise<void> {
  try {
    await unwrap(ipc.commands.deleteHistoryEntry(entry.id));
  } catch (error) {
    showError(error, { title: t('history.deleteFailed') });
    return;
  }
  if (useHistoryUi.getState().selectedId === entry.id) useHistoryUi.getState().select(null);
  await refreshHistory();
}
