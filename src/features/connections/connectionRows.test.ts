import { describe, expect, it } from 'vitest';

import { buildSidebarRows, byRecency, searchConnections } from './connectionRows';
import type { ConnectionGroup, ConnectionSummary } from './model';
import { blankDefinition } from '../../ipc/mockData';

function connection(name: string, patch: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: name,
    name,
    engine: 'postgres',
    target: 'localhost:5432',
    database: '',
    groupId: null,
    position: 0,
    environment: null,
    environmentLabel: null,
    environmentColor: null,
    readOnly: false,
    favorite: false,
    lastUsedAt: null,
    definition: blankDefinition('postgres', name),
    ...patch,
  };
}

function group(id: string, patch: Partial<ConnectionGroup> = {}): ConnectionGroup {
  return { id, name: id, parentId: null, position: 0, collapsed: false, ...patch };
}

const all = [
  connection('pg-eu', { groupId: 'prod', environment: 'prod', database: 'shop', position: 0 }),
  connection('pg-us', { groupId: 'prod', environment: 'prod', position: 1 }),
  connection('shop-local', { groupId: 'local', environment: 'dev' }),
  connection('app.sqlite', { engine: 'sqlite', target: 'app.sqlite' }),
];
const groups = [group('prod', { position: 0 }), group('local', { position: 1 })];

describe('searchConnections', () => {
  it('returns everything in the given order for an empty query', () => {
    expect(searchConnections(all, '  ').map((m) => m.connection.name)).toEqual(
      all.map((c) => c.name),
    );
  });

  it('finds by name with the matched characters, best match first', () => {
    const matches = searchConnections(all, 'pgeu');
    expect(matches.map((m) => m.connection.name)).toEqual(['pg-eu']);
    expect(matches[0]?.nameIndices).toEqual([0, 1, 3, 4]);
  });

  it('also finds by database, target and environment', () => {
    expect(searchConnections(all, 'shop').map((m) => m.connection.name)).toContain('pg-eu');
    expect(
      searchConnections(all, 'prod')
        .map((m) => m.connection.name)
        .sort(),
    ).toEqual(['pg-eu', 'pg-us']);
    expect(searchConnections(all, 'sqlite')[0]?.connection.name).toBe('app.sqlite');
  });

  it('finds nothing for an unrelated query', () => {
    expect(searchConnections(all, 'zzzz')).toEqual([]);
  });
});

describe('byRecency', () => {
  it('puts the most recently used first and never used ones last, by name', () => {
    const list = [
      connection('c', { lastUsedAt: null }),
      connection('b', { lastUsedAt: 1_000 }),
      connection('a', { lastUsedAt: null }),
      connection('d', { lastUsedAt: 9_000 }),
    ];
    expect([...list].sort(byRecency).map((c) => c.name)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('buildSidebarRows', () => {
  const label = (rows: ReturnType<typeof buildSidebarRows>) =>
    rows.map((row) =>
      row.kind === 'group'
        ? `${String(row.depth)}[${row.group.name}]`
        : `${String(row.depth)}:${row.connection.name}`,
    );

  it('lists the groups in their order with their connections, then the ungrouped ones', () => {
    expect(label(buildSidebarRows(all, groups, ''))).toEqual([
      '0[prod]',
      '1:pg-eu',
      '1:pg-us',
      '0[local]',
      '1:shop-local',
      '0:app.sqlite',
    ]);
  });

  it('follows the position of the connections inside a group', () => {
    const swapped = [
      connection('pg-eu', { groupId: 'prod', position: 1 }),
      connection('pg-us', { groupId: 'prod', position: 0 }),
    ];
    expect(label(buildSidebarRows(swapped, [group('prod')], ''))).toEqual([
      '0[prod]',
      '1:pg-us',
      '1:pg-eu',
    ]);
  });

  it('nests subgroups and counts their connections in the parent', () => {
    const nested = [group('clients'), group('acme', { parentId: 'clients' })];
    const members = [connection('a', { groupId: 'acme' }), connection('b', { groupId: 'clients' })];
    const rows = buildSidebarRows(members, nested, '');
    expect(label(rows)).toEqual(['0[clients]', '1[acme]', '2:a', '1:b']);
    expect(rows[0]).toMatchObject({ kind: 'group', count: 2 });
    expect(rows[1]).toMatchObject({ kind: 'group', count: 1 });
  });

  it('hides the content of a collapsed group but keeps its count', () => {
    const folded = [group('prod', { collapsed: true }), group('local', { position: 1 })];
    const rows = buildSidebarRows(all, folded, '');
    expect(label(rows)).toEqual(['0[prod]', '0[local]', '1:shop-local', '0:app.sqlite']);
    expect(rows[0]).toMatchObject({ kind: 'group', expanded: false, count: 2 });
  });

  it('shows empty groups', () => {
    const rows = buildSidebarRows([], groups, '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'group', count: 0 });
  });

  it('puts what belongs to an unknown group at the top level', () => {
    const orphan = connection('orphan', { groupId: 'gone' });
    const lost = group('lost', { parentId: 'gone' });
    expect(label(buildSidebarRows([orphan], [lost], ''))).toEqual(['0[lost]', '0:orphan']);
  });

  it('flattens the matches while searching, ignoring collapsed groups', () => {
    const folded = [group('prod', { collapsed: true })];
    expect(label(buildSidebarRows(all, folded, 'pg'))).toEqual(['0:pg-eu', '0:pg-us']);
  });
});
