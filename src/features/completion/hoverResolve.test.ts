import { beforeAll, describe, expect, it } from 'vitest';

import { CatalogIndex } from './catalogIndex';
import { mockCatalog, quotingFor } from './completionTestKit';
import { resolveHover, type HoverHit } from './hoverResolve';

let index: CatalogIndex;

beforeAll(async () => {
  index = new CatalogIndex(await mockCatalog());
});

/** What the name at `^` (the character after it) resolves to, as `schema.table[.column]`. */
function hover(marked: string): string | null {
  const pos = marked.indexOf('^');
  const text = marked.replace('^', '');
  const hit: HoverHit | null = resolveHover({
    text,
    base: 0,
    pos,
    rules: quotingFor('postgres'),
    index,
  });
  if (!hit) return null;
  const { target } = hit;
  if (target.kind === 'routine') return `routine ${index.routine(target.routine)?.name ?? '?'}`;
  const relation = index.relation(target.relation);
  const name = `${index.schemaName(relation?.schema ?? null) ?? ''}.${relation?.name ?? '?'}`;
  return target.kind === 'column' ? `${name}.${target.column}` : name;
}

describe('hover resolution', () => {
  it('resolves tables, aliases and their columns', () => {
    const sql = 'select o.total, status from shop.orders o where o.customer_id = 1';
    expect(hover(sql.replace('o.total', 'o.^total'))).toBe('shop.orders.total');
    expect(hover(sql.replace('o.total', '^o.total'))).toBe('shop.orders');
    expect(hover(sql.replace('shop.orders', 'shop.^orders'))).toBe('shop.orders');
    expect(hover(sql.replace(', status', ', ^status'))).toBe('shop.orders.status');
    expect(hover(sql.replace('o.customer_id', 'o.custo^mer_id'))).toBe('shop.orders.customer_id');
  });

  it('follows the search path and qualified columns', () => {
    expect(hover('select * from ^schema_migrations')).toBe('public.schema_migrations');
    expect(hover('select shop.customers.^email from shop.customers')).toBe('shop.customers.email');
    expect(
      hover('select c.^email from shop.customers c join shop.orders o on o.customer_id = c.id'),
    ).toBe('shop.customers.email');
  });

  it('resolves function calls', () => {
    expect(hover('select ^lower(email) from shop.customers')).toBe('routine lower');
  });

  it('finds nothing in strings, comments, schemas or CTE names', () => {
    expect(hover("select 'shop.^orders' from shop.orders")).toBeNull();
    expect(hover('select 1 -- shop.^orders')).toBeNull();
    expect(hover('select * from ^shop.orders')).toBeNull();
    expect(hover('with recent as (select 1) select * from ^recent')).toBeNull();
    expect(hover('select ^nowhere from shop.orders')).toBeNull();
  });
});
