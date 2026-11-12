import type { Engine } from './bindings';

/**
 * The engines of the SQL family: the keys of the tables only SQL engines have an entry in
 * (dialects, keywords, lexers…). Code outside those tables branches on the family.
 */
export type SqlEngine = Extract<Engine, 'postgres' | 'mssql' | 'mysql' | 'sqlite'>;

const SQL_ENGINES: readonly Engine[] = ['postgres', 'mssql', 'mysql', 'sqlite'];

export function isSqlEngine(engine: Engine): engine is SqlEngine {
  return SQL_ENGINES.includes(engine);
}

/**
 * The entry of a SQL-only table for `engine`. SQL code paths only ever ask for SQL engines; an
 * engine of another family gets PostgreSQL's entry, the closest to standard SQL, rather than
 * nothing.
 */
export function sqlEntry<T>(table: Readonly<Record<SqlEngine, T>>, engine: Engine): T {
  return isSqlEngine(engine) ? table[engine] : table.postgres;
}
