//! MySQL / MariaDB introspection over `information_schema`.
//!
//! MySQL's databases are its namespaces: the explorer shows them at the database level and
//! the dialect has no schema level (`schema` is always `None`). One connection sees every
//! database, so every query filters on the database (and the table) by bound equality on
//! `TABLE_SCHEMA` / `TABLE_NAME`: MySQL 8 then reads its data dictionary for those objects
//! only, and MariaDB opens only that database's (or that table's) definitions instead of
//! every table of the server.

use std::collections::HashMap;

use mysql_async::Value as MyValue;

use super::{Inner, MysqlConnection, detached};
use crate::db::dialect::{Dialect, MysqlDialect};
use crate::db::driver::recorded;
use crate::db::errors::YadbeError;
use crate::db::introspect::{Introspector, MetaFuture, TypeInterner, index_u32};
use crate::db::meta::{
    CatalogForeignKey, CatalogRelation, CatalogRoutine, CheckConstraint, ColumnInfo,
    CompletionCatalog, DatabaseInfo, ForeignKey, ForeignKeyAction, Generated, Identity, IndexInfo,
    KeyConstraint, ObjectCount, ObjectDetail, ObjectInfo, ObjectKind, ObjectRef, RelationSummary,
    RoutineSignature, SchemaInfo, TableDetails, TriggerEvent, TriggerInfo, TriggerTiming,
};
use crate::db::object_model::{DdlTarget, ObjectDdl, ObjectDependents, ObjectProperties};
use crate::db::value::Value;

/// Databases the server itself provides, hidden by default.
const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

const TABLE_TYPES: &str = "('BASE TABLE', 'SYSTEM VERSIONED')";
const VIEW_TYPES: &str = "('VIEW', 'SYSTEM VIEW')";

const DATABASES_SQL: &str = "SELECT SCHEMA_NAME, SCHEMA_NAME = DATABASE() \
FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME";

fn counts_sql() -> String {
    format!(
        "SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?),
       (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN {TABLE_TYPES}),
       (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN {VIEW_TYPES}),
       (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION'),
       (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE')"
    )
}

fn relations_sql(types: &str) -> String {
    format!(
        "SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS, CREATE_OPTIONS, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN {types}
ORDER BY TABLE_NAME"
    )
}

const ROUTINES_SQL: &str = "SELECT ROUTINE_NAME, ROUTINE_COMMENT, DTD_IDENTIFIER
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ?
ORDER BY ROUTINE_NAME";

/// Parameters of every routine of a database, in order.
const PARAMETERS_SQL: &str =
    "SELECT SPECIFIC_NAME, ROUTINE_TYPE, PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER
FROM information_schema.PARAMETERS
WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0
ORDER BY SPECIFIC_NAME, ORDINAL_POSITION";

const TABLE_SQL: &str = "SELECT TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

const COLUMNS_SQL: &str = "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, \
COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION";

/// `EXPRESSION` (functional key parts) exists from MySQL 8.0.13; MariaDB has none.
fn indexes_sql(expressions: bool) -> String {
    format!(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, {}, SUB_PART, INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX",
        if expressions { "EXPRESSION" } else { "NULL" }
    )
}

const FOREIGN_KEYS_SQL: &str = "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, \
k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, \
r.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
  AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND r.CONSTRAINT_SCHEMA = ? AND r.TABLE_NAME = ?
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

/// MySQL 8.0.16+: check constraints are named per database.
const MYSQL_CHECKS_SQL: &str = "SELECT c.CONSTRAINT_NAME, c.CHECK_CLAUSE
FROM information_schema.TABLE_CONSTRAINTS t
JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA
  AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? AND t.CONSTRAINT_TYPE = 'CHECK'
ORDER BY c.CONSTRAINT_NAME";

/// MariaDB names checks per table (a column check is named after its column).
const MARIADB_CHECKS_SQL: &str = "SELECT CONSTRAINT_NAME, CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY CONSTRAINT_NAME";

const TRIGGERS_SQL: &str = "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, \
ACTION_ORIENTATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS
WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
ORDER BY ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER";

const CATALOG_RELATIONS_SQL: &str = "SELECT TABLE_NAME, TABLE_TYPE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME";

const CATALOG_COLUMNS_SQL: &str = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, ORDINAL_POSITION";

const CATALOG_ROUTINES_SQL: &str = "SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ?
ORDER BY ROUTINE_NAME";

/// Foreign keys between tables of one database (join suggestions).
const CATALOG_FOREIGN_KEYS_SQL: &str = "SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, \
REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION";

type Row = Vec<Value>;

/// One index read from `STATISTICS`: name, unique, key parts, plain columns only, method.
type IndexRows = Vec<(String, bool, Vec<String>, bool, Option<String>)>;

/// Foreign keys by (table, constraint): (from, from column, to, to column) per key part.
type ForeignKeyRows = Vec<((String, String), Vec<[String; 4]>)>;

/// A cell as text. `information_schema` columns are text, but some come with the binary
/// character set on MySQL 8: their hexadecimal form is turned back into text.
pub(super) fn text(row: &Row, index: usize) -> Option<String> {
    match row.get(index)? {
        Value::Null => None,
        Value::Bytes(hex) => Some(String::from_utf8_lossy(&unhex(hex)).into_owned()),
        Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_owned()),
        Value::Array(_) => None,
        Value::Int(s)
        | Value::Decimal(s)
        | Value::Float(s)
        | Value::Text(s)
        | Value::Date(s)
        | Value::Time(s)
        | Value::Timestamp(s)
        | Value::TimestampTz(s)
        | Value::Interval(s)
        | Value::Uuid(s)
        | Value::Json(s)
        | Value::Other(s) => Some(s.clone()),
    }
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok())
        .collect()
}

