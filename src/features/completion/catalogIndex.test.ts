import { beforeAll, describe, expect, it } from 'vitest';

import type { CompletionCatalog } from '../../ipc';
import { CatalogIndex } from './catalogIndex';
import { mockCatalog } from './completionTestKit';

let catalog: CompletionCatalog;
let index: CatalogIndex;

beforeAll(async () => {
  catalog = await mockCatalog();
  index = new CatalogIndex(catalog);
});

const nameOf = (relation: number) => {
  const entry = index.relation(relation);
  return `${index.schemaName(entry?.schema ?? null) ?? ''}.${entry?.name ?? ''}`;
};

describe('resolving a name', () => {
  it('finds a table on the search path by its bare name', () => {
    expect(nameOf(index.resolve(['feature_flags']))).toBe('public.feature_flags');
  });

  it('does not find a table off the search path by its bare name… unless nothing else fits', () => {
    // `orders` lives in `shop`, which the path does not list: still the only candidate.
    expect(nameOf(index.resolve(['orders']))).toBe('shop.orders');
  });

  it('finds schema-qualified names, with or without the database', () => {
    expect(nameOf(index.resolve(['shop', 'orders']))).toBe('shop.orders');
    expect(nameOf(index.resolve(['app_dev', 'shop', 'orders']))).toBe('shop.orders');
  });

  it('ignores case, but prefers the exact one', () => {
    expect(nameOf(index.resolve(['SHOP', 'ORDERS']))).toBe('shop.orders');
    expect(nameOf(index.resolve(['shop', 'Order Notes']))).toBe('shop.Order Notes');
    expect(nameOf(index.resolve(['shop', 'order notes']))).toBe('shop.Order Notes');
  });

  it('is -1 for what does not exist', () => {
    expect(index.resolve(['nope'])).toBe(-1);
    expect(index.resolve(['shop', 'nope'])).toBe(-1);
    expect(index.resolve(['nope', 'orders'])).toBe(-1);
    expect(index.resolve([])).toBe(-1);
  });

  it('prefers the first schema of the search path when a name exists in several', () => {
    const twin: CompletionCatalog = {
      database: 'd',
      schemas: [
        { name: 'a', system: false },
        { name: 'b', system: false },
      ],
      searchPath: ['b', 'a'],
      typeNames: ['int'],
      relations: [
        { schema: 0, name: 't', kind: 'table', columns: ['x'], columnTypes: [0] },
        { schema: 1, name: 't', kind: 'table', columns: ['y'], columnTypes: [0] },
      ],
      routines: [],
      foreignKeys: [],
    };
    const twins = new CatalogIndex(twin);
    expect(twins.resolve(['t'])).toBe(1);
    expect(twins.resolve(['a', 't'])).toBe(0);
    // `a.t` has to be said; `b.t` is what `t` already means.
    expect(twins.needsSchema(0)).toBe(true);
    expect(twins.needsSchema(1)).toBe(false);
  });
});

describe('qualifying names', () => {
  it('needs the schema of a table off the search path, not of one on it', () => {
    expect(index.needsSchema(index.resolve(['shop', 'orders']))).toBe(true);
    expect(index.needsSchema(index.resolve(['feature_flags']))).toBe(false);
  });

  it('needs nothing without schemas', () => {
    const flat = new CatalogIndex({
      database: 'main',
      schemas: [],
      searchPath: [],
      typeNames: [],
      relations: [{ schema: null, name: 't', kind: 'table', columns: [], columnTypes: [] }],
      routines: [],
      foreignKeys: [],
    });
    expect(flat.hasSchemas).toBe(false);
    expect(flat.needsSchema(0)).toBe(false);
    expect(flat.resolve(['t'])).toBe(0);
    expect(flat.resolve(['main', 't'])).toBe(0);
  });
});

describe('lists', () => {
  it('lists the relations of a schema only', () => {
    const sales = index.schemaIndex('sales');
    expect(sales).not.toBeNull();
    const names = index.relationsIn(sales).names;
    expect(names).toContain('invoices');
    expect(names).not.toContain('orders');
  });

  it('lists distinct column names once, with an owner', () => {
    const names = index.columnNames.names;
    expect(new Set(names).size).toBe(names.length);
    const id = index.columnNames.ids[names.indexOf('customer_id')];
    expect(id).toBeDefined();
    const owner = index.ownerOfColumn(id ?? -1);
    expect(index.relation(owner ?? -1)?.columns).toContain('customer_id');
  });

  it('finds the schemas by prefix', () => {
    expect(index.schemaList.search('sh', 5).map((r) => r.name)[0]).toBe('shop');
  });
});

describe('foreign keys', () => {
  it('are seen from both sides', () => {
    const orders = index.resolve(['shop', 'orders']);
    const customers = index.resolve(['shop', 'customers']);
    const out = index.linksOf(orders).find((l) => l.other === customers);
    expect(out).toMatchObject({ columns: ['customer_id'], otherColumns: ['id'], outgoing: true });
    const back = index.linksOf(customers).find((l) => l.other === orders);
    expect(back).toMatchObject({ columns: ['id'], otherColumns: ['customer_id'], outgoing: false });
  });

  it('say which column holds the key', () => {
    const orders = index.resolve(['shop', 'orders']);
    expect(index.foreignKeyOf(orders, 'customer_id')).toBeDefined();
    expect(index.foreignKeyOf(orders, 'total')).toBeUndefined();
    expect(index.foreignKeyOf(orders, 'nope')).toBeUndefined();
  });
});
