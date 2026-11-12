import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from '../../app/actions';
import { translate } from '../../i18n/i18n';
import type { CompletionCatalog } from '../../ipc';
import { blankDefinition } from '../../ipc/mockData';
import type { ConnectionSummary } from '../connections/model';
import { buildObjectItems } from './objectItems';
import { createSearcher } from './matcher';
import { parseQuery, type PaletteItem, type SavedItem } from './paletteItems';
import { buildResults, type PaletteSources, type ResultRow } from './paletteResults';
import { buildActionItems, buildConnectionItems, buildTabItems } from './paletteSources';
import type { ActionContext } from './actionAvailability';

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);

function summarize(id: string, name: string): ConnectionSummary {
  return {
    id,
    name,
    engine: 'postgres',
    family: 'sql',
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
  };
}

const context: ActionContext = {
  queryTab: false,
  connected: false,
  running: false,
  transactionOpen: false,
  tabCount: 1,
  closedTabCount: 0,
  registered: new Set(ACTION_IDS),
};

const catalog: CompletionCatalog = {
  database: 'app',
  schemas: [
    { name: 'public', system: false },
    { name: 'sales', system: false },
  ],
  searchPath: ['public'],
  typeNames: ['int4'],
  relations: [
    { schema: 0, name: 'orders', kind: 'table', columns: ['id'], columnTypes: [0] },
    { schema: 0, name: 'customers', kind: 'table', columns: ['id'], columnTypes: [0] },
    { schema: 1, name: 'orders', kind: 'table', columns: ['id'], columnTypes: [0] },
    { schema: 1, name: 'order_view', kind: 'view', columns: ['id'], columnTypes: [0] },
  ],
  routines: [
    { schema: 0, name: 'order_total', kind: 'function', arguments: 'int4', returnType: 'numeric' },
  ],
  foreignKeys: [],
};

function sources(): PaletteSources {
  const actions = buildActionItems(t, context);
  const connections = buildConnectionItems(
    [summarize('conn-1', 'orders warehouse'), summarize('conn-2', 'billing')],
    () => 'connected',
  );
  const tabs = buildTabItems(
    [
      {
        tab: { id: 't1', connectionId: null, ordinal: 0, pinned: false },
        name: 'New tab',
        connectionName: null,
      },
    ],
    't1',
  );
  const objects = buildObjectItems(
    [{ connectionId: 'conn-1', database: 'app', catalog }],
    new Map([['conn-1', 'orders warehouse']]),
  );
  return {
    actions,
    connections,
    tabs,
    objects,
    history: [],
    saved: [],
    savedTextIds: [],
    searchers: {
      actions: createSearcher(actions),
      connections: createSearcher(connections),
      tabs: createSearcher(tabs),
      objects: createSearcher(objects),
      saved: createSearcher<SavedItem>([]),
    },
  };
}

const items = (rows: ResultRow[]): PaletteItem[] =>
  rows.flatMap((row) => (row.type === 'item' ? [row.item] : []));
const headers = (rows: ResultRow[]) =>
  rows.flatMap((row) => (row.type === 'header' ? [row.key] : []));

describe('parseQuery', () => {
  it('reads a prefix as a mode and the rest as the text', () => {
    expect(parseQuery('>new tab')).toEqual({ mode: 'action', text: 'new tab' });
    expect(parseQuery('  @ sho.ord ')).toEqual({ mode: 'object', text: 'sho.ord' });
    expect(parseQuery('#')).toEqual({ mode: 'tab', text: '' });
    expect(parseQuery('!select 1')).toEqual({ mode: 'history', text: 'select 1' });
    expect(parseQuery(':prod')).toEqual({ mode: 'connection', text: 'prod' });
    expect(parseQuery('orders')).toEqual({ mode: 'all', text: 'orders' });
  });
});

describe('buildActionItems', () => {
  it('lists every action but the palette itself and the tab numbers', () => {
    const ids = buildActionItems(t, context).map((item) => item.id);
    expect(ids).toContain('connection.new');
    expect(ids).toContain('query.commit');
    expect(ids).not.toContain('palette.open');
    expect(ids).not.toContain('tab.select3');
  });

  it('explains why an action cannot run', () => {
    const byId = new Map(buildActionItems(t, context).map((item) => [item.id, item]));
    expect(byId.get('query.run')?.disabledReason).toBe('palette.disabled.noQueryTab');
    expect(byId.get('query.cancel')?.disabledReason).toBe('palette.disabled.notRunning');
    expect(byId.get('tab.reopenClosed')?.disabledReason).toBe('palette.disabled.noClosedTab');
    expect(byId.get('connection.new')?.disabledReason).toBeNull();
    expect(byId.get('connection.new')?.shortcut).toBe('Mod+N');
    expect(byId.get('theme.dark')?.shortcut).toBeNull();
  });
});

describe('buildResults', () => {
  it('lists the recent items first for an empty query, without repeating them below', () => {
    const { rows } = buildResults(sources(), 'all', '', ['connection:conn-2', 'action:tab.new']);
    expect(headers(rows)).toEqual([
      'group:recent',
      'group:action',
      'group:connection',
      'group:tab',
    ]);
    const list = items(rows);
    expect(list[0]?.key).toBe('connection:conn-2');
    expect(list[1]?.key).toBe('action:tab.new');
    expect(list.filter((item) => item.key === 'action:tab.new')).toHaveLength(1);
    // Thousands of objects are not listed until something is typed.
    expect(list.some((item) => item.kind === 'object')).toBe(false);
  });

  it('forgets a recent item that is gone', () => {
    const { rows } = buildResults(sources(), 'all', '', ['connection:deleted']);
    expect(headers(rows)[0]).toBe('group:action');
  });

  it('groups what matches, the group of the best match first', () => {
    const { rows } = buildResults(sources(), 'all', 'orders', []);
    const groups = headers(rows);
    expect(groups[0]).toBe('group:object');
    expect(groups).toContain('group:connection');
    expect(items(rows)[0]).toMatchObject({ kind: 'object', name: 'orders' });
  });

  it('matches a schema-qualified query on the objects', () => {
    const { rows } = buildResults(sources(), 'object', 'sal.ord', []);
    expect(items(rows).map((item) => item.text)).toEqual(['sales.orders', 'sales.order_view']);
  });

  it('lists one kind alone under a prefix, without headings', () => {
    const { rows, total } = buildResults(sources(), 'object', '', []);
    expect(headers(rows)).toEqual([]);
    expect(items(rows).every((item) => item.kind === 'object')).toBe(true);
    expect(total).toBe(5);
  });

  it('moves what was used before up', () => {
    const all = sources();
    const position = (recents: string[]) =>
      items(buildResults(all, 'action', 'tab', recents).rows)
        .map((item) => item.key)
        .indexOf('action:tab.previous');
    expect(position(['action:tab.previous'])).toBeLessThan(position([]));
  });
});
