import type {
  SecretKind,
  SecretLocation,
  SshAuthMethod,
  SshHop,
  SshTunnel,
  TunnelHop,
  TunnelSecretInput,
} from '../../ipc';

export const SSH_AUTH_METHODS: readonly SshAuthMethod[] = ['password', 'key', 'agent'];
export const DEFAULT_SSH_PORT = 22;
export const MAX_KEEPALIVE_SECS = 3600;

/** One SSH server of the form. The secret is write-only, like the database password. */
export interface SshHopDraft {
  host: string;
  port: string;
  username: string;
  auth: SshAuthMethod;
  keyPath: string;
  /** Password (`password` auth) or key passphrase (`key` auth), typed; never read back. */
  secret: string;
  rememberSecret: boolean;
}

/** The SSH tunnel section of the connection form (F-010). */
export interface SshDraft {
  enabled: boolean;
  server: SshHopDraft;
  jumpEnabled: boolean;
  jump: SshHopDraft;
  keepaliveSecs: string;
}

/** Where the SSH secrets of the connection being edited are kept. */
export type SshSecretLocations = Partial<Record<SecretKind, SecretLocation>>;

export type SshHopName = Exclude<TunnelHop, 'database'>;

export function emptySshHop(): SshHopDraft {
  return {
    host: '',
    port: '',
    username: '',
    auth: 'key',
    keyPath: '',
    secret: '',
    rememberSecret: true,
  };
}

export function emptySshDraft(): SshDraft {
  return {
    enabled: false,
    server: emptySshHop(),
    jumpEnabled: false,
    jump: emptySshHop(),
    keepaliveSecs: '',
  };
}

function hopDraft(hop: SshHop): SshHopDraft {
  return {
    host: hop.host,
    port: hop.port === null ? '' : String(hop.port),
    username: hop.username,
    auth: hop.auth,
    keyPath: hop.keyPath ?? '',
    secret: '',
    rememberSecret: hop.rememberSecret,
  };
}

/** The form of a saved tunnel, without any secret. */
export function sshDraftFrom(ssh: SshTunnel | null | undefined): SshDraft {
  if (!ssh) return emptySshDraft();
  return {
    enabled: true,
    server: hopDraft(ssh.server),
    jumpEnabled: ssh.jump !== null,
    jump: ssh.jump ? hopDraft(ssh.jump) : emptySshHop(),
    keepaliveSecs: ssh.keepaliveSecs === null ? '' : String(ssh.keepaliveSecs),
  };
}

function toHop(hop: SshHopDraft): SshHop {
  const port = hop.port.trim();
  return {
    host: hop.host.trim(),
    port: port === '' ? null : Number(port),
    username: hop.username.trim(),
    auth: hop.auth,
    keyPath: hop.auth === 'key' ? hop.keyPath.trim() : null,
    rememberSecret: hop.rememberSecret,
  };
}

/** The tunnel the backend stores, `null` when the section is off. */
export function toSshTunnel(draft: SshDraft): SshTunnel | null {
  if (!draft.enabled) return null;
  const keepalive = draft.keepaliveSecs.trim();
  return {
    server: toHop(draft.server),
    jump: draft.jumpEnabled ? toHop(draft.jump) : null,
    keepaliveSecs: keepalive === '' ? null : Number(keepalive),
  };
}

/** The secret kind of a hop for its authentication method (`null`: the agent needs none). */
export function secretKindOf(hop: SshHopName, auth: SshAuthMethod): SecretKind | null {
  switch (auth) {
    case 'password':
      return hop === 'jump' ? 'jumpPassword' : 'sshPassword';
    case 'key':
      return hop === 'jump' ? 'jumpPassphrase' : 'sshPassphrase';
    case 'agent':
      return null;
  }
}

/** Whether a secret kind is a key passphrase (else a password). */
export function isPassphrase(kind: SecretKind): boolean {
  return kind === 'sshPassphrase' || kind === 'jumpPassphrase' || kind === 'tlsKeyPassphrase';
}

