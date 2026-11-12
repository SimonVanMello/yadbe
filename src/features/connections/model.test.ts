import { describe, expect, it } from 'vitest';

import type { EngineInfo, ParsedConnectionString, SavedConnection } from '../../ipc';
import { MOCK_CONNECTIONS, MOCK_ENGINES, blankDefinition } from '../../ipc/mockData';
import {
  applyParsed,
  defaultTlsMode,
  draftFromSaved,
  emptyDraft,
  looksLikeConnectionString,
  patchDraft,
  secretOf,
  suggestedName,
  summarize,
  tintOf,
  parseSeconds,
  toDefinition,
  validateDraft,
  withEngine,
} from './model';

function engine(name: EngineInfo['engine']): EngineInfo {
  const found = MOCK_ENGINES.find((info) => info.engine === name);
  if (!found) throw new Error(`no mock engine ${name}`);
  return found;
}
const postgres = engine('postgres');
const mssql = engine('mssql');
const sqlite = engine('sqlite');

const NOTHING: ParsedConnectionString = {
  format: 'url',
  engine: null,
  host: null,
  port: null,
  database: null,
  username: null,
  filePath: null,
  tlsMode: null,
  caCertPath: null,
  options: [],
  passwordId: null,
  ignoredKeys: [],
};

describe('withEngine', () => {
  it('moves the port and the user name with the engine while they are still the defaults', () => {
    const draft = withEngine(emptyDraft(postgres), mssql, postgres);
    expect(draft).toMatchObject({ engine: 'mssql', port: '1433', username: 'sa' });
  });

  it('keeps a port and a user the person chose', () => {
    const typed = { ...emptyDraft(postgres), port: '6543', username: 'ana' };
    expect(withEngine(typed, mssql, postgres)).toMatchObject({ port: '6543', username: 'ana' });
  });

  it('clears the server fields for a file database and restores localhost coming back', () => {
    const typed = {
      ...emptyDraft(postgres),
      username: 'ana',
      password: 'secret',
      pendingPasswordId: 'pending-1',
    };
    const file = withEngine(typed, sqlite, postgres);
    expect(file).toMatchObject({
      host: '',
      port: '',
      username: '',
      password: '',
      pendingPasswordId: null,
    });
    expect(withEngine(file, postgres, sqlite)).toMatchObject({ host: 'localhost', port: '5432' });
  });

  it('is the identity for the same engine', () => {
    const draft = emptyDraft(postgres);
    expect(withEngine(draft, postgres, postgres)).toBe(draft);
  });
});

describe('TLS mode of a new connection (SPEC §9)', () => {
  it('is verify-full for a remote host and prefer on this machine', () => {
    expect(defaultTlsMode('localhost')).toBe('prefer');
    expect(defaultTlsMode('127.0.0.1')).toBe('prefer');
    expect(defaultTlsMode('[::1]')).toBe('prefer');
    expect(defaultTlsMode('/var/run/postgresql')).toBe('prefer');
    expect(defaultTlsMode('db.example.com')).toBe('verifyFull');
    expect(defaultTlsMode('10.0.0.5')).toBe('verifyFull');
  });

  it('follows the host while the user has not chosen a mode', () => {
    const draft = emptyDraft(postgres);
    expect(draft.tlsMode).toBe('prefer');
    const remote = patchDraft(draft, { host: 'db.example.com' });
    expect(remote.tlsMode).toBe('verifyFull');
    expect(patchDraft(remote, { host: 'localhost' }).tlsMode).toBe('prefer');
  });

  it('stays as chosen once the user picks a mode', () => {
    const chosen = patchDraft(emptyDraft(postgres), { tlsMode: 'require' });
    expect(patchDraft(chosen, { host: 'db.example.com' })).toMatchObject({
      tlsMode: 'require',
      tlsModeAuto: false,
    });
  });

  it('never changes the mode of a saved connection', () => {
    const saved = draftFromSaved(MOCK_CONNECTIONS[0] as SavedConnection);
    const moved = patchDraft(saved, { host: 'db.example.com' });
    expect(moved.tlsMode).toBe(saved.tlsMode);
  });

  it('follows the host of a pasted string unless the string states a mode', () => {
    const remote = applyParsed(
      emptyDraft(postgres),
      { ...NOTHING, host: 'db.example.com' },
      MOCK_ENGINES,
    );
    expect(remote).toMatchObject({ tlsMode: 'verifyFull', tlsModeAuto: true });
    const stated = applyParsed(
      emptyDraft(postgres),
      { ...NOTHING, host: 'db.example.com', tlsMode: 'disable' },
      MOCK_ENGINES,
    );
    expect(stated).toMatchObject({ tlsMode: 'disable', tlsModeAuto: false });
  });

  it('follows the host when the engine changes', () => {
    const remote = patchDraft(emptyDraft(postgres), { host: 'db.example.com' });
    expect(withEngine(remote, mssql, postgres).tlsMode).toBe('verifyFull');
  });
});

