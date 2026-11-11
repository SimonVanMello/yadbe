import { describe, expect, it } from 'vitest';

import type { QueryFolder, SavedQuery } from '../../ipc';
import {
  NO_FILTER,
  buildLibraryRows,
  canMoveFolder,
  folderContents,
  folderOptions,
  folderPath,
  isFiltering,
  parseTags,
  suggestName,
  type Library,
} from './libraryModel';

const folder = (id: string, name: string, parentId: string | null = null): QueryFolder => ({
  id,
  name,
  parentId,
  createdAt: 0,
});

const query = (id: string, name: string, patch: Partial<SavedQuery> = {}): SavedQuery => ({
  id,
  folderId: null,
  name,
  sql: 'SELECT 1',
  sqlTruncated: false,
  description: '',
  tags: [],
  connectionId: null,
  database: null,
  snippetTrigger: null,
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  ...patch,
});

const library: Library = {
  folders: [
    folder('reports', 'Reports'),
    folder('monthly', 'Monthly', 'reports'),
    folder('ops', 'Ops'),
    folder('empty', 'Empty'),
  ],
  queries: [
    query('a', 'Zebra'),
    query('b', 'Revenue', { folderId: 'monthly' }),
    query('c', 'Orders', { folderId: 'reports', connectionId: 'pg' }),
    query('d', 'Vacuum', { folderId: 'ops', connectionId: 'lite' }),
    query('e', 'Apple'),
  ],
};

const keys = (rows: { key: string }[]) => rows.map((row) => row.key);

describe('buildLibraryRows', () => {
  it('lists folders before queries, each sorted by name, nested folders under their parent', () => {
    const { rows } = buildLibraryRows(library, new Set(), NO_FILTER);
    expect(keys(rows)).toEqual([
      'f:empty',
      'f:ops',
      'q:d',
      'f:reports',
      'f:monthly',
      'q:b',
      'q:c',
      'q:e',
      'q:a',
    ]);
    expect(rows.map((row) => row.level)).toEqual([1, 1, 2, 1, 2, 3, 2, 1, 1]);
  });

  it('counts the queries below a folder, subfolders included', () => {
    const { rows } = buildLibraryRows(library, new Set(), NO_FILTER);
    const counts = Object.fromEntries(
      rows.flatMap((row) => (row.type === 'folder' ? [[row.folder.id, row.count]] : [])),
    );
    expect(counts).toEqual({ empty: 0, ops: 1, reports: 2, monthly: 1 });
  });

  it('leaves out what a folded folder holds', () => {
    const { rows } = buildLibraryRows(library, new Set(['reports']), NO_FILTER);
    expect(keys(rows)).not.toContain('q:b');
    expect(keys(rows)).not.toContain('f:monthly');
    expect(rows.find((row) => row.key === 'f:reports')).toMatchObject({ expanded: false });
  });

  it('filters by name with a fuzzy match, keeps the folders above the matches open', () => {
    const { rows, matches } = buildLibraryRows(library, new Set(['reports', 'monthly']), {
      ...NO_FILTER,
      text: 'rvn',
    });
    expect(matches).toBe(1);
    expect(keys(rows)).toEqual(['f:reports', 'f:monthly', 'q:b']);
    const match = rows.find((row) => row.type === 'query');
    expect(match?.type === 'query' && match.indices.length).toBe(3);
  });

  it('adds the queries the full-text search found, without name highlights', () => {
    const { rows } = buildLibraryRows(library, new Set(), {
      ...NO_FILTER,
      text: 'something only in a statement',
      textIds: new Set(['d']),
    });
    expect(keys(rows)).toEqual(['f:ops', 'q:d']);
    expect(rows[1]).toMatchObject({ indices: [] });
  });

  it('shows the global queries and the connection’s, hides the folders it empties', () => {
    const { rows } = buildLibraryRows(library, new Set(), { ...NO_FILTER, connectionId: 'pg' });
    expect(keys(rows)).toEqual(['f:reports', 'f:monthly', 'q:b', 'q:c', 'q:e', 'q:a']);
    expect(rows.some((row) => row.key === 'f:ops' || row.key === 'f:empty')).toBe(false);
  });

  it('shows a folder whose parent is unknown at the top instead of losing it', () => {
    const { rows } = buildLibraryRows(
      {
        folders: [folder('x', 'Lost', 'gone')],
        queries: [query('q', 'In lost', { folderId: 'x' })],
      },
      new Set(),
      NO_FILTER,
    );
    expect(keys(rows)).toEqual(['f:x', 'q:q']);
  });

  it('tells whether a filter is active', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_FILTER, text: ' ' })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, text: 'a' })).toBe(true);
    expect(isFiltering({ ...NO_FILTER, connectionId: 'pg' })).toBe(true);
  });
});

describe('folders', () => {
  it('forbids moving a folder into itself or below, allows the top', () => {
    expect(canMoveFolder(library.folders, 'reports', 'monthly')).toBe(false);
    expect(canMoveFolder(library.folders, 'reports', 'reports')).toBe(false);
    expect(canMoveFolder(library.folders, 'reports', 'ops')).toBe(true);
    expect(canMoveFolder(library.folders, 'monthly', null)).toBe(true);
  });

  it('counts what deleting a folder removes', () => {
    expect(folderContents(library, 'reports')).toEqual({ folders: 2, queries: 2 });
    expect(folderContents(library, 'empty')).toEqual({ folders: 1, queries: 0 });
  });

  it('lists folders with their path in tree order, optionally without a subtree', () => {
    expect(folderOptions(library.folders).map((o) => o.label)).toEqual([
      'Empty',
      'Ops',
      'Reports',
      'Reports / Monthly',
    ]);
    expect(
      folderOptions(library.folders, new Set(['reports', 'monthly'])).map((o) => o.id),
    ).toEqual(['empty', 'ops']);
    expect(folderPath(library.folders, 'monthly')).toBe('Reports / Monthly');
    expect(folderPath(library.folders, null)).toBe('');
  });
});

describe('suggestName', () => {
  it('uses the leading line comment', () => {
    expect(suggestName('-- Orders of the week\nSELECT * FROM orders;', 'x')).toBe(
      'Orders of the week',
    );
    expect(suggestName('\n  --- Big one  \n-- second\nSELECT 1', 'x')).toBe('Big one');
  });

  it('uses the first line of a leading block comment', () => {
    expect(suggestName('/*\n * Monthly revenue\n * by country\n */\nSELECT 1', 'x')).toBe(
      'Monthly revenue',
    );
    expect(suggestName('/* One line */ SELECT 1', 'x')).toBe('One line');
  });

  it('falls back to the first line of the statement, without its semicolon', () => {
    expect(suggestName('select  id,\n  name\nfrom users;', 'x')).toBe('select id,');
    expect(suggestName('SELECT 1;', 'x')).toBe('SELECT 1');
  });

  it('cuts a long line and gives the fallback for an empty text', () => {
    const long = `SELECT ${'column_name, '.repeat(20)}1 FROM t`;
    const name = suggestName(long, 'x');
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('…')).toBe(true);
    expect(suggestName('   \n ', 'Untitled')).toBe('Untitled');
    expect(suggestName('-- \n', 'Untitled')).toBe('Untitled');
  });
});

describe('parseTags', () => {
  it('splits, trims and drops empty ones', () => {
    expect(parseTags(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseTags('')).toEqual([]);
  });
});