export const SSH_SECRET_KINDS: readonly SecretKind[] = [
  'sshPassword',
  'sshPassphrase',
  'jumpPassword',
  'jumpPassphrase',
];

/** The hops of the tunnel the form uses, with their draft. */
export function activeHops(draft: SshDraft): [SshHopName, SshHopDraft][] {
  if (!draft.enabled) return [];
  return draft.jumpEnabled
    ? [
        ['jump', draft.jump],
        ['server', draft.server],
      ]
    : [['server', draft.server]];
}

/** The SSH secrets typed in the form, with whether each goes to the keychain. */
export function typedSshSecrets(
  draft: SshDraft,
): { kind: SecretKind; value: string; remember: boolean }[] {
  return activeHops(draft).flatMap(([name, hop]) => {
    const kind = secretKindOf(name, hop.auth);
    return kind !== null && hop.secret !== ''
      ? [{ kind, value: hop.secret, remember: hop.rememberSecret }]
      : [];
  });
}

/** The typed SSH secrets as the backend takes them for one attempt. */
export function tunnelSecretsOf(draft: SshDraft): TunnelSecretInput[] {
  return typedSshSecrets(draft).map(({ kind, value }) => ({
    kind,
    secret: { kind: 'value', value },
  }));
}

/** Secrets kept in the keychain that the form now says not to remember (or no longer uses). */
export function sshSecretsToForget(draft: SshDraft, stored: SshSecretLocations): SecretKind[] {
  const used = new Map<SecretKind, boolean>();
  for (const [name, hop] of activeHops(draft)) {
    const kind = secretKindOf(name, hop.auth);
    if (kind !== null) used.set(kind, hop.rememberSecret);
  }
  return SSH_SECRET_KINDS.filter((kind) => {
    const location = stored[kind];
    if (location === undefined) return false;
    const remember = used.get(kind);
    // Unused: forgotten wherever it is; not remembered: only the keychain copy goes.
    return remember === undefined || (!remember && location === 'keychain');
  });
}

export type SshErrorKey = 'host' | 'user' | 'key' | 'port' | 'keepalive';
export type SshDraftErrors = Partial<
  Record<`${SshHopName}.${Exclude<SshErrorKey, 'keepalive'>}` | 'keepalive', 'required' | 'invalid'>
>;

function validPort(port: string): boolean {
  if (port.trim() === '') return true;
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function validateSsh(draft: SshDraft): SshDraftErrors {
  const errors: SshDraftErrors = {};
  for (const [name, hop] of activeHops(draft)) {
    if (!hop.host.trim()) errors[`${name}.host`] = 'required';
    if (!hop.username.trim()) errors[`${name}.user`] = 'required';
    if (!validPort(hop.port)) errors[`${name}.port`] = 'invalid';
    if (hop.auth === 'key' && !hop.keyPath.trim()) errors[`${name}.key`] = 'required';
  }
  const keepalive = draft.keepaliveSecs.trim();
  if (draft.enabled && keepalive !== '') {
    const value = Number(keepalive);
    if (!Number.isInteger(value) || value < 0 || value > MAX_KEEPALIVE_SECS) {
      errors.keepalive = 'invalid';
    }
  }
  return errors;
}

/** `user@host:port` of a hop, as the backend names it. */
export function endpointOfHop(hop: SshHop): string {
  return `${hop.username}@${hop.host}:${String(hop.port ?? DEFAULT_SSH_PORT)}`;
}

/** One line for the collapsed section and the tunnel indicators. */
export function describeTunnel(ssh: SshTunnel | null | undefined): string | null {
  if (!ssh) return null;
  const server = endpointOfHop(ssh.server);
  return ssh.jump ? `${endpointOfHop(ssh.jump)} → ${server}` : server;
}
