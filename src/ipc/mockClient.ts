import type {
  ActivitySession,
  AppInfo,
  LaunchRequest,
  ConnectionDefinition,
  ConnectionGroup,
  Engine,
  ObjectRef,
  Preferences,
  SavedConnection,
  SecretInput,
  SecretKind,
  SecretLocation,
  SessionInfo,
  StatementLogEntry,
  TabsState,
  TunnelSecretInput,
  Value,
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
  mockFamilyOf,
} from './mockData';
import { mockErrors } from './mockErrors';
import { createMockConnectionImport } from './mock/connectionImport';
import { createMockActivity } from './mock/activity';
import { createMockDotnet } from './mock/dotnet';
import { createMockExport } from './mock/export';
import { createMockImport } from './mock/import';
import { createMockFiles } from './mockFiles';
import { createMockHistory } from './mock/history';
import { createMockSavedQueries } from './mock/savedQueries';
import { createMockMeta } from './mock/meta';
import { createMockObjects } from './mock/objects';
import type { LargeCatalogOptions } from './mock/metaCatalog';
import { cellValue, createMockQuery } from './mockQuery';
import { createMockReferences } from './mock/references';
import { createMockSsh, tunnelStatus } from './mock/ssh';
import { createMockTableData } from './mock/tableData';
import { createMockResultEdit, parseTableSelect, tableSelect } from './mock/resultEdit';
import { createMockJournal } from './mock/journal';
import { createMockDocument } from './mock/document';
import { createMockKeyValue } from './mock/keyValue';

/** Version reported by the mock backend: the one of the app it stands in for. */
const MOCK_APP_INFO: AppInfo = { appVersion: '0.1.0', os: 'linux', arch: 'x86_64' };

const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  locale: null,
  density: 'comfortable',
  uiState: null,
  historyEnabled: true,
  historyMaxEntries: 50_000,
  historyMaxAgeDays: 365,
  connectTimeoutSecs: 15,
  journalMaxEntries: 1000,
  journalMaxAgeDays: 90,
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
 * connects, then drops 3 s later and reconnects. A TLS client certificate or key path containing
 * `missing` → tlsClientCertInvalid, host `fail-cert` without one → tlsClientCertRequired; a key path (or certificate, when it holds the key) containing
 * `encrypted` needs its passphrase (`wrong` is refused).
 */
