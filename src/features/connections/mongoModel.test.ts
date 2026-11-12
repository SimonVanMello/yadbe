import { describe, expect, it } from 'vitest';

import { MOCK_ENGINES } from '../../ipc/mockData';
import { applyParsed, emptyDraft, toDefinition } from './model';
import { emptyMongoDraft, mongoTunnelIssue } from './mongoModel';

const mongo = MOCK_ENGINES.find((info) => info.engine === 'mongodb');

describe('the MongoDB part of the connection form', () => {
  it('saves the MongoDB fields, without a password when there is no user', () => {
    if (!mongo) throw new Error('mock engine');
    const draft = {
      ...emptyDraft(mongo),
      name: 'catalog',
      host: 'db1:27017, db2',
      mongo: { ...emptyMongoDraft(), replicaSet: ' rs0 ', authSource: '' },
    };
    const definition = toDefinition(draft, mongo);
    expect(definition.mongo).toEqual({
      srv: false,
      replicaSet: 'rs0',
      authSource: null,
      authMechanism: 'default',
      directConnection: false,
    });
    expect(definition.auth).toBe('none');
    // `prefer` (a local host's default) means no TLS on MongoDB.
    expect(definition.tlsMode).toBe('disable');
    expect(toDefinition({ ...draft, username: 'app' }, mongo).auth).toBe('password');
    const x509 = {
      ...draft,
      username: 'CN=app',
      mongo: { ...draft.mongo, authMechanism: 'x509' as const },
    };
    expect(toDefinition(x509, mongo).auth).toBe('none');
  });

  it('fills itself from a parsed mongodb+srv string', () => {
    if (!mongo) throw new Error('mock engine');
    const draft = applyParsed(
      emptyDraft(mongo),
      {
        format: 'url',
        engine: 'mongodb',
        host: 'cluster0.example.net',
        port: null,
        database: 'shop',
        username: 'app',
        filePath: null,
        tlsMode: 'verifyFull',
        caCertPath: null,
        options: [],
        passwordId: 'pending-1',
        ignoredKeys: [],
        mongo: {
          srv: true,
          replicaSet: null,
          authSource: 'admin',
          authMechanism: 'default',
          directConnection: false,
        },
      },
      MOCK_ENGINES,
    );
    expect(draft.mongo.srv).toBe(true);
    expect(draft.mongo.authSource).toBe('admin');
    expect(draft.pendingPasswordId).toBe('pending-1');
    expect(draft.password).toBe('');
  });

  it('says why a tunnel cannot carry the connection as it is', () => {
    const plain = emptyMongoDraft();
    expect(mongoTunnelIssue(plain, 'db1')).toBeNull();
    expect(mongoTunnelIssue({ ...plain, srv: true }, 'c.example.net')).toBe('srv');
    expect(mongoTunnelIssue(plain, 'db1,db2')).toBe('hosts');
    expect(mongoTunnelIssue({ ...plain, replicaSet: 'rs0' }, 'db1')).toBe('replicaSet');
    expect(
      mongoTunnelIssue({ ...plain, replicaSet: 'rs0', directConnection: true }, 'db1'),
    ).toBeNull();
  });
});
