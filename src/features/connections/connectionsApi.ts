import {
  ipc,
  unwrap,
  type ConnectionGroup,
  type Engine,
  type EngineInfo,
  type KeychainStatus,
  type KnownHost,
  type ParsedConnectionString,
  type SavedConnection,
  type SecretInput,
  type SecretKind,
  type SecretLocation,
  type SessionInfo,
  type TestConnectionResult,
  type TunnelSecretInput,
} from '../../ipc';
import { secretOf, tlsSecretsOf, toDefinition, type ConnectionDraft } from './model';
import {
  SSH_SECRET_KINDS,
  sshSecretsToForget,
  tunnelSecretsOf,
  typedSshSecrets,
  type SshSecretLocations,
} from './sshModel';

/**
 * A saved connection; `reconnectNeeded`: it is open and keeps settings other than the saved ones
 * until it connects again (read-only and the statement timeout apply at once).
 */
export type SavedConnectionOutcome = SavedConnection & { reconnectNeeded: boolean };

/**
 * What the connections UI asks of the backend. Every function rejects with a `YadbeIpcError`
 * (typed error with a suggested action) when the command fails.
 */
export const connectionsApi = {
  engines: (): Promise<EngineInfo[]> => unwrap(ipc.commands.listEngines()),

  async list(): Promise<{ connections: SavedConnection[]; groups: ConnectionGroup[] }> {
    const [connections, groups] = await Promise.all([
      unwrap(ipc.commands.listConnections()),
      unwrap(ipc.commands.listConnectionGroups()),
    ]);
    return { connections, groups };
  },

  /**
   * Creates or updates a connection, then hands its password (typed, or held from a pasted
   * string) to the keychain or the session. With "remember" turned off, a password the keychain
   * still holds is forgotten, so it is asked at connect time as the form says. When the
   * password cannot be stored, a connection this call created is deleted again.
   */
  async save(
    draft: ConnectionDraft,
    info: EngineInfo,
    storedSecret: SecretLocation | null,
    storedSshSecrets: SshSecretLocations = {},
  ): Promise<SavedConnectionOutcome> {
    const definition = toDefinition(draft, info);
    const { connection: saved, reconnectNeeded } =
      draft.id === null
        ? {
            connection: await unwrap(ipc.commands.createConnection(definition)),
            reconnectNeeded: false,
          }
        : await unwrap(ipc.commands.updateConnection(draft.id, definition));
    const secret = secretOf(draft);
    if (secret) {
      try {
        await unwrap(
          ipc.commands.setConnectionSecret(saved.id, 'password', secret, draft.rememberPassword),
        );
      } catch (error) {
        // The password held from a pasted string may have expired. A new connection saved
        // without it would come back as a duplicate on the next Save: undo its creation.
        if (draft.id === null) {
          await unwrap(ipc.commands.deleteConnection(saved.id)).catch(() => undefined);
        }
        throw error;
      }
    } else if (!draft.rememberPassword && storedSecret === 'keychain') {
      await unwrap(ipc.commands.deleteConnectionSecret(saved.id, 'password'));
    }
    // SSH passwords and passphrases (F-010) follow the same rules, kind by kind.
    const ssh = info.capabilities.usesFile ? { ...draft.ssh, enabled: false } : draft.ssh;
    for (const typed of typedSshSecrets(ssh)) {
      await unwrap(
        ipc.commands.setConnectionSecret(
          saved.id,
          typed.kind,
          { kind: 'value', value: typed.value },
          typed.remember,
        ),
      );
    }
    // The passphrase of the TLS client key: kept with the connection while it has a certificate.
    if (definition.tlsClientCertPath !== null) {
      if (draft.tlsKeyPassphrase !== '') {
        await unwrap(
          ipc.commands.setConnectionSecret(
            saved.id,
            'tlsKeyPassphrase',
            { kind: 'value', value: draft.tlsKeyPassphrase },
            draft.rememberTlsKeyPassphrase,
          ),
        );
      }
    } else if (storedSshSecrets.tlsKeyPassphrase !== undefined) {
      await unwrap(ipc.commands.deleteConnectionSecret(saved.id, 'tlsKeyPassphrase'));
    }
    const typedKinds = new Set(typedSshSecrets(ssh).map((typed) => typed.kind));
    for (const kind of sshSecretsToForget(ssh, storedSshSecrets)) {
      if (!typedKinds.has(kind)) {
        await unwrap(ipc.commands.deleteConnectionSecret(saved.id, kind));
      }
    }
    return { ...saved, reconnectNeeded };
  },

  /** Replaces a definition as is (favorite, group…): nothing about the secrets changes. */
  update: (connection: Pick<SavedConnection, 'id' | 'definition'>): Promise<SavedConnection> =>
    unwrap(ipc.commands.updateConnection(connection.id, connection.definition)).then(
      (update) => update.connection,
    ),

  remove: (id: string): Promise<null> => unwrap(ipc.commands.deleteConnection(id)),

  duplicate: (id: string, name: string): Promise<SavedConnection> =>
    unwrap(ipc.commands.duplicateConnection(id, name)),

  move: (id: string, groupId: string | null, position: number): Promise<null> =>
    unwrap(ipc.commands.moveConnection(id, groupId, position)),

  createGroup: (name: string, parentId: string | null): Promise<ConnectionGroup> =>
    unwrap(ipc.commands.createConnectionGroup(name, parentId)),

  renameGroup: (id: string, name: string): Promise<ConnectionGroup> =>
    unwrap(ipc.commands.renameConnectionGroup(id, name)),

  setGroupCollapsed: (id: string, collapsed: boolean): Promise<null> =>
    unwrap(ipc.commands.setConnectionGroupCollapsed(id, collapsed)),

  deleteGroup: (id: string): Promise<null> => unwrap(ipc.commands.deleteConnectionGroup(id)),

  /** Tries the form without saving it (F-004); cancellable with `cancelTest(requestId)`. */
  test(requestId: string, draft: ConnectionDraft, info: EngineInfo): Promise<TestConnectionResult> {
    return unwrap(
      ipc.commands.testConnection(
        requestId,
        toDefinition(draft, info),
        secretOf(draft),
        draft.id,
        info.capabilities.usesFile
          ? null
          : [...tunnelSecretsOf(draft.ssh), ...tlsSecretsOf(draft, info)],
      ),
    );
  },

  cancelTest: (requestId: string): Promise<null> =>
    unwrap(ipc.commands.cancelTestConnection(requestId)),

  connect: (id: string, password: SecretInput | null): Promise<SessionInfo> =>
    unwrap(ipc.commands.connect(id, password)),

  /** Connects with SSH secrets typed at connect time (kept for the session once they worked). */
  connectWithSecrets: (
    id: string,
    password: SecretInput | null,
    tunnelSecrets: TunnelSecretInput[],
  ): Promise<SessionInfo> => unwrap(ipc.commands.connectWithSecrets(id, password, tunnelSecrets)),

  /** Stores a secret typed in a prompt (password or SSH secret) once it worked. */
  setSecret: (
    id: string,
    kind: SecretKind,
    value: string,
    remember: boolean,
  ): Promise<SecretLocation> =>
    unwrap(ipc.commands.setConnectionSecret(id, kind, { kind: 'value', value }, remember)),

  /** Where each SSH secret of a connection is kept. */
  async sshSecretLocations(id: string): Promise<SshSecretLocations> {
    const found = await Promise.all(
      [...SSH_SECRET_KINDS, 'tlsKeyPassphrase' as const].map(
        async (kind) => [kind, await unwrap(ipc.commands.hasConnectionSecret(id, kind))] as const,
      ),
    );
    const locations: SshSecretLocations = {};
    for (const [kind, location] of found) {
      if (location !== null) locations[kind] = location;
    }
    return locations;
  },

  knownHosts: (): Promise<KnownHost[]> => unwrap(ipc.commands.listKnownHosts()),

  /** Trusts the host key the user was shown (`sshHostKeyUnknown`). */
  trustHostKey: (
    host: string,
    port: number,
    keyType: string,
    fingerprint: string,
  ): Promise<KnownHost> => unwrap(ipc.commands.trustHostKey(host, port, keyType, fingerprint)),

  forgetHostKey: (host: string, port: number, keyType: string | null): Promise<number> =>
    unwrap(ipc.commands.forgetHostKey(host, port, keyType)),

  disconnect: (id: string): Promise<null> => unwrap(ipc.commands.disconnect(id)),

  sessions: (): Promise<SessionInfo[]> => unwrap(ipc.commands.listSessions()),

  keychainStatus: (): Promise<KeychainStatus> => unwrap(ipc.commands.keychainStatus()),

  /** Stores a password typed in the prompt: in the keychain when asked, else for the session. */
  setPassword: (id: string, password: string, remember: boolean): Promise<SecretLocation> =>
    unwrap(
      ipc.commands.setConnectionSecret(
        id,
        'password',
        { kind: 'value', value: password },
        remember,
      ),
    ),

  /** Where the password of a connection is kept, `null` when there is none. */
  passwordLocation: (id: string): Promise<SecretLocation | null> =>
    unwrap(ipc.commands.hasConnectionSecret(id, 'password')),

  /** Reads a pasted connection string (F-006); its password stays with the backend. */
  parseConnectionString: (
    text: string,
    engineHint: Engine | null,
  ): Promise<ParsedConnectionString> =>
    unwrap(ipc.commands.parseConnectionString(text, engineHint)),

  /** Drops the password held from a pasted string (the dialog was cancelled). */
  discardPending: (id: string): Promise<null> => unwrap(ipc.commands.discardPendingSecret(id)),
};
