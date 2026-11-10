import { describe, expect, it } from 'vitest';

import { postgresServer, sqliteFile } from '../../ipc/mock/metaCatalog';
import {
  buildNodes,
  flattenNodes,
  nodeKeys,
  pruneNodes,
  type ExplorerLevels,
  type ExplorerRow,
  type MetaSource,
} from './explorerRows';
import { catalogSource } from './testSource';

const ORDERS = { database: 'app_dev', schema: 'shop', name: 'orders' } as const;

const PG_LEVELS: ExplorerLevels = { databases: true, schemas: true };
const SQLITE_LEVELS: ExplorerLevels = { databases: false, schemas: false };

interface Setup {
  levels?: ExplorerLevels;
  source: MetaSource;
  expanded?: string[];
  showSystem?: boolean;
  exhaustive?: boolean;
  fetching?: boolean;
}

function rows({
  levels = PG_LEVELS,
  source,
  expanded = [],
  showSystem = false,
  exhaustive = false,
  fetching = true,
}: Setup): ExplorerRow[] {
  const open = new Set(expanded);
  const nodes = buildNodes({ levels, showSystem, expanded: open, source, exhaustive }, fetching);
  return flattenNodes(nodes, { connectionId: 'c', level: 2, expanded: open, open: false });
}

/** `type:name` of each row, indented by level, to read a tree at a glance. */
function outline(list: ExplorerRow[]): string[] {
  return list.map((row) => {
    let text: string = row.type;
    if (row.type === 'database') text += `:${row.database.name}`;
    if (row.type === 'schema') text += `:${row.schema.name}`;
    if (row.type === 'kind') text += `:${row.kind}(${String(row.count)})`;
    if (row.type === 'object') text += `:${row.object.name}`;
    if (row.type === 'detailGroup') text += `:${row.group}(${String(row.count)})`;
    if (row.type === 'column') text += `:${row.column.name}`;
    if (row.type === 'status') text += `:${row.status}`;
    return `${'  '.repeat(row.level - 2)}${text}`;
  });
}

const pg = (options?: Parameters<typeof catalogSource>[2]) =>
  catalogSource('postgres', postgresServer('app_dev', null), options);
const sqlite = (options?: Parameters<typeof catalogSource>[2]) =>
  catalogSource('sqlite', sqliteFile(), options);

describe('levels follow the capabilities', () => {
  it('lists the databases of a server, system ones hidden, inaccessible ones disabled', () => {
    const { source } = pg();
    const list = rows({ source });
    expect(outline(list)).toEqual([
      'database:analytics_archive',
      'database:app_dev',
      'database:postgres',
    ]);
    const archive = list[0];
    expect(archive?.type === 'database' && archive.database.accessible).toBe(false);
    expect(archive?.expandable).toBe(false);
    expect(list[1]?.expandable).toBe(true);
  });

  it('goes database → schema → kinds → objects → table details', () => {
    const { source } = pg();
    const list = rows({
      source,
      expanded: [
        nodeKeys.database('app_dev'),
        nodeKeys.schema('app_dev', 'shop'),
        nodeKeys.kind('app_dev', 'shop', 'table'),
        nodeKeys.object('app_dev', 'shop', 'table', 'orders'),
        nodeKeys.group(ORDERS, 'table', 'columns'),
      ],
    });
    const text = outline(list);
    expect(text).toContain('  schema:shop');
    expect(text).toContain('    kind:table(21)');
    expect(text).toContain('      object:orders');
    expect(text).toContain('        detailGroup:columns(10)');
    expect(text).toContain('          column:id');
    // Groups with nothing in them are left out, the columns always stay.
    const groups = list.flatMap((row) => (row.type === 'detailGroup' ? [row.group] : []));
    expect(groups).toEqual(['columns', 'keys', 'foreignKeys', 'indexes', 'triggers']);
    const columns = list.find((row) => row.type === 'detailGroup');
    expect(columns).toMatchObject({ expandable: true, expanded: true, level: 6 });
  });

  it('has no database and no schema level on SQLite: the kinds hang off the connection', () => {
    const { source, requested } = sqlite();
    const list = rows({ levels: SQLITE_LEVELS, source });
    expect(outline(list)[0]).toBe('kind:table(4)');
    expect(list.every((row) => row.level === 2)).toBe(true);
    // `main` is read from the database list, and the objects are asked with `schema: null`.
    expect(requested).toEqual([
      { type: 'databases' },
      { type: 'counts', database: 'main', schema: null },
    ]);
  });

  it('skips the schema level on an engine with several databases but no schemas', () => {
    const { source } = pg();
    const list = rows({
      levels: { databases: true, schemas: false },
      source,
      expanded: [nodeKeys.database('app_dev')],
    });
    const text = outline(list);
    expect(text.slice(0, 3)).toEqual([
      'database:analytics_archive',
      'database:app_dev',
      '  kind:table(0)',
    ]);
  });

  it('opens objects of a kind other than relations without details', () => {
    const { source } = pg();
    const kinds = [
      nodeKeys.database('app_dev'),
      nodeKeys.schema('app_dev', 'shop'),
      nodeKeys.kind('app_dev', 'shop', 'function'),
    ];
    const list = rows({ source, expanded: kinds });
    const fn = list.find((row) => row.type === 'object');
    expect(fn).toMatchObject({ expandable: false, expanded: false });
  });
});