describe('applyParsed', () => {
  it('fills the form from a URL and keeps what the string does not say', () => {
    const draft = { ...emptyDraft(postgres), name: 'Mine', environment: 'prod' as const };
    const filled = applyParsed(
      draft,
      {
        ...NOTHING,
        engine: 'postgres',
        host: 'db.example.com',
        port: 6543,
        database: 'shop',
        username: 'ana',
        tlsMode: 'verifyFull',
        passwordId: 'pending-7',
      },
      MOCK_ENGINES,
    );
    expect(filled).toMatchObject({
      name: 'Mine',
      environment: 'prod',
      host: 'db.example.com',
      port: '6543',
      database: 'shop',
      username: 'ana',
      tlsMode: 'verifyFull',
      pendingPasswordId: 'pending-7',
      password: '',
    });
  });

  it('switches the engine and uses its default port when the string has none', () => {
    const filled = applyParsed(
      emptyDraft(postgres),
      { ...NOTHING, engine: 'mssql', host: 'sql.example.com' },
      MOCK_ENGINES,
    );
    expect(filled).toMatchObject({ engine: 'mssql', host: 'sql.example.com', port: '1433' });
  });

  it('fills the file of a SQLite string and has no port', () => {
    const filled = applyParsed(
      emptyDraft(postgres),
      { ...NOTHING, engine: 'sqlite', filePath: '/data/app.sqlite' },
      MOCK_ENGINES,
    );
    expect(filled).toMatchObject({ engine: 'sqlite', filePath: '/data/app.sqlite', port: '' });
  });

  it('leaves the typed password alone when the string carries none, and replaces it when it does', () => {
    const typed = { ...emptyDraft(postgres), password: 'typed' };
    expect(applyParsed(typed, { ...NOTHING, host: 'h' }, MOCK_ENGINES).password).toBe('typed');
    const replaced = applyParsed(typed, { ...NOTHING, passwordId: 'pending-1' }, MOCK_ENGINES);
    expect(replaced).toMatchObject({ password: '', pendingPasswordId: 'pending-1' });
  });

  it('keeps the options of the form unless the string brings some', () => {
    const draft = { ...emptyDraft(postgres), options: [{ key: 'a', value: '1' }] };
    expect(applyParsed(draft, NOTHING, MOCK_ENGINES).options).toEqual([{ key: 'a', value: '1' }]);
    const filled = applyParsed(
      draft,
      { ...NOTHING, options: [{ key: 'application_name', value: 'x' }] },
      MOCK_ENGINES,
    );
    expect(filled.options).toEqual([{ key: 'application_name', value: 'x' }]);
  });
});

describe('looksLikeConnectionString', () => {
  it.each([
    'postgres://ana:pw@localhost:5432/shop',
    'sqlserver://sa@host?database=x',
    'jdbc:postgresql://localhost/shop',
    'Server=tcp:db.example.com,1433;Database=shop;User Id=sa;Password=x;',
    '  mysql://root@127.0.0.1/app  ',
  ])('recognizes %s', (text) => {
    expect(looksLikeConnectionString(text)).toBe(true);
  });

  it.each(['localhost', 'db.example.com', '192.168.1.5', 'my_database', ''])(
    'does not take %j for one',
    (text) => {
      expect(looksLikeConnectionString(text)).toBe(false);
    },
  );
});

