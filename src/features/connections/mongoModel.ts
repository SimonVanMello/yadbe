import type { MongoAuthMechanism, MongoSettings, TlsMode } from '../../ipc';

/** The MongoDB part of the connection form (document family). */
export interface MongoDraft {
  /** `mongodb+srv://`: the host is a DNS name that lists the servers. */
  srv: boolean;
  replicaSet: string;
  authSource: string;
  authMechanism: MongoAuthMechanism;
  directConnection: boolean;
}

export const MONGO_AUTH_MECHANISMS: readonly MongoAuthMechanism[] = [
  'default',
  'scramSha256',
  'scramSha1',
  'x509',
];

/** The TLS modes of a MongoDB connection: it has no opportunistic TLS (`prefer`). */
export const MONGO_TLS_MODES: readonly TlsMode[] = ['disable', 'require', 'verifyFull'];

export function emptyMongoDraft(): MongoDraft {
  return {
    srv: false,
    replicaSet: '',
    authSource: '',
    authMechanism: 'default',
    directConnection: false,
  };
}

export function mongoDraftFrom(settings: MongoSettings | null | undefined): MongoDraft {
  return {
    srv: settings?.srv ?? false,
    replicaSet: settings?.replicaSet ?? '',
    authSource: settings?.authSource ?? '',
    authMechanism: settings?.authMechanism ?? 'default',
    directConnection: settings?.directConnection ?? false,
  };
}

export function toMongoSettings(draft: MongoDraft): MongoSettings {
  const text = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    srv: draft.srv,
    replicaSet: text(draft.replicaSet),
    authSource: text(draft.authSource),
    authMechanism: draft.authMechanism,
    directConnection: draft.directConnection,
  };
}

/** The hosts of a seed list (`a:27017, b`). */
export function seedHosts(hosts: string): string[] {
  return hosts
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');
}

/**
 * Why an SSH tunnel cannot carry this connection as it is, or `null`: a tunnel reaches one host,
 * so yadbe connects to it directly; an SRV name or a list of hosts cannot go through it, and a
 * replica set is then reached through the one member given only.
 */
export function mongoTunnelIssue(
  draft: MongoDraft,
  hosts: string,
): 'srv' | 'hosts' | 'replicaSet' | null {
  if (draft.srv) return 'srv';
  if (seedHosts(hosts).length > 1) return 'hosts';
  if (draft.replicaSet.trim() !== '' && !draft.directConnection) return 'replicaSet';
  return null;
}
