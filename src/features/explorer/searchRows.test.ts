import { describe, expect, it } from 'vitest';

import type { SearchIndexDetails, SearchIndexInfo } from '../../ipc';
import { flattenNodes, pruneNodes, type Loadable } from './explorerRows';
import { buildSearchNodes, searchKeys, searchNodeOf, type SearchSource } from './searchRows';

const ready = <T>(data: T): Loadable<T> => ({ state: 'ready', data });

function index(name: string, system = false): SearchIndexInfo {
  return {
    name,
    health: 'green',
    open: true,
    docs: 10,
    sizeBytes: 2048,
    primaries: 1,
    replicas: 0,
    system,
  };
}

const DETAILS: SearchIndexDetails = {
  fields: [
    { path: 'customer.name', typeName: 'keyword', sortable: true, multiField: false },
    { path: 'notes', typeName: 'text', sortable: false, multiField: false },
  ],
  settings: [{ key: 'index.number_of_shards', value: '1' }],
  maxResultWindow: 10_000,
};

const source: SearchSource = {
  indices: () => ready([index('orders'), index('.kibana_1', true)]),
  dataStreams: () => ready([]),
  aliases: () => ({ state: 'loading' }),
  templates: () => ({ state: 'idle' }),
  details: () => ready(DETAILS),
};

function rows(expanded: string[], showSystem = false, filter = '') {
  const context = { source, expanded: new Set(expanded), showSystem };
  const nodes = buildSearchNodes({ ...context, exhaustive: filter !== '' }, true);
  const shown = filter === '' ? nodes : pruneNodes(nodes, filter);
  return flattenNodes(shown, {
    connectionId: 'c',
    level: 2,
    expanded: context.expanded,
    open: filter !== '',
  }).map((row) => {
    switch (row.type) {
      case 'searchGroup':
        return `${row.group}:${String(row.count)}`;
      case 'searchIndex':
        return `index:${row.index.name}`;
      case 'searchDetails':
        return `${row.detail}:${String(row.count)}`;
      case 'searchField':
        return `field:${row.field.path}`;
      case 'status':
        return `status:${row.status}`;
      default:
        return row.type;
    }
  });
}

describe('the search explorer', () => {
  it('lists its four groups with what they hold, system indices behind the toggle', () => {
    expect(rows([])).toEqual(['indices:1', 'dataStreams:0', 'aliases:null', 'templates:null']);
    expect(rows([searchKeys.group('indices')])).toEqual([
      'indices:1',
      'index:orders',
      'dataStreams:0',
      'aliases:null',
      'templates:null',
    ]);
    expect(rows([searchKeys.group('indices')], true)).toContain('index:.kibana_1');
    expect(rows([searchKeys.group('aliases')])).toContain('status:loading');
  });

  it('opens an index on its fields and settings, and filters by field path', () => {
    const opened = rows([
      searchKeys.group('indices'),
      searchKeys.target('index', 'orders'),
      searchKeys.details('index', 'orders', 'fields'),
    ]);
    expect(opened).toEqual([
      'indices:1',
      'index:orders',
      'fields:2',
      'field:customer.name',
      'field:notes',
      'settings:1',
      'dataStreams:0',
      'aliases:null',
      'templates:null',
    ]);
    expect(rows([searchKeys.group('indices')], false, 'custname')).toEqual([
      'indices:1',
      'index:orders',
      'fields:2',
      'field:customer.name',
    ]);
  });

  it('refreshes an index where its details are cached', () => {
    expect(searchNodeOf({ type: 'searchIndex', index: index('orders') })).toEqual({
      level: 'table',
      table: { database: '', schema: null, name: 'orders' },
    });
    expect(searchNodeOf({ type: 'searchGroup', group: 'indices', count: 1 })).toEqual({
      level: 'connection',
    });
  });
});