pub(super) fn text_req(row: &Row, index: usize) -> Result<String, YadbeError> {
    text(row, index).ok_or_else(|| YadbeError::internal(format!("metadata column {index} is null")))
}

/// Empty comments are no comment.
pub(super) fn comment(row: &Row, index: usize) -> Option<String> {
    text(row, index).filter(|c| !c.trim().is_empty())
}

pub(super) fn number(row: &Row, index: usize) -> Option<u64> {
    text(row, index)?.parse().ok()
}

fn count(row: &Row, index: usize) -> u32 {
    number(row, index).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

fn flag(row: &Row, index: usize) -> bool {
    number(row, index).is_some_and(|n| n != 0)
}

#[allow(clippy::cast_precision_loss)]
pub(super) fn estimate(row: &Row, index: usize) -> Option<f64> {
    number(row, index).map(|n| n as f64)
}

fn fk_action(rule: Option<&str>) -> ForeignKeyAction {
    match rule.unwrap_or_default().to_ascii_uppercase().as_str() {
        "CASCADE" => ForeignKeyAction::Cascade,
        "SET NULL" => ForeignKeyAction::SetNull,
        "SET DEFAULT" => ForeignKeyAction::SetDefault,
        "RESTRICT" => ForeignKeyAction::Restrict,
        _ => ForeignKeyAction::NoAction,
    }
}

fn is_system(database: &str) -> bool {
    SYSTEM_DATABASES.contains(&database.to_ascii_lowercase().as_str())
}

fn no_schema(schema: Option<&str>) -> Result<(), YadbeError> {
    match schema {
        None => Ok(()),
        Some(schema) => Err(YadbeError::object_not_found(schema)),
    }
}

/// Numeric families whose default MySQL prints as a bare literal.
fn numeric(data_type: &str) -> bool {
    matches!(
        data_type,
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "numeric"
            | "float"
            | "double"
            | "real"
            | "bit"
            | "year"
    )
}

/// The default as a SQL expression. MariaDB already writes one (`'text'`, `NULL`,
/// `current_timestamp()`); MySQL writes literals bare and flags expressions
/// `DEFAULT_GENERATED`.
fn default_expression(
    raw: Option<String>,
    data_type: &str,
    extra: &str,
    mariadb: bool,
) -> Option<String> {
    let raw = raw?;
    if mariadb {
        return (!raw.eq_ignore_ascii_case("null")).then_some(raw);
    }
    let upper = raw.to_ascii_uppercase();
    if extra.to_ascii_uppercase().contains("DEFAULT_GENERATED")
        || numeric(data_type)
        || upper.starts_with("CURRENT_TIMESTAMP")
    {
        Some(raw)
    } else {
        Some(format!("'{}'", raw.replace('\'', "''")))
    }
}

fn generated(extra: &str, expression: Option<String>) -> Option<Generated> {
    let extra = extra.to_ascii_uppercase();
    let virtual_column = extra.contains("VIRTUAL GENERATED");
    let stored = extra.contains("STORED GENERATED") || extra.contains("PERSISTENT GENERATED");
    (virtual_column || stored).then(|| Generated {
        stored,
        expression: expression.filter(|e| !e.is_empty()),
    })
}

/// One parameter: `IN p_id int` (procedures), `p_id int` (functions).
fn argument(mode: Option<&str>, name: &str, type_name: &str) -> String {
    match mode {
        Some(mode) if !mode.is_empty() => format!("{mode} {name} {type_name}"),
        _ => format!("{name} {type_name}"),
    }
}

/// Arguments of every routine by (name, type): (full list, types only).
fn arguments_by_routine(rows: &[Row]) -> HashMap<(String, String), (Vec<String>, Vec<String>)> {
    let mut out: HashMap<(String, String), (Vec<String>, Vec<String>)> = HashMap::new();
    for row in rows {
        let (Some(routine), Some(kind)) = (text(row, 0), text(row, 1)) else {
            continue;
        };
        let type_name = text(row, 4).unwrap_or_default();
        let kind = kind.to_ascii_uppercase();
        // A function's parameters are all `IN` (MySQL says so, MariaDB leaves it empty).
        let mode = if kind == "PROCEDURE" {
            text(row, 2)
        } else {
            None
        };
        let entry = out.entry((routine, kind)).or_default();
        entry.0.push(argument(
            mode.as_deref(),
            &text(row, 3).unwrap_or_default(),
            &type_name,
        ));
        entry.1.push(type_name);
    }
    out
}

fn kind_word(kind: ObjectKind) -> &'static str {
    if kind == ObjectKind::Procedure {
        "PROCEDURE"
    } else {
        "FUNCTION"
    }
}

