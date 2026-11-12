import type {
  ConnectionDefinition,
  ConnectionGroup,
  ConnectionOption,
  ConnectionState as BackendConnectionState,
  EngineInfo,
  Engine,
  EngineFamily,
  EnvironmentKind,
  ParsedConnectionString,
  SavedConnection,
  SecretInput,
  TlsMode,
  TunnelSecretInput,
} from '../../ipc';
import {
  emptySshDraft,
  sshDraftFrom,
  toSshTunnel,
  validateSsh,
  type SshDraft,
  type SshDraftErrors,
} from './sshModel';
import { emptyMongoDraft, mongoDraftFrom, toMongoSettings, type MongoDraft } from './mongoModel';
import {
  emptySearchDraft,
  parseSearchUrl,
  searchDefinition,
  searchDraftFrom,
  searchUrlOf,
  type SearchDraft,
} from './searchModel';

export type { ConnectionGroup, Engine, EngineInfo, EnvironmentKind, TlsMode };

/**
 * What the backend says of `engine` in `engines` (its label, family and capabilities); `undefined`
 * for no engine, or while the list is not loaded. The one place an engine is looked up: the rest
 * of the front branches on what this returns, never on the engine itself.
 */
export function engineInfoOf(
  engines: readonly EngineInfo[] | undefined,
  engine: Engine | null | undefined,
): EngineInfo | undefined {
  return engine == null ? undefined : engines?.find((info) => info.engine === engine);
}

/** What the user sees of a connection: the backend's states, plus "no session" (`disconnected`). */
export type ConnectionState = Exclude<BackendConnectionState, 'closed'> | 'disconnected';

export const TLS_MODES: readonly TlsMode[] = ['disable', 'prefer', 'require', 'verifyFull'];

/** Environment choices of the form (`none` is "no environment"). */
export const ENVIRONMENTS: readonly EnvironmentKind[] = [
  'none',
  'dev',
  'staging',
  'prod',
  'custom',
];

