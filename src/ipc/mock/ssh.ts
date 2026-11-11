import type {
  ConnectionDefinition,
  KnownHost,
  SecretKind,
  SshHop,
  TunnelFailure,
  TunnelHop,
  TunnelStatus,
  YadbeError,
} from '../bindings';

/**
 * The SSH tunnel part of the mock backend (F-010). Every SSH host's key starts unknown, as with
 * a real server, except the seeded `bastion.example.com:22`; trusting it in the prompt makes the
 * next attempt go through. Failures are chosen by the SSH host:
 * `fail-ssh-dns` → not found, `fail-ssh-refused` → unreachable, `fail-ssh-auth` (or password /
 * passphrase `wrong`) → authentication refused, `changed-hostkey` → a known key changed (always
 * refused), `fail-ssh-channel` → forwarding refused, `fail-ssh-agent` with agent auth → no agent.
 * A key path containing `missing` is unreadable; one containing `encrypted` needs a passphrase.
 */

const DEFAULT_SSH_PORT = 22;

function portOf(hop: SshHop): number {
  return hop.port ?? DEFAULT_SSH_PORT;
}

export function endpointOf(hop: SshHop): string {
  return `${hop.username}@${hop.host}:${String(portOf(hop))}`;
}

export function tunnelStatus(def: ConnectionDefinition, phase: TunnelStatus['phase']) {
  const ssh = def.ssh;
  if (!ssh) return null;
  return {
    phase,
    endpoint: endpointOf(ssh.server),
    jump: ssh.jump ? endpointOf(ssh.jump) : null,
  } satisfies TunnelStatus;
}

/** A fingerprint that looks like OpenSSH's and stays the same for a host. */
export function mockFingerprint(host: string, port: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let seed = 2166136261;
  for (const char of `${host.toLowerCase()}:${String(port)}`) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 43; i += 1) {
    seed = Math.imul(seed ^ (seed >>> 13), 1274126177) >>> 0;
    out += alphabet.charAt(seed % 64);
  }
  return `SHA256:${out}`;
}

const KEY_TYPE = 'ssh-ed25519';

function failure(
  hop: TunnelHop,
  ssh: SshHop | { host: string; port: number },
  extra: Partial<TunnelFailure> = {},
): TunnelFailure {
  const port = 'username' in ssh ? portOf(ssh) : ssh.port;
  return {
    hop,
    host: ssh.host,
    port,
    keyType: null,
    fingerprint: null,
    secret: null,
    ...extra,
  };
}

function hopName(hop: TunnelHop, host: string, port: number): { en: string; fr: string } {
  const at = `${host}:${String(port)}`;
  switch (hop) {
    case 'jump':
      return { en: `the jump host ${at}`, fr: `l'hôte de rebond ${at}` };
    case 'server':
      return { en: `the SSH server ${at}`, fr: `le serveur SSH ${at}` };
    case 'database':
      return { en: at, fr: at };
  }
}

function sshError(
  code: YadbeError['code'],
  en: string,
  fr: string,
  action: YadbeError['action'],
  tunnel: TunnelFailure,
  detail: string | null = null,
): YadbeError {
  return { code, message: { en, fr }, action, detail, tunnel };
}

