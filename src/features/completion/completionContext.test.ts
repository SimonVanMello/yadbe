import { describe, expect, it } from 'vitest';

import { analyze, type CompletionContext } from './completionContext';
import type { QuoteRules } from './sqlTokens';

const PG: QuoteRules = { open: '"', close: '"' };
const MSSQL: QuoteRules = { open: '[', close: ']' };
const MYSQL: QuoteRules = { open: '`', close: '`' };

const COLUMNS: Record<string, string[]> = {
  orders: ['id', 'customer_id', 'total'],
  customers: ['id', 'email'],
  'public.orders': ['id', 'customer_id', 'total'],
};

/** Analyzes `sql`, where `|` marks the cursor. */
function at(sql: string, rules: QuoteRules = PG): CompletionContext {
  const cursor = sql.indexOf('|');
  const text = sql.replace('|', '');
  return analyze({
    text,
    base: 0,
    cursor,
    rules,
    columnsOf: (path) => COLUMNS[path.join('.').toLowerCase()] ?? null,
  });
}

const visible = (ctx: CompletionContext) => ctx.relations.map((r) => r.visible);

describe('where a word is being typed', () => {
  it('reports the word before the cursor as the prefix', () => {
    const ctx = at('select * from ord|ers');
    expect(ctx.prefix).toBe('ord');
    expect(ctx.from).toBe('select * from '.length);
    // Accepting a name replaces the whole word under the cursor.
    expect(ctx.to).toBe('select * from orders'.length);
  });

  it('has an empty prefix after a space', () => {
    const ctx = at('select * from |');
    expect(ctx.prefix).toBe('');
    expect(ctx.from).toBe(ctx.to);
  });

  it('offers nothing inside a string', () => {
    expect(at("select 'abc|' from t").kind).toBe('none');
    expect(at("select 'abc|").kind).toBe('none');
    expect(at('select $$ from |$$').kind).toBe('none');
    expect(at('select $tag$ from |$tag$').kind).toBe('none');
  });

  it('offers nothing inside a comment', () => {
    expect(at('select 1 -- from |').kind).toBe('none');
    expect(at('select 1 /* from | */').kind).toBe('none');
    expect(at('select 1 /* from |').kind).toBe('none');
  });

  it('resumes after the end of a line comment', () => {
    expect(at('select 1 -- note\nfrom |').kind).toBe('relation');
  });

  it('is not fooled by a keyword inside a string or comment', () => {
    expect(at("select ' from ' + |").kind).toBe('columns');
    expect(at('select /* from */ |').kind).toBe('columns');
  });

  it('offers nothing in a number or after a closed quoted name', () => {
    expect(at('select 12|').kind).toBe('none');
    expect(at('select "abc"|').kind).toBe('none');
  });
});

describe('relations', () => {
  it.each([
    'select * from |',
    'select * from ord|',
    'select * from a join |',
    'select * from a left outer join |',
    'select * from a x, |',
    'insert into |',
    'update |',
    'delete from |',
    'truncate table |',
    'drop table |',
    'select * from only |',
  ])('after %s', (sql) => {
    expect(at(sql).kind).toBe('relation');
  });

  it('is not a relation position after a relation or its alias', () => {
    expect(at('select * from orders |').kind).toBe('keywords');
    expect(at('select * from orders o |').kind).toBe('keywords');
    expect(at('select * from orders o join customers c |').kind).toBe('keywords');
    expect(at('insert into orders |').kind).toBe('keywords');
  });

  it('does not suggest a name for CREATE TABLE', () => {
    expect(at('create table |').kind).toBe('none');
  });

  it('does not suggest an alias', () => {
    expect(at('select * from orders as |').kind).toBe('none');
    expect(at('select a as |').kind).toBe('none');
  });

  it('is a start of statement inside FROM (', () => {
    const ctx = at('select * from (|');
    expect(ctx.kind).toBe('keywords');
    expect(ctx.position).toBe('start');
  });

  it('knows a FROM list in another statement of the script', () => {
    expect(at('select 1 from a;\nselect * from |').kind).toBe('relation');
    expect(at('select 1 from a;\n|').kind).toBe('keywords');
  });
});

