import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import { openConnectionTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YadbeIpcError, type SecretInput, type SecretKind, type TunnelFailure } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { refreshLibrary } from '../library/useLibrary';
import { connectionsApi } from './connectionsApi';
import { connectionKeys, refreshConnections, stateOf, useSessions } from './connectionStore';
import { isTlsKeyError, type ConnectionSummary } from './model';
import { askTrustHostKey } from './hostKeyPromptStore';
import { askPassword, type PromptedPassword } from './passwordPromptStore';
import { endpointOfHop } from './sshModel';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Secrets typed in the prompts of one connection attempt, and whether each goes to the keychain. */
interface TypedSecrets {
  password: PromptedPassword | null;
  tunnel: Map<SecretKind, PromptedPassword>;
}

/** Endpoint of the SSH hop a failure is about, as the prompt names it. */
function endpointOf(connection: ConnectionSummary, failure: TunnelFailure): string {
  const ssh = connection.definition.ssh;
  const hop = failure.hop === 'jump' ? ssh?.jump : ssh?.server;
  return hop ? endpointOfHop(hop) : `${failure.host}:${String(failure.port)}`;
}

async function askTunnelSecret(
  connection: ConnectionSummary,
  failure: TunnelFailure,
  typed: TypedSecrets,
): Promise<boolean> {
  const kind = failure.secret;
  if (kind === null) return false;
  const secret = await askPassword(connection, { kind, endpoint: endpointOf(connection, failure) });
  if (!secret) return false;
  typed.tunnel.set(kind, secret);
  return true;
}

/** The passphrase of the TLS client key (`tlsKeyPassphraseRequired`, or refused as wrong). */
async function askTlsKeyPassphrase(
  connection: ConnectionSummary,
  typed: TypedSecrets,
): Promise<boolean> {
  const { tlsClientKeyPath, tlsClientCertPath } = connection.definition;
  const secret = await askPassword(connection, {
    kind: 'tlsKeyPassphrase',
    endpoint: tlsClientKeyPath ?? tlsClientCertPath ?? '',
  });
  if (!secret) return false;
  typed.tunnel.set('tlsKeyPassphrase', secret);
  return true;
}

/** Keeps in the keychain the typed secrets the user asked to remember, once they worked. */
async function rememberTyped(connection: ConnectionSummary, typed: TypedSecrets): Promise<void> {
  const remembered: [SecretKind, PromptedPassword][] = [...typed.tunnel.entries()];
  if (typed.password) remembered.push(['password', typed.password]);
  for (const [kind, secret] of remembered) {
    if (!secret.remember) continue;
    try {
      await connectionsApi.setSecret(connection.id, kind, secret.password, true);
    } catch (error) {
      showError(error, { title: t('connection.rememberFailed') });
    }
  }
}

/**
 * Connects, asking for what the backend lacks on the way: the database password, an SSH
 * password or key passphrase, the trust of an unknown SSH host key (F-005, F-010). Typed secrets
 * are kept for the session by the backend; the keychain only gets them once they worked, so a
 * wrong one is never stored.
 */
async function attempt(connection: ConnectionSummary, typed: TypedSecrets): Promise<boolean> {
  const sessions = useSessions.getState();
  // Each round answers one question; a few cover a jump host, the server and the database.
  for (let round = 0; round < 8; round += 1) {
    sessions.clearError(connection.id);
    const password: SecretInput | null = typed.password
      ? { kind: 'value', value: typed.password.password }
      : null;
    try {
      if (typed.tunnel.size === 0) {
        await connectionsApi.connect(connection.id, password);
      } else {
        await connectionsApi.connectWithSecrets(
          connection.id,
          password,
          [...typed.tunnel.entries()].map(([kind, secret]) => ({
            kind,
            secret: { kind: 'value', value: secret.password },
          })),
        );
      }
    } catch (error) {
      const failure = error instanceof YadbeIpcError ? error.error : null;
      if (failure?.code === 'passwordRequired') {
        const secret = await askPassword(connection);
        if (!secret) return false;
        typed.password = secret;
        continue;
      }
      if (failure?.code === 'sshSecretRequired' && failure.tunnel) {
        if (!(await askTunnelSecret(connection, failure.tunnel, typed))) return false;
        continue;
      }
      if (failure && isTlsKeyError(failure)) {
        if (!(await askTlsKeyPassphrase(connection, typed))) return false;
        continue;
      }
      if (failure?.code === 'sshHostKeyUnknown' && failure.tunnel) {
        if (!(await askTrustHostKey(failure.tunnel))) return false;
        continue;
      }
      reportConnectFailure(connection, error);
      return false;
    }
    await rememberTyped(connection, typed);
    return true;
  }
  return false;
}

function freshTyped(): TypedSecrets {
  return { password: null, tunnel: new Map() };
}

function reportConnectFailure(connection: ConnectionSummary, error: unknown): void {
  const typedError = error instanceof YadbeIpcError ? error.error : null;
  if (typedError) useSessions.getState().setError(connection.id, typedError);
  const tunnel = typedError?.tunnel ?? null;
  showError(error, {
    title: t('connection.connectFailed', { name: connection.name }),
    retry: () => {
      void connectTo(connection);
    },
    reconnect: () => {
      void connectTo(connection);
    },
    enterPassword: () => {
      const typed = freshTyped();
      // A refused SSH secret or TLS key passphrase is asked again; otherwise the database password.
      const asked =
        typedError && isTlsKeyError(typedError)
          ? askTlsKeyPassphrase(connection, typed)
          : tunnel?.secret != null
            ? askTunnelSecret(connection, tunnel, typed)
            : askPassword(connection).then((secret) => {
                typed.password = secret;
                return secret !== null;
              });
      void asked.then((ok) => (ok ? attempt(connection, typed) : false));
    },
    trustHostKey: tunnel
      ? () => {
          void askTrustHostKey(tunnel).then((trusted) => (trusted ? connectTo(connection) : false));
        }
      : undefined,
    connectionId: connection.id,
  });
}

/**
 * Connects, asking for the password (and SSH secrets) when the backend has none for this
 * connection (F-005, F-010). Returns whether the connection is open.
 */
export async function connectTo(connection: ConnectionSummary): Promise<boolean> {
  const sessions = useSessions.getState();
  const state = stateOf(sessions.sessions[connection.id]);
  if (state === 'connected') return true;
  // An attempt (or an automatic reconnection) is already running: let it finish.
  if (state === 'connecting' || state === 'reconnecting') return false;
  return attempt(connection, freshTyped());
}

export async function disconnectFrom(connection: ConnectionSummary): Promise<void> {
  try {
    await connectionsApi.disconnect(connection.id);
  } catch (error) {
    showError(error, { title: t('connection.disconnectFailed', { name: connection.name }) });
  }
}

/**
 * Closes the open connection and opens it again, so that it runs with its saved settings
 * (offered after a save that changes what only a new connection picks up). An open transaction
 * ends with the old connection, as with Disconnect.
 */
export async function reconnectTo(connection: ConnectionSummary): Promise<boolean> {
  await disconnectFrom(connection);
  return attempt(connection, freshTyped());
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
    connection,
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
  // The queries bound to it are global ones now.
  void refreshLibrary();
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
