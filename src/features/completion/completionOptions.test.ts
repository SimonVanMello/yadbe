import { beforeAll, describe, expect, it } from 'vitest';

import { CatalogIndex } from './catalogIndex';
import { mockCatalog, probe } from './completionTestKit';

let index: CatalogIndex;

beforeAll(async () => {
  index = new CatalogIndex(await mockCatalog());
});

const first = (sql: string, engine: 'postgres' | 'mssql' | 'mysql' | 'sqlite' = 'postgres') =>
  probe(sql, index, engine).items[0];

describe('relations after FROM', () => {
  it('ranks prefix matches before word-start and scattered ones, shorter first', () => {
    const { labels } = probe('select * from ord|', index);
    expect(labels.slice(0, 4)).toEqual(['orders', 'order_items', 'order_coupons', 'Order Notes']);
    expect(labels).toContain('customer_orders');
  });

  it('matches letters in order when nothing starts with them', () => {
    expect(probe('select * from oitm|', index).labels).toContain('order_items');
  });

  it('shows the schema as detail and writes it when the table is not on the search path', () => {
    const orders = first('select * from ord|');
    expect(orders).toMatchObject({
      label: 'orders',
      kind: 'table',
      detail: 'shop',
      insert: 'shop.orders',
    });
    // `public` is the search path: no schema to write.
    expect(first('select * from feature|')).toMatchObject({
      label: 'feature_flags',
      detail: 'public',
      insert: 'feature_flags',
    });
  });

  it('marks views and materialized views', () => {
    const kinds = Object.fromEntries(
      probe('select * from customer_orders|', index).items.map((i) => [i.label, i.kind]),
    );
    expect(kinds.customer_orders).toBe('view');
    expect(
      probe('select * from top_products|', index).items.find((i) => i.label === 'top_products')
        ?.kind,
    ).toBe('materializedView');
  });

  it('quotes names that need it, only then', () => {
    const notes = probe('select * from Order|', index).items.find((i) => i.label === 'Order Notes');
    expect(notes?.insert).toBe('shop."Order Notes"');
    expect(first('select * from ord|')?.insert).toBe('shop.orders');
  });

  it('offers schemas, which continue with a dot', () => {
    const shop = probe('select * from sho|', index).items.find((i) => i.kind === 'schema');
    expect(shop).toMatchObject({ label: 'shop', insert: 'shop.', follow: true });
  });

  it('ranks the user schemas above the system ones', () => {
    const labels = probe('select * from p|', index).labels;
    expect(labels.indexOf('products')).toBeLessThan(labels.indexOf('pg_class'));
  });

  it('offers the CTEs of the statement', () => {
    const { items } = probe('with recent as (select 1) select * from rec|', index);
    expect(items[0]).toMatchObject({ label: 'recent', kind: 'cte' });
  });

  it('inserts the name alone inside an open quote, with the closing quote', () => {
    const items = probe('select * from shop."Order|', index).items;
    expect(items.find((i) => i.label === 'Order Notes')?.insert).toBe('Order Notes"');
  });
});

describe('after schema.', () => {
  it('lists the objects of that schema only', () => {
    const { labels, items } = probe('select * from sales.|', index);
    expect(labels).toContain('invoices');
    expect(labels).not.toContain('orders');
    expect(items.every((i) => i.kind !== 'schema')).toBe(true);
    // Qualified already: nothing to prefix.
    expect(items.find((i) => i.label === 'invoices')?.insert).toBe('invoices');
  });

  it('filters by what follows the dot', () => {
    expect(probe('select * from shop.ord|', index).labels[0]).toBe('orders');
  });

  it('adds routines in an expression, not after FROM', () => {
    expect(probe('select shop.order_t|', index).labels).toContain('order_total');
    expect(probe('select * from shop.order_t|', index).labels).not.toContain('order_total');
  });

  it('reads the schema case-insensitively', () => {
    expect(probe('select * from SHOP.ord|', index).labels[0]).toBe('orders');
  });
});

