import { describe, expect, it } from 'vitest';

import { postgresServer, sqliteFile } from '../../ipc/mock/metaCatalog';
import { MOCK_CONNECTIONS, MOCK_GROUPS } from '../../ipc/mockData';
import { summarize, type ConnectionState } from '../connections/model';
import { nodeKeys } from '../explorer/explorerRows';
import { ROOT_NODE } from '../explorer/explorerStore';
import { catalogSource, POSTGRES, SQLITE } from '../explorer/testSource';
import {
  composeSidebarRows,
  treeShape,
  type SidebarInput,
  type SidebarTreeRow,
} from './sidebarRows';

const PG = 'conn-local-pg';
const LITE = 'conn-app-sqlite';
const connections = MOCK_CONNECTIONS.map(summarize);

const pg = catalogSource('postgres', postgresServer('app_dev', null));
const lite = catalogSource('sqlite', sqliteFile());

function compose(
  overrides: Partial<SidebarInput> & { states?: Record<string, ConnectionState> } = {},
): SidebarTreeRow[] {
  const { states = {}, ...rest } = overrides;
  return composeSidebarRows({
    connections,
    groups: MOCK_GROUPS,
    query: '',
    capabilities: new Map([
      ['postgres', POSTGRES],
      ['sqlite', SQLITE],
    ]),
    stateOf: (id) => states[id] ?? 'disconnected',
    expanded: {},
    showSystem: false,
    sourceFor: (id) => (id === LITE ? lite.source : pg.source),
    ...rest,
  });
}

const describeRow = (row: SidebarTreeRow): string => {
  switch (row.type) {
    case 'group':
      return `group:${row.group.name}`;
    case 'connection':
      return `connection:${row.connection.name}`;
    case 'database':
      return `database:${row.database.name}`;
    case 'schema':
      return `schema:${row.schema.name}`;
    case 'kind':
      return `kind:${row.kind}`;
    case 'object':
      return `object:${row.object.name}`;
    default:
      return row.type;
  }
};

describe('the sidebar rows', () => {
  it('lists folders and connections, closed, when nothing is open', () => {
    const rows = compose();
    expect(rows.map(describeRow)).toEqual([
      'group:Clients',
      'group:ACME',
      'connection:shop · prod',
      'connection:shop · staging',
      'connection:reporting',
      'group:Local',
      'connection:local postgres',
      'connection:wordpress',
      'connection:app.sqlite',
      'connection:auth failure demo',
    ]);
    expect(rows.every((row) => row.type !== 'connection' || !row.expanded)).toBe(true);
  });

  it('puts the explorer of an open connection right under its row, one level deeper', () => {
    const rows = compose({
      states: { [PG]: 'connected' },
      expanded: { [PG]: new Set([ROOT_NODE, nodeKeys.database('app_dev')]) },
    });
    const at = rows.findIndex((row) => row.type === 'connection' && row.connection.id === PG);
    const connection = rows[at];
    expect(connection).toMatchObject({ expanded: true, level: 2 });
    const text = rows.slice(at + 1, at + 4).map(describeRow);
    expect(text).toEqual(['database:analytics_archive', 'database:app_dev', 'schema:analytics']);
    expect(rows[at + 1]?.level).toBe(3);
    expect(rows[at + 3]?.level).toBe(4);
  });

  it('builds no SQL explorer under a connection of another engine family', () => {
    const fresh = catalogSource('postgres', postgresServer('app_dev', null));
    const rows = composeSidebarRows({
      connections: connections.map((connection) =>
        connection.id === PG ? { ...connection, family: 'document' as const } : connection,
      ),
      groups: MOCK_GROUPS,
      query: '',
      capabilities: new Map([['postgres', POSTGRES]]),
      stateOf: (id) => (id === PG ? 'connected' : 'disconnected'),
      expanded: { [PG]: new Set([ROOT_NODE]) },
      showSystem: false,
      sourceFor: () => fresh.source,
    });
    expect(rows.every((row) => row.type === 'group' || row.type === 'connection')).toBe(true);
    expect(fresh.requested).toEqual([]);
  });

  it('shows the kinds directly under a SQLite connection', () => {
    const rows = compose({
      states: { [LITE]: 'connected' },
      expanded: { [LITE]: new Set([ROOT_NODE]) },
    });
    const at = rows.findIndex((row) => row.type === 'connection' && row.connection.id === LITE);
    expect(rows.slice(at + 1, at + 3).map(describeRow)).toEqual(['kind:table', 'kind:view']);
    expect(rows[at + 1]?.level).toBe(2);
  });

  it('shows what is being done while connecting, and nothing once closed', () => {
    const connecting = compose({
      states: { [PG]: 'connecting' },
      expanded: { [PG]: new Set([ROOT_NODE]) },
    });
    const at = connecting.findIndex((row) => row.type === 'connection' && row.connection.id === PG);
    expect(connecting[at + 1]).toMatchObject({ type: 'status', subject: 'connecting' });

    const closed = compose({ expanded: { [PG]: new Set([ROOT_NODE]) } });
    const row = closed.find((r) => r.type === 'connection' && r.connection.id === PG);
    expect(row).toMatchObject({ expanded: false });
    expect(closed.some((r) => r.type === 'database')).toBe(false);
  });

  it('does not ask for anything from a connection that is not up, but shows what it has', () => {
    const { source, requested } = catalogSource('postgres', postgresServer('app_dev', null));
    const rows = compose({
      states: { [PG]: 'lost' },
      expanded: { [PG]: new Set([ROOT_NODE]) },
      sourceFor: () => source,
    });
    expect(requested).toEqual([]);
    expect(rows.some((row) => row.type === 'database')).toBe(true);
  });

  it('is not tied to a folder: a connection folded away takes its explorer with it', () => {
    const folded = MOCK_GROUPS.map((group) =>
      group.id === 'group-local' ? { ...group, collapsed: true } : group,
    );
    const rows = compose({
      groups: folded,
      states: { [PG]: 'connected' },
      expanded: { [PG]: new Set([ROOT_NODE]) },
    });
    expect(rows.some((row) => row.type === 'database')).toBe(false);
  });
});