describe('columns', () => {
  it.each([
    'select |',
    'select a, |',
    'select distinct |',
    'select top 10 |',
    'select * from t where |',
    'select * from t where a = |',
    'select * from t where a = 1 and |',
    'select * from t where a in (|',
    'select * from t group by |',
    'select * from t order by a, |',
    'select * from a join b on |',
    'select * from a join b on a.x = |',
    'select count(|',
    'select coalesce(a, |',
    'update t set |',
    'update t set a = 1, |',
    'select * from t having |',
    'select case when |',
  ])('in %s', (sql) => {
    expect(at(sql).kind).toBe('columns');
  });

  it('expects a keyword after an operand', () => {
    expect(at('select a |').kind).toBe('keywords');
    expect(at('select a, count(*) |').kind).toBe('keywords');
    expect(at('select * from t where a = 1 |').kind).toBe('keywords');
    expect(at("select * from t where a = 'x' |").kind).toBe('keywords');
    expect(at('select * from t order by a |').kind).toBe('keywords');
    expect(at('select * |').kind).toBe('keywords');
  });

  it('is a keyword position at the start of a statement', () => {
    const ctx = at('sel|');
    expect(ctx.kind).toBe('keywords');
    expect(ctx.position).toBe('start');
    expect(at('|').position).toBe('start');
  });

  it('is only keywords after LIMIT and in VALUES', () => {
    expect(at('select * from t limit |').kind).toBe('keywords');
    expect(at('insert into t values (|').kind).toBe('keywords');
  });
});

describe('qualified names', () => {
  it('reads the qualifiers before the cursor', () => {
    expect(at('select o.| from orders o').qualifiers).toEqual(['o']);
    expect(at('select o.to| from orders o').qualifiers).toEqual(['o']);
    expect(at('select o.to| from orders o').prefix).toBe('to');
    expect(at('select * from public.|').qualifiers).toEqual(['public']);
    expect(at('select * from db.public.|').qualifiers).toEqual(['db', 'public']);
    expect(at('select a . | from t').qualifiers).toEqual(['a']);
  });

  it('is qualified, whatever the clause', () => {
    expect(at('select * from public.|').kind).toBe('qualified');
    expect(at('select o.| from orders o').kind).toBe('qualified');
    expect(at('select * from a join b on a.x = b.|').kind).toBe('qualified');
  });

  it('reads quoted qualifiers per dialect', () => {
    expect(at('select "My Table".| from "My Table"').qualifiers).toEqual(['My Table']);
    expect(at('select [My Table].| from [My Table]', MSSQL).qualifiers).toEqual(['My Table']);
    expect(at('select `a b`.| from `a b`', MYSQL).qualifiers).toEqual(['a b']);
  });

  it('offers nothing after a dot that follows no name', () => {
    expect(at('select f(x).|').kind).toBe('none');
    expect(at('select 1 + .|').kind).toBe('none');
  });
});

describe('aliases and relations of the statement', () => {
  it('resolves aliases declared after the cursor', () => {
    const ctx = at('select o.| from orders o');
    expect(ctx.relations).toEqual([
      { visible: 'o', path: ['orders'], columns: COLUMNS.orders, depth: 0, joinedHere: false },
    ]);
  });

  it('resolves AS aliases, bare names and schema-qualified names', () => {
    const ctx = at('select | from public.orders as o, customers c join orders on 1=1');
    expect(visible(ctx)).toEqual(['o', 'c', 'orders']);
    expect(ctx.relations[0]?.path).toEqual(['public', 'orders']);
  });

  it('keeps quoted aliases as written', () => {
    const ctx = at('select | from orders "My Alias"');
    expect(visible(ctx)).toEqual(['My Alias']);
  });

  it('does not take a keyword for an alias', () => {
    const ctx = at('select | from orders where 1 = 1');
    expect(visible(ctx)).toEqual(['orders']);
    expect(at('select | from orders left join customers on 1 = 1').relations).toHaveLength(2);
    expect(at('select | from orders order by 1').relations[0]?.visible).toBe('orders');
  });

  it('finds the target of UPDATE, INSERT and DELETE', () => {
    expect(visible(at('update orders o set |'))).toEqual(['o']);
    expect(visible(at('delete from orders where |'))).toEqual(['orders']);
  });

  it('does not see relations of another statement', () => {
    const ctx = at('select * from customers;\nselect | from orders');
    expect(visible(ctx)).toEqual(['orders']);
    expect(visible(at('select | from orders;\nselect * from customers'))).toEqual(['orders']);
  });

  it('marks the relation a JOIN introduces while writing its ON', () => {
    const ctx = at('select * from orders o join customers c on |');
    expect(ctx.relations.map((r) => [r.visible, r.joinedHere])).toEqual([
      ['o', false],
      ['c', true],
    ]);
    const later = at('select * from orders o join customers c on c.id = |');
    expect(later.relations.find((r) => r.joinedHere)?.visible).toBe('c');
  });
});

