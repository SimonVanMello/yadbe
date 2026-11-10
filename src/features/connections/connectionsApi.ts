import {
  ipc,
  unwrap,
  type ConnectionGroup,
  type Engine,
  type EngineInfo,
  type KeychainStatus,
  type ParsedConnectionString,
  type SavedConnection,
  type SecretInput,
  type SecretLocation,
  type SessionInfo,
  type TestConnectionResult,
} from '../../ipc';
import { secretOf, toDefinition, type ConnectionDraft } from './model';

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
  ): Promise<SavedConnection> {
    const definition = toDefinition(draft, info);
    const saved = await unwrap(
      draft.id === null
        ? ipc.commands.createConnection(definition)
        : ipc.commands.updateConnection(draft.id, definition),
    );
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
    return saved;
  },

  /** Replaces a definition as is (favorite, group…): nothing about the secrets changes. */
  update: (connection: Pick<SavedConnection, 'id' | 'definition'>): Promise<SavedConnection> =>
    unwrap(ipc.commands.updateConnection(connection.id, connection.definition)),

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
      ipc.commands.testConnection(requestId, toDefinition(draft, info), secretOf(draft), draft.id),
    );
  },

  cancelTest: (requestId: string): Promise<null> =>
    unwrap(ipc.commands.cancelTestConnection(requestId)),

  connect: (id: string, password: SecretInput | null): Promise<SessionInfo> =>
    unwrap(ipc.commands.connect(id, password)),

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