impl Inner {
    async fn meta_rows(&self, sql: &str, params: Vec<MyValue>) -> Result<Vec<Row>, YadbeError> {
        let (mut guard, running) = self.lock().await?;
        let conn = guard.as_mut().ok_or_else(|| self.closed())?;
        let result = super::bound::run_one(conn, sql, params, usize::MAX).await;
        drop(running);
        if result.is_err() {
            self.track_transaction(conn).await;
        }
        result
            .map(|drained| {
                drained
                    .sets
                    .into_iter()
                    .next()
                    .map(|set| set.rows)
                    .unwrap_or_default()
            })
            .map_err(|e| self.failed(&e))
    }
}

impl MysqlConnection {
    /// Runs one metadata query with its names bound, recorded in the statement log.
    pub(super) async fn meta(&self, sql: &str, params: &[&str]) -> Result<Vec<Row>, YadbeError> {
        let inner = std::sync::Arc::clone(&self.inner);
        let owned = sql.to_owned();
        let params: Vec<MyValue> = params
            .iter()
            .map(|p| MyValue::Bytes(p.as_bytes().to_vec()))
            .collect();
        recorded(
            &*self.inner.recorder,
            sql,
            |rows: &Vec<Row>| u64::try_from(rows.len()).ok(),
            detached(async move { inner.meta_rows(&owned, params).await }),
        )
        .await
    }

