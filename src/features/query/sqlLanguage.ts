import { MSSQL, MySQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql';
import type { Extension } from '@codemirror/state';

import type { Engine } from '../../ipc';

// The one place that maps an engine to a CodeMirror dialect: highlighting and quoting rules of
// the editor follow the connection's engine, not the other way round.
const DIALECTS: Record<Engine, SQLDialect> = {
  postgres: PostgreSQL,
  mssql: MSSQL,
  mysql: MySQL,
  sqlite: SQLite,
};

/** The SQL language support for an engine (F-040). */
export function sqlLanguage(engine: Engine): Extension {
  return sql({ dialect: DIALECTS[engine], upperCaseKeywords: false });
}
