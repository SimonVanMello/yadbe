import { describe, expect, it } from 'vitest';

import type { ConnectionDefinition, ConnectionGroup, SavedConnection } from '../bindings';
import { blankDefinition } from '../mockData';
import { createMockConnectionImport } from './connectionImport';

function setup(initial: SavedConnection[] = []) {
  let connections = initial;
  let groups: ConnectionGroup[] = [];
  const disk = new Map<string, string>();
  const secrets = new Map<string, string>();
  const importer = createMockConnectionImport({
    connections: () => connections,
    groups: () => groups,
    createGroup: (name, parentId) => {
      const group = {
        id: `g${String(groups.length + 1)}`,
        name,
        parentId,
        position: 0,
        collapsed: false,
      };
      groups = [...groups, group];
      return group;
    },
    createConnection: (definition: ConnectionDefinition) => {
      const saved: SavedConnection = {
        id: `c${String(connections.length + 1)}`,
        definition,
        family: 'sql',
        position: 0,
        createdAt: 0,
        updatedAt: 0,
        lastConnectedAt: null,
      };
      connections = [...connections, saved];
      return saved;
    },
    storePassword: (id, password) => {
      secrets.set(id, password);
      return 'keychain';
    },
    readFile: (path) => disk.get(path),
    writeFile: (path, text) => disk.set(path, text),
  });
  return { importer, disk, secrets, all: () => connections, allGroups: () => groups };
}

const existing: SavedConnection = {
  id: 'c0',
  family: 'sql',
  definition: {
    ...blankDefinition('postgres', 'local postgres'),
    host: 'localhost',
    database: 'app_dev',
    username: 'postgres',
  },
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  lastConnectedAt: null,
};

describe('the mock connection import', () => {
  it('lists the sources with the file each has on the mock computer', async () => {
    const { importer } = setup();
    const listed = await importer.commands.listConnectionSources();
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') return;
    expect(listed.data.find((s) => s.kind === 'pgpass')).toMatchObject({
      defaultPath: '/home/ana/.pgpass',
      supportsPasswords: true,
    });
    expect(listed.data.find((s) => s.kind === 'ssms')?.defaultPath).toBeNull();
  });

  it('marks a connection that already exists and imports the others with folders and passwords', async () => {
    const { importer, all, allGroups, secrets } = setup([existing]);
    const scan = await importer.commands.scanConnectionSource('pgpass', null);
    expect(scan.status).toBe('ok');
    if (scan.status !== 'ok') return;
    expect(scan.data.connections[0]?.conflict).toMatchObject({
      kind: 'sameTarget',
      existingId: 'c0',
    });
    expect(scan.data.connections[1]?.conflict).toBeNull();
    expect(JSON.stringify(scan.data)).not.toContain('secret');

    const result = await importer.commands.importConnections({
      kind: 'pgpass',
      path: null,
      keys: ['line 1', 'line 2'],
      importPasswords: true,
    });
    expect(result).toMatchObject({ status: 'ok', data: { passwordsStored: 2 } });
    expect(all().map((c) => c.definition.name)).toEqual([
      'local postgres',
      'postgres@localhost/app_dev',
      'analyst@warehouse.example.com:5433/dw',
    ]);
    expect(secrets.size).toBe(2);

    const grouped = await importer.commands.importConnections({
      kind: 'azureDataStudio',
      path: null,
      keys: ['ads-1'],
      importPasswords: false,
    });
    expect(grouped.status).toBe('ok');
    expect(allGroups().map((g) => g.name)).toEqual(['Prod', 'EU']);
    expect(allGroups()[1]?.parentId).toBe(allGroups()[0]?.id);
  });

  it('exports without secrets and reads its own file back', async () => {
    const { importer, disk } = setup([existing]);
    const written = await importer.commands.exportConnections('/home/ana/exports/c.json', []);
    expect(written).toMatchObject({ status: 'ok', data: 1 });
    expect(disk.get('/home/ana/exports/c.json')).toContain('"yadbe-connections"');
    const scan = await importer.commands.scanConnectionSource('yadbe', '/home/ana/exports/c.json');
    expect(scan).toMatchObject({ status: 'ok' });
    if (scan.status !== 'ok') return;
    expect(scan.data.connections).toHaveLength(1);
    expect(scan.data.connections[0]?.conflict?.kind).toBe('sameTarget');
    disk.set('/home/ana/exports/newer.json', '{"format":"yadbe-connections","version":9}');
    expect(
      await importer.commands.scanConnectionSource('yadbe', '/home/ana/exports/newer.json'),
    ).toMatchObject({
      status: 'error',
      error: { code: 'connectionFileInvalid' },
    });
    expect(await importer.commands.exportConnections('relative.json', [])).toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
  });
});
