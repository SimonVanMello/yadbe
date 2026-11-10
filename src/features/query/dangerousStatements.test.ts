import { describe, expect, it } from 'vitest';

import { classifyStatement, findDangerousStatements } from './dangerousStatements';

describe('classifyStatement', () => {
  it.each([
    ['update orders set status = 1', 'updateWithoutWhere'],
    ['UPDATE orders SET status = 1;', 'updateWithoutWhere'],
    ['delete from orders', 'deleteWithoutWhere'],
    ['DELETE FROM orders', 'deleteWithoutWhere'],
    ['truncate table orders', 'truncate'],
    ['TRUNCATE orders RESTART IDENTITY', 'truncate'],
    ['drop table orders', 'drop'],
    ['drop database shop', 'drop'],
    ['DROP INDEX IF EXISTS idx_orders', 'drop'],
  ])('flags %s', (sql, kind) => {
    expect(classifyStatement(sql)).toBe(kind);
  });

  it.each([
    'update orders set status = 1 where id = 3',
    'DELETE FROM orders WHERE id IN (1, 2)',
    'select * from orders',
    'insert into orders (id) values (1)',
    'insert into t select * from u',
    'insert into t values (1) on conflict (id) do update set a = 1',
    'select * from t for update',
    'alter table t drop column c',
    'create trigger tr before update on t for each row execute function f()',
    'grant update on t to bob',
    'explain delete from orders',
    'explain update orders set a = 1',
    'begin',
    '',
    '-- delete from orders',
    '/* drop table orders */ select 1',
  ])('lets %s through', (sql) => {
    expect(classifyStatement(sql)).toBeNull();
  });

  it('is not fooled by keywords in strings, quoted identifiers and comments', () => {
    expect(classifyStatement("update t set note = 'where' ")).toBe('updateWithoutWhere');
    expect(classifyStatement('update t set "where" = 1')).toBe('updateWithoutWhere');
    expect(classifyStatement('update t set a = 1 -- where id = 3')).toBe('updateWithoutWhere');
    expect(classifyStatement('delete from t /* where id = 3 */')).toBe('deleteWithoutWhere');
    expect(classifyStatement('delete from [where]')).toBe('deleteWithoutWhere');
    expect(classifyStatement('delete from `where`')).toBe('deleteWithoutWhere');
    expect(classifyStatement("select 'drop table t'")).toBeNull();
    expect(classifyStatement('select $$ delete from t $$')).toBeNull();
  });

  it('handles escape strings and dollar quoting around a real WHERE', () => {
    expect(classifyStatement("update t set a = E'it\\'s' where id = 1")).toBeNull();
    expect(classifyStatement("update t set a = 'it''s' where id = 1")).toBeNull();
    expect(classifyStatement('update t set a = $tag$ x $tag$ where id = 1')).toBeNull();
  });

  it('only counts a WHERE at the statement level', () => {
    expect(classifyStatement('update t set a = (select max(b) from u where u.id = 1)')).toBe(
      'updateWithoutWhere',
    );
    expect(classifyStatement('delete from t where id in (select id from u where x)')).toBeNull();
    expect(classifyStatement('update t set a = u.a from u where u.id = t.id')).toBeNull();
    expect(classifyStatement('update t set a = case when b then 1 else 2 end')).toBe(
      'updateWithoutWhere',
    );
  });

  it('sees through WITH clauses and writable CTEs', () => {
    expect(classifyStatement('with x as (select 1) delete from t')).toBe('deleteWithoutWhere');
    expect(
      classifyStatement('with x as (select 1) delete from t where id in (select * from x)'),
    ).toBeNull();
    expect(
      classifyStatement('with d as (delete from t returning *) insert into log select * from d'),
    ).toBe('deleteWithoutWhere');
    expect(classifyStatement('with recursive r(n) as (select 1) select * from r')).toBeNull();
  });

  it('flags EXPLAIN ANALYZE of a dangerous statement, which really runs it', () => {
    expect(classifyStatement('explain analyze delete from t')).toBe('deleteWithoutWhere');
    expect(classifyStatement('explain (analyze) update t set a = 1')).toBe('updateWithoutWhere');
  });

  it('knows SQL Server and MySQL forms', () => {
    expect(classifyStatement('DELETE TOP (10) FROM t')).toBe('deleteWithoutWhere');
    expect(classifyStatement('DELETE TOP (10) FROM t WHERE a = 1')).toBeNull();
    expect(classifyStatement('delete from t order by id limit 1')).toBe('deleteWithoutWhere');
    expect(classifyStatement('UPDATE `orders` SET `n` = 1')).toBe('updateWithoutWhere');
  });
});

describe('findDangerousStatements', () => {
  it('returns the statements to confirm with their index in the run', () => {
    const text = 'select 1;\ndelete from orders;\nupdate t set a = 1 where id = 2;\ndrop table t;';
    const ranges = [
      { from: 0, to: 8 },
      { from: 10, to: 28 },
      { from: 30, to: 61 },
      { from: 63, to: 75 },
    ];
    expect(findDangerousStatements(text, ranges)).toEqual([
      {
        index: 1,
        range: { from: 10, to: 28 },
        kind: 'deleteWithoutWhere',
        sql: 'delete from orders',
      },
      { index: 3, range: { from: 63, to: 75 }, kind: 'drop', sql: 'drop table t' },
    ]);
  });

  it('is empty for a harmless script', () => {
    expect(findDangerousStatements('select 1', [{ from: 0, to: 8 }])).toEqual([]);
  });
});
