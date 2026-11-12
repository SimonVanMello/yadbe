import type { Engine } from './bindings';

/** The engines outside the SQL family; an engine of another family adds itself here. */
type NonSqlEngine = 'mongodb';

/**
 * The engines of the SQL family: what the SQL-only tables (dialects, keywords, formatter,
 * splitter…) are keyed by. A connection's capabilities say whether its engine is one of them
 * (`family === 'sql'`).
 */
export type SqlEngine = Exclude<Engine, NonSqlEngine>;

const SQL_ENGINES: ReadonlySet<Engine> = new Set<SqlEngine>([
  'postgres',
  'mssql',
  'mysql',
  'sqlite',
]);

/** Narrows an engine to the SQL family. */
export function isSqlEngine(engine: Engine): engine is SqlEngine {
  return SQL_ENGINES.has(engine);
}

/**
 * The SQL engine whose rules apply to `engine`: itself, or PostgreSQL's (generic SQL) for an
 * engine of another family. For SQL-only code that a connection of another family never
 * reaches: its tabs, toolbar and explorer are chosen by family.
 */
export function sqlEngineOf(engine: Engine): SqlEngine {
  return isSqlEngine(engine) ? engine : 'postgres';
}
