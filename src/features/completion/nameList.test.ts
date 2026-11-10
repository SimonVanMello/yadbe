import { describe, expect, it } from 'vitest';

import { matchScore, NameList } from './nameList';

const score = (name: string, typed: string) =>
  matchScore(name, name.toLowerCase(), typed.toLowerCase());

describe('matchScore', () => {
  it('ranks a prefix above a word start above scattered letters', () => {
    const prefix = score('order_items', 'ord');
    const word = score('customer_orders', 'ord');
    const fuzzy = score('product_stock', 'prk');
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it('does not match when the letters are not in order', () => {
    expect(score('orders', 'sro')).toBe(0);
    expect(score('orders', 'xyz')).toBe(0);
  });

  it('puts shorter names first among equals', () => {
    expect(score('orders', 'ord')).toBeGreaterThan(score('order_items', 'ord'));
  });

  it('prefers an exact match', () => {
    expect(score('id', 'id')).toBeGreaterThan(score('id_card', 'id'));
  });

  it('finds the start of a camelCase word', () => {
    const camel = score('createdAt', 'at');
    const fuzzy = score('boat', 'at');
    expect(camel).toBeGreaterThan(fuzzy);
  });

  it('finds the start of a word after a separator, the earlier the better', () => {
    expect(score('a_items', 'it')).toBeGreaterThan(score('a_b_c_d_items', 'it'));
  });

  it('matches everything when nothing is typed', () => {
    expect(score('anything', '')).toBeGreaterThan(0);
  });

  it('prefers fewer skipped letters among scattered matches', () => {
    expect(score('order_items', 'oiems')).toBeGreaterThan(0);
    expect(score('oixxxxxxxxtems', 'oitems')).toBeLessThan(score('oi_tems', 'oitems'));
  });
});

describe('NameList', () => {
  const list = new NameList(
    ['orders', 'order_items', 'Order Notes', 'customer_orders', 'customers', 'ord', 'products'].map(
      (name, id) => ({ name, id }),
    ),
  );

  it('is sorted for prefix lookups, case-insensitively', () => {
    expect(list.lowers).toEqual([...list.lowers].sort());
    expect(list.size).toBe(7);
  });

  it('finds the prefix matches first, shortest first', () => {
    expect(list.search('ord', 10).map((r) => r.name)).toEqual([
      'ord',
      'orders',
      'order_items',
      'Order Notes',
      'customer_orders',
    ]);
  });

  it('is not case sensitive, but prefers the case typed', () => {
    const names = list.search('Order', 10).map((r) => r.name);
    expect(names.slice(0, 3)).toEqual(['Order Notes', 'orders', 'order_items']);
    expect(list.search('ORD', 10).map((r) => r.name)).toContain('orders');
  });

  it('keeps the id it was given', () => {
    const found = list.search('products', 5)[0];
    expect(found).toMatchObject({ name: 'products', id: 6 });
  });

  it('stops at the limit, and does not scan past enough prefix matches', () => {
    expect(list.search('o', 2).map((r) => r.name)).toEqual(['ord', 'orders']);
  });

  it('lists the first names when nothing is typed', () => {
    expect(list.search('', 3)).toHaveLength(3);
    expect(list.search('', 100)).toHaveLength(7);
  });

  it('finds nothing for an unrelated query', () => {
    expect(list.search('zzz', 5)).toEqual([]);
  });

  it('falls back to word starts and scattered letters', () => {
    const names = list.search('cust', 10).map((r) => r.name);
    expect(names).toEqual(['customers', 'customer_orders']);
    expect(list.search('oi', 10).map((r) => r.name)[0]).toBe('order_items');
  });
});