describe('nested selects', () => {
  it('sees the relations of the subquery first, then the outer ones', () => {
    const ctx = at('select * from orders o where exists (select 1 from customers c where |)');
    expect(ctx.relations.map((r) => [r.visible, r.depth])).toEqual([
      ['c', 0],
      ['o', 1],
    ]);
  });

  it('does not leak the subquery relations outside of it', () => {
    const ctx = at('select | from orders o where exists (select 1 from customers c)');
    expect(visible(ctx)).toEqual(['o']);
  });

  it('works inside parentheses that are not subqueries', () => {
    const ctx = at('select * from orders o where (o.total > 1 and |)');
    expect(ctx.kind).toBe('columns');
    expect(visible(ctx)).toEqual(['o']);
  });

  it('copes with unbalanced parentheses', () => {
    expect(at('select * from (select a from t where |').kind).toBe('columns');
    expect(at('select a) from |').kind).toBe('relation');
  });
});

describe('derived tables and CTEs', () => {
  it('knows the columns of a derived table', () => {
    const ctx = at('select d.| from (select id, total as amount, count(*) n from orders) d');
    expect(ctx.relations[0]).toMatchObject({
      visible: 'd',
      path: null,
      columns: ['id', 'amount', 'n'],
    });
  });

  it('expands * in a derived table', () => {
    const ctx = at('select d.| from (select * from orders) d');
    expect(ctx.relations[0]?.columns).toEqual(COLUMNS.orders);
    const qualified = at('select d.| from (select o.* from orders o) d');
    expect(qualified.relations[0]?.columns).toEqual(COLUMNS.orders);
  });

  it('knows the columns of a CTE', () => {
    const ctx = at('with big as (select id, total from orders) select b.| from big b');
    expect(ctx.relations[0]).toMatchObject({ visible: 'b', path: null, columns: ['id', 'total'] });
  });

  it('uses the explicit column list of a CTE', () => {
    const ctx = at('with big(a, b) as (select id, total from orders) select | from big');
    expect(ctx.relations[0]?.columns).toEqual(['a', 'b']);
  });

  it('chains CTEs', () => {
    const ctx = at(
      'with a as (select id from orders), b as (select id as x from a) select | from b',
    );
    expect(ctx.relations[0]?.columns).toEqual(['x']);
  });

  it('is a relation position inside a CTE body too', () => {
    expect(at('with a as (select * from |) select 1').kind).toBe('relation');
  });
});

describe('INSERT column lists', () => {
  it('knows the target', () => {
    const ctx = at('insert into public.orders (id, |)');
    expect(ctx.kind).toBe('insertColumns');
    expect(ctx.insertTarget).toEqual(['public', 'orders']);
    expect(at('insert into orders (|').insertTarget).toEqual(['orders']);
  });
});

describe('quoted names', () => {
  it('completes inside an open quote, without the quote', () => {
    const ctx = at('select * from "Ord|');
    expect(ctx.quoted).toBe(true);
    expect(ctx.prefix).toBe('Ord');
    expect(ctx.kind).toBe('relation');
    expect(ctx.from).toBe('select * from "'.length);
  });

  it('replaces up to the closing quote', () => {
    const sql = 'select * from "Ord|ers" o';
    const ctx = at(sql);
    expect(ctx.quoted).toBe(true);
    expect(ctx.prefix).toBe('Ord');
    expect(ctx.to).toBe('select * from "Orders"'.length);
  });

  it('undoes doubled quotes in the prefix', () => {
    expect(at('select * from "a""b|').prefix).toBe('a"b');
  });

  it('uses the dialect quotes', () => {
    expect(at('select * from [Ord|', MSSQL).quoted).toBe(true);
    expect(at('select * from `Ord|', MYSQL).quoted).toBe(true);
    // A double quote is a string in MySQL.
    expect(at('select "from |', MYSQL).kind).toBe('none');
  });

  it('offers nothing in a [ of a Postgres array subscript', () => {
    expect(at('select a[1] from |').kind).toBe('relation');
  });
});