    async fn relations(
        &self,
        database: &str,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        let view = kind == ObjectKind::View;
        let sql = relations_sql(if view { VIEW_TYPES } else { TABLE_TYPES });
        let system = is_system(database);
        self.meta(&sql, &[database])
            .await?
            .iter()
            .map(|row| {
                let name = text_req(row, 0)?;
                let engine = text(row, 4).unwrap_or_default().to_ascii_uppercase();
                Ok(ObjectInfo {
                    kind,
                    id: name.clone(),
                    name,
                    system,
                    // A view's comment is the word `VIEW`.
                    comment: if view { None } else { comment(row, 1) },
                    detail: ObjectDetail::Relation(RelationSummary {
                        row_estimate: if view { None } else { estimate(row, 2) },
                        partitioned: text(row, 3)
                            .is_some_and(|o| o.to_ascii_lowercase().contains("partitioned")),
                        foreign: matches!(engine.as_str(), "FEDERATED" | "CONNECT" | "SPIDER"),
                    }),
                })
            })
            .collect()
    }

    async fn routines(
        &self,
        database: &str,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        let word = kind_word(kind);
        let routines = self.meta(ROUTINES_SQL, &[database, word]).await?;
        let parameters = self.meta(PARAMETERS_SQL, &[database]).await?;
        let arguments = arguments_by_routine(&parameters);
        let system = is_system(database);
        routines
            .iter()
            .map(|row| {
                let name = text_req(row, 0)?;
                let (full, types) = arguments
                    .get(&(name.clone(), word.to_owned()))
                    .cloned()
                    .unwrap_or_default();
                Ok(ObjectInfo {
                    kind,
                    id: name.clone(),
                    name,
                    system,
                    comment: comment(row, 1),
                    detail: ObjectDetail::Routine(RoutineSignature {
                        arguments: full.join(", "),
                        identity_arguments: types.join(", "),
                        return_type: if kind == ObjectKind::Function {
                            text(row, 2)
                        } else {
                            None
                        },
                        language: Some("SQL".to_owned()),
                        aggregate: false,
                    }),
                })
            })
            .collect()
    }