function tlsIdentityFailure(
  def: ConnectionDefinition,
  passphrase: string | null,
): YadbeError | null {
  const cert = def.tlsClientCertPath ?? null;
  if (cert === null && def.host === 'fail-cert' && def.tlsMode !== 'disable') {
    return mockErrors.tlsClientCertRequired();
  }
  if (cert === null || def.tlsMode === 'disable') return null;
  const key = def.tlsClientKeyPath ?? cert;
  for (const path of [cert, key]) {
    if (path.includes('missing')) {
      return mockErrors.tlsClientCertInvalid(`cannot read the client file ${path}: No such file`);
    }
  }
  if (!key.includes('encrypted')) return null;
  if (passphrase === null || passphrase === '') return mockErrors.tlsKeyPassphraseRequired();
  return passphrase === 'wrong' ? mockErrors.tlsKeyPassphraseWrong() : null;
}

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
  const ssh = createMockSsh();
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

  const objects = createMockObjects({
    meta,
    readOnly: (connectionId) => findConnection(connectionId)?.definition.readOnly ?? false,
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
  });

  const activity = createMockActivity({
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { engine: conn.definition.engine, database: conn.definition.database };
    },
    readOnly: (connectionId) => findConnection(connectionId)?.definition.readOnly ?? false,
    latency: () => meta.latency(),
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
  });

  const dotnet = createMockDotnet({
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { engine: conn.definition.engine, database: conn.definition.database };
    },
    definition: (connectionId) => findConnection(connectionId)?.definition ?? null,
    password: (connectionId) => secrets.get(secretKey(connectionId, 'password'))?.value ?? null,
    latency: () => meta.latency(),
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
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
    // Like the backend: only an engine that can present a certificate keeps one.
    const certificate = engine?.capabilities.clientCertificate
      ? (def.tlsClientCertPath ?? '').trim() || null
      : null;
    return {
      ...clone(def),
      name,
      host: def.host.trim(),
      tlsClientCertPath: certificate,
      tlsClientKeyPath: certificate === null ? null : (def.tlsClientKeyPath ?? '').trim() || null,
    };
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

  /** Open sessions whose saved settings changed in a way only a new connection picks up. */
  const outdated = new Set<string>();

  function setSession(info: SessionInfo): SessionInfo {
    if (info.state === 'connecting' || info.state === 'closed') outdated.delete(info.connectionId);
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

  function defaultPort(def: ConnectionDefinition): number {
    return MOCK_ENGINES.find((e) => e.engine === def.engine)?.capabilities.defaultPort ?? 0;
  }

  /** The SSH secrets typed for this attempt, else those kept for the connection. */
  function tunnelSecrets(
    typed: TunnelSecretInput[],
    connectionId: string | null,
  ): Map<SecretKind, string> | YadbeError {
    const found = new Map<SecretKind, string>();
    for (const input of typed) {
      const value = resolveSecret(input.secret, false);
      if (isError(value)) return value;
      found.set(input.kind, value);
    }
    if (connectionId !== null) {
      for (const kind of [
        'sshPassword',
        'sshPassphrase',
        'jumpPassword',
        'jumpPassphrase',
        'tlsKeyPassphrase',
      ] as const) {
        const stored = secrets.get(secretKey(connectionId, kind));
        if (!found.has(kind) && stored) found.set(kind, stored.value);
      }
    }
    return found;
  }

  /** Opens the tunnel of `def` (if any) after the mock latency; logs it like the backend. */
  async function openTunnel(
    def: ConnectionDefinition,
    found: Map<SecretKind, string>,
    connectionId: string | null,
    signal: AbortSignal,
  ): Promise<YadbeError | null> {
    const described = ssh.describe(def, defaultPort(def));
    if (described === null) return null;
    if (!(await sleep(latency, signal))) return mockErrors.cancelled();
    const failure = ssh.open(def, (kind) => found.get(kind) ?? null, defaultPort(def));
    logStatement(connectionId, def.name, `-- SSH tunnel open: ${described}`, failure);
    return failure;
  }

  /**
   * Simulates a dropped link followed by an automatic reconnection (`stayLost`: the link stays
   * lost, for a screen that shows it).
   */
  async function dropConnection(connectionId: string, stayLost = false): Promise<void> {
    const current = sessions.get(connectionId);
    if (current?.state !== 'connected') return;
    setSession({ ...current, state: 'lost', error: mockErrors.connectionLost() });
    if (stayLost) return;
    setSession({ ...current, state: 'reconnecting', error: null, reconnectAttempt: 1 });
    await sleep(latency);
    if (sessions.get(connectionId)?.state !== 'reconnecting') return;
    setSession({ ...current, state: 'connected', error: null, reconnectAttempt: null });
    meta.reconnected(connectionId);
  }

  const history = createMockHistory({ events, connection: findConnection });

  const query = createMockQuery({
    events,
    recordHistory: history.record,
    connection: findConnection,
    session: (id) => sessions.get(id),
    logStatement: (connectionId, connectionName, sql) => {
      logStatement(connectionId, connectionName, sql);
    },
    tableSelect: (connectionId, database, sql) => {
      const parsed = parseTableSelect(sql);
      const definition = findConnection(connectionId)?.definition;
      if (!parsed || !definition) return null;
      const table = {
        database: database ?? definition.database,
        schema: parsed.schema,
        name: parsed.table,
      };
      const found = tableData.rowsFor(connectionId, table);
      return found ? tableSelect(parsed, connectionId, table, found.details, found.rows) : null;
    },
  });

  const files = createMockFiles();
  const savedQueries = createMockSavedQueries({ events, connection: findConnection, files });

  const exporter = createMockExport({
    events,
    source: (resultId) => query.resultSource(resultId),
    table: (tabId, filter, sort) => {
      const found = tableData.exportRows(tabId, filter, sort);
      if ('code' in found) return found;
      return {
        columns: found.columns,
        loaded: found.rows.length,
        total: found.rows.length,
        value: (row, column) => cellValue(found.rows[row]?.[column] ?? null),
      };
    },
    writeFile: (path, text) => {
      files.set(path, text);
    },
  });

  const journal = createMockJournal({ events });

  const tableData = createMockTableData({
    events,
    journal,
    connectionName: (connectionId) => findConnection(connectionId)?.definition.name ?? connectionId,
    relation: (connectionId, table) => meta.relation(connectionId, table),
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { engine: conn.definition.engine, readOnly: conn.definition.readOnly };
    },
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
    storeRows: (columns, rows) => query.storeRows(columns, rows),
    freeResults: (ids) => {
      query.freeResults(ids);
    },
  });

  const resultEdit = createMockResultEdit({
    origin: (resultId) => query.resultOrigin(resultId),
    tabTransaction: (tabId) => query.tabTransaction(tabId),
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { engine: conn.definition.engine, readOnly: conn.definition.readOnly };
    },
    relation: (connectionId, table) => meta.relation(connectionId, table),
    tables: tableData.commands,
    storeRows: (columns, rows) => query.storeRows(columns, rows),
    freeResults: (ids) => {
      query.freeResults(ids);
    },
    window: (resultId, offset, limit) => query.window(resultId, offset, limit),
    patchRow: (resultId, row, cells) => {
      query.patchRow(resultId, row, cells);
    },
    removeRows: (resultId, rows) => query.removeRows(resultId, rows),
  });

  const references = createMockReferences({
    session: (connectionId) => tableDataSession(connectionId),
    tablesOf: (connectionId, database) => meta.tablesOf(connectionId, database),
    rowsFor: (connectionId, table) => tableData.rowsFor(connectionId, table),
    tabTarget: (tabId) => tableData.tabTarget(tabId),
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
    storeRows: (columns, rows) => query.storeRows(columns, rows),
    freeResults: (ids) => {
      query.freeResults(ids);
    },
  });

  function tableDataSession(connectionId: string): { engine: Engine } | null {
    const conn = findConnection(connectionId);
    if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
    return { engine: conn.definition.engine };
  }

  async function connectWith(
    connectionId: string,
    password: SecretInput | null,
    typedTunnel: TunnelSecretInput[],
  ): Result<SessionInfo> {
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
    const found = tunnelSecrets(typedTunnel, connectionId);
    if (isError(found)) return fail(found);
    const identityError = tlsIdentityFailure(
      conn.definition,
      found.get('tlsKeyPassphrase') ?? null,
    );
    if (identityError) return fail(identityError);
    const base: SessionInfo = {
      connectionId,
      state: 'connecting',
      serverVersion: null,
      error: null,
      reconnectAttempt: null,
      tunnel: tunnelStatus(conn.definition, 'down'),
    };
    setSession(base);
    const controller = new AbortController();
    attempts.set(connectionId, controller);
    if (conn.definition.ssh) {
      setSession({ ...base, tunnel: tunnelStatus(conn.definition, 'opening') });
      const failure = await openTunnel(conn.definition, found, connectionId, controller.signal);
      if (failure) {
        attempts.delete(connectionId);
        setSession({ ...base, state: 'closed', error: failure });
        return fail(failure);
      }
      setSession({ ...base, tunnel: tunnelStatus(conn.definition, 'open') });
    }
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
    for (const input of typedTunnel) {
      const value = found.get(input.kind);
      if (value !== undefined) {
        secrets.set(secretKey(connectionId, input.kind), { value, location: 'session' });
      }
    }
    conn.lastConnectedAt = now();
    const info = setSession({
      ...base,
      state: 'connected',
      serverVersion: result,
      tunnel: tunnelStatus(conn.definition, 'open'),
    });
    if (conn.definition.host === 'fail-lost') {
      void sleep(3000).then(() => dropConnection(connectionId));
    }
    return ok(clone(info));
  }

  function createConnectionNow(definition: ConnectionDefinition): SavedConnection | YadbeError {
    const def = normalized(definition);
    if (isError(def)) return def;
    const at = now();
    const conn: SavedConnection = {
      id: newId('conn'),
      definition: def,
      family: mockFamilyOf(def.engine),
      position: nextPosition(connections.filter((c) => c.definition.groupId === def.groupId)),
      createdAt: at,
      updatedAt: at,
      lastConnectedAt: null,
    };
    connections = [...connections, conn];
    return clone(conn);
  }

  const importer = createMockImport({
    events,
    readFile: (path) => files.get(path),
    writeFile: (path, text) => {
      files.set(path, text);
    },
    relation: (connectionId, table) => meta.relation(connectionId, table),
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { engine: conn.definition.engine, readOnly: conn.definition.readOnly };
    },
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
  });

  const connectionImport = createMockConnectionImport({
    connections: () => connections,
    groups: () => groups,
    createGroup: (name, parentId) => {
      const group: ConnectionGroup = {
        id: newId('group'),
        name,
        parentId,
        position: nextPosition(groups.filter((g) => g.parentId === parentId)),
        collapsed: false,
      };
      groups = [...groups, group];
      return clone(group);
    },
    createConnection: createConnectionNow,
    storePassword: (connectionId, password) => {
      const location: SecretLocation = keychainAvailable ? 'keychain' : 'session';
      secrets.set(secretKey(connectionId, 'password'), { value: password, location });
      return location;
    },
    readFile: (path) => files.get(path),
    writeFile: (path, text) => {
      files.set(path, text);
    },
  });

  const document = createMockDocument({
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return { readOnly: conn.definition.readOnly };
    },
    latency: () => meta.latency(),
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
    recordHistory: (entry) => {
      history.record(entry);
    },
    storeRows: (columns, rows) => query.storeRows(columns, rows),
    freeResults: (ids) => {
      query.freeResults(ids);
    },
    readTexts: (resultId, offset, limit) => {
      const source = query.resultSource(resultId);
      if (!source) return null;
      const texts: string[] = [];
      for (let row = offset; row < Math.min(source.loaded, offset + limit); row++) {
        const value = source.value(row, 0);
        texts.push('value' in value && typeof value.value === 'string' ? value.value : '{}');
      }
      return texts;
    },
  });

  const keyValue = createMockKeyValue({
    events,
    session: (connectionId) => {
      const conn = findConnection(connectionId);
      if (!conn || sessions.get(connectionId)?.state !== 'connected') return null;
      return {
        database: Number(conn.definition.database) || 0,
        readOnly: conn.definition.readOnly,
      };
    },
    logStatement: (connectionId, sql, error = null) => {
      logStatement(connectionId, findConnection(connectionId)?.definition.name ?? '', sql, error);
    },
    recordHistory: (entry) => {
      history.record({
        tabId: entry.tabId,
        connectionId: entry.connectionId,
        database: entry.database,
        sql: entry.sql,
        startedAt: Date.now(),
        durationMs: 0.6,
        rows: entry.rows,
        outcome:
          entry.error === null
            ? 'ok'
            : entry.error.code === 'readOnlyViolation'
              ? 'refused'
              : 'error',
        error: entry.error,
      });
    },
    storeRows: (columns, rows) => query.storeRows(columns, rows),
    freeResults: (ids) => {
      query.freeResults(ids);
    },
    latency: () => meta.latency(),
    journal,
    connectionName: (connectionId) => findConnection(connectionId)?.definition.name ?? connectionId,
    engine: (connectionId) => findConnection(connectionId)?.definition.engine ?? 'redis',
  });

  const commands: YadbeClient['commands'] = {
    appInfo: () => ok(appInfo),

    // The command line of the browser mock: a test sets `window.__YADBE_MOCK_LAUNCH__`.
    takeLaunchRequests: () => {
      const injected = (globalThis as { __YADBE_MOCK_LAUNCH__?: LaunchRequest[] })
        .__YADBE_MOCK_LAUNCH__;
      const taken = injected ?? [];
      (globalThis as { __YADBE_MOCK_LAUNCH__?: LaunchRequest[] }).__YADBE_MOCK_LAUNCH__ = [];
      return ok(clone(taken));
    },

    listEngines: () => ok(clone(MOCK_ENGINES)),

    listConnections: () => ok(clone(connections)),

    createConnection: (definition) => {
      const created = createConnectionNow(definition);
      return isError(created) ? fail(created) : ok(created);
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
      // Like the backend: read-only and the statement timeout apply to an open session at once.
      if (sessions.has(connectionId) && needsReconnect(current.definition, def)) {
        outdated.add(connectionId);
      }
      return ok({ connection: clone(updated), reconnectNeeded: outdated.has(connectionId) });
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
      savedQueries.connectionDeleted(connectionId);
      objects.forgetConnection(connectionId);
      activity.forgetConnection(connectionId);
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

    testConnection: async (requestId, definition, password, connectionId, typedTunnel) => {
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
      const found = tunnelSecrets(typedTunnel ?? [], connectionId);
      if (isError(found)) return fail(found);
      const identityError = tlsIdentityFailure(def, found.get('tlsKeyPassphrase') ?? null);
      if (identityError) return fail(identityError);
      const controller = new AbortController();
      tests.set(requestId, controller);
      const started = performance.now();
      const tunnelFailure = await openTunnel(def, found, connectionId, controller.signal);
      if (tunnelFailure) {
        tests.delete(requestId);
        return fail(tunnelFailure);
      }
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

    connect: (connectionId, password) => connectWith(connectionId, password, []),

    connectWithSecrets: (connectionId, password, typedTunnel) =>
      connectWith(connectionId, password, typedTunnel),

    listKnownHosts: () => ok(ssh.list()),

    trustHostKey: (host, port, keyType, fingerprint) => {
      const trusted = ssh.trust(host, port, keyType, fingerprint);
      return isError(trusted) ? fail(trusted) : ok(trusted);
    },

    forgetHostKey: (host, port, keyType) => ok(ssh.forget(host, port, keyType)),

    disconnect: (connectionId) => {
      attempts.get(connectionId)?.abort();
      const current = sessions.get(connectionId);
      if (current) {
        setSession({ ...current, state: 'closed', error: null, reconnectAttempt: null });
      }
      keyValue.forgetConnection(connectionId);
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
      journal.setMaxEntries(preferences.journalMaxEntries);
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
    ...history.commands,
    ...savedQueries.commands,
    ...tableData.commands,
    ...resultEdit.commands,
    ...references.commands,
    ...journal.commands,
    closeTableData: (tabId) => {
      references.close(tabId);
      return tableData.commands.closeTableData(tabId);
    },

    ...files.commands,
    ...exporter.commands,
    ...objects.commands,
    ...activity.commands,
    ...dotnet.commands,
    ...importer.commands,
    ...connectionImport.commands,
    ...document.commands,
    ...keyValue.commands,
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
    ssh.seed();
    meta.reset();
    objects.reset();
    activity.reset();
    keyValue.reset();
    dotnet.reset();
    query.reset();
    history.reset();
    savedQueries.reset();
    tableData.reset();
    resultEdit.reset();
    journal.reset();
    references.reset();
    document.reset();
    files.reset();
    exporter.reset();
    importer.reset();
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
    /** Shows the activity monitor of a user who may not see other sessions (`null`: may). */
    setActivityFault(connectionId: string, fault: 'insufficientPrivilege' | null): void {
      activity.setFault(connectionId, fault);
    },
    /** A session starts a statement on the mock server, as another client would. */
    startActivitySession(
      connectionId: string,
      session: Partial<ActivitySession> & { id: string },
    ): void {
      activity.startSession(connectionId, session);
    },
    /** Time between two streamed batches of a query result, in ms (0 in unit tests). */
    setQueryTick(ms: number): void {
      query.setTick(ms);
    },
    /** Time between two simulated steps of an export, in ms (0 in unit tests). */
    setExportTick(ms: number): void {
      exporter.setTick(ms);
    },
    /** Time between two simulated steps of an import, in ms (0 in unit tests). */
    setImportTick(ms: number): void {
      importer.setTick(ms);
    },
    /** `count` synthetic history entries over the last year (100 000 for the scroll check). */
    seedHistory(count: number): void {
      history.seedSynthetic(count);
    },
    /** Empties the query library (a screen that shows its empty state). */
    clearSavedQueries(): void {
      savedQueries.clear();
    },
    /** Delay of the debounced `history-changed`, in ms (0 in unit tests). */
    setHistoryDebounce(ms: number): void {
      history.setEmitDelay(ms);
    },
    /** Puts a script on the mock disk, or removes it with `null` (a change behind the app's back). */
    setFile: (path: string, text: string | null): void => {
      files.set(path, text);
    },
    getFile: (path: string): string | undefined => files.get(path),
    /** Time a table data statement takes, in ms (0 in unit tests). */
    setTableDataLatency(ms: number): void {
      tableData.setLatency(ms);
      references.setLatency(ms);
    },
    /**
     * Deletes a row of a table open in a table tab as another session would: the next update
     * or delete of it fails the one-row check (`rowNotFound`).
     */
    deleteRowElsewhere: (connectionId: string, table: ObjectRef, key: Value[]): boolean =>
      tableData.deleteRowElsewhere(connectionId, table, key),
    /** Changes a cell of a table open in a table tab as another session would (F-089). */
    changeRowElsewhere: (
      connectionId: string,
      table: ObjectRef,
      key: Value[],
      column: string,
      value: Value,
    ): boolean => tableData.changeRowElsewhere(connectionId, table, key, column, value),
    reset,
  };
}

export type MockBackend = ReturnType<typeof createMockBackend>;

function clientOf(backend: MockBackend): YadbeClient {
  return { commands: backend.commands, events: backend.events };
}

// Pure for the bundler: a production build, which never reads them, leaves the mock out (its
// fixtures were built at every launch, P-01).
export const mockBackend: MockBackend = /* @__PURE__ */ createMockBackend();

export const mockClient: YadbeClient = /* @__PURE__ */ clientOf(mockBackend);

/** Whether `after` changes a setting an open session only picks up when it connects again. */
function needsReconnect(before: ConnectionDefinition, after: ConnectionDefinition): boolean {
  // Key order differs between a seed and a definition built by the form: compare sorted.
  const canonical = (value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : Array.isArray(value)
        ? value.map(canonical)
        : value;
  const sessionPart = (d: ConnectionDefinition) =>
    JSON.stringify(
      canonical({
        ...d,
        name: '',
        groupId: null,
        environment: null,
        favorite: false,
        readOnly: false,
        rememberPassword: false,
        historyEnabled: false,
        statementTimeoutSecs: null,
      }),
    );
  return sessionPart(before) !== sessionPart(after);
}