describe('routines', () => {
  it('after EXEC and CALL', () => {
    expect(at('exec |', MSSQL).kind).toBe('routine');
    expect(at('call |').kind).toBe('routine');
  });
});

describe('statement offsets', () => {
  it('maps offsets back into the document', () => {
    const text = 'select * from ord';
    const ctx = analyze({
      text,
      base: 100,
      cursor: 100 + text.length,
      rules: PG,
      columnsOf: () => null,
    });
    expect(ctx.from).toBe(100 + 'select * from '.length);
    expect(ctx.to).toBe(100 + text.length);
    expect(ctx.kind).toBe('relation');
  });
});

describe('FOR UPDATE and ON UPDATE', () => {
  it('are not the start of an UPDATE', () => {
    expect(at('select * from t for update |').kind).toBe('keywords');
  });
});

describe('less common shapes', () => {
  it('USING (…) of a join lists columns', () => {
    const ctx = at('select * from orders o join customers c using (|');
    expect(ctx.kind).toBe('columns');
    expect(visible(ctx)).toEqual(['o', 'c']);
  });

  it('INSERT … SELECT reads the select', () => {
    const ctx = at('insert into customers (id) select | from orders o');
    expect(ctx.kind).toBe('columns');
    expect(ctx.clause).toBe('select');
    expect(visible(ctx)).toContain('o');
  });

  it('UPDATE … FROM sees both relations in SET', () => {
    const ctx = at('update orders o set total = c.id, | from customers c');
    expect(ctx.kind).toBe('columns');
    expect(visible(ctx)).toEqual(['o', 'c']);
  });

  it('SELECT TOP n on SQL Server still expects the select list', () => {
    expect(at('select top 5 | from [orders]', MSSQL).kind).toBe('columns');
    expect(at('select top (5) | from orders', MSSQL).kind).toBe('columns');
  });

  it('a scalar subquery in the select list resolves its own aliases', () => {
    const ctx = at('select (select max(x) from orders o2 where o2.|) from customers c');
    expect(ctx.kind).toBe('qualified');
    expect(ctx.relations.map((r) => [r.visible, r.depth])).toEqual([
      ['o2', 0],
      ['c', 1],
    ]);
  });

  it('a comma-separated FROM list declares every relation', () => {
    expect(visible(at('select | from orders o, customers c, public.orders p2'))).toEqual([
      'o',
      'c',
      'p2',
    ]);
  });

  it('keywords of a clause after a subquery in FROM', () => {
    expect(at('select * from (select 1) t |').kind).toBe('keywords');
    expect(at('select * from (select 1) t where |').kind).toBe('columns');
  });

  it('a window clause and a CASE expression are expression positions', () => {
    expect(at('select sum(x) over (partition by |) from orders').kind).toBe('columns');
    expect(at('select case when a > 1 then | end from orders').kind).toBe('columns');
  });

  it('the typed word is never taken for a declaration', () => {
    expect(visible(at('select * from orders o join cust|'))).toEqual(['o']);
    expect(visible(at('select * from orders o, shop.cust|'))).toEqual(['o']);
    expect(at('select * from orders o join cust|').kind).toBe('relation');
  });

  it('ignores a semicolon inside a string or a dollar-quoted body', () => {
    expect(visible(at("select ';' as s, | from orders o"))).toEqual(['o']);
    expect(visible(at('select $$a;b$$, | from orders o'))).toEqual(['o']);
  });

  it('keeps working on an empty or whitespace-only statement', () => {
    expect(at('   |').position).toBe('start');
    expect(at('\n\n|\n').kind).toBe('keywords');
  });
});