describe('validateDraft', () => {
  it('requires a host for a server and a file for SQLite', () => {
    expect(validateDraft({ ...emptyDraft(postgres), host: ' ' }, postgres)).toEqual({
      host: 'required',
    });
    expect(validateDraft(emptyDraft(sqlite), sqlite)).toEqual({ filePath: 'required' });
    expect(validateDraft({ ...emptyDraft(sqlite), filePath: '/x.db' }, sqlite)).toEqual({});
  });

  it('rejects a port outside 1-65535 but accepts an empty one', () => {
    expect(validateDraft({ ...emptyDraft(postgres), port: '70000' }, postgres)).toEqual({
      port: 'invalid',
    });
    expect(validateDraft({ ...emptyDraft(postgres), port: 'abc' }, postgres)).toEqual({
      port: 'invalid',
    });
    expect(validateDraft({ ...emptyDraft(postgres), port: '' }, postgres)).toEqual({});
  });

  it('requires a label for a custom environment', () => {
    const draft = { ...emptyDraft(postgres), environment: 'custom' as const };
    expect(validateDraft(draft, postgres)).toEqual({ environmentLabel: 'required' });
    expect(validateDraft({ ...draft, environmentLabel: 'QA' }, postgres)).toEqual({});
  });
});

describe('suggestedName', () => {
  it('combines the database and the host, or takes the file name', () => {
    expect(
      suggestedName({ ...emptyDraft(postgres), host: 'pg-eu', database: 'shop' }, postgres),
    ).toBe('shop@pg-eu');
    expect(suggestedName({ ...emptyDraft(postgres), host: 'pg-eu' }, postgres)).toBe('pg-eu');
    expect(suggestedName({ ...emptyDraft(sqlite), filePath: 'C:\\data\\app.sqlite' }, sqlite)).toBe(
      'app.sqlite',
    );
    expect(suggestedName({ ...emptyDraft(postgres), host: '' }, postgres)).toBe('');
  });
});

describe('toDefinition', () => {
  it('sends only what the engine uses and falls back to the suggested name', () => {
    const server = toDefinition(
      {
        ...emptyDraft(postgres),
        host: ' db.example.com ',
        port: '6543',
        database: 'shop',
        filePath: '/stale.db',
      },
      postgres,
    );
    expect(server).toMatchObject({
      name: 'shop@db.example.com',
      host: 'db.example.com',
      port: 6543,
      filePath: '',
      auth: 'password',
    });
    const file = toDefinition(
      { ...emptyDraft(sqlite), filePath: '/data/app.sqlite', host: 'stale', username: 'stale' },
      sqlite,
    );
    expect(file).toMatchObject({
      name: 'app.sqlite',
      host: '',
      port: null,
      username: '',
      filePath: '/data/app.sqlite',
      auth: 'none',
    });
  });

  it('keeps the custom environment label and color, and drops them for a preset', () => {
    const custom = toDefinition(
      {
        ...emptyDraft(postgres),
        environment: 'custom',
        environmentLabel: ' QA ',
        environmentColor: '#8b5cf6',
      },
      postgres,
    );
    expect(custom.environment).toEqual({ kind: 'custom', label: 'QA', color: '#8b5cf6' });
    const prod = toDefinition(
      {
        ...emptyDraft(postgres),
        environment: 'prod',
        environmentLabel: 'x',
        environmentColor: '#fff',
      },
      postgres,
    );
    expect(prod.environment).toEqual({ kind: 'prod', label: null, color: null });
  });

  it('sends the timeouts and the keep-alive as whole seconds, empty meaning the default (F-014)', () => {
    const draft = { ...emptyDraft(postgres), host: 'db', database: 'shop' };
    expect(toDefinition(draft, postgres)).toMatchObject({
      connectTimeoutSecs: null,
      statementTimeoutSecs: null,
      keepAliveSecs: null,
    });
    expect(
      toDefinition(
        { ...draft, connectTimeout: ' 30 ', statementTimeout: '120', keepAlive: '0' },
        postgres,
      ),
    ).toMatchObject({ connectTimeoutSecs: 30, statementTimeoutSecs: 120, keepAliveSecs: 0 });
    // Not a whole number: left out, the backend would refuse it.
    expect(
      toDefinition(
        { ...draft, connectTimeout: '1.5', statementTimeout: '-3', keepAlive: 'x' },
        postgres,
      ),
    ).toMatchObject({ connectTimeoutSecs: null, statementTimeoutSecs: null, keepAliveSecs: null });
    // A file engine has no connection to time out or keep open, only statements to limit.
    expect(
      toDefinition(
        {
          ...emptyDraft(sqlite),
          filePath: '/a.sqlite',
          connectTimeout: '9',
          statementTimeout: '5',
          keepAlive: '9',
        },
        sqlite,
      ),
    ).toMatchObject({ connectTimeoutSecs: null, statementTimeoutSecs: 5, keepAliveSecs: null });
    expect(parseSeconds('')).toBeNull();
    expect(parseSeconds('007')).toBe(7);
  });

  it('shows the saved timeouts back in the form', () => {
    const saved = {
      ...(MOCK_CONNECTIONS[0] as SavedConnection),
    };
    saved.definition = {
      ...saved.definition,
      connectTimeoutSecs: 20,
      statementTimeoutSecs: 90,
      keepAliveSecs: 0,
    };
    expect(draftFromSaved(saved)).toMatchObject({
      connectTimeout: '20',
      statementTimeout: '90',
      keepAlive: '0',
    });
  });

  it('round-trips a saved connection through the form without losing a field', () => {
    for (const saved of MOCK_CONNECTIONS) {
      const info = engine(saved.definition.engine);
      expect(toDefinition(draftFromSaved(saved), info)).toEqual(saved.definition);
    }
  });
});

