import { describe, expect, it } from 'vitest';

import type { EngineInfo } from '../../ipc';
import { MOCK_ENGINES } from '../../ipc/mockData';
import type { MessageKey, MessageParams } from '../../i18n/i18n';
import {
  advancedSummary,
  environmentSummary,
  hasTlsSection,
  tlsSummary,
} from './connectionSections';
import { emptyDraft, patchDraft, type ConnectionDraft } from './model';

function engine(name: EngineInfo['engine']): EngineInfo {
  const found = MOCK_ENGINES.find((info) => info.engine === name);
  if (!found) throw new Error(`no mock engine ${name}`);
  return found;
}

/** The key and its parameters, so that a summary reads without a catalog. */
const t = (key: MessageKey, params?: MessageParams) =>
  params ? `${key}(${Object.values(params).join(',')})` : key;

const postgres = engine('postgres');
const sqlite = engine('sqlite');
const mongodb = engine('mongodb');
const redis = engine('redis');
const search = engine('elasticsearch');

describe('tlsSummary', () => {
  it('says the mode, unmarked while it is the default for the host', () => {
    expect(tlsSummary(emptyDraft(postgres), postgres, t)).toEqual({
      text: 'connection.tls.prefer',
      modified: false,
    });
    const remote = patchDraft(emptyDraft(postgres), { host: 'db.example.com' });
    expect(tlsSummary(remote, postgres, t)).toEqual({
      text: 'connection.tls.verifyFull',
      modified: false,
    });
  });

  it('marks a weaker mode than the default and a client certificate', () => {
    const draft: ConnectionDraft = {
      ...emptyDraft(postgres),
      host: 'db.example.com',
      tlsMode: 'require',
      tlsClientCert: '/certs/client.crt',
    };
    expect(tlsSummary(draft, postgres, t)).toEqual({
      text: 'connection.tls.require · connection.section.clientCert',
      modified: true,
    });
  });

  it('reads `prefer` as no TLS for MongoDB and Redis', () => {
    expect(tlsSummary(emptyDraft(mongodb), mongodb, t).text).toBe('connection.tls.disable');
    expect(tlsSummary(emptyDraft(redis), redis, t).modified).toBe(false);
  });

  it('describes the certificate checks of an https search URL', () => {
    const draft: ConnectionDraft = {
      ...emptyDraft(search),
      search: { url: 'https://search.example.com:9200', auth: 'basic', skipVerify: true },
      caCertPath: '/certs/ca.crt',
    };
    expect(tlsSummary(draft, search, t)).toEqual({
      text: 'connection.section.noVerify · connection.section.caFile',
      modified: true,
    });
  });
});

describe('hasTlsSection', () => {
  it('has none for a file or a plain http search URL', () => {
    expect(hasTlsSection(emptyDraft(sqlite), sqlite)).toBe(false);
    expect(hasTlsSection(emptyDraft(search), search)).toBe(false);
    const https = {
      ...emptyDraft(search),
      search: { url: 'https://localhost:9200', auth: 'basic' as const, skipVerify: false },
    };
    expect(hasTlsSection(https, search)).toBe(true);
    expect(hasTlsSection(emptyDraft(postgres), postgres)).toBe(true);
  });
});

describe('environmentSummary', () => {
  it('says there is none by default', () => {
    expect(environmentSummary(emptyDraft(postgres), t)).toEqual({
      text: 'connection.section.noEnvironment',
      modified: false,
      details: [],
    });
  });

  it('names the environment and the switches turned', () => {
    const draft: ConnectionDraft = {
      ...emptyDraft(postgres),
      environment: 'custom',
      environmentLabel: ' QA ',
      readOnly: true,
      historyEnabled: false,
    };
    expect(environmentSummary(draft, t)).toEqual({
      text: 'QA · connection.section.readOnly · connection.section.noHistory',
      modified: true,
      details: ['connection.section.readOnly', 'connection.section.noHistory'],
    });
  });
});

describe('advancedSummary', () => {
  it('says the defaults apply when nothing was set', () => {
    expect(advancedSummary(emptyDraft(postgres), postgres, t)).toEqual({
      text: 'connection.section.defaults',
      modified: false,
    });
  });

  it('lists the timeouts set, a statement limit of 0 being the default', () => {
    const draft = {
      ...emptyDraft(postgres),
      connectTimeout: '20',
      statementTimeout: '0',
      keepAlive: '0',
    };
    expect(advancedSummary(draft, postgres, t).text).toBe(
      'connection.section.connectTimeout(20) · connection.section.keepAlive(0)',
    );
    // A file has no connection to time out: only the statement limit counts.
    const file = { ...emptyDraft(sqlite), connectTimeout: '20', statementTimeout: '30' };
    expect(advancedSummary(file, sqlite, t).text).toBe('connection.section.statementTimeout(30)');
  });

  it('lists the MongoDB options and the key delimiter', () => {
    const mongo: ConnectionDraft = {
      ...emptyDraft(mongodb),
      mongo: {
        srv: true,
        replicaSet: 'rs0',
        authSource: 'admin',
        authMechanism: 'x509',
        directConnection: true,
      },
    };
    expect(advancedSummary(mongo, mongodb, t)).toEqual({
      text: 'connection.section.srv · connection.section.replicaSet(rs0) · mongo.mechanism.x509',
      modified: true,
    });
    const kv = { ...emptyDraft(redis), keyDelimiter: '::' };
    expect(advancedSummary(kv, redis, t).text).toBe('connection.section.delimiter(::)');
  });
});