/** What the sidebar, the tabs and the welcome screen show of a saved connection. */
export interface ConnectionSummary {
  id: string;
  name: string;
  engine: Engine;
  /** The engine's family: which query tab, explorer and toolbar the connection gets. */
  family: EngineFamily;
  /** `host:port` or the file name, shown under the name. */
  target: string;
  database: string;
  groupId: string | null;
  /** Order inside its group, from 0. */
  position: number;
  /** `null` when the connection has no environment. */
  environment: Exclude<EnvironmentKind, 'none'> | null;
  /** Name of a `custom` environment. */
  environmentLabel: string | null;
  /** `#rrggbb` of a `custom` environment. */
  environmentColor: string | null;
  readOnly: boolean;
  favorite: boolean;
  /** Unix time in ms of the last successful connection. */
  lastUsedAt: number | null;
  /** The complete definition, to edit one field and save the rest unchanged. */
  definition: ConnectionDefinition;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function summarize(saved: SavedConnection): ConnectionSummary {
  const { definition } = saved;
  const environment = definition.environment.kind;
  return {
    id: saved.id,
    name: definition.name,
    engine: definition.engine,
    family: saved.family,
    target:
      definition.host !== ''
        ? `${definition.host}${definition.port === null ? '' : `:${String(definition.port)}`}`
        : basename(definition.filePath),
    database: definition.host !== '' ? definition.database : '',
    groupId: definition.groupId,
    position: saved.position,
    environment: environment === 'none' ? null : environment,
    environmentLabel: environment === 'custom' ? definition.environment.label : null,
    environmentColor: environment === 'custom' ? definition.environment.color : null,
    readOnly: definition.readOnly,
    favorite: definition.favorite,
    lastUsedAt: saved.lastConnectedAt === null ? null : saved.lastConnectedAt * 1000,
    definition,
  };
}

/**
 * The environment/color of a connection as CSS: the `--env-*` token of a preset, the user's own
 * color for a custom environment, nothing without environment.
 */
export function tintOf(
  connection: Pick<ConnectionSummary, 'environment' | 'environmentColor'>,
): string | null {
  switch (connection.environment) {
    case 'dev':
    case 'staging':
    case 'prod':
      return `var(--env-${connection.environment})`;
    case 'custom':
      return connection.environmentColor;
    case null:
      return null;
  }
}

/**
 * The connection form. Text inputs are strings (the port is converted when saving). The
 * password is write-only: a form for an existing connection starts with it empty and only
 * sends it when the user types one.
 */
export interface ConnectionDraft {
  /** `null` for a new connection. */
  id: string | null;
  name: string;
  engine: Engine;
  host: string;
  port: string;
  database: string;
  username: string;
  /** Path of the database file (file engines). */
  filePath: string;
  /** Typed by the user, sent once, never read back. */
  password: string;
  /** Password the backend holds from a pasted connection string (it never comes back either). */
  pendingPasswordId: string | null;
  rememberPassword: boolean;
  tlsMode: TlsMode;
  /**
   * The TLS mode still follows the host (new connection, mode not chosen by the user nor stated
   * by a pasted string): `verifyFull` for a remote host, `prefer` on this machine (SPEC §9).
   */
  tlsModeAuto: boolean;
  groupId: string | null;
  environment: EnvironmentKind;
  environmentLabel: string;
  /** `#rrggbb` of a custom environment. */
  environmentColor: string | null;
  readOnly: boolean;
  /** Statements run on the connection are recorded in the history (F-104). */
  historyEnabled: boolean;
  favorite: boolean;
  /** SSH tunnel section (F-010); its secrets are write-only too. */
  ssh: SshDraft;
  /** Seconds as typed (F-014); empty: the default (connect, keep-alive) or no limit (statement). */
  connectTimeout: string;
  statementTimeout: string;
  keepAlive: string;
  /** TLS client certificate and key files (F-009); the key's passphrase is write-only. */
  tlsClientCert: string;
  tlsClientKey: string;
  tlsKeyPassphrase: string;
  rememberTlsKeyPassphrase: boolean;
  /** The MongoDB fields (document family). */
  mongo: MongoDraft;
  /** Key-value connections: what separates the levels of the key tree; empty: the preference. */
  keyDelimiter: string;
  /** The search fields (Elasticsearch, OpenSearch): URL and authentication. */
  search: SearchDraft;
  // Not editable in the SQL forms yet (the search form edits it): carried so that saving does
  // not lose it.
  caCertPath: string | null;
  options: ConnectionOption[];
}

/** Whole seconds typed in a field: `null` when empty or not a whole number of 0 or more. */
export function parseSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function emptyDraft(info: EngineInfo): ConnectionDraft {
  const { capabilities } = info;
  return {
    id: null,
    name: '',
    engine: info.engine,
    host: capabilities.usesFile ? '' : 'localhost',
    port: capabilities.defaultPort === null ? '' : String(capabilities.defaultPort),
    database: '',
    username: info.defaultUsername ?? '',
    filePath: '',
    password: '',
    pendingPasswordId: null,
    rememberPassword: true,
    tlsMode: 'prefer',
    tlsModeAuto: true,
    groupId: null,
    environment: 'none',
    environmentLabel: '',
    environmentColor: null,
    readOnly: false,
    historyEnabled: true,
    favorite: false,
    ssh: emptySshDraft(),
    connectTimeout: '',
    statementTimeout: '',
    keepAlive: '',
    tlsClientCert: '',
    tlsClientKey: '',
    tlsKeyPassphrase: '',
    rememberTlsKeyPassphrase: true,
    mongo: emptyMongoDraft(),
    keyDelimiter: '',
    search: emptySearchDraft(),
    caCertPath: null,
    options: [],
  };
}

/** The form of a saved connection, without any secret. */
export function draftFromSaved(saved: SavedConnection): ConnectionDraft {
  const { definition } = saved;
  return {
    id: saved.id,
    name: definition.name,
    engine: definition.engine,
    host: definition.host,
    port: definition.port === null ? '' : String(definition.port),
    database: definition.database,
    username: definition.username,
    filePath: definition.filePath,
    password: '',
    pendingPasswordId: null,
    rememberPassword: definition.rememberPassword,
    tlsMode: definition.tlsMode,
    // A saved connection keeps the mode it was saved with, whatever its host.
    tlsModeAuto: false,
    groupId: definition.groupId,
    environment: definition.environment.kind,
    environmentLabel: definition.environment.label ?? '',
    environmentColor: definition.environment.color,
    readOnly: definition.readOnly,
    historyEnabled: definition.historyEnabled ?? true,
    favorite: definition.favorite,
    ssh: sshDraftFrom(definition.ssh),
    connectTimeout: secondsText(definition.connectTimeoutSecs),
    statementTimeout: secondsText(definition.statementTimeoutSecs ?? null),
    keepAlive: secondsText(definition.keepAliveSecs ?? null),
    tlsClientCert: definition.tlsClientCertPath ?? '',
    tlsClientKey: definition.tlsClientKeyPath ?? '',
    tlsKeyPassphrase: '',
    rememberTlsKeyPassphrase: true,
    mongo: mongoDraftFrom(definition.mongo),
    keyDelimiter: definition.keyValue?.keyDelimiter ?? '',
    search: searchDraftFrom(definition),
    caCertPath: definition.caCertPath,
    options: definition.options,
  };
}

function textOrNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

function secondsText(secs: number | null): string {
  return secs === null ? '' : String(secs);
}

/** Same rule as the backend's `TlsMode::default_for_host` (SPEC §9). */
export function isLocalHost(host: string): boolean {
  const value = host.trim().replace(/^\[/, '').replace(/\]$/, '');
  return (
    value === '' ||
    value.toLowerCase() === 'localhost' ||
    value.startsWith('/') ||
    value === '::1' ||
    value.startsWith('127.')
  );
}

/** The TLS mode a new connection to `host` starts with: certificate checks for a remote host. */
export function defaultTlsMode(host: string): TlsMode {
  return isLocalHost(host) ? 'prefer' : 'verifyFull';
}

/**
 * Applies a change made in the form. Choosing a TLS mode fixes it; changing the host of a draft
 * whose mode still follows the host moves the mode along.
 */
export function patchDraft(
  draft: ConnectionDraft,
  changes: Partial<ConnectionDraft>,
): ConnectionDraft {
  const next = { ...draft, ...changes };
  if (changes.tlsMode !== undefined) return { ...next, tlsModeAuto: false };
  if (changes.host !== undefined && next.tlsModeAuto) {
    return { ...next, tlsMode: defaultTlsMode(next.host) };
  }
  return next;
}

/** Name suggested when the user left the field empty. */
export function suggestedName(draft: ConnectionDraft, info: EngineInfo | undefined): string {
  if (info?.capabilities.usesFile ?? draft.host === '') return basename(draft.filePath.trim());
  const host = draft.host.trim();
  if (!host) return '';
  return draft.database.trim() ? `${draft.database.trim()}@${host}` : host;
}

/** The definition the backend stores. `info` says whether the engine uses a file or a server. */
export function toDefinition(draft: ConnectionDraft, info: EngineInfo): ConnectionDefinition {
  const { capabilities } = info;
  const file = capabilities.usesFile;
  const document = capabilities.family === 'document';
  const port = draft.port.trim();
  // A document server without a user (or authenticated by its certificate) asks no password.
  const passwordless =
    document && (draft.username.trim() === '' || draft.mongo.authMechanism === 'x509');
  const environment = draft.environment;
  // MongoDB has no opportunistic TLS: `prefer` is none.
  const tlsMode = document && draft.tlsMode === 'prefer' ? 'disable' : draft.tlsMode;
  const clientCert =
    info.capabilities.clientCertificate && tlsMode !== 'disable'
      ? textOrNull(draft.tlsClientCert)
      : null;
  return {
    name: draft.name.trim() || suggestedName(draft, info),
    engine: draft.engine,
    host: file ? '' : draft.host.trim(),
    port: file || port === '' ? null : Number(port),
    database: file ? '' : draft.database.trim(),
    username: file ? '' : draft.username.trim(),
    filePath: file ? draft.filePath.trim() : '',
    auth: file || passwordless ? 'none' : 'password',
    tlsMode,
    caCertPath: draft.caCertPath,
    tlsClientCertPath: clientCert,
    tlsClientKeyPath: clientCert === null ? null : textOrNull(draft.tlsClientKey),
    // A file has no connection to time out or keep open: only the statement limit applies.
    connectTimeoutSecs: file ? null : parseSeconds(draft.connectTimeout),
    statementTimeoutSecs: parseSeconds(draft.statementTimeout),
    keepAliveSecs: file ? null : parseSeconds(draft.keepAlive),
    options: draft.options,
    groupId: draft.groupId,
    environment: {
      kind: environment,
      label: environment === 'custom' ? draft.environmentLabel.trim() : null,
      color: environment === 'custom' ? draft.environmentColor : null,
    },
    favorite: draft.favorite,
    readOnly: draft.readOnly,
    rememberPassword: draft.rememberPassword,
    historyEnabled: draft.historyEnabled,
    ssh: file ? null : toSshTunnel(draft.ssh),
    mongo: document ? toMongoSettings(draft.mongo) : null,
    // The family's own settings, only on its connections.
    ...(capabilities.family === 'keyValue'
      ? { keyValue: { keyDelimiter: draft.keyDelimiter === '' ? null : draft.keyDelimiter } }
      : {}),
    // The URL stands for host, port, TLS and path; the user only counts for basic auth.
    ...(capabilities.family === 'search'
      ? {
          ...searchDefinition(draft.search),
          username: draft.search.auth === 'basic' ? draft.username.trim() : '',
        }
      : {}),
  };
}

/** The password the form holds, as the backend takes it: typed, else from a pasted string. */
export function secretOf(draft: ConnectionDraft): SecretInput | null {
  if (draft.password !== '') return { kind: 'value', value: draft.password };
  if (draft.pendingPasswordId !== null) return { kind: 'pending', id: draft.pendingPasswordId };
  return null;
}

/**
 * Switches the engine of a draft: the port follows when it still is the previous engine's
 * default, the user name when it still is the previous engine's, and the fields the new
 * engine does not use are cleared.
 */
export function withEngine(
  draft: ConnectionDraft,
  next: EngineInfo,
  previous: EngineInfo | undefined,
): ConnectionDraft {
  if (next.engine === draft.engine) return draft;
  const from = previous?.capabilities;
  const to = next.capabilities;
  const portIsDefault =
    draft.port === '' || (from?.defaultPort !== null && draft.port === String(from?.defaultPort));
  const userIsDefault = draft.username === '' || draft.username === previous?.defaultUsername;
  const host = to.usesFile ? '' : draft.host === '' ? 'localhost' : draft.host;
  return {
    ...draft,
    engine: next.engine,
    port: to.defaultPort === null ? '' : portIsDefault ? String(to.defaultPort) : draft.port,
    host,
    filePath: to.usesFile ? draft.filePath : '',
    username: to.usesFile ? '' : userIsDefault ? (next.defaultUsername ?? '') : draft.username,
    password: to.usesFile ? '' : draft.password,
    pendingPasswordId: to.usesFile ? null : draft.pendingPasswordId,
    tlsMode: !to.supportsTls ? 'prefer' : draft.tlsModeAuto ? defaultTlsMode(host) : draft.tlsMode,
    ssh: to.usesFile ? { ...draft.ssh, enabled: false } : draft.ssh,
    ...(to.clientCertificate ? {} : { tlsClientCert: '', tlsClientKey: '', tlsKeyPassphrase: '' }),
  };
}

/** The refusals that ask for the passphrase of the TLS client key again. */
export function isTlsKeyError(error: { code: string }): boolean {
  return error.code === 'tlsKeyPassphraseRequired' || error.code === 'tlsKeyPassphraseWrong';
}

/**
 * The TLS key passphrase typed in the form, as the backend takes it for one attempt
 * (a test): empty when none is typed or the connection presents no certificate.
 */
export function tlsSecretsOf(draft: ConnectionDraft, info: EngineInfo): TunnelSecretInput[] {
  const used =
    info.capabilities.clientCertificate &&
    draft.tlsMode !== 'disable' &&
    draft.tlsClientCert.trim() !== '' &&
    draft.tlsKeyPassphrase !== '';
  return used
    ? [{ kind: 'tlsKeyPassphrase', secret: { kind: 'value', value: draft.tlsKeyPassphrase } }]
    : [];
}

/**
 * Fills the form from a parsed connection string (F-006). Only what the string states is
 * replaced; the name, group, environment and the rest of the form stay as the user left them.
 * `engines` resolves the engine the string names, so its defaults apply.
 */
export function applyParsed(
  draft: ConnectionDraft,
  parsed: ParsedConnectionString,
  engines: readonly EngineInfo[],
): ConnectionDraft {
  const previous = engineInfoOf(engines, draft.engine);
  const next = engineInfoOf(engines, parsed.engine ?? draft.engine);
  const base = next ? withEngine(draft, next, previous) : draft;
  const file = next?.capabilities.usesFile ?? false;
  const host = parsed.host ?? base.host;
  const tlsModeAuto = base.tlsModeAuto && parsed.tlsMode === null;
  return {
    ...base,
    host,
    port: file ? '' : parsed.port === null ? base.port : String(parsed.port),
    database: parsed.database ?? base.database,
    username: parsed.username ?? base.username,
    filePath: parsed.filePath ?? base.filePath,
    tlsMode: parsed.tlsMode ?? (tlsModeAuto && !file ? defaultTlsMode(host) : base.tlsMode),
    tlsModeAuto,
    caCertPath: parsed.caCertPath ?? base.caCertPath,
    options: parsed.options.length > 0 ? parsed.options : base.options,
    mongo: parsed.mongo ? mongoDraftFrom(parsed.mongo) : base.mongo,
    search: parsed.search
      ? {
          url: searchUrlOf({
            host,
            port: parsed.port,
            tlsMode: parsed.tlsMode ?? 'disable',
            search: parsed.search,
          }),
          auth: parsed.search.auth ?? 'basic',
          skipVerify: parsed.tlsMode === 'require',
        }
      : base.search,
    // A password in the string is held by the backend; a password typed before is replaced.
    password: parsed.passwordId === null ? base.password : '',
    pendingPasswordId: parsed.passwordId ?? base.pendingPasswordId,
  };
}

/** Whether pasted text looks like a connection string rather than a host name. */
export function looksLikeConnectionString(text: string): boolean {
  const value = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+/i.test(value)) return true;
  if (/^jdbc:[a-z0-9]+:/i.test(value)) return true;
  // ADO.NET style: `Key=value;Key=value`.
  return /^[\w .-]+=[^;]*;[\w .-]+=/.test(value);
}