describe('system objects', () => {
  it('hides system schemas and subtracts system objects from the counts', () => {
    const { source } = sqlite();
    const hidden = rows({ levels: SQLITE_LEVELS, source });
    expect(hidden[0]).toMatchObject({ type: 'kind', kind: 'table', count: 4 });
    const shown = rows({ levels: SQLITE_LEVELS, source, showSystem: true });
    expect(shown[0]).toMatchObject({ type: 'kind', kind: 'table', count: 5 });
  });

  it('lists system databases and schemas on demand', () => {
    const { source } = pg();
    const open = [nodeKeys.database('app_dev')];
    expect(outline(rows({ source, expanded: open }))).not.toContain('  schema:pg_catalog');
    const all = outline(rows({ source, expanded: open, showSystem: true }));
    expect(all).toContain('  schema:pg_catalog');
    expect(all).toContain('database:template1');
  });

  it('hides the objects themselves too', () => {
    const { source } = sqlite();
    const kind = [nodeKeys.kind('main', null, 'table')];
    const hidden = outline(rows({ levels: SQLITE_LEVELS, source, expanded: kind }));
    expect(hidden.filter((line) => line.includes('sqlite_sequence'))).toEqual([]);
    const shown = outline(
      rows({ levels: SQLITE_LEVELS, source, expanded: kind, showSystem: true }),
    );
    expect(shown.filter((line) => line.includes('sqlite_sequence'))).toHaveLength(1);
  });
});

describe('lazy loading', () => {
  it('asks for nothing under a collapsed node', () => {
    const { source, requested } = pg();
    rows({ source });
    expect(requested).toEqual([{ type: 'databases' }]);
  });

  it('asks only for the open nodes', () => {
    const { source, requested } = pg();
    rows({
      source,
      expanded: [
        nodeKeys.database('app_dev'),
        nodeKeys.schema('app_dev', 'shop'),
        nodeKeys.kind('app_dev', 'shop', 'view'),
        // Open, but under a node that is closed: not asked for.
        nodeKeys.kind('app_dev', 'sales', 'table'),
      ],
    });
    expect(requested).toEqual([
      { type: 'databases' },
      { type: 'schemas', database: 'app_dev' },
      { type: 'counts', database: 'app_dev', schema: 'shop' },
      { type: 'objects', database: 'app_dev', schema: 'shop', kind: 'view' },
    ]);
  });

  it('does not ask for anything while the connection is not up', () => {
    const { source, requested } = pg();
    const list = rows({ source, expanded: [nodeKeys.database('app_dev')], fetching: false });
    expect(requested).toEqual([]);
    expect(outline(list)).toContain('  schema:shop');
  });

  it('shows a loading row under a node that is on its way', () => {
    const { source } = pg({ loading: (r) => r.type === 'schemas' });
    const list = rows({ source, expanded: [nodeKeys.database('app_dev')] });
    expect(outline(list)).toEqual([
      'database:analytics_archive',
      'database:app_dev',
      '  status:loading',
      'database:postgres',
    ]);
  });

  it('shows the typed error on the node, with the node a retry refreshes', () => {
    const notFound = {
      code: 'objectNotFound' as const,
      message: { en: 'gone', fr: 'disparu' },
      action: null,
      detail: null,
    };
    const { source } = pg({ error: (r) => (r.type === 'table' ? notFound : undefined) });
    const list = rows({
      source,
      expanded: [
        nodeKeys.database('app_dev'),
        nodeKeys.schema('app_dev', 'shop'),
        nodeKeys.kind('app_dev', 'shop', 'table'),
        nodeKeys.object('app_dev', 'shop', 'table', 'orders'),
      ],
    });
    const failed = list.find((row) => row.type === 'status');
    expect(failed).toMatchObject({
      status: 'error',
      error: { code: 'objectNotFound' },
      // The table is gone: the list it was in must be read again, not the table alone.
      refresh: { level: 'objects', database: 'app_dev', schema: 'shop', kind: 'table' },
    });
    const queryFailed = { ...notFound, code: 'queryFailed' as const };
    const other = pg({ error: (r) => (r.type === 'counts' ? queryFailed : undefined) });
    const second = rows({
      source: other.source,
      expanded: [nodeKeys.database('app_dev'), nodeKeys.schema('app_dev', 'shop')],
    });
    expect(second.find((row) => row.type === 'status')).toMatchObject({
      status: 'error',
      refresh: { level: 'schema', database: 'app_dev', schema: 'shop' },
    });
  });

  it('says so when a node has no children', () => {
    const { source } = pg();
    const list = rows({
      source,
      expanded: [nodeKeys.database('postgres'), nodeKeys.schema('postgres', 'public')],
    });
    // `postgres` only holds an empty `public` schema: its kinds all count 0 and cannot open.
    expect(list.find((row) => row.type === 'kind')).toMatchObject({ count: 0, expandable: false });
  });
});