    async fn details(&self, table: &ObjectRef) -> Result<TableDetails, YadbeError> {
        let (db, name) = (table.database.as_str(), table.name.as_str());
        let flavor = self.inner.flavor();
        let relation = self.meta(TABLE_SQL, &[db, name]).await?;
        let Some(relation) = relation.first() else {
            return Err(YadbeError::object_not_found(&format!("{db}.{name}")));
        };
        let table_type = text(relation, 0).unwrap_or_default().to_ascii_uppercase();
        let view = table_type.contains("VIEW");
        let kind = if view {
            ObjectKind::View
        } else {
            ObjectKind::Table
        };

        let mut columns = Vec::new();
        for (index, row) in self
            .meta(COLUMNS_SQL, &[db, name])
            .await?
            .iter()
            .enumerate()
        {
            let data_type = text(row, 2).unwrap_or_default().to_ascii_lowercase();
            let type_name = text_req(row, 1)?;
            let extra = text(row, 5).unwrap_or_default();
            columns.push(ColumnInfo {
                name: text_req(row, 0)?,
                ordinal: index_u32(index + 1),
                kind: super::decode::kind_of_type(&data_type, &type_name),
                type_name,
                nullable: text(row, 3).is_some_and(|n| n.eq_ignore_ascii_case("YES")),
                default: default_expression(text(row, 4), &data_type, &extra, flavor.mariadb),
                identity: extra
                    .to_ascii_lowercase()
                    .contains("auto_increment")
                    .then_some(Identity::ByDefault),
                generated: generated(&extra, text(row, 6)),
                comment: comment(row, 7),
                primary_key: false,
                foreign_key: false,
            });
        }

        let mut details = TableDetails {
            table: table.clone(),
            kind,
            comment: if view { None } else { comment(relation, 1) },
            row_estimate: if view { None } else { estimate(relation, 2) },
            columns,
            primary_key: None,
            unique_keys: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            indexes: Vec::new(),
            triggers: Vec::new(),
        };
        if view {
            return Ok(details);
        }

        let expressions = !flavor.mariadb && flavor.at_least(8, 0, 13);
        self.add_indexes(&mut details, &indexes_sql(expressions))
            .await?;
        self.add_foreign_keys(&mut details).await?;
        let checks_sql = if flavor.mariadb {
            Some(MARIADB_CHECKS_SQL)
        } else if flavor.at_least(8, 0, 16) {
            Some(MYSQL_CHECKS_SQL)
        } else {
            None
        };
        if let Some(sql) = checks_sql {
            details.checks = self
                .meta(sql, &[db, name])
                .await?
                .iter()
                .map(|row| {
                    Ok(CheckConstraint {
                        name: text(row, 0),
                        expression: text_req(row, 1)?,
                    })
                })
                .collect::<Result<_, YadbeError>>()?;
        }
        details.triggers = self
            .meta(TRIGGERS_SQL, &[db, name])
            .await?
            .iter()
            .map(|row| {
                let trigger = text_req(row, 0)?;
                let timing = text(row, 1).unwrap_or_default().to_ascii_uppercase();
                let event = text(row, 2).unwrap_or_default().to_ascii_uppercase();
                let for_each_row = text(row, 3).is_none_or(|o| o.eq_ignore_ascii_case("ROW"));
                let body = text(row, 4).unwrap_or_default();
                Ok(TriggerInfo {
                    definition: Some(format!(
                        "CREATE TRIGGER {} {timing} {event} ON {} FOR EACH ROW {body}",
                        MysqlDialect.quote_identifier(&trigger),
                        MysqlDialect.quote_identifier(name),
                    )),
                    name: trigger,
                    timing: if timing == "BEFORE" {
                        TriggerTiming::Before
                    } else {
                        TriggerTiming::After
                    },
                    events: vec![match event.as_str() {
                        "INSERT" => TriggerEvent::Insert,
                        "DELETE" => TriggerEvent::Delete,
                        _ => TriggerEvent::Update,
                    }],
                    for_each_row,
                    enabled: true,
                    function: None,
                })
            })
            .collect::<Result<_, YadbeError>>()?;
        details.mark_key_columns();
        Ok(details)
    }

