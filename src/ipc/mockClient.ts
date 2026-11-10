import type {
  AppInfo,
  ConnectionDefinition,
  ConnectionGroup,
  Preferences,
  SavedConnection,
  SecretInput,
  SecretKind,
  SecretLocation,
  SessionInfo,
  StatementLogEntry,
  TabsState,
  YadbeError,
} from './bindings';
import type { YadbeClient, YadbeEventMap, YadbeEventName } from './client';
import { EventEmitter } from './emitter';
import { mockParseConnectionString } from './mockConnectionString';
import {
  MOCK_CONNECTIONS,
  MOCK_ENGINES,
  MOCK_GROUPS,
  MOCK_REMEMBERED_PASSWORDS,
  MOCK_SERVER_VERSIONS,
} from './mockData';
import { mockErrors } from './mockErrors';
import { createMockFiles } from './mockFiles';
import { createMockMeta } from './mock/meta';
import type { LargeCatalogOptions } from './mock/metaCatalog';
import { createMockQuery } from './mockQuery';

/** Version reported by the mock backend: the one of the app it stands in for. */
const MOCK_APP_INFO: AppInfo = { appVersion: '0.1.0', os: 'linux', arch: 'x86_64' };

const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  locale: null,
  density: 'comfortable',
  uiState: null,
};

/** Time a connection attempt takes in the mock, in ms. */
const DEFAULT_LATENCY_MS = 600;
/** The mock keeps a parsed password this long, like the backend (15 min). */
const PENDING_TTL_MS = 15 * 60 * 1000;
const STATEMENT_LOG_CAPACITY = 1000;
const RELOAD_KEY = 'yadbe.mock.reload';

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

const clone = <T>(value: T): T => structuredClone(value);

/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Failures the mock simulates, chosen by the definition:
 * host `fail-dns` / `*.invalid` → hostNotFound, `fail-refused` → connectionRefused,
 * `fail-timeout` → connectionTimeout (after 3× the latency), `fail-tls` → tlsFailed (unless
 * TLS is disabled), `fail-auth` or password `wrong` → authFailed, database `missing` →
 * unknownDatabase, a SQLite path containing `missing` → fileNotFound. Host `fail-lost`
 * connects, then drops 3 s later and reconnects.
 */
function unsupportedEngine(def: ConnectionDefinition): YadbeError | null {
  const engine = MOCK_ENGINES.find((e) => e.engine === def.engine);
  return engine && !engine.available ? mockErrors.engineNotSupported(engine.label) : null;
}

function simulatedFailure(def: ConnectionDefinition, password: string | null): YadbeError | null {
  const engine = MOCK_ENGINES.find((e) => e.engine === def.engine);
  if (def.engine === 'sqlite') {
    return def.filePath.includes('missing') ? mockErrors.fileNotFound(def.filePath) : null;
  }
  const host = def.host.toLowerCase();
  const port = def.port ?? engine?.capabilities.defaultPort ?? 0;
  if (host === 'fail-dns' || host.endsWith('.invalid')) return mockErrors.hostNotFound(def.host);
  if (host === 'fail-refused') return mockErrors.connectionRefused(def.host, port);
  if (host === 'fail-timeout') {
    return mockErrors.connectionTimeout(def.host, def.connectTimeoutSecs ?? 15);
  }
  if (host === 'fail-tls' && def.tlsMode !== 'disable') return mockErrors.tlsFailed();
  if (host === 'fail-auth' || password === 'wrong') return mockErrors.authFailed(def.username);
  if (def.database === 'missing') return mockErrors.unknownDatabase(def.database);
  return null;
}

function secretKey(connectionId: string, kind: SecretKind): string {
  return `${connectionId}:${kind}`;
}