/** Field-level problems that make the form unsendable. Keys are the field names. */
export type DraftErrors = Partial<
  Record<
    'host' | 'port' | 'filePath' | 'environmentLabel' | 'database' | 'url',
    'required' | 'invalid'
  >
> & { ssh?: SshDraftErrors };

export function validateDraft(draft: ConnectionDraft, info: EngineInfo | undefined): DraftErrors {
  const errors: DraftErrors = {};
  if (info?.capabilities.usesFile ?? false) {
    if (!draft.filePath.trim()) errors.filePath = 'required';
  } else {
    if (!draft.host.trim()) errors.host = 'required';
    if (draft.port.trim() !== '') {
      const port = Number(draft.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'invalid';
    }
  }
  // A key-value database is a numbered index.
  if (info?.capabilities.family === 'keyValue' && !/^\d*$/.test(draft.database.trim())) {
    errors.database = 'invalid';
  }
  // A search connection is one URL: it stands for the host and the port.
  if (info?.capabilities.family === 'search') {
    delete errors.host;
    delete errors.port;
    if (parseSearchUrl(draft.search.url) === null) errors.url = 'invalid';
  }
  if (draft.environment === 'custom' && !draft.environmentLabel.trim()) {
    errors.environmentLabel = 'required';
  }
  const ssh = info?.capabilities.usesFile ? {} : validateSsh(draft.ssh);
  if (Object.keys(ssh).length > 0) errors.ssh = ssh;
  return errors;
}
