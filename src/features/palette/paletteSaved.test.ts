import { describe, expect, it } from 'vitest';

import type { SavedQuery } from '../../ipc';
import type { Library } from '../library/libraryModel';
import { createSearcher } from './matcher';
import { parseQuery, type PaletteItem, type SavedItem } from './paletteItems';
import { buildResults, type PaletteSources, type ResultRow } from './paletteResults';
import { buildSavedItems } from './paletteSources';

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
  folders: [{ id: 'f', name: 'Reports', parentId: null, createdAt: 0 }],
  queries: [
    query('a', 'Orders of the week', { folderId: 'f', lastUsedAt: 10 }),
    query('b', 'Revenue per month', { lastUsedAt: 30 }),
    query('c', 'Stale customers', { lastUsedAt: 20 }),
    query('d', 'Plain', { snippetTrigger: 'plain' }),
  ],
};

function sources(savedTextIds: readonly string[] = []): PaletteSources {
  const saved = buildSavedItems(library);
  return {
    actions: [],
    connections: [],
    tabs: [],
    objects: [],
    history: [],
    saved,
    savedTextIds,
    searchers: {
      actions: createSearcher([]),
      connections: createSearcher([]),
      tabs: createSearcher([]),
      objects: createSearcher([]),
      saved: createSearcher<SavedItem>(saved),
    },
  };
}

const items = (rows: ResultRow[]): PaletteItem[] =>
  rows.flatMap((row) => (row.type === 'item' ? [row.item] : []));
const names = (rows: ResultRow[]) =>
  items(rows).map((item) => (item.kind === 'saved' ? item.query.name : item.key));

describe('saved queries in the palette (F-120)', () => {
  it('has its own prefix', () => {
    expect(parseQuery('*rev')).toEqual({ mode: 'saved', text: 'rev' });
  });

  it('lists the most recently used first, the rest by name, under the prefix', () => {
    const { rows } = buildResults(sources(), 'saved', '', []);
    expect(names(rows)).toEqual([
      'Revenue per month',
      'Stale customers',
      'Orders of the week',
      'Plain',
    ]);
    // One kind alone needs no heading.
    expect(rows.every((row) => row.type === 'item')).toBe(true);
  });

  it('matches names with the fuzzy matcher, emphasizing the matched characters', () => {
    const { rows } = buildResults(sources(), 'saved', 'rvn', []);
    expect(names(rows)).toEqual(['Revenue per month']);
    const row = rows[0];
    expect(row?.type === 'item' && row.indices.length).toBe(3);
  });

  it('adds what only the text or the tags matched, after the names', () => {
    const { rows, total } = buildResults(sources(['c', 'b']), 'saved', 'rev', []);
    expect(names(rows)).toEqual(['Revenue per month', 'Stale customers']);
    expect(total).toBe(2);
    const row = rows[1];
    expect(row?.type === 'item' && row.indices).toEqual([]);
  });

  it('shows its group among the others once a query is typed, not for an empty one', () => {
    const typed = buildResults(sources(), 'all', 'week', []);
    expect(typed.rows[0]).toMatchObject({ type: 'header', key: 'group:saved' });
    const empty = buildResults(sources(), 'all', '', []);
    expect(empty.rows).toEqual([]);
  });

  it('shows where a saved query lives', () => {
    const [first] = buildSavedItems(library).filter((item) => item.query.id === 'a');
    expect(first?.folder).toBe('Reports');
  });
});
