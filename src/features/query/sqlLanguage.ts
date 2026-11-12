import { MSSQL, MySQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql';
import type { Extension } from '@codemirror/state';

import type { Engine } from '../../ipc';
import { sqlEngineOf, type SqlEngine } from '../../ipc/sqlEngine';

// The one place that maps an engine to a CodeMirror dialect: highlighting and quoting rules of
// the editor follow the connection's engine, not the other way round.
const DIALECTS: Record<SqlEngine, SQLDialect> = {
  postgres: PostgreSQL,
  mssql: MSSQL,
  mysql: MySQL,
  sqlite: SQLite,
};

/** The CodeMirror dialect of an engine (its type names feed the completion vocabulary). */
export function dialectOf(engine: Engine): SQLDialect {
  return DIALECTS[sqlEngineOf(engine)];
}

/** The SQL language support for an engine (F-040). */
export function sqlLanguage(engine: Engine): Extension {
  return sql({ dialect: DIALECTS[sqlEngineOf(engine)], upperCaseKeywords: false });
}
