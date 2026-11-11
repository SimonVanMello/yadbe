import { describe, expect, it } from 'vitest';

import type { SshTunnel } from '../../ipc';
import { hopOutcomes } from './HopTrail';
import {
  describeTunnel,
  emptySshDraft,
  emptySshHop,
  sshDraftFrom,
  sshSecretsToForget,
  toSshTunnel,
  tunnelSecretsOf,
  typedSshSecrets,
  validateSsh,
  type SshDraft,
} from './sshModel';

const tunnel: SshTunnel = {
  server: {
    host: 'bastion',
    port: null,
    username: 'deploy',
    auth: 'key',
    keyPath: '~/.ssh/id_ed25519',
    rememberSecret: true,
  },
  jump: {
    host: 'jump',
    port: 2222,
    username: 'ops',
    auth: 'password',
    keyPath: null,
    rememberSecret: false,
  },
  keepaliveSecs: 15,
};

function draft(patch: Partial<SshDraft> = {}): SshDraft {
  return { ...sshDraftFrom(tunnel), ...patch };
}

describe('SSH draft', () => {
  it('round-trips a saved tunnel without any secret', () => {
    const form = sshDraftFrom(tunnel);
    expect(form.enabled).toBe(true);
    expect(form.server.secret).toBe('');
    expect(form.jump.secret).toBe('');
    expect(toSshTunnel(form)).toEqual(tunnel);
  });

  it('is off without a tunnel and drops the jump host when unchecked', () => {
    expect(toSshTunnel(sshDraftFrom(null))).toBeNull();
    expect(toSshTunnel(draft({ jumpEnabled: false }))?.jump).toBeNull();
  });

  it('sends the typed secrets with the kind of their hop and method', () => {
    const form = draft({
      server: { ...draft().server, secret: 'phrase' },
      jump: { ...draft().jump, secret: 'pw' },
    });
    expect(typedSshSecrets(form)).toEqual([
      { kind: 'jumpPassword', value: 'pw', remember: false },
      { kind: 'sshPassphrase', value: 'phrase', remember: true },
    ]);
    expect(tunnelSecretsOf(form).map((s) => s.kind)).toEqual(['jumpPassword', 'sshPassphrase']);
    const agent = draft({ jumpEnabled: false, server: { ...draft().server, auth: 'agent' } });
    expect(typedSshSecrets({ ...agent, server: { ...agent.server, secret: 'x' } })).toEqual([]);
  });

  it('forgets secrets the form no longer uses, and keychain copies it stops remembering', () => {
    const form = draft({ jump: { ...draft().jump, rememberSecret: false } });
    expect(
      sshSecretsToForget(form, {
        sshPassphrase: 'keychain',
        jumpPassword: 'keychain',
        sshPassword: 'session',
      }),
    ).toEqual(['sshPassword', 'jumpPassword']);
    expect(sshSecretsToForget(emptySshDraft(), { sshPassphrase: 'session' })).toEqual([
      'sshPassphrase',
    ]);
  });

  it('validates the hops in use only', () => {
    expect(validateSsh(emptySshDraft())).toEqual({});
    const bad = draft({
      server: { ...emptySshHop(), port: '70000' },
      keepaliveSecs: '-1',
    });
    expect(validateSsh(bad)).toEqual({
      'server.host': 'required',
      'server.user': 'required',
      'server.port': 'invalid',
      'server.key': 'required',
      keepalive: 'invalid',
    });
    expect(validateSsh(draft())).toEqual({});
  });

  it('describes the route', () => {
    expect(describeTunnel(tunnel)).toBe('ops@jump:2222 → deploy@bastion:22');
    expect(describeTunnel(null)).toBeNull();
  });
});

describe('hopOutcomes', () => {
  it('marks the hops before, at and after the failure', () => {
    expect(hopOutcomes(['jump', 'server', 'database'], 'server')).toEqual([
      ['jump', 'ok'],
      ['server', 'failed'],
      ['database', 'skipped'],
    ]);
    expect(hopOutcomes(['server', 'database'], null)).toEqual([
      ['server', 'ok'],
      ['database', 'ok'],
    ]);
  });
});
