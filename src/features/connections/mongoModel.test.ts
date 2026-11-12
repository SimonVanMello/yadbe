import { describe, expect, it } from 'vitest';

import type { ParsedConnectionString } from '../../ipc';
import { mockParseConnectionString } from '../../ipc/mockConnectionString';
import { MOCK_ENGINES } from '../../ipc/mockData';
import { applyParsed, emptyDraft, summarize, toDefinition } from './model';
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
        search: null,
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

describe('a pasted mongodb:// URL (M4-2 bug)', () => {
  const pasted = (url: string) => {
    if (!mongo) throw new Error('mock engine');
    const parsed = mockParseConnectionString(url, null);
    if (!parsed) throw new Error('parses');
    const fields: ParsedConnectionString = { ...parsed.fields, passwordId: null };
    const draft = applyParsed(emptyDraft(mongo), fields, MOCK_ENGINES);
    return { draft, definition: toDefinition(draft, mongo) };
  };
  const summaryOf = (definition: ReturnType<typeof toDefinition>) =>
    summarize({
      id: 'c1',
      definition,
      family: 'document',
      position: 0,
      lastConnectedAt: null,
      createdAt: 0,
      updatedAt: 0,
    }).target;

  it('keeps TLS off without tls=… and splits the one host from its port', () => {
    const { draft, definition } = pasted('mongodb://localhost:57017/?replicaSet=rs0');
    expect(draft.tlsMode).toBe('disable');
    expect(draft.host).toBe('localhost');
    expect(draft.port).toBe('57017');
    expect(definition.tlsMode).toBe('disable');
    expect(summaryOf(definition)).toBe('localhost:57017');
  });

  it('keeps a seed list whole and shows it without the default port', () => {
    const { draft, definition } = pasted('mongodb://a:27018,b/shop?tls=true');
    expect(draft.host).toBe('a:27018,b');
    expect(draft.tlsMode).toBe('verifyFull');
    expect(summaryOf(definition)).toBe('a:27018,b');
  });
});