/** In-memory backend for `pnpm dev`, Playwright and Vitest. Implements every command. */
function createMockBackend() {
  const events = new EventEmitter();
  let appInfo: AppInfo = MOCK_APP_INFO;
  let latency = DEFAULT_LATENCY_MS;
  let keychainAvailable = true;
  let connections: SavedConnection[] = [];
  let groups: ConnectionGroup[] = [];
  let preferences: Preferences = DEFAULT_PREFERENCES;
  let tabs: TabsState = { tabs: [], activeTabId: null };
  let log: StatementLogEntry[] = [];
  let logId = 0;
  let nextId = 1;
  const secrets = new Map<string, { value: string; location: SecretLocation }>();
  const pending = new Map<string, { value: string; at: number }>();
  const sessions = new Map<string, SessionInfo>();
  const attempts = new Map<string, AbortController>();
  const tests = new Map<string, AbortController>();
  const meta = createMockMeta({
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { engine: conn.definition.engine, database: conn.definition.database };
    },
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
    emitRefreshed: (payload) => {
      events.emit('metaRefreshed', payload);
    },
  });

  function seed(): void {
    connections = clone(MOCK_CONNECTIONS);
    groups = clone(MOCK_GROUPS);
    secrets.clear();
    for (const id of MOCK_REMEMBERED_PASSWORDS) {
      secrets.set(secretKey(id, 'password'), { value: 'secret', location: 'keychain' });
    }
  }

  function newId(prefix: string): string {
    return `${prefix}-${nextId++}`;
  }

  function now(): number {
    return Math.floor(Date.now() / 1000);
  }

  function findConnection(id: string): SavedConnection | undefined {
    return connections.find((c) => c.id === id);
  }

  function normalized(def: ConnectionDefinition): ConnectionDefinition | YadbeError {
    const name = def.name.trim();
    if (!name) {
      return mockErrors.invalidArgument(
        'A connection needs a name.',
        'Une connexion doit avoir un nom.',
      );
    }
    const engine = MOCK_ENGINES.find((e) => e.engine === def.engine);
    if (engine?.capabilities.usesFile && !def.filePath.trim()) {
      return mockErrors.invalidArgument(
        'Choose the database file.',
        'Choisissez le fichier de la base.',
      );
    }
    if (!engine?.capabilities.usesFile && !def.host.trim()) {
      return mockErrors.invalidArgument(
        'A server connection needs a host.',
        'Une connexion à un serveur doit avoir un hôte.',
      );
    }
    if (def.groupId !== null && !groups.some((g) => g.id === def.groupId)) {
      return mockErrors.groupNotFound(def.groupId);
    }
    return { ...clone(def), name, host: def.host.trim() };
  }

  function isError(value: unknown): value is YadbeError {
    return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
  }

  function nextPosition(siblings: { position: number }[]): number {
    return siblings.reduce((max, s) => Math.max(max, s.position + 1), 0);
  }

  function renumber(items: { position: number }[]): void {
    items.forEach((item, index) => {
      item.position = index;
    });
  }

  function logStatement(
    connectionId: string | null,
    connectionName: string,
    sql: string,
    error: YadbeError | null = null,
  ): void {
    const entry: StatementLogEntry = {
      id: ++logId,
      connectionId,
      connectionName,
      sql,
      startedAt: Date.now(),
      durationMs: 1.2,
      outcome: error ? { kind: 'error', error } : { kind: 'ok', rows: 1 },
    };
    log = [...log, entry].slice(-STATEMENT_LOG_CAPACITY);
    events.emit('statementLogged', { entry });
  }

  function setSession(info: SessionInfo): SessionInfo {
    if (info.state === 'closed') {
      sessions.delete(info.connectionId);
      meta.forget(info.connectionId);
    } else sessions.set(info.connectionId, info);
    events.emit('connectionStateChanged', { session: clone(info) });
    return info;
  }

  function resolveSecret(input: SecretInput, consume: boolean): string | YadbeError {
    if (input.kind === 'value') return input.value;
    const entry = pending.get(input.id);
    if (!entry || Date.now() - entry.at > PENDING_TTL_MS) {
      pending.delete(input.id);
      return mockErrors.pendingSecretExpired();
    }
    if (consume) pending.delete(input.id);
    return entry.value;
  }

  /** Runs the simulated handshake; logs the statements a real driver would run. */
  async function handshake(
    def: ConnectionDefinition,
    password: string | null,
    connectionId: string | null,
    signal: AbortSignal,
  ): Promise<YadbeError | string> {
    const failure = simulatedFailure(def, password);
    const wait = failure?.code === 'connectionTimeout' ? latency * 3 : latency;
    if (!(await sleep(wait, signal))) return mockErrors.cancelled();
    if (failure) return failure;
    const versionSql = def.engine === 'sqlite' ? 'SELECT sqlite_version()' : 'SHOW server_version';
    logStatement(connectionId, def.name, versionSql);
    return MOCK_SERVER_VERSIONS[def.engine];
  }

  function storedPassword(connectionId: string): string | null {
    return secrets.get(secretKey(connectionId, 'password'))?.value ?? null;
  }

  /** Simulates a dropped link followed by an automatic reconnection. */
  async function dropConnection(connectionId: string): Promise<void> {
    const current = sessions.get(connectionId);
    if (current?.state !== 'connected') return;
    setSession({ ...current, state: 'lost', error: mockErrors.connectionLost() });
    setSession({ ...current, state: 'reconnecting', error: null, reconnectAttempt: 1 });
    await sleep(latency);
    if (sessions.get(connectionId)?.state !== 'reconnecting') return;
    setSession({ ...current, state: 'connected', error: null, reconnectAttempt: null });
    meta.reconnected(connectionId);
  }

  const query = createMockQuery({
    events,
    connection: findConnection,
    session: (id) => sessions.get(id),
    logStatement: (connectionId, connectionName, sql) => {
      logStatement(connectionId, connectionName, sql);
    },
  });

  const files = createMockFiles();

  const commands: YadbeClient['commands'] = {
    appInfo: () => ok(appInfo),

    listEngines: () => ok(clone(MOCK_ENGINES)),

    listConnections: () => ok(clone(connections)),

    createConnection: (definition) => {
      const def = normalized(definition);
      if (isError(def)) return fail(def);
      const at = now();
      const conn: SavedConnection = {
        id: newId('conn'),
        definition: def,
        position: nextPosition(connections.filter((c) => c.definition.groupId === def.groupId)),
        createdAt: at,
        updatedAt: at,
        lastConnectedAt: null,
      };
      connections = [...connections, conn];
      return ok(clone(conn));
    },

    updateConnection: (connectionId, definition) => {
      const current = findConnection(connectionId);
      if (!current) return fail(mockErrors.connectionNotFound(connectionId));
      const def = normalized(definition);
      if (isError(def)) return fail(def);
      const moved = current.definition.groupId !== def.groupId;
      const updated: SavedConnection = {
        ...current,
        definition: def,
        position: moved
          ? nextPosition(connections.filter((c) => c.definition.groupId === def.groupId))
          : current.position,
        updatedAt: now(),
      };
      connections = connections.map((c) => (c.id === connectionId ? updated : c));
      return ok(clone(updated));
    },

    duplicateConnection: (connectionId, name) => {
      const current = findConnection(connectionId);
      if (!current) return fail(mockErrors.connectionNotFound(connectionId));
      return commands.createConnection({ ...current.definition, name });
    },

    deleteConnection: async (connectionId) => {
      if (!findConnection(connectionId)) return fail(mockErrors.connectionNotFound(connectionId));
      await commands.disconnect(connectionId);
      connections = connections.filter((c) => c.id !== connectionId);
      for (const kind of ['password', 'sshPassphrase', 'token'] as const) {
        secrets.delete(secretKey(connectionId, kind));
      }
      return ok(null);
    },

    moveConnection: (connectionId, groupId, position) => {
      const conn = findConnection(connectionId);
      if (!conn) return fail(mockErrors.connectionNotFound(connectionId));
      if (groupId !== null && !groups.some((g) => g.id === groupId)) {
        return fail(mockErrors.groupNotFound(groupId));
      }
      const siblings = connections
        .filter((c) => c.definition.groupId === groupId && c.id !== connectionId)
        .sort((a, b) => a.position - b.position);
      conn.definition.groupId = groupId;
      siblings.splice(Math.min(position, siblings.length), 0, conn);
      renumber(siblings);
      return ok(null);
    },

    listConnectionGroups: () => ok(clone(groups)),

    createConnectionGroup: (name, parentId) => {
      if (!name.trim()) {
        return fail(
          mockErrors.invalidArgument('A group needs a name.', 'Un groupe doit avoir un nom.'),
        );
      }
      if (parentId !== null && !groups.some((g) => g.id === parentId)) {
        return fail(mockErrors.groupNotFound(parentId));
      }
      const group: ConnectionGroup = {
        id: newId('group'),
        name: name.trim(),
        parentId,
        position: nextPosition(groups.filter((g) => g.parentId === parentId)),
        collapsed: false,
      };
      groups = [...groups, group];
      return ok(clone(group));
    },

    renameConnectionGroup: (groupId, name) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return fail(mockErrors.groupNotFound(groupId));
      if (!name.trim()) {
        return fail(
          mockErrors.invalidArgument('A group needs a name.', 'Un groupe doit avoir un nom.'),
        );
      }
      group.name = name.trim();
      return ok(clone(group));
    },

    setConnectionGroupCollapsed: (groupId, collapsed) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return fail(mockErrors.groupNotFound(groupId));
      group.collapsed = collapsed;
      return ok(null);
    },

    moveConnectionGroup: (groupId, parentId, position) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return fail(mockErrors.groupNotFound(groupId));
      for (let p = parentId; p !== null; p = groups.find((g) => g.id === p)?.parentId ?? null) {
        if (p === groupId) {
          return fail(
            mockErrors.invalidArgument(
              'A group cannot move into itself.',
              'Un groupe ne peut pas être déplacé dans lui-même.',
            ),
          );
        }
      }
      const siblings = groups
        .filter((g) => g.parentId === parentId && g.id !== groupId)
        .sort((a, b) => a.position - b.position);
      group.parentId = parentId;
      siblings.splice(Math.min(position, siblings.length), 0, group);
      renumber(siblings);
      return ok(null);
    },

    deleteConnectionGroup: (groupId) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return fail(mockErrors.groupNotFound(groupId));
      let groupBase = nextPosition(groups.filter((g) => g.parentId === group.parentId));
      for (const child of groups.filter((g) => g.parentId === groupId)) {
        child.parentId = group.parentId;
        child.position = groupBase++;
      }
      let connBase = nextPosition(
        connections.filter((c) => c.definition.groupId === group.parentId),
      );
      for (const conn of connections.filter((c) => c.definition.groupId === groupId)) {
        conn.definition.groupId = group.parentId;
        conn.position = connBase++;
      }
      groups = groups.filter((g) => g.id !== groupId);
      return ok(null);
    },

    testConnection: async (requestId, definition, password, connectionId) => {
      const def = normalized(definition);
      if (isError(def)) return fail(def);
      const unsupported = unsupportedEngine(def);
      if (unsupported) return fail(unsupported);
      let secret: string | null = null;
      if (password) {
        const resolved = resolveSecret(password, false);
        if (isError(resolved)) return fail(resolved);
        secret = resolved;
      } else if (connectionId !== null) {
        secret = storedPassword(connectionId);
      }
      if (def.auth === 'password' && secret === null) return fail(mockErrors.passwordRequired());
      const controller = new AbortController();
      tests.set(requestId, controller);
      const started = performance.now();
      const result = await handshake(def, secret, connectionId, controller.signal);
      tests.delete(requestId);
      if (isError(result)) return fail(result);
      logStatement(connectionId, def.name, 'SELECT 1');
      return ok({ serverVersion: result, durationMs: Math.round(performance.now() - started) });
    },

    cancelTestConnection: (requestId) => {
      tests.get(requestId)?.abort();
      return ok(null);
    },

    connect: async (connectionId, password) => {
      const conn = findConnection(connectionId);
      if (!conn) return fail(mockErrors.connectionNotFound(connectionId));
      const existing = sessions.get(connectionId);
      if (existing && existing.state !== 'lost') return ok(clone(existing));
      const unsupported = unsupportedEngine(conn.definition);
      if (unsupported) return fail(unsupported);
      let secret: string | null;
      if (password) {
        const resolved = resolveSecret(password, true);
        if (isError(resolved)) return fail(resolved);
        secret = resolved;
      } else {
        secret = storedPassword(connectionId);
      }
      if (conn.definition.auth === 'password' && secret === null) {
        return fail(mockErrors.passwordRequired());
      }
      const base: SessionInfo = {
        connectionId,
        state: 'connecting',
        serverVersion: null,
        error: null,
        reconnectAttempt: null,
      };
      setSession(base);
      const controller = new AbortController();
      attempts.set(connectionId, controller);
      const result = await handshake(conn.definition, secret, connectionId, controller.signal);
      attempts.delete(connectionId);
      if (isError(result)) {
        setSession({ ...base, state: 'closed', error: result });
        return fail(result);
      }
      // A password typed at connect time is kept for the session, like the backend does.
      if (password && secret !== null) {
        secrets.set(secretKey(connectionId, 'password'), { value: secret, location: 'session' });
      }
      conn.lastConnectedAt = now();
      const info = setSession({ ...base, state: 'connected', serverVersion: result });
      if (conn.definition.host === 'fail-lost') {
        void sleep(3000).then(() => dropConnection(connectionId));
      }
      return ok(clone(info));
    },

    disconnect: (connectionId) => {
      attempts.get(connectionId)?.abort();
      const current = sessions.get(connectionId);
      if (current) {
        setSession({ ...current, state: 'closed', error: null, reconnectAttempt: null });
      }
      return ok(null);
    },

    listSessions: () => ok(clone([...sessions.values()])),

    keychainStatus: () =>
      ok(
        keychainAvailable
          ? { available: true, detail: null }
          : { available: false, detail: 'org.freedesktop.secrets was not provided by any files' },
      ),

    setConnectionSecret: (connectionId, kind, secret, remember) => {
      if (!findConnection(connectionId)) return fail(mockErrors.connectionNotFound(connectionId));
      const value = resolveSecret(secret, true);
      if (isError(value)) return fail(value);
      const location: SecretLocation = remember && keychainAvailable ? 'keychain' : 'session';
      secrets.set(secretKey(connectionId, kind), { value, location });
      return ok(location);
    },

    deleteConnectionSecret: (connectionId, kind) => {
      secrets.delete(secretKey(connectionId, kind));
      return ok(null);
    },

    hasConnectionSecret: (connectionId, kind) =>
      ok(secrets.get(secretKey(connectionId, kind))?.location ?? null),

    parseConnectionString: (input, engineHint) => {
      const parsed = mockParseConnectionString(input, engineHint);
      if (!parsed) return fail(mockErrors.invalidConnectionString());
      const fields = { ...parsed.fields };
      if (parsed.password !== null) {
        const id = newId('pending');
        pending.set(id, { value: parsed.password, at: Date.now() });
        fields.passwordId = id;
      }
      return ok(fields);
    },

    discardPendingSecret: (id) => {
      pending.delete(id);
      return ok(null);
    },

    getPreferences: () => ok(clone(preferences)),

    setPreferences: (prefs) => {
      preferences = clone(prefs);
      persistForReload();
      return ok(clone(preferences));
    },

    loadTabs: () => ok(clone(tabs)),

    saveTabs: (state) => {
      const known = new Set(connections.map((c) => c.id));
      tabs = {
        ...clone(state),
        tabs: state.tabs.map((tab) => ({
          ...clone(tab),
          connectionId:
            tab.connectionId !== null && known.has(tab.connectionId) ? tab.connectionId : null,
        })),
      };
      persistForReload();
      return ok(null);
    },

    getStatementLog: () => ok(clone(log)),

    clearStatementLog: () => {
      log = [];
      return ok(null);
    },

    ...meta.commands,
    ...query.commands,

    ...files.commands,
  };

  function reset(): void {
    for (const controller of [...attempts.values(), ...tests.values()]) controller.abort();
    attempts.clear();
    tests.clear();
    appInfo = MOCK_APP_INFO;
    latency = DEFAULT_LATENCY_MS;
    keychainAvailable = true;
    preferences = DEFAULT_PREFERENCES;
    tabs = { tabs: [], activeTabId: null };
    log = [];
    logId = 0;
    nextId = 1;
    pending.clear();
    sessions.clear();
    meta.reset();
    query.reset();
    files.reset();
    clearReloadState();
    seed();
  }

  /**
   * The real store survives a restart, so the mock keeps the tabs and the preferences across a
   * page reload (session storage: gone with the browser tab), which is how `pnpm dev` and
   * Playwright check that the shell restores them.
   */
  function persistForReload(): void {
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ tabs, preferences }));
    } catch {
      // Storage unavailable: the mock then forgets them on reload, like before.
    }
  }

  function restoreAfterReload(): void {
    try {
      const raw = sessionStorage.getItem(RELOAD_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { tabs?: TabsState; preferences?: Preferences };
      if (saved.tabs) tabs = saved.tabs;
      if (saved.preferences) preferences = saved.preferences;
    } catch {
      // Unreadable: start from the defaults.
    }
  }

  function clearReloadState(): void {
    try {
      sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      // Nothing to clear.
    }
  }

  seed();
  restoreAfterReload();

  return {
    commands,
    events,
    /** Pushes a backend event to the subscribers, as the real backend would. */
    emit<K extends YadbeEventName>(name: K, payload: YadbeEventMap[K]): void {
      events.emit(name, payload);
    },
    /** Replaces what `appInfo` returns (tests). */
    setAppInfo(info: AppInfo): void {
      appInfo = info;
    },
    /** Duration of a simulated connection attempt, in ms (0 in unit tests). */
    setLatency(ms: number): void {
      latency = ms;
    },
    /** Simulates a machine without keychain: secrets then stay in the session. */
    setKeychainAvailable(available: boolean): void {
      keychainAvailable = available;
    },
    /** Simulates a dropped link on an open connection, then the automatic reconnection. */
    dropConnection,
    /** Duration of a first metadata load, in ms (0 in unit tests). */
    setMetaLatency(ms: number): void {
      meta.setLatency(ms);
    },
    /**
     * `large`: PostgreSQL connections opened from now on see a 10 000-object database, or the
     * synthetic one `options` describe.
     */
    setMetaCatalog(kind: 'shop' | 'large', options?: LargeCatalogOptions): void {
      meta.setCatalog(kind, options);
    },
    /** Time between two streamed batches of a query result, in ms (0 in unit tests). */
    setQueryTick(ms: number): void {
      query.setTick(ms);
    },
    /** Puts a script on the mock disk, or removes it with `null` (a change behind the app's back). */
    setFile: (path: string, text: string | null): void => {
      files.set(path, text);
    },
    getFile: (path: string): string | undefined => files.get(path),
    reset,
  };
}

export type MockBackend = ReturnType<typeof createMockBackend>;

export const mockBackend: MockBackend = createMockBackend();

export const mockClient: YadbeClient = {
  commands: mockBackend.commands,
  events: mockBackend.events,
};