describe('draftFromSaved', () => {
  it('never carries a secret: the password starts empty', () => {
    const saved = MOCK_CONNECTIONS[0] as SavedConnection;
    expect(draftFromSaved(saved)).toMatchObject({
      id: saved.id,
      password: '',
      pendingPasswordId: null,
    });
  });
});

describe('secretOf', () => {
  it('sends what was typed, else the password held from a pasted string, else nothing', () => {
    const draft = emptyDraft(postgres);
    expect(secretOf(draft)).toBeNull();
    expect(secretOf({ ...draft, pendingPasswordId: 'p1' })).toEqual({ kind: 'pending', id: 'p1' });
    expect(secretOf({ ...draft, password: 'pw', pendingPasswordId: 'p1' })).toEqual({
      kind: 'value',
      value: 'pw',
    });
  });
});

describe('summarize and tintOf', () => {
  const summary = (patch: Partial<ReturnType<typeof blankDefinition>>) =>
    summarize({
      id: 'c',
      definition: { ...blankDefinition('postgres', 'c'), host: 'h', port: 5432, ...patch },
      position: 0,
      createdAt: 0,
      updatedAt: 0,
      lastConnectedAt: 100,
    });

  it('shows host and port, or the file name, and the last use in milliseconds', () => {
    expect(summary({}).target).toBe('h:5432');
    const file = summarize({
      id: 'f',
      definition: { ...blankDefinition('sqlite', 'f'), filePath: '/a/b/app.sqlite' },
      position: 0,
      createdAt: 0,
      updatedAt: 0,
      lastConnectedAt: null,
    });
    expect(file).toMatchObject({ target: 'app.sqlite', database: '', lastUsedAt: null });
    expect(summary({}).lastUsedAt).toBe(100_000);
  });

  it('uses the environment token for a preset, the own color for a custom one, nothing else', () => {
    expect(tintOf(summary({ environment: { kind: 'prod', label: null, color: null } }))).toBe(
      'var(--env-prod)',
    );
    expect(
      tintOf(summary({ environment: { kind: 'custom', label: 'QA', color: '#8b5cf6' } })),
    ).toBe('#8b5cf6');
    expect(tintOf(summary({}))).toBeNull();
  });
});