describe('filtering the sidebar', () => {
  const open = {
    expanded: {
      [PG]: new Set([
        ROOT_NODE,
        nodeKeys.database('app_dev'),
        nodeKeys.schema('app_dev', 'shop'),
        nodeKeys.kind('app_dev', 'shop', 'table'),
      ]),
    },
    states: { [PG]: 'connected' as const },
  };

  it('lists matching connections flat, then the ones that hold a matching node', () => {
    const rows = compose({ ...open, query: 'order' });
    const text = rows.map(describeRow);
    // No connection is called "order": only the open one shows, with its matches' ancestors.
    expect(text[0]).toBe('connection:local postgres');
    expect(text).toEqual(
      expect.arrayContaining([
        'database:app_dev',
        'schema:shop',
        'kind:table',
        'object:Order Notes',
        'object:orders',
      ]),
    );
    expect(text).not.toContain('object:products');
    expect(rows.every((row) => row.type !== 'group')).toBe(true);
    expect(rows[0]).toMatchObject({ type: 'connection', expanded: true });
  });

  it('shows a connection matched by name alone as a single, closed row', () => {
    const rows = compose({ ...open, query: 'sqlite' });
    expect(rows.map(describeRow)).toEqual(['connection:app.sqlite']);
    expect(rows[0]).toMatchObject({ expanded: false });
  });

  it('does not touch the explorer of a connection that is not connected', () => {
    const rows = compose({ query: 'order' });
    expect(rows).toEqual([]);
  });
});

describe('tree shape', () => {
  it('derives parents and sibling positions from the levels', () => {
    const shape = treeShape([
      { level: 1 },
      { level: 2 },
      { level: 3 },
      { level: 3 },
      { level: 2 },
      { level: 1 },
    ]);
    expect(shape.parent).toEqual([-1, 0, 1, 1, 0, -1]);
    expect(shape.posInSet).toEqual([1, 1, 1, 2, 2, 2]);
    expect(shape.setSize).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('handles an empty tree', () => {
    expect(treeShape([])).toEqual({ parent: [], posInSet: [], setSize: [] });
  });
});
