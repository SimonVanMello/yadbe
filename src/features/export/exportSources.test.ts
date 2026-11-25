import { describe, expect, it } from 'vitest';

import type { CollectionPage, ExportScope, IndexPage } from '../../ipc';
import { collectionExportSource, knownCollectionCount } from '../document/collectionExport';
import { newCollectionTab, type CollectionTabState } from '../document/collectionStore';
import { indexExportSource, knownIndexCount } from '../search/indexExport';
import { newIndexTab, type IndexTabState } from '../search/indexStore';
import {
  exactTotal,
  exportSourceSpec,
  selectableResultOf,
  sourceKey,
  type ExportSource,
} from './exportSources';

const documents = {
  result: {
    resultId: 7,
    statementIndex: 0,
    columns: [],
    rowCount: 100,
    status: 'complete' as const,
    pausedBy: null,
    bytes: 0,
    truncated: false,
  },
  documentsId: 8,
  count: 100,
};

const collectionPage: CollectionPage = {
  documents,
  page: 0,
  hasMore: true,
  keyset: true,
  command: '',
  durationMs: 1,
  ids: [],
};

function collectionTab(patch: Partial<CollectionTabState>): CollectionTabState {
  return { ...newCollectionTab(), phase: 'ready', page: collectionPage, ...patch };
}

const indexPage: IndexPage = {
  documents,
  page: 0,
  hasMore: true,
  total: { value: 10_000, exact: false },
  paging: 'pointInTime',
  window: null,
  request: '',
  tookMs: 1,
  durationMs: 1,
};

function indexTab(patch: Partial<IndexTabState>): IndexTabState {
  return { ...newIndexTab(), phase: 'ready', page: indexPage, ...patch };
}

const info = {
  database: 'shop',
  collection: 'orders',
  kind: 'collection' as const,
  estimatedCount: 1300,
  topology: 'replicaSet' as const,
  capped: false,
};

describe('a collection tab as an export source', () => {
  it('takes the applied query, the page shown and the count the tab knows', () => {
    const applied = { filter: '{"status":"paid"}', projection: '{"a":1}', sort: '{"_id":-1}' };
    const source = collectionExportSource(
      'c1',
      'shop',
      'orders',
      collectionTab({ info, applied, draft: { ...applied, filter: '' }, exactCount: 42 }),
      true,
    );
    expect(source).toEqual({
      kind: 'collection',
      connectionId: 'c1',
      database: 'shop',
      collection: 'orders',
      ...applied,
      count: { value: 42, kind: 'exact' },
      page: { resultId: 7, documentsId: 8 },
      filtered: true,
      pending: true,
    });
  });

  it('counts by estimate only without a filter', () => {
    expect(knownCollectionCount(collectionTab({ info }))).toEqual({
      value: 1300,
      kind: 'estimated',
    });
    const filtered = { filter: '{"a":1}', projection: '', sort: '' };
    expect(knownCollectionCount(collectionTab({ info, applied: filtered }))).toBeNull();
  });
});

describe('an index tab as an export source', () => {
  it('takes the applied query and says what its total is', () => {
    const applied = {
      mode: 'queryString' as const,
      text: 'status:paid',
      source: 'a, -b',
      sortField: 'total',
      descending: true,
    };
    const source = indexExportSource('c2', 'm4-orders', indexTab({ applied }), false);
    expect(source).toMatchObject({
      kind: 'index',
      target: 'm4-orders',
      mode: 'queryString',
      text: 'status:paid',
      source: 'a, -b',
      sort: [{ field: 'total', descending: true }],
      count: { value: 10_000, kind: 'atLeast' },
      filtered: true,
      pending: false,
    });
    expect(knownIndexCount(indexTab({ exactCount: 25_000 }))).toEqual({
      value: 25_000,
      kind: 'exact',
    });
    expect(knownIndexCount(indexTab({ page: null }))).toBeNull();
  });
});

describe('what the backend reads for an export', () => {
  const collection = collectionExportSource(
    'c1',
    'shop',
    'orders',
    collectionTab({ info, exactCount: 1300 }),
    false,
  );
  const index = indexExportSource('c2', 'logs', indexTab({}), false);
  const all: ExportScope = { kind: 'all' };
  const range: ExportScope = { kind: 'range', rowFrom: 2, rowTo: 4, columns: [0] };

  it('reads a whole collection or index under the query, as rows or as documents', () => {
    expect(exportSourceSpec(collection, all, false, 8)).toEqual({
      kind: 'collection',
      connectionId: 'c1',
      database: 'shop',
      collection: 'orders',
      filter: '',
      projection: '',
      sort: '',
      documents: false,
    });
    expect(exportSourceSpec(index, all, true, 8)).toMatchObject({
      kind: 'index',
      target: 'logs',
      documents: true,
    });
    expect(exactTotal(collection, all)).toBe(1300);
    expect(exactTotal(index, all)).toBeNull();
  });

  it('cuts a selection from the page shown: its grid, or its documents', () => {
    expect(exportSourceSpec(collection, range, false, 8)).toEqual({
      kind: 'result',
      resultId: 7,
      scope: range,
    });
    expect(exportSourceSpec(index, range, true, 8)).toEqual({
      kind: 'result',
      resultId: 8,
      scope: range,
    });
    expect(exactTotal(collection, range)).toBeNull();
    expect(selectableResultOf(collection)).toBe(7);
  });

  it('keeps results and tables as they were', () => {
    const result: ExportSource = {
      kind: 'result',
      resultId: 3,
      rowCount: 10,
      status: 'complete',
      pausedBy: null,
      truncated: false,
    };
    expect(exportSourceSpec(result, all, true, 4)).toEqual({
      kind: 'result',
      resultId: 4,
      scope: all,
    });
    expect(exportSourceSpec(result, all, false, 4)).toEqual({
      kind: 'result',
      resultId: 3,
      scope: all,
    });
    const table: ExportSource = {
      kind: 'table',
      tabId: 't',
      filter: { conditions: [], rawWhere: null },
      sort: [],
      pending: false,
    };
    expect(exportSourceSpec(table, all, false, null)).toEqual({
      kind: 'table',
      tabId: 't',
      filter: table.filter,
      sort: [],
    });
    expect(selectableResultOf(table)).toBeNull();
    expect(new Set([result, table, collection, index].map(sourceKey)).size).toBe(4);
  });
});