    async fn add_indexes(&self, details: &mut TableDetails, sql: &str) -> Result<(), YadbeError> {
        let (db, name) = (details.table.database.clone(), details.table.name.clone());
        let mut indexes: IndexRows = Vec::new();
        for row in &self.meta(sql, &[&db, &name]).await? {
            let index = text_req(row, 0)?;
            let unique = !flag(row, 1);
            let (part, plain) = match (text(row, 2), text(row, 3)) {
                (Some(column), _) => match number(row, 4) {
                    Some(length) => (format!("{column}({length})"), true),
                    None => (column, true),
                },
                (None, Some(expression)) => (expression, false),
                (None, None) => (String::new(), false),
            };
            let method = text(row, 5).map(|m| m.to_ascii_lowercase());
            match indexes.last_mut() {
                Some(last) if last.0 == index => {
                    last.2.push(part);
                    last.3 &= plain;
                }
                _ => indexes.push((index, unique, vec![part], plain, method)),
            }
        }
        let quote = |s: &str| MysqlDialect.quote_identifier(s);
        for (index, unique, parts, plain, method) in indexes {
            let primary = index == "PRIMARY";
            // Key columns without their prefix length.
            let columns: Vec<String> = parts
                .iter()
                .map(|p| match p.rsplit_once('(') {
                    Some((column, rest)) if plain && rest.ends_with(')') => column.to_owned(),
                    _ => p.clone(),
                })
                .collect();
            if primary {
                details.primary_key = Some(KeyConstraint {
                    name: Some(index.clone()),
                    columns: columns.clone(),
                });
            } else if unique && plain {
                details.unique_keys.push(KeyConstraint {
                    name: Some(index.clone()),
                    columns: columns.clone(),
                });
            }
            let key = parts
                .iter()
                .zip(&columns)
                .map(|(part, column)| {
                    if !plain {
                        format!("({part})")
                    } else if part == column {
                        quote(column)
                    } else {
                        format!("{}{}", quote(column), &part[column.len()..])
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let kind_prefix = match method.as_deref() {
                Some("fulltext") => "FULLTEXT ",
                Some("spatial") => "SPATIAL ",
                _ if unique => "UNIQUE ",
                _ => "",
            };
            details.indexes.push(IndexInfo {
                definition: Some(if primary {
                    format!(
                        "ALTER TABLE {}.{} ADD PRIMARY KEY ({key})",
                        quote(&db),
                        quote(&name)
                    )
                } else {
                    format!(
                        "CREATE {kind_prefix}INDEX {} ON {}.{} ({key})",
                        quote(&index),
                        quote(&db),
                        quote(&name)
                    )
                }),
                name: index,
                columns,
                unique,
                primary,
                method,
                predicate: None,
            });
        }
        Ok(())
    }

    async fn add_foreign_keys(&self, details: &mut TableDetails) -> Result<(), YadbeError> {
        let (db, name) = (details.table.database.clone(), details.table.name.clone());
        let rows = self
            .meta(FOREIGN_KEYS_SQL, &[&db, &name, &db, &name])
            .await?;
        for row in &rows {
            let constraint = text_req(row, 0)?;
            let column = text_req(row, 1)?;
            let referenced = text_req(row, 4)?;
            match details.foreign_keys.last_mut() {
                Some(fk) if fk.name.as_deref() == Some(constraint.as_str()) => {
                    fk.columns.push(column);
                    fk.referenced_columns.push(referenced);
                }
                _ => details.foreign_keys.push(ForeignKey {
                    name: Some(constraint),
                    columns: vec![column],
                    referenced_table: ObjectRef {
                        database: text(row, 2).unwrap_or_else(|| db.clone()),
                        schema: None,
                        name: text_req(row, 3)?,
                    },
                    referenced_columns: vec![referenced],
                    on_update: fk_action(text(row, 5).as_deref()),
                    on_delete: fk_action(text(row, 6).as_deref()),
                    deferrable: false,
                }),
            }
        }
        Ok(())
    }

    async fn catalog(&self, database: &str) -> Result<CompletionCatalog, YadbeError> {
        let relations = self.meta(CATALOG_RELATIONS_SQL, &[database]).await?;
        let columns = self.meta(CATALOG_COLUMNS_SQL, &[database]).await?;
        let routines = self.meta(CATALOG_ROUTINES_SQL, &[database]).await?;
        let parameters = self.meta(PARAMETERS_SQL, &[database]).await?;
        let foreign_keys = self
            .meta(CATALOG_FOREIGN_KEYS_SQL, &[database, database])
            .await?;

        let mut catalog_relations = Vec::with_capacity(relations.len());
        let mut by_name: HashMap<String, usize> = HashMap::with_capacity(relations.len());
        for row in &relations {
            let name = text_req(row, 0)?;
            let table_type = text(row, 1).unwrap_or_default().to_ascii_uppercase();
            let kind = if table_type.contains("VIEW") {
                ObjectKind::View
            } else {
                ObjectKind::Table
            };
            by_name.insert(name.clone(), catalog_relations.len());
            catalog_relations.push(CatalogRelation {
                schema: None,
                name,
                kind,
                columns: Vec::new(),
                column_types: Vec::new(),
            });
        }
        let mut types = TypeInterner::default();
        for row in &columns {
            let Some(&relation) = by_name.get(&text_req(row, 0)?) else {
                continue;
            };
            let type_id = types.intern(&text(row, 2).unwrap_or_default());
            let relation = &mut catalog_relations[relation];
            relation.columns.push(text_req(row, 1)?);
            relation.column_types.push(type_id);
        }

        let arguments = arguments_by_routine(&parameters);
        let mut catalog_routines = Vec::with_capacity(routines.len());
        for row in &routines {
            let name = text_req(row, 0)?;
            let word = text(row, 1).unwrap_or_default().to_ascii_uppercase();
            let procedure = word == "PROCEDURE";
            catalog_routines.push(CatalogRoutine {
                schema: None,
                arguments: arguments
                    .get(&(name.clone(), word))
                    .map(|a| a.0.join(", "))
                    .unwrap_or_default(),
                name,
                kind: if procedure {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                },
                return_type: if procedure { None } else { text(row, 2) },
            });
        }

        // Rows come by constraint, in key order: (from, from column, to, to column).
        let mut constraints: ForeignKeyRows = Vec::new();
        for row in &foreign_keys {
            let id = (text_req(row, 1)?, text_req(row, 0)?);
            let pair = [
                text_req(row, 1)?,
                text_req(row, 2)?,
                text_req(row, 3)?,
                text_req(row, 4)?,
            ];
            match constraints.last_mut() {
                Some((last, pairs)) if *last == id => pairs.push(pair),
                _ => constraints.push((id, vec![pair])),
            }
        }
        let position = |relation: usize, column: &str| {
            catalog_relations[relation]
                .columns
                .iter()
                .position(|c| c == column)
                .map(index_u32)
        };
        let mut catalog_fks = Vec::with_capacity(constraints.len());
        for (_, pairs) in constraints {
            let (Some(&from), Some(&to)) = (by_name.get(&pairs[0][0]), by_name.get(&pairs[0][2]))
            else {
                continue;
            };
            let from_columns: Option<Vec<u32>> =
                pairs.iter().map(|p| position(from, &p[1])).collect();
            let to_columns: Option<Vec<u32>> = pairs.iter().map(|p| position(to, &p[3])).collect();
            if let (Some(from_columns), Some(to_columns)) = (from_columns, to_columns) {
                catalog_fks.push(CatalogForeignKey {
                    from: index_u32(from),
                    from_columns,
                    to: index_u32(to),
                    to_columns,
                });
            }
        }
        Ok(CompletionCatalog {
            database: database.to_owned(),
            schemas: Vec::new(),
            search_path: Vec::new(),
            type_names: types.into_names(),
            relations: catalog_relations,
            routines: catalog_routines,
            foreign_keys: catalog_fks,
        })
    }
}

impl Introspector for MysqlConnection {
    fn native_ddl<'a>(
        &'a self,
        target: &'a DdlTarget,
        _info: Option<&'a ObjectInfo>,
    ) -> MetaFuture<'a, Option<ObjectDdl>> {
        Box::pin(self.native_definition(target))
    }

    fn properties<'a>(
        &'a self,
        object: &'a ObjectRef,
        kind: ObjectKind,
    ) -> MetaFuture<'a, ObjectProperties> {
        Box::pin(self.object_properties(object, kind))
    }

    fn dependents<'a>(
        &'a self,
        object: &'a ObjectRef,
        kind: ObjectKind,
    ) -> MetaFuture<'a, ObjectDependents> {
        Box::pin(self.object_dependents(object, kind))
    }

    fn databases(&self) -> MetaFuture<'_, Vec<DatabaseInfo>> {
        Box::pin(async move {
            self.meta(DATABASES_SQL, &[])
                .await?
                .iter()
                .map(|row| {
                    let name = text_req(row, 0)?;
                    Ok(DatabaseInfo {
                        current: flag(row, 1),
                        system: is_system(&name),
                        // SCHEMATA lists only the databases the user has a privilege on.
                        accessible: true,
                        comment: None,
                        name,
                    })
                })
                .collect()
        })
    }

    fn schemas<'a>(&'a self, _database: &'a str) -> MetaFuture<'a, Vec<SchemaInfo>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn object_counts<'a>(
        &'a self,
        database: &'a str,
        schema: Option<&'a str>,
    ) -> MetaFuture<'a, Vec<ObjectCount>> {
        Box::pin(async move {
            no_schema(schema)?;
            let rows = self.meta(&counts_sql(), &[database; 5]).await?;
            let Some(row) = rows.first() else {
                return Err(YadbeError::unknown_database(database));
            };
            if count(row, 0) == 0 {
                return Err(YadbeError::unknown_database(database));
            }
            let system = is_system(database);
            let kinds = [
                ObjectKind::Table,
                ObjectKind::View,
                ObjectKind::Function,
                ObjectKind::Procedure,
            ];
            Ok(kinds
                .into_iter()
                .enumerate()
                .map(|(index, kind)| {
                    let count = count(row, index + 1);
                    ObjectCount {
                        kind,
                        count,
                        system_count: if system { count } else { 0 },
                    }
                })
                .collect())
        })
    }

    fn objects<'a>(
        &'a self,
        database: &'a str,
        schema: Option<&'a str>,
        kind: ObjectKind,
    ) -> MetaFuture<'a, Vec<ObjectInfo>> {
        Box::pin(async move {
            no_schema(schema)?;
            match kind {
                ObjectKind::Table | ObjectKind::View => self.relations(database, kind).await,
                ObjectKind::Function | ObjectKind::Procedure => self.routines(database, kind).await,
                ObjectKind::MaterializedView | ObjectKind::Sequence | ObjectKind::Type => {
                    Ok(Vec::new())
                }
            }
        })
    }

    fn table_details<'a>(&'a self, table: &'a ObjectRef) -> MetaFuture<'a, TableDetails> {
        Box::pin(async move {
            no_schema(table.schema.as_deref())?;
            self.details(table).await
        })
    }

    fn completion_catalog<'a>(
        &'a self,
        database: &'a str,
        _include_system: bool,
    ) -> MetaFuture<'a, CompletionCatalog> {
        // Objects are flagged system by their database only: a database's catalog is whole.
        Box::pin(self.catalog(database))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_become_sql_expressions() {
        let mysql = |raw: &str, data_type: &str, extra: &str| {
            default_expression(Some(raw.to_owned()), data_type, extra, false)
        };
        assert_eq!(mysql("abc", "varchar", "").as_deref(), Some("'abc'"));
        assert_eq!(mysql("it's", "varchar", "").as_deref(), Some("'it''s'"));
        assert_eq!(mysql("0", "int", "").as_deref(), Some("0"));
        assert_eq!(
            mysql("CURRENT_TIMESTAMP", "timestamp", "DEFAULT_GENERATED").as_deref(),
            Some("CURRENT_TIMESTAMP")
        );
        assert_eq!(
            mysql("uuid()", "char", "DEFAULT_GENERATED").as_deref(),
            Some("uuid()")
        );
        assert_eq!(
            default_expression(Some("NULL".into()), "varchar", "", true),
            None
        );
        assert_eq!(
            default_expression(Some("'abc'".into()), "varchar", "", true).as_deref(),
            Some("'abc'")
        );
        assert_eq!(default_expression(None, "int", "", false), None);
    }

    #[test]
    fn reads_generated_columns_and_actions() {
        let stored = generated("STORED GENERATED", Some("(`a` + `b`)".into())).expect("stored");
        assert!(stored.stored);
        assert!(generated("VIRTUAL GENERATED", None).is_some_and(|g| !g.stored));
        assert!(generated("DEFAULT_GENERATED", None).is_none());
        assert!(generated("auto_increment", None).is_none());
        assert_eq!(fk_action(Some("SET NULL")), ForeignKeyAction::SetNull);
        assert_eq!(fk_action(None), ForeignKeyAction::NoAction);
        assert_eq!(argument(Some("IN"), "p", "int"), "IN p int");
        assert_eq!(argument(None, "p", "int"), "p int");
    }

    #[test]
    fn binary_catalog_text_reads_as_text() {
        let row = vec![Value::bytes(b"abc"), Value::Null, Value::Int("12".into())];
        assert_eq!(text(&row, 0).as_deref(), Some("abc"));
        assert_eq!(text(&row, 1), None);
        assert_eq!(number(&row, 2), Some(12));
    }
}
