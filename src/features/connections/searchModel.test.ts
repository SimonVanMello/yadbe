import { describe, expect, it } from 'vitest';

import { MOCK_ENGINES } from '../../ipc/mockData';
import { applyParsed, emptyDraft, toDefinition, validateDraft } from './model';
import { parseSearchUrl, searchDraftFrom, searchUrlOf } from './searchModel';

const search = MOCK_ENGINES.find((info) => info.engine === 'elasticsearch');

describe('search connection model', () => {
  it('reads a URL into host, port, TLS and path', () => {
    expect(parseSearchUrl('https://search.example.com:9243/es/')).toEqual({
      https: true,
      host: 'search.example.com',
      port: 9243,
      pathPrefix: '/es',
      credentials: false,
    });
    expect(parseSearchUrl('http://[::1]')).toMatchObject({ host: '::1', port: 80 });
    expect(parseSearchUrl('https://elastic:pw@h')?.credentials).toBe(true);
    expect(parseSearchUrl('localhost:9200')).toBeNull();
    expect(parseSearchUrl('ftp://h')).toBeNull();
  });

  it('turns the form into a definition and back', () => {
    if (!search) throw new Error('mock engine');
    const draft = {
      ...emptyDraft(search),
      name: 'logs',
      username: 'elastic',
      search: { url: 'https://es.example.com:9200/api', auth: 'basic' as const, skipVerify: true },
    };
    const definition = toDefinition(draft, search);
    expect(definition).toMatchObject({
      host: 'es.example.com',
      port: 9200,
      tlsMode: 'require',
      database: '',
      auth: 'password',
      username: 'elastic',
      search: { auth: 'basic', pathPrefix: '/api' },
    });
    expect(searchUrlOf(definition)).toBe('https://es.example.com:9200/api');
    expect(searchDraftFrom(definition)).toEqual(draft.search);
    // An API key has no user; no authentication asks no secret.
    const apiKey = toDefinition({ ...draft, search: { ...draft.search, auth: 'apiKey' } }, search);
    expect(apiKey.username).toBe('');
    const none = toDefinition({ ...draft, search: { ...draft.search, auth: 'none' } }, search);
    expect(none.auth).toBe('none');
  });

  it('flags an invalid URL, not the host and port it replaces', () => {
    if (!search) throw new Error('mock engine');
    const draft = { ...emptyDraft(search), host: '', search: { ...emptyDraft(search).search } };
    expect(validateDraft(draft, search)).toEqual({});
    const bad = { ...draft, search: { ...draft.search, url: 'nope' } };
    expect(validateDraft(bad, search)).toEqual({ url: 'invalid' });
  });

  it('fills itself from a parsed http URL', () => {
    if (!search) throw new Error('mock engine');
    const draft = applyParsed(
      emptyDraft(search),
      {
        format: 'url',
        engine: 'elasticsearch',
        host: 'es.internal',
        port: 443,
        database: null,
        username: 'elastic',
        filePath: null,
        tlsMode: 'verifyFull',
        caCertPath: null,
        options: [],
        passwordId: 'pending-1',
        ignoredKeys: [],
        mongo: null,
        search: { auth: 'basic', pathPrefix: '/es' },
      },
      MOCK_ENGINES,
    );
    expect(draft.search).toEqual({
      url: 'https://es.internal/es',
      auth: 'basic',
      skipVerify: false,
    });
    expect(draft.pendingPasswordId).toBe('pending-1');
    expect(draft.password).toBe('');
  });
});
