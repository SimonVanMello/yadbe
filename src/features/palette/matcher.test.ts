import { describe, expect, it } from 'vitest';

import { createSearcher, normalizeQuery, scoreMatch, searchable, type Searchable } from './matcher';

/** `schema.name` entries, the way the object index builds them. */
function entry(schema: string | null, name: string): Searchable & { name: string } {
  const text = schema === null ? name : `${schema}.${name}`;
  return { ...searchable(text, schema === null ? 0 : schema.length + 1), name };
}

function rank(query: string, texts: string[]): string[] {
  const items = texts.map((text) => searchable(text));
  return createSearcher(items)
    .search(query)
    .hits.map((hit) => hit.item.text);
}

describe('scoreMatch', () => {
  it('matches subsequences, case-insensitively, and reports the matched characters', () => {
    const out: number[] = [];
    expect(scoreMatch(normalizeQuery('PGE'), searchable('pg-eu'), out)).not.toBeNull();
    expect(out).toEqual([0, 1, 3]);
    expect(scoreMatch('xyz', searchable('pg-eu'), null)).toBeNull();
  });

  it('never loses a match to a word boundary that leaves no room for the rest', () => {
    // `a` sits at a boundary only in `_a`, after which there is no `b`.
    expect(scoreMatch('ab', searchable('xab_a'), null)).not.toBeNull();
    expect(scoreMatch('ba', searchable('a'), null)).toBeNull();
    expect(scoreMatch('aa', searchable('a'), null)).toBeNull();
  });

  it('ignores spaces in the query', () => {
    expect(normalizeQuery(' Ord ers ')).toBe('orders');
  });
});

describe('ranking', () => {
  it('prefers prefixes and word boundaries', () => {
    expect(rank('ord', ['work_orders', 'orders', 'order_items', 'recorded'])).toEqual([
      'orders',
      'order_items',
      'work_orders',
      'recorded',
    ]);
  });

  it('prefers consecutive characters, then shorter names', () => {
    expect(rank('pg', ['p-g-x', 'pg-eu-replica', 'pg-eu'])).toEqual([
      'pg-eu',
      'pg-eu-replica',
      'p-g-x',
    ]);
  });

  it('puts the exact name first', () => {
    expect(rank('orders', ['orders_archive', 'orders'])[0]).toBe('orders');
  });

  it('matches a camelCase word start', () => {
    expect(rank('oi', ['orderItems', 'noise'])[0]).toBe('orderItems');
  });

  it('lets a schema-qualified query match schema and name', () => {
    const items = [
      entry('public', 'orders'),
      entry('public', 'customers'),
      entry('pub_archive', 'orders'),
      entry('sales', 'orders'),
      entry('sales', 'public_notes'),
    ];
    const hits = createSearcher(items).search('pub.ord').hits;
    expect(hits.map((hit) => hit.item.text)).toEqual(['public.orders', 'pub_archive.orders']);
    // Highlights: `pub` in the schema, `ord` in the name.
    expect(hits[0]?.indices).toEqual([0, 1, 2, 6, 7, 8, 9]);
  });

  it('ranks a match in the name above one in the schema', () => {
    const items = [entry('orders_archive', 'users'), entry('public', 'orders')];
    expect(
      createSearcher(items)
        .search('ord')
        .hits.map((hit) => hit.item.text),
    ).toEqual(['public.orders', 'orders_archive.users']);
  });

  it('adds the boost to the score', () => {
    const items = [searchable('orders'), searchable('order_items')];
    const first = createSearcher(items).search('ord').hits[0]?.item.text;
    expect(first).toBe('orders');
    const boosted = createSearcher(items).search('ord', 10, (item) =>
      item.text === 'order_items' ? 100 : 0,
    );
    expect(boosted.hits[0]?.item.text).toBe('order_items');
  });
});

describe('createSearcher', () => {
  const items = ['orders', 'order_items', 'customers', 'work_orders', 'products'].map((text) =>
    searchable(text),
  );

  it('lists the first items for an empty query', () => {
    const result = createSearcher(items).search('', 2);
    expect(result.hits.map((hit) => hit.item.text)).toEqual(['orders', 'order_items']);
    expect(result.total).toBe(5);
  });

  it('keeps the best hits and counts every match', () => {
    const result = createSearcher(items).search('o', 2);
    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it('gives the same results typed a key at a time as typed at once', () => {
    const all = Array.from({ length: 400 }, (_, i) =>
      searchable(
        `schema_${String(i % 7)}.table_${String(i).padStart(3, '0')}_${'abcdef'[i % 6] ?? ''}`,
      ),
    );
    const typed = createSearcher(all);
    let incremental = typed.search('');
    for (const query of ['t', 'ta', 'tab', 'tabl', 'table_01', 'table_012']) {
      incremental = typed.search(query);
    }
    const direct = createSearcher(all).search('table_012');
    expect(incremental.hits.map((hit) => hit.item.text)).toEqual(
      direct.hits.map((hit) => hit.item.text),
    );
    expect(incremental.total).toBe(direct.total);
  });

  it('starts over when the query no longer extends the previous one', () => {
    const searcher = createSearcher(items);
    expect(searcher.search('xyz').total).toBe(0);
    expect(searcher.search('ord').total).toBe(3);
    expect(searcher.search('pro').hits[0]?.item.text).toBe('products');
    expect(searcher.search('pr').hits[0]?.item.text).toBe('products');
  });
});
