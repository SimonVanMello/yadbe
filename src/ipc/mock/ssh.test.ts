import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionDefinition, SecretKind, SshHop } from '../bindings';
import { unwrap, YadbeIpcError } from '../result';
import { mockBackend, mockClient } from '../mockClient';
import { blankDefinition } from '../mockData';
import { mockFingerprint } from './ssh';

const { commands } = mockClient;

function hop(host: string, patch: Partial<SshHop> = {}): SshHop {
  return {
    host,
    port: null,
    username: 'deploy',
    auth: 'agent',
    keyPath: null,
    rememberSecret: false,
    ...patch,
  };
}

function definition(server: SshHop, jump: SshHop | null = null): ConnectionDefinition {
  return {
    ...blankDefinition('postgres', 'tunnelled'),
    host: 'db.internal',
    ssh: { server, jump, keepaliveSecs: null },
  };
}

async function test(def: ConnectionDefinition, secrets: [SecretKind, string][] = []) {
  try {
    await unwrap(
      commands.testConnection(
        'r',
        def,
        { kind: 'value', value: 'pw' },
        null,
        secrets.map(([kind, value]) => ({
          kind,
          secret: { kind: 'value', value },
        })),
      ),
    );
    return null;
  } catch (error) {
    if (error instanceof YadbeIpcError) return error.error;
    throw error;
  }
}

beforeEach(() => {
  mockBackend.reset();
  mockBackend.setLatency(0);
});

describe('mock SSH tunnel', () => {
  it('asks to trust an unknown host key once, then goes through', async () => {
    const def = definition(hop('new-bastion'));
    const unknown = await test(def);
    expect(unknown).toMatchObject({ code: 'sshHostKeyUnknown', tunnel: { hop: 'server' } });
    await unwrap(
      commands.trustHostKey('new-bastion', 22, 'ssh-ed25519', mockFingerprint('new-bastion', 22)),
    );
    expect(await test(def)).toBeNull();
    const known = await unwrap(commands.listKnownHosts());
    expect(known.some((k) => k.host === 'new-bastion')).toBe(true);
  });

  it('refuses a changed key until it is forgotten', async () => {
    const def = definition(hop('changed-hostkey'));
    expect(await test(def)).toMatchObject({ code: 'sshHostKeyChanged' });
    expect(await unwrap(commands.forgetHostKey('changed-hostkey', 22, null))).toBe(1);
    expect(await test(def)).toMatchObject({ code: 'sshHostKeyUnknown' });
  });

  it('names the failed hop and the secret to ask for', async () => {
    await unwrap(commands.trustHostKey('jump', 22, 'ssh-ed25519', mockFingerprint('jump', 22)));
    const def = definition(hop('bastion.example.com'), hop('jump', { auth: 'password' }));
    expect(await test(def)).toMatchObject({
      code: 'sshSecretRequired',
      tunnel: { hop: 'jump', secret: 'jumpPassword' },
    });
    expect(await test(def, [['jumpPassword', 'wrong']])).toMatchObject({
      code: 'sshAuthFailed',
      tunnel: { hop: 'jump' },
    });
    expect(await test(def, [['jumpPassword', 'ok']])).toBeNull();
  });

  it('simulates the other failures', async () => {
    const trusted = (host: string) =>
      commands.trustHostKey(host, 22, 'ssh-ed25519', mockFingerprint(host, 22));
    expect(await test(definition(hop('fail-ssh-dns')))).toMatchObject({
      code: 'sshHostUnreachable',
    });
    await trusted('fail-ssh-channel');
    expect(await test(definition(hop('fail-ssh-channel')))).toMatchObject({
      code: 'sshChannelRefused',
      tunnel: { hop: 'database' },
    });
    await trusted('fail-ssh-agent');
    expect(await test(definition(hop('fail-ssh-agent')))).toMatchObject({
      code: 'sshAgentUnavailable',
    });
    const key = (path: string) =>
      definition(hop('bastion.example.com', { auth: 'key', keyPath: path }));
    expect(await test(key('/keys/missing'))).toMatchObject({ code: 'sshKeyUnreadable' });
    expect(await test(key('/keys/encrypted'))).toMatchObject({
      code: 'sshSecretRequired',
      tunnel: { secret: 'sshPassphrase' },
    });
    expect(await test(key('/keys/encrypted'), [['sshPassphrase', 'wrong']])).toMatchObject({
      code: 'sshKeyPassphraseWrong',
    });
  });

  it('reports the tunnel phase in the session and logs the tunnel', async () => {
    const saved = await unwrap(commands.createConnection(definition(hop('bastion.example.com'))));
    await unwrap(
      commands.setConnectionSecret(saved.id, 'password', { kind: 'value', value: 'pw' }, false),
    );
    const info = await unwrap(commands.connect(saved.id, null));
    expect(info.tunnel).toEqual({
      phase: 'open',
      endpoint: 'deploy@bastion.example.com:22',
      jump: null,
    });
    const log = await unwrap(commands.getStatementLog());
    expect(log.some((entry) => entry.sql.startsWith('-- SSH tunnel open: ssh deploy@'))).toBe(true);
  });
});
