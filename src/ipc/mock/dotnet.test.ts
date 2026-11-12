import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionDefinition, Engine } from '../bindings';
import { blankDefinition } from '../mockData';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap, YadbeIpcError } from '../result';
import { adoValue, buildConnectionString, csharpString, parseMigrationId } from './dotnet';

const { commands } = mockClient;

function definition(
  engine: Engine,
  patch: Partial<ConnectionDefinition> = {},
): ConnectionDefinition {
  return {
    ...blankDefinition(engine, 'shop'),
    host: 'db.example.com',
    port: 6543,
    database: 'shop',
    username: 'app',
    tlsMode: 'verifyFull',
    ...patch,
  };
}

// The same cases as `db::dotnet` in Rust: the mock writes what the backend writes.
describe('mock connection strings', () => {
  it('writes each provider without the password', () => {
    const ado = (engine: Engine) => buildConnectionString(definition(engine), 'adoNet', null).text;
    expect(ado('postgres')).toBe(
      'Host=db.example.com;Port=6543;Database=shop;Username=app;SSL Mode=VerifyFull',
    );
    expect(ado('mssql')).toBe(
      'Server=db.example.com,6543;Database=shop;User Id=app;Encrypt=True;TrustServerCertificate=False',
    );
    expect(ado('mysql')).toBe(
      'Server=db.example.com;Port=6543;Database=shop;User ID=app;SSL Mode=VerifyFull',
    );
    expect(
      buildConnectionString(
        definition('sqlite', { filePath: '/data/my app.db', readOnly: true }),
        'adoNet',
        null,
      ).text,
    ).toBe('Data Source=/data/my app.db;Mode=ReadOnly');
  });

  it('includes and quotes the password only when given', () => {
    const copy = buildConnectionString(definition('postgres'), 'adoNet', 'p;w="x\'');
    expect(copy.includesPassword).toBe(true);
    expect(copy.text).toContain('Password="p;w=""x\'";SSL Mode');
    const without = buildConnectionString(definition('postgres'), 'adoNet', null);
    expect(without.includesPassword).toBe(false);
    expect(without.notes).toContain('passwordLeftOut');
  });

  it('wraps the string in the EF Core provider call', () => {
    const ef = (engine: Engine) => buildConnectionString(definition(engine), 'efCore', null).text;
    expect(ef('postgres')).toMatch(
      /^var connectionString = ".*";\noptions\.UseNpgsql\(connectionString\);$/,
    );
    expect(ef('mssql')).toMatch(/options\.UseSqlServer\(connectionString\);$/);
    expect(ef('mysql')).toMatch(
      /options\.UseMySql\(connectionString, ServerVersion\.AutoDetect\(connectionString\)\);$/,
    );
    expect(ef('sqlite')).toMatch(/options\.UseSqlite\(connectionString\);$/);
  });

  it('notes what a string cannot say', () => {
    const copy = buildConnectionString(
      definition('mysql', {
        readOnly: true,
        options: [{ key: 'init_command', value: 'SET x=1' }],
        ssh: {
          server: {
            host: 'bastion',
            port: null,
            username: 'me',
            auth: 'agent',
            keyPath: null,
            rememberSecret: false,
          },
          jump: null,
          keepaliveSecs: null,
        },
      }),
      'adoNet',
      null,
    );
    expect(copy.notes).toEqual([
      'sshTunnel',
      'optionsNotExpressed',
      'readOnlyNotExpressed',
      'passwordLeftOut',
    ]);
  });

  it('quotes like the providers do', () => {
    expect(adoValue('plain')).toBe('plain');
    expect(adoValue('a;b')).toBe('"a;b"');
    expect(adoValue('say "hi"')).toBe('\'say "hi"\'');
    expect(csharpString('tab\there \\ "q"')).toBe('"tab\\there \\\\ \\"q\\""');
  });
});

describe('mock migrations', () => {
  it('splits the timestamp from the name like the backend', () => {
    expect(parseMigrationId('20231105134530_AddOrders')).toEqual({
      timestamp: '2023-11-05 13:45:30',
      name: 'AddOrders',
    });
    for (const id of ['Initial', '00000000000000_Seed', '20231305134530_Bad']) {
      expect(parseMigrationId(id)).toEqual({ timestamp: null, name: id });
    }
  });
});

describe('mock dotnet commands', () => {
  beforeEach(async () => {
    mockBackend.reset();
    mockBackend.setLatency(0);
    mockBackend.setMetaLatency(0);
    await unwrap(commands.connect('conn-local-pg', null));
  });

  it('reads the history of a history table and nothing else', async () => {
    const table = { database: 'app_dev', schema: 'public', name: '__EFMigrationsHistory' };
    const history = await unwrap(commands.getEfMigrations(null, 'conn-local-pg', table));
    expect(history.migrations.length).toBeGreaterThan(3);
    expect(history.migrations[0]?.name).toBe('InitialCreate');
    expect(history.migrations[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} /);
    await expect(
      unwrap(commands.getEfMigrations(null, 'conn-local-pg', { ...table, name: 'orders' })),
    ).rejects.toBeInstanceOf(YadbeIpcError);
  });

  it('copies a connection, with the password only when it is stored and asked for', async () => {
    const plain = await unwrap(commands.copyConnectionString('conn-local-pg', 'adoNet', false));
    expect(plain.text).not.toContain('Password');
    // The mock seeds a remembered password for this connection.
    const withPassword = await unwrap(
      commands.copyConnectionString('conn-shop-prod', 'adoNet', true),
    );
    expect(withPassword.includesPassword).toBe(true);
    await expect(
      unwrap(commands.copyConnectionString('conn-reporting', 'adoNet', true)),
    ).rejects.toMatchObject({ error: { code: 'passwordRequired' } });
  });
});