export const mockSshErrors = {
  notFound: (t: TunnelFailure) => {
    const n = hopName(t.hop, t.host, t.port);
    return sshError(
      'sshHostUnreachable',
      `SSH tunnel: ${n.en} could not be found. Check its name and your network (VPN, DNS).`,
      `Tunnel SSH : ${n.fr} est introuvable. Vérifiez son nom et votre réseau (VPN, DNS).`,
      'editConnection',
      t,
      'failed to lookup address information: Name or service not known',
    );
  },
  unreachable: (t: TunnelFailure) => {
    const n = hopName(t.hop, t.host, t.port);
    return sshError(
      'sshHostUnreachable',
      `SSH tunnel: ${n.en} did not accept the connection. Check that its SSH service runs on this port and that no firewall blocks it.`,
      `Tunnel SSH : ${n.fr} n'a pas accepté la connexion. Vérifiez que son service SSH écoute sur ce port et qu'aucun pare-feu ne le bloque.`,
      'retry',
      t,
      'Connection refused (os error 111)',
    );
  },
  authFailed: (t: TunnelFailure, user: string) => {
    const n = hopName(t.hop, t.host, t.port);
    return sshError(
      'sshAuthFailed',
      `SSH tunnel: ${n.en} refused the authentication of "${user}". Check the user name, the password or key, and that the key is authorized on the server.`,
      `Tunnel SSH : ${n.fr} a refusé l'authentification de « ${user} ». Vérifiez le nom d'utilisateur, le mot de passe ou la clé, et que la clé est autorisée sur le serveur.`,
      t.secret ? 'enterPassword' : 'editConnection',
      t,
    );
  },
  secretRequired: (t: TunnelFailure) => {
    const n = hopName(t.hop, t.host, t.port);
    const passphrase = t.secret === 'sshPassphrase' || t.secret === 'jumpPassphrase';
    return passphrase
      ? sshError(
          'sshSecretRequired',
          `SSH tunnel: the private key for ${n.en} is protected by a passphrase.`,
          `Tunnel SSH : la clé privée pour ${n.fr} est protégée par une phrase de passe.`,
          'enterPassword',
          t,
        )
      : sshError(
          'sshSecretRequired',
          `SSH tunnel: a password is required for ${n.en}.`,
          `Tunnel SSH : un mot de passe est requis pour ${n.fr}.`,
          'enterPassword',
          t,
        );
  },
  hostKeyUnknown: (t: TunnelFailure) => {
    const n = hopName(t.hop, t.host, t.port);
    const key = `${t.keyType ?? ''} ${t.fingerprint ?? ''}`;
    return sshError(
      'sshHostKeyUnknown',
      `SSH tunnel: the host key of ${n.en} is not known yet (${key}). Check this fingerprint with the server's administrator before trusting it.`,
      `Tunnel SSH : la clé d'hôte de ${n.fr} n'est pas encore connue (${key}). Vérifiez cette empreinte auprès de l'administrateur du serveur avant de lui faire confiance.`,
      'trustHostKey',
      t,
    );
  },
  hostKeyChanged: (t: TunnelFailure) => {
    const n = hopName(t.hop, t.host, t.port);
    const key = `${t.keyType ?? ''} ${t.fingerprint ?? ''}`;
    return sshError(
      'sshHostKeyChanged',
      `SSH tunnel: the host key of ${n.en} CHANGED (now ${key}). Someone may be intercepting the connection, or the server was reinstalled. yadbe refuses to connect. Once the administrator confirms the new key, forget the old one in Preferences › SSH known hosts.`,
      `Tunnel SSH : la clé d'hôte de ${n.fr} a CHANGÉ (maintenant ${key}). Quelqu'un intercepte peut-être la connexion, ou le serveur a été réinstallé. yadbe refuse de se connecter. Une fois la nouvelle clé confirmée par l'administrateur, oubliez l'ancienne dans Préférences › Hôtes SSH connus.`,
      null,
      t,
    );
  },
  channelRefused: (server: TunnelFailure, next: TunnelFailure) => {
    const s = hopName(server.hop, server.host, server.port);
    const n = hopName(next.hop, next.host, next.port);
    return sshError(
      'sshChannelRefused',
      `SSH tunnel: ${s.en} refused to forward the connection to ${n.en} (TCP forwarding is disabled for this user, or not allowed to this destination).`,
      `Tunnel SSH : ${s.fr} a refusé de relayer la connexion vers ${n.fr} (le relais TCP est désactivé pour cet utilisateur, ou interdit vers cette destination).`,
      'editConnection',
      next,
      'AdministrativelyProhibited',
    );
  },
  agentUnavailable: (t: TunnelFailure) =>
    sshError(
      'sshAgentUnavailable',
      'SSH tunnel: no SSH agent is reachable, or it holds no key. Start the agent and add your key (ssh-add), or choose another authentication method.',
      'Tunnel SSH : aucun agent SSH n’est joignable, ou il ne contient aucune clé. Démarrez l’agent et ajoutez votre clé (ssh-add), ou choisissez une autre méthode d’authentification.',
      'editConnection',
      t,
      'SSH_AUTH_SOCK is not set',
    ),
  keyUnreadable: (t: TunnelFailure, path: string) =>
    sshError(
      'sshKeyUnreadable',
      `SSH tunnel: the private key "${path}" could not be read, or is not a supported key (OpenSSH or PEM; Ed25519, ECDSA or RSA).`,
      `Tunnel SSH : la clé privée « ${path} » n'a pas pu être lue, ou n'est pas une clé prise en charge (OpenSSH ou PEM ; Ed25519, ECDSA ou RSA).`,
      'editConnection',
      t,
      'No such file or directory (os error 2)',
    ),
  passphraseWrong: (t: TunnelFailure, path: string) =>
    sshError(
      'sshKeyPassphraseWrong',
      `SSH tunnel: the passphrase of the private key "${path}" is wrong.`,
      `Tunnel SSH : la phrase de passe de la clé privée « ${path} » est incorrecte.`,
      'enterPassword',
      t,
    ),
};

