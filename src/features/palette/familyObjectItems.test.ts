import { describe, expect, it } from 'vitest';

import { collectionItems, searchItems } from './familyObjectItems';

describe('family object items', () => {
  it('lists the collections of a database, without the system ones', () => {
    const items = collectionItems('c1', 'Mongo', 'shop', [
      { name: 'orders', kind: 'collection', system: false, capped: false, viewOn: null },
      { name: 'system.views', kind: 'collection', system: true, capped: false, viewOn: null },
    ]);
    expect(items.map((item) => [item.text, item.database, item.family?.type])).toEqual([
      ['orders', 'shop', 'collection'],
    ]);
    expect(items[0]?.lower).toBe('orders');
  });

  it('lists indices, data streams and aliases, hiding dot names', () => {
    const items = searchItems('c2', 'ES', {
      indices: [
        { name: 'orders', system: false },
        { name: '.kibana', system: false },
        { name: 'hidden', system: true },
      ],
      dataStreams: [{ name: 'logs-app', system: false }],
      aliases: [{ name: 'orders-live', system: false }],
    });
    expect(items.map((item) => [item.text, item.family?.type])).toEqual([
      ['orders', 'index'],
      ['logs-app', 'dataStream'],
      ['orders-live', 'alias'],
    ]);
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
  });
});