describe('flat rows', () => {
  it('gives every row a unique key and the right expanded state', () => {
    const { source } = pg();
    const list = rows({
      source,
      expanded: [nodeKeys.database('app_dev'), nodeKeys.schema('app_dev', 'shop')],
    });
    expect(new Set(list.map((row) => row.key)).size).toBe(list.length);
    const shop = list.find((row) => row.type === 'schema' && row.schema.name === 'shop');
    const auth = list.find((row) => row.type === 'schema' && row.schema.name === 'auth');
    expect(shop?.expanded).toBe(true);
    expect(auth?.expanded).toBe(false);
  });
});

describe('filter', () => {
  const open = [
    nodeKeys.database('app_dev'),
    nodeKeys.schema('app_dev', 'shop'),
    nodeKeys.kind('app_dev', 'shop', 'table'),
    nodeKeys.object('app_dev', 'shop', 'table', 'orders'),
    nodeKeys.group(ORDERS, 'table', 'columns'),
  ];

  function filtered(query: string, expanded: string[] = open): ExplorerRow[] {
    const { source } = pg();
    const set = new Set(expanded);
    const nodes = buildNodes(
      { levels: PG_LEVELS, showSystem: false, expanded: set, source, exhaustive: true },
      false,
    );
    return flattenNodes(pruneNodes(nodes, query), {
      connectionId: 'c',
      level: 2,
      expanded: set,
      open: true,
    });
  }

  it('keeps the matches with their ancestors, and drops the rest', () => {
    const text = outline(filtered('orders'));
    expect(text).toContain('database:app_dev');
    expect(text).toContain('  schema:shop');
    expect(text).toContain('    kind:table(21)');
    expect(text).toContain('      object:orders');
    expect(text).not.toContain('      object:products');
    expect(text).not.toContain('database:postgres');
  });

  it('looks inside the loaded nodes even where they are collapsed', () => {
    // Nothing is expanded, but what was loaded stays in the cache: `fake` has it all.
    const text = outline(filtered('customer_id', []));
    expect(text).toContain('          column:customer_id');
  });

  it('highlights the matched characters', () => {
    const found = filtered('ord').find(
      (row) => row.type === 'object' && row.object.name === 'orders',
    );
    expect(found?.indices).toEqual([0, 1, 2]);
  });

  it('shows a match with nothing matching under it collapsed', () => {
    // `top_products` matches, its details are not loaded: no open chevron over nothing.
    const found = filtered('products').find(
      (row) => row.type === 'object' && row.object.name === 'top_products',
    );
    expect(found).toMatchObject({ expandable: true, expanded: false });
  });

  it('narrows the previous result as the query grows', () => {
    const { source } = pg();
    const set = new Set(open);
    const whole = buildNodes(
      { levels: PG_LEVELS, showSystem: false, expanded: set, source, exhaustive: true },
      false,
    );
    const options = { connectionId: 'c', level: 2, expanded: set, open: true };
    const fromWhole = flattenNodes(pruneNodes(whole, 'orid'), options);
    const narrowed = flattenNodes(pruneNodes(pruneNodes(whole, 'or'), 'orid'), options);
    expect(narrowed).toEqual(fromWhole);
    expect(fromWhole.length).toBeGreaterThan(0);
  });

  it('shows nothing for a query that matches nothing loaded', () => {
    expect(filtered('zzzz')).toEqual([]);
  });

  it('leaves out the loading and failed rows', () => {
    const { source } = pg({ loading: (r) => r.type === 'schemas' });
    const set = new Set([nodeKeys.database('app_dev')]);
    const nodes = buildNodes(
      { levels: PG_LEVELS, showSystem: false, expanded: set, source, exhaustive: true },
      true,
    );
    expect(pruneNodes(nodes, 'app')).toHaveLength(1);
    expect(
      flattenNodes(pruneNodes(nodes, 'app'), {
        connectionId: 'c',
        level: 2,
        expanded: set,
        open: true,
      }),
    ).toHaveLength(1);
  });
});