function normalizedHost(host: string): string {
  return host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

type SecretLookup = (kind: SecretKind) => string | null;

export function createMockSsh() {
  let known: KnownHost[] = [];

  function seed(): void {
    known = [
      {
        host: 'bastion.example.com',
        port: 22,
        keyType: KEY_TYPE,
        fingerprint: mockFingerprint('bastion.example.com', 22),
        addedAt: 1_760_000_000,
      },
      // The key the mock server presents differs: a changed key.
      {
        host: 'changed-hostkey',
        port: 22,
        keyType: KEY_TYPE,
        fingerprint: 'SHA256:Zm9yZ290dGVuLWtleS1mcm9tLWFub3RoZXItaW5zdGFsbA',
        addedAt: 1_750_000_000,
      },
    ];
  }
  seed();

  function checkHostKey(hop: TunnelHop, ssh: SshHop): YadbeError | null {
    const host = normalizedHost(ssh.host);
    const port = portOf(ssh);
    const fingerprint = mockFingerprint(host, port);
    const entries = known.filter((k) => k.host === host && k.port === port);
    if (entries.some((k) => k.keyType === KEY_TYPE && k.fingerprint === fingerprint)) return null;
    const keyed = failure(hop, ssh, { keyType: KEY_TYPE, fingerprint });
    if (entries.some((k) => k.keyType === KEY_TYPE)) return mockSshErrors.hostKeyChanged(keyed);
    return mockSshErrors.hostKeyUnknown(keyed);
  }

  /** Connect, check the host key, authenticate: the failure of one hop, if any. */
  function checkHop(hop: TunnelHop, ssh: SshHop, secret: SecretLookup): YadbeError | null {
    const host = normalizedHost(ssh.host);
    const base = failure(hop, ssh);
    if (host === 'fail-ssh-dns' || host.endsWith('.invalid')) return mockSshErrors.notFound(base);
    if (host === 'fail-ssh-refused') return mockSshErrors.unreachable(base);
    const hostKey = checkHostKey(hop, ssh);
    if (hostKey) return hostKey;
    const [passwordKind, passphraseKind]: [SecretKind, SecretKind] =
      hop === 'jump' ? ['jumpPassword', 'jumpPassphrase'] : ['sshPassword', 'sshPassphrase'];
    switch (ssh.auth) {
      case 'password': {
        const password = secret(passwordKind);
        if (password === null) {
          return mockSshErrors.secretRequired({ ...base, secret: passwordKind });
        }
        if (host === 'fail-ssh-auth' || password === 'wrong') {
          return mockSshErrors.authFailed({ ...base, secret: passwordKind }, ssh.username);
        }
        return null;
      }
      case 'key': {
        const path = ssh.keyPath ?? '';
        if (path.includes('missing')) return mockSshErrors.keyUnreadable(base, path);
        if (path.includes('encrypted')) {
          const passphrase = secret(passphraseKind);
          if (passphrase === null) {
            return mockSshErrors.secretRequired({ ...base, secret: passphraseKind });
          }
          if (passphrase === 'wrong') {
            return mockSshErrors.passphraseWrong({ ...base, secret: passphraseKind }, path);
          }
        }
        return host === 'fail-ssh-auth' ? mockSshErrors.authFailed(base, ssh.username) : null;
      }
      case 'agent':
        if (host === 'fail-ssh-agent') return mockSshErrors.agentUnavailable(base);
        return host === 'fail-ssh-auth' ? mockSshErrors.authFailed(base, ssh.username) : null;
    }
  }

  return {
    seed,

    /**
     * Opens the tunnel of `def`, hop by hop: the first failure, or `null` when the database is
     * reachable through it. `databasePort`: the engine's port when the definition sets none.
     */
    open(def: ConnectionDefinition, secret: SecretLookup, databasePort: number): YadbeError | null {
      const ssh = def.ssh;
      if (!ssh) return null;
      if (ssh.jump) {
        const jump = checkHop('jump', ssh.jump, secret);
        if (jump) return jump;
      }
      const server = checkHop('server', ssh.server, secret);
      if (server) return server;
      if (normalizedHost(ssh.server.host) === 'fail-ssh-channel') {
        return mockSshErrors.channelRefused(
          failure('server', ssh.server),
          failure('database', { host: def.host, port: def.port ?? databasePort }),
        );
      }
      return null;
    },

    describe(def: ConnectionDefinition, databasePort: number): string | null {
      const ssh = def.ssh;
      if (!ssh) return null;
      const via = ssh.jump ? ` via ${endpointOf(ssh.jump)}` : '';
      return `ssh ${endpointOf(ssh.server)}${via} → ${def.host}:${String(def.port ?? databasePort)}`;
    },

    list(): KnownHost[] {
      return known.map((k) => ({ ...k }));
    },

    trust(
      host: string,
      port: number,
      keyType: string,
      fingerprint: string,
    ): KnownHost | YadbeError {
      const name = normalizedHost(host);
      const clash = known.some(
        (k) =>
          k.host === name &&
          k.port === port &&
          k.keyType === keyType &&
          k.fingerprint !== fingerprint,
      );
      if (clash) {
        return {
          code: 'invalidArgument',
          message: {
            en: 'Another key of this type is already known for this host: forget it first in Preferences › SSH known hosts.',
            fr: 'Une autre clé de ce type est déjà connue pour cet hôte : oubliez-la d’abord dans Préférences › Hôtes SSH connus.',
          },
          action: null,
          detail: null,
        };
      }
      const existing = known.find(
        (k) => k.host === name && k.port === port && k.keyType === keyType,
      );
      if (existing) return { ...existing };
      const entry: KnownHost = {
        host: name,
        port,
        keyType,
        fingerprint,
        addedAt: Math.floor(Date.now() / 1000),
      };
      known = [...known, entry];
      return { ...entry };
    },

    forget(host: string, port: number, keyType: string | null): number {
      const name = normalizedHost(host);
      const before = known.length;
      known = known.filter(
        (k) => !(k.host === name && k.port === port && (keyType === null || k.keyType === keyType)),
      );
      return before - known.length;
    },
  };
}