describe('after alias.', () => {
  it('lists the columns of the aliased relation, with their types', () => {
    const { items } = probe('select o.| from shop.orders o', index);
    expect(items.map((i) => i.label)).toEqual(
      expect.arrayContaining(['id', 'customer_id', 'status', 'total']),
    );
    const total = items.find((i) => i.label === 'total');
    expect(total?.kind).toBe('column');
    expect(total?.detail).not.toBe('');
  });

  it('keeps the table`s own order while nothing is typed', () => {
    const { labels } = probe('select o.| from shop.orders o', index);
    expect(labels.slice(0, 5)).toEqual(['id', 'customer_id', 'status', 'subtotal', 'shipping']);
    const joined = probe('select | from shop.orders o join shop.customers c on 1=1', index);
    const columns = joined.items.filter((i) => i.kind === 'column').map((i) => i.insert);
    expect(columns.slice(0, 3)).toEqual(['o.id', 'customer_id', 'status']);
  });

  it('filters and ranks the columns', () => {
    const labels = probe('select o.cr| from shop.orders o', index).labels;
    expect(labels[0]).toBe('created_at');
  });

  it('works with the table name when there is no alias', () => {
    const { labels } = probe('select orders.| from shop.orders', index);
    expect(labels).toContain('customer_id');
  });

  it('works in a WHERE and an ON, for either side', () => {
    const sql = 'select * from shop.orders o join shop.customers c on o.customer_id = c.|';
    expect(probe(sql, index).labels).toContain('email');
    expect(probe('select * from shop.orders o where o.|', index).labels).toContain('status');
  });

  it('does not offer the columns of another relation', () => {
    const { labels } = probe('select c.| from shop.orders o join shop.customers c on 1=1', index);
    expect(labels).toContain('email');
    expect(labels).not.toContain('subtotal');
  });

  it('resolves a table by name when its schema is on the search path', () => {
    expect(probe('select f.| from feature_flags f', index).labels).toContain('rollout');
  });

  it('resolves schema-qualified references written with their name', () => {
    expect(probe('select shop.orders.| from shop.orders', index).labels).toContain('note');
  });

  it('resolves a table typed with a different case', () => {
    expect(probe('select o.| from SHOP.ORDERS o', index).labels).toContain('status');
  });

  it('knows nothing of an unknown table, without failing', () => {
    expect(probe('select x.| from nowhere x', index).items).toEqual([]);
  });

  it('completes the columns of a CTE and of a derived table', () => {
    const cte = probe(
      'with big as (select id, total from shop.orders) select b.| from big b',
      index,
    );
    expect(cte.labels).toEqual(['id', 'total']);
    const derived = probe('select d.| from (select o.* from shop.orders o) d', index);
    expect(derived.labels).toContain('customer_id');
  });
});

describe('columns of the statement', () => {
  const sql = 'select | from shop.orders o join shop.customers c on c.id = o.customer_id';

  it('lists the columns of the relations of the statement, with the aliases', () => {
    const { labels } = probe(sql, index);
    expect(labels).toEqual(expect.arrayContaining(['status', 'email', 'o', 'c']));
  });

  it('qualifies a column name that two relations share', () => {
    const items = probe('select i| from shop.orders o join shop.customers c on 1=1', index).items;
    const id = items.filter((i) => i.label === 'id');
    expect(id.map((i) => i.insert).sort()).toEqual(['c.id', 'o.id']);
    expect(id[0]?.detail).toMatch(/^[oc] · /);
    // A column of one relation only is written as is.
    expect(
      probe('select ema| from shop.orders o join shop.customers c on 1=1', index).items[0],
    ).toMatchObject({ label: 'email', insert: 'email' });
  });

  it('ranks the statement columns above the same name elsewhere', () => {
    const items = probe('select stat| from shop.orders', index).items;
    expect(items[0]).toMatchObject({ label: 'status', kind: 'column' });
  });

  it('offers a catalog column after two characters when the relation is not there yet', () => {
    // One character is too few to go looking in the whole catalog.
    expect(probe('select c| from shop.orders', index).labels).not.toContain('cart_id');
    expect(probe('select cart_| from shop.orders', index).labels).toContain('cart_id');
    // And what the statement has comes first.
    const items = probe('select cr| from shop.orders', index).items;
    expect(items[0]?.label).toBe('created_at');
  });

  it('offers catalog columns from the first character while the statement has no relation', () => {
    const { items } = probe('select ema|', index);
    expect(items.find((i) => i.label === 'email')?.kind).toBe('column');
  });

  it('does not rank a column of the catalog above a function with no relation yet', () => {
    const items = probe('select coun|', index).items;
    expect(items[0]).toMatchObject({ label: 'count', kind: 'function' });
    expect(items.some((i) => i.label === 'country_code')).toBe(true);
  });

  it('ranks the columns of the inner select above those of the outer one', () => {
    const items = probe(
      'select * from shop.orders o where exists (select 1 from shop.customers c where e|)',
      index,
    ).items;
    expect(items[0]).toMatchObject({ label: 'email', kind: 'column' });
  });

  it('sees the outer relations from a subquery', () => {
    const { labels } = probe(
      'select * from shop.orders o where exists (select 1 from shop.customers c where sub|)',
      index,
    );
    expect(labels).toContain('subtotal');
  });

  it('suggests functions and keywords too, below the columns', () => {
    const { items } = probe('select cou| from shop.orders', index);
    expect(items.map((i) => i.kind)).toContain('function');
    expect(items.find((i) => i.label === 'count')?.insert).toBe('count()');
    expect(items.find((i) => i.label === 'count')?.cursorBack).toBe(1);
  });

  it('adds the functions of the catalog', () => {
    const { items } = probe('select order_t| from shop.orders', index);
    expect(items[0]).toMatchObject({
      label: 'order_total',
      kind: 'function',
      insert: 'shop.order_total()',
    });
  });

  it('completes the aliases, which continue with a dot', () => {
    const alias = probe('select o| from shop.orders o', index).items.find(
      (i) => i.kind === 'alias',
    );
    expect(alias).toMatchObject({ label: 'o', insert: 'o.', follow: true });
  });

  it('writes a quoted alias and a column that needs quotes', () => {
    const items = probe('select "My|" from shop.orders "My Alias"', index).items;
    expect(items.find((i) => i.kind === 'alias')?.insert).toBe('My Alias".');
    expect(
      probe('select My| from shop.orders "My Alias"', index).items.find((i) => i.kind === 'alias')
        ?.insert,
    ).toBe('"My Alias".');
    const notes = probe('select Sel| from shop."Order Notes"', index).items.find(
      (i) => i.kind === 'column',
    );
    expect(notes).toMatchObject({ label: 'Select', insert: '"Select"' });
  });
});

