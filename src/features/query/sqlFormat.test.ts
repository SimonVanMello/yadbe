import { describe, expect, it } from 'vitest';

import type { SqlEngine } from '../../ipc/sqlEngines';
import { formatSql, significantTokens, type FormatOptions } from './sqlFormat';

const options = (engine: SqlEngine, extra: Partial<FormatOptions> = {}): FormatOptions => ({
  engine,
  keywordCase: 'upper',
  indent: '  ',
  ...extra,
});

/** Tricky scripts per engine: every one must keep its tokens and be a fixed point. */
const CORPUS: Record<SqlEngine, string[]> = {
  postgres: [
    "select a, b from t where x = 'it''s -- not a comment' and y::int > -1 order by a desc limit 10;",
    'select $1, :name, "Mixed Case"."Col", e\'\\n\', $tag$ select ; -- $tag$ from t',
    'with recursive r(n) as (select 1 union all select n + 1 from r where n < 5) select * from r',
    'select * from a left join b on a.id = b.a_id and b.x is not null where a.v between 1 and 2 or a.w in (select w from c)',
    'insert into t (a, b) values (1, 2), (3, 4) on conflict (a) do update set b = excluded.b returning *',
    "do $$ begin raise notice 'x;y'; end $$;",
    'create function f() returns int language sql begin atomic select 1; select 2; end;',
    "select a[1:2], b->>'k', c @> d, - -1, 5 - -3, x*-1 /* keep */ from t",
    'select count(*) filter (where x) over (partition by a order by b) from t group by 1 having count(*) > 1',
    '-- leading comment\nselect 1; -- trailing\n\n/* block */ select 2\n',
    'update t set a = 1, b = case when c then 2 else 3 end where id = 4',
    "create table t (id int primary key, name text not null default 'x', check (id > 0))",
    'select 1a, 1e5, .5, 0x1F from "select"',
    'select a.select, t.from from t',
  ],
  mssql: [
    "SELECT TOP (10) a, b FROM dbo.[order] o WHERE o.[name] = N'x''y' AND @id = 1\nGO\nSELECT 2",
    'DECLARE @x int = 1; SELECT @x + @@ROWCOUNT, #temp.a FROM #temp',
    'IF @x = 1 BEGIN SELECT 1 END ELSE BEGIN SELECT 2 END',
    'CREATE PROCEDURE p @id int AS BEGIN SELECT * FROM t WHERE id = @id; SELECT 2; END\nGO 3\nEXEC p @id = 1',
    'select a from t cross apply f(t.id) x outer apply g(x.y) z',
    'merge into t using s on t.id = s.id when matched then update set t.a = s.a;',
  ],
  mysql: [
    'select `order`.id, \'a\\\'b\', "c\\"d", @v := 1 from `order` # hash comment\nwhere x = 1',
    'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END $$\nDELIMITER ;\nselect 3',
    "select ?, :id, if(a, 1, 2), json->>'$.k' from t limit 1, 2",
    'select a--1 from t',
    'select /*!40101 sql_no_cache */ 1 from dual',
    "select _utf8mb4'x' collate utf8mb4_bin, x'0f', b'01'",
  ],
  sqlite: [
    'select ?, ?2, :a, @b, $c from [t] join `u` on u.id = t.id',
    'create trigger tr after insert on t begin update u set n = n + 1; delete from v; end; select 1',
    "select * from t where a glob '*x*' order by a nulls last",
  ],
};

describe('formatSql', () => {
  for (const [engine, scripts] of Object.entries(CORPUS) as [SqlEngine, string[]][]) {
    for (const script of scripts) {
      it(`keeps the tokens and is idempotent (${engine}): ${script.slice(0, 40)}`, () => {
        for (const indent of ['  ', '    ', '\t']) {
          for (const keywordCase of ['upper', 'lower', 'preserve'] as const) {
            const opts = options(engine, { indent, keywordCase });
            const once = formatSql(script, opts);
            expect(formatSql(once, opts)).toBe(once);
            expect(significantTokens(once, engine)).toEqual(significantTokens(script, engine));
          }
        }
      });
    }
  }

  it('lays a query out one clause per line, lists one item per line', () => {
    const sql =
      "select o.id, o.total, c.email from orders o join customers c on c.id = o.customer_id and c.active where o.total > 10 and o.status in ('a', 'b') order by o.id desc limit 5;";
    expect(formatSql(sql, options('postgres'))).toBe(
      [
        'SELECT',
        '  o.id,',
        '  o.total,',
        '  c.email',
        'FROM orders o',
        '  JOIN customers c ON c.id = o.customer_id',
        '    AND c.active',
        'WHERE o.total > 10',
        "  AND o.status IN ('a', 'b')",
        'ORDER BY o.id DESC',
        'LIMIT 5;',
      ].join('\n'),
    );
  });

  it('indents subqueries and keeps BETWEEN … AND together', () => {
    const sql = 'select a from t where b between 1 and 2 and c in (select c from u where d = 1)';
    expect(formatSql(sql, options('postgres', { indent: '    ' }))).toBe(
      [
        'SELECT a',
        'FROM t',
        'WHERE b BETWEEN 1 AND 2',
        '    AND c IN (',
        '        SELECT c',
        '        FROM u',
        '        WHERE d = 1',
        '    )',
      ].join('\n'),
    );
  });

  it('never touches strings, quoted names, comments or casts', () => {
    const sql = `select 'from where' as "select", x::text -- select from\nfrom t`;
    const out = formatSql(sql, options('postgres', { keywordCase: 'lower' }));
    expect(out).toContain("'from where'");
    expect(out).toContain('"select"');
    expect(out).toContain('x::text -- select from');
  });

  it('cases only keywords, never names', () => {
    expect(formatSql('select key, `select` from orders', options('mysql'))).toBe(
      'SELECT\n  KEY,\n  `select`\nFROM orders',
    );
    expect(
      formatSql('SELECT left(a, 2) FROM t', options('postgres', { keywordCase: 'lower' })),
    ).toBe('select left(a, 2)\nfrom t');
    // `end` is not reserved on MySQL: a table may be called that.
    expect(formatSql('select * from end', options('mysql'))).toBe('SELECT *\nFROM end');
  });

  it('keeps routine bodies, GO and DELIMITER lines verbatim', () => {
    const body = 'CREATE PROCEDURE p AS\nBEGIN\n  select 1;   select 2;\nEND';
    expect(formatSql(`${body}\nGO\nselect 3`, options('mssql'))).toBe(`${body}\nGO\nSELECT 3`);
    const script = 'DELIMITER //\nCREATE PROCEDURE p() BEGIN  select 1; END //\nDELIMITER ;';
    expect(formatSql(script, options('mysql'))).toBe(script);
  });

  it('never glues operators into a comment', () => {
    const out = formatSql('select 5 - -3, (- -1), a--1\n from t', options('mysql'));
    expect(out).toContain('5 - -3');
    expect(out).toContain('(- -1)');
    // `--1` is two minus signs on MySQL; `-- 1` would be a comment.
    expect(out).toContain('a --1');
  });
});
