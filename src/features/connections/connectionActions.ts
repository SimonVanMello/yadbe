import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import { openConnectionTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YadbeIpcError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { connectionsApi } from './connectionsApi';
import { connectionKeys, refreshConnections, stateOf, useSessions } from './connectionStore';
import type { ConnectionSummary } from './model';
import { askPassword } from './passwordPromptStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Opens the password prompt, then connects with what was typed. */
async function connectWithPrompt(connection: ConnectionSummary): Promise<boolean> {
  const secret = await askPassword(connection);
  if (!secret) return false;
  const sessions = useSessions.getState();
  sessions.clearError(connection.id);
  try {
    // The password is kept for the session by the backend; the keychain only gets it once it
    // is known to work, so a wrong password is never stored.
    await connectionsApi.connect(connection.id, { kind: 'value', value: secret.password });
  } catch (error) {
    reportConnectFailure(connection, error);
    return false;
  }
  if (secret.remember) {
    try {
      await connectionsApi.setPassword(connection.id, secret.password, true);
    } catch (error) {
      showError(error, { title: t('connection.rememberFailed') });
    }
  }
  return true;
}

function reportConnectFailure(connection: ConnectionSummary, error: unknown): void {
  if (error instanceof YadbeIpcError) {
    useSessions.getState().setError(connection.id, error.error);
  }
  showError(error, {
    title: t('connection.connectFailed', { name: connection.name }),
    retry: () => {
      void connectTo(connection);
    },
    reconnect: () => {
      void connectTo(connection);
    },
    enterPassword: () => {
      void connectWithPrompt(connection);
    },
    connectionId: connection.id,
  });
}

/**
 * Connects, asking for the password when the backend has none for this connection (F-005).
 * Returns whether the connection is open.
 */
export async function connectTo(connection: ConnectionSummary): Promise<boolean> {
  const sessions = useSessions.getState();
  const state = stateOf(sessions.sessions[connection.id]);
  if (state === 'connected') return true;
  // An attempt (or an automatic reconnection) is already running: let it finish.
  if (state === 'connecting' || state === 'reconnecting') return false;
  sessions.clearError(connection.id);
  try {
    await connectionsApi.connect(connection.id, null);
    return true;
  } catch (error) {
    if (error instanceof YadbeIpcError && error.error.code === 'passwordRequired') {
      return connectWithPrompt(connection);
    }
    reportConnectFailure(connection, error);
    return false;
  }
}

export async function disconnectFrom(connection: ConnectionSummary): Promise<void> {
  try {
    await connectionsApi.disconnect(connection.id);
  } catch (error) {
    showError(error, { title: t('connection.disconnectFailed', { name: connection.name }) });
  }
}

/** Opens a query tab on a connection (in the active welcome tab, else a new one) and connects. */
export function openQuery(connection: ConnectionSummary, options: { newTab?: boolean } = {}): void {
  if (options.newTab) useTabsStore.getState().openQueryTab(connection.id);
  else openConnectionTab(connection.id);
  void connectTo(connection);
}

export async function deleteConnection(
  connection: ConnectionSummary,
  tabCount: number,
): Promise<boolean> {
  const confirmed = await confirm({
    title: t('connection.delete.title', { name: connection.name }),
    description: t('connection.delete.description'),
    confirmLabel: t('connection.delete.confirm'),
    danger: true,
    items: [
      { label: connection.name, note: t('connection.delete.removed'), danger: true },
      ...(tabCount > 0
        ? [
            {
              label: t('connection.delete.tabs', { count: tabCount }),
              note: t('connection.delete.closed'),
            },
          ]
        : []),
    ],
  });
  if (!confirmed) return false;
  try {
    await connectionsApi.remove(connection.id);
  } catch (error) {
    showError(error, { title: t('connection.deleteFailed', { name: connection.name }) });
    return false;
  }
  useSessions.getState().forget(connection.id);
  useTabsStore.getState().closeConnectionTabs(connection.id);
  await refreshConnections();
  toast({ variant: 'success', title: t('connection.deleted', { name: connection.name }) });
  return true;
}

export async function duplicateConnection(connection: ConnectionSummary): Promise<void> {
  try {
    const copy = await connectionsApi.duplicate(
      connection.id,
      t('connection.copyName', { name: connection.name }),
    );
    await refreshConnections();
    toast({
      variant: 'success',
      title: t('connection.duplicated', { name: copy.definition.name }),
    });
  } catch (error) {
    showError(error, { title: t('connection.duplicateFailed', { name: connection.name }) });
  }
}

export async function toggleFavorite(connection: ConnectionSummary): Promise<void> {
  try {
    await connectionsApi.update({
      id: connection.id,
      definition: { ...connection.definition, favorite: !connection.favorite },
    });
    await refreshConnections();
  } catch (error) {
    showError(error);
  }
}

/** Moves a connection to the end of a group (`null`: top level). */
export async function moveToGroup(
  connection: ConnectionSummary,
  groupId: string | null,
): Promise<void> {
  const list = queryClient.getQueryData<{
    connections: { definition: { groupId: string | null } }[];
  }>(connectionKeys.all);
  const position = list?.connections.filter((c) => c.definition.groupId === groupId).length ?? 0;
  try {
    await connectionsApi.move(connection.id, groupId, position);
    await refreshConnections();
  } catch (error) {
    showError(error);
  }
}