describe('join suggestions', () => {
  it('proposes the foreign key between the joined table and the others', () => {
    const { items } = probe('select * from shop.orders o join shop.customers c on |', index);
    const join = items.find((i) => i.kind === 'join');
    expect(join?.label).toBe('c.id = o.customer_id');
  });

  it('works the other way round, and for composite keys', () => {
    const { items } = probe('select * from shop.customers c join shop.orders o on |', index);
    expect(items.find((i) => i.kind === 'join')?.label).toBe('o.customer_id = c.id');
  });

  it('offers none when the tables are not related, or outside of an ON', () => {
    expect(
      probe('select * from shop.orders o join shop.warehouses w on |', index).items.some(
        (i) => i.kind === 'join',
      ),
    ).toBe(false);
    expect(
      probe('select * from shop.orders o join shop.customers c where |', index).items.some(
        (i) => i.kind === 'join',
      ),
    ).toBe(false);
  });
});

describe('INSERT column lists', () => {
  it('lists the columns of the target table', () => {
    const { labels } = probe('insert into shop.customers (|', index);
    expect(labels).toEqual(expect.arrayContaining(['email', 'full_name']));
  });
});

describe('keywords', () => {
  it('offers statement starters at the start', () => {
    expect(probe('|', index).labels[0]).toBe('select');
    expect(first('sel|')).toMatchObject({ label: 'select', kind: 'keyword' });
  });

  it('answers in capitals when capitals were typed', () => {
    expect(first('SEL|')?.label).toBe('SELECT');
    expect(first('S|')?.label).not.toBe('S');
  });

  it('proposes what follows a relation or an operand', () => {
    expect(probe('select * from shop.orders |', index).labels.slice(0, 2)).toEqual([
      'where',
      'join',
    ]);
    expect(first('select * from shop.orders wh|')?.label).toBe('where');
    expect(first('select a fr|')?.label).toBe('from');
  });

  it('proposes types after a cast', () => {
    const items = probe('select a::int|', index).items;
    expect(items.every((i) => i.kind === 'type')).toBe(true);
    expect(items.map((i) => i.label)).toContain('integer');
    expect(probe('select cast(a as var|)', index).items[0]?.kind).toBe('type');
  });

  it('is available while the catalog is not (no index)', () => {
    expect(probe('select * from ord|', null).items).toEqual([]);
    expect(probe('select a, cou|', null).labels).toContain('count');
    expect(probe('sel|', null).labels[0]).toBe('select');
  });
});

describe('routines', () => {
  it('after CALL / EXEC', () => {
    expect(probe('call order_|', index, 'postgres').labels).toContain('order_total');
    const proc = probe('call arch|', index).items[0];
    expect(proc).toMatchObject({ label: 'archive_invoices', kind: 'procedure' });
    expect(proc?.insert).toBe('sales.archive_invoices');
  });
});

describe('quoting follows the dialect', () => {
  it('uses brackets on SQL Server and backticks on MySQL', () => {
    const named = (sql: string, engine: 'mssql' | 'mysql') =>
      probe(sql, index, engine).items.find((i) => i.label === 'Order Notes')?.insert;
    expect(named('select * from shop.Order|', 'mssql')).toBe('[Order Notes]');
    expect(named('select * from shop.Order|', 'mysql')).toBe('`Order Notes`');
    expect(named('select * from Order|', 'mssql')).toBe('shop.[Order Notes]');
  });

  it('quotes reserved words and mixed-case names only where it matters', () => {
    const pg = probe('select Sel| from shop."Order Notes"', index, 'postgres').items[0];
    expect(pg?.insert).toBe('"Select"');
    const sqlite = probe('select Sel| from shop."Order Notes"', index, 'sqlite').items[0];
    expect(sqlite?.insert).toBe('"Select"');
  });
});

describe('nothing in strings and comments', () => {
  it('returns no suggestion', () => {
    expect(probe("select 'ord|' from shop.orders", index).items).toEqual([]);
    expect(probe('select 1 -- ord|', index).items).toEqual([]);
  });
});

describe('limits', () => {
  it('returns at most the limit', () => {
    expect(probe('select * from |', index, 'postgres', 7).items).toHaveLength(7);
  });
});
