//! SQLite introspection through the pragma table-valued functions (`pragma_table_list`,
//! `pragma_table_xinfo`, `pragma_foreign_key_list`, `pragma_index_list`…), completed by the
//! `CREATE` text for what pragmas do not expose (checks, generation expressions, triggers).
//! One database (`main`), no schemas, tables and views only.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{Params, Row};

use super::ddl::{parse_index, parse_table, parse_trigger};
use super::{SqliteConnection, blocking, classify, kind_of};
use crate::db::driver::recorded_sync;
use crate::db::errors::YadbeError;
use crate::db::introspect::{Introspector, MetaFuture, TypeInterner, index_u32};
use crate::db::meta::{
    CatalogForeignKey, CatalogRelation, CheckConstraint, ColumnInfo, CompletionCatalog,
    DatabaseInfo, ForeignKey, ForeignKeyAction, Generated, Identity, IncomingForeignKey,
    IncomingForeignKeys, IndexInfo, KeyConstraint, ObjectCount, ObjectDetail, ObjectInfo,
    ObjectKind, ObjectRef, RelationSummary, SchemaInfo, TableDetails, TriggerInfo,
};

const MAIN: &str = "main";

const COUNTS_SQL: &str = r"
SELECT type, count(*), sum(type = 'shadow' OR name LIKE 'sqlite\_%' ESCAPE '\')
FROM pragma_table_list
WHERE schema = 'main'
GROUP BY type";

const OBJECTS_SQL: &str = "\
SELECT name, type FROM pragma_table_list
WHERE schema = 'main' AND type IN (?1, ?2, ?3, ?4)
ORDER BY name";

const RELATION_SQL: &str = "\
SELECT t.type, t.wr, m.sql
FROM pragma_table_list(?1) t
LEFT JOIN sqlite_schema m ON m.name = t.name AND m.type IN ('table', 'view')
WHERE t.schema = 'main'";

const COLUMNS_SQL: &str = "\
SELECT name, type, \"notnull\", dflt_value, pk, hidden
FROM pragma_table_xinfo(?1, 'main')
ORDER BY cid";

const FOREIGN_KEYS_SQL: &str = "\
SELECT id, \"table\", \"from\", \"to\", on_update, on_delete
FROM pragma_foreign_key_list(?1, 'main')
ORDER BY id, seq";

const INDEXES_SQL: &str = "\
SELECT il.name, il.\"unique\", il.origin, ii.name, m.sql
FROM pragma_index_list(?1, 'main') il
JOIN pragma_index_info(il.name, 'main') ii
LEFT JOIN sqlite_schema m ON m.type = 'index' AND m.name = il.name
ORDER BY il.name, ii.seqno";

const PRIMARY_KEY_SQL: &str = "\
SELECT name FROM pragma_table_info(?1, 'main') WHERE pk > 0 ORDER BY pk";

const TRIGGERS_SQL: &str = "\
SELECT name, sql FROM sqlite_schema
WHERE type = 'trigger' AND tbl_name = ?1
ORDER BY name";

const CATALOG_COLUMNS_SQL: &str = r"
SELECT t.name, t.type, c.name, c.type, c.pk
FROM pragma_table_list t
LEFT JOIN pragma_table_xinfo(t.name, 'main') c ON c.hidden <> 1
WHERE t.schema = 'main' AND t.type IN ('table', 'view', 'virtual', 'shadow')
  AND (?1 OR (t.type <> 'shadow' AND t.name NOT LIKE 'sqlite\_%' ESCAPE '\'))
ORDER BY t.name, c.cid";

const CATALOG_FOREIGN_KEYS_SQL: &str = "\
SELECT t.name, f.id, f.\"table\", f.\"from\", f.\"to\"
FROM pragma_table_list t
JOIN pragma_foreign_key_list(t.name, 'main') f
WHERE t.schema = 'main' AND t.type = 'table'
ORDER BY t.name, f.id, f.seq";

const INCOMING_FOREIGN_KEYS_SQL: &str = "\
SELECT t.name, f.id, f.\"from\", f.\"to\", f.on_update, f.on_delete
FROM pragma_table_list t
JOIN pragma_foreign_key_list(t.name, 'main') f
WHERE t.schema = 'main' AND t.type = 'table' AND f.\"table\" = ?1 COLLATE NOCASE
ORDER BY t.name, f.id, f.seq";

/// An index from the pragmas: name, unique, origin, statement, key columns (`None` for an
/// expression).
type IndexGroup = (String, bool, String, Option<String>, Vec<Option<String>>);

fn is_system(name: &str, table_type: &str) -> bool {
    table_type == "shadow" || name.starts_with("sqlite_")
}

fn fk_action(action: &str) -> ForeignKeyAction {
    match action.to_ascii_uppercase().as_str() {
        "RESTRICT" => ForeignKeyAction::Restrict,
        "CASCADE" => ForeignKeyAction::Cascade,
        "SET NULL" => ForeignKeyAction::SetNull,
        "SET DEFAULT" => ForeignKeyAction::SetDefault,
        _ => ForeignKeyAction::NoAction,
    }
}

fn check_database(database: &str) -> Result<(), YadbeError> {
    if database == MAIN {
        Ok(())
    } else {
        Err(YadbeError::unknown_database(database))
    }
}

impl SqliteConnection {
    /// Runs `work` on the connection's blocking thread.
    async fn with_conn<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Meta<'_>) -> Result<T, YadbeError> + Send + 'static,
    ) -> Result<T, YadbeError> {
        let conn = Arc::clone(&self.conn);
        let recorder = Arc::clone(&self.recorder);
        let path = self.path.clone();
        blocking(move || {
            let conn = conn
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            work(&Meta {
                conn: &conn,
                recorder: &*recorder,
                path: &path,
            })
        })
        .await
    }
}

/// One metadata read on a locked connection.
struct Meta<'a> {
    conn: &'a rusqlite::Connection,
    recorder: &'a dyn crate::db::driver::StatementRecorder,
    path: &'a std::path::Path,
}

impl Meta<'_> {
    /// Runs one recorded query and maps its rows.
    fn rows<T>(
        &self,
        sql: &str,
        params: impl Params,
        map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<Vec<T>, YadbeError> {
        recorded_sync(
            self.recorder,
            sql,
            |rows: &Vec<T>| u64::try_from(rows.len()).ok(),
            || {
                let mut stmt = self
                    .conn
                    .prepare_cached(sql)
                    .map_err(|e| classify(&e, self.path))?;
                stmt.query_map(params, map)
                    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<T>>>())
                    .map_err(|e| classify(&e, self.path))
            },
        )
    }

    fn counts(&self) -> Result<Vec<ObjectCount>, YadbeError> {
        let rows = self.rows(COUNTS_SQL, rusqlite::params![], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        let total = |types: &[&str]| {
            let (mut count, mut system) = (0, 0);
            for (t, n, s) in &rows {
                if types.contains(&t.as_str()) {
                    count += n;
                    system += s;
                }
            }
            (
                u32::try_from(count).unwrap_or(u32::MAX),
                u32::try_from(system).unwrap_or(u32::MAX),
            )
        };
        let (tables, system_tables) = total(&["table", "virtual", "shadow"]);
        let (views, system_views) = total(&["view"]);
        Ok(vec![
            ObjectCount {
                kind: ObjectKind::Table,
                count: tables,
                system_count: system_tables,
            },
            ObjectCount {
                kind: ObjectKind::View,
                count: views,
                system_count: system_views,
            },
        ])
    }

    fn objects(&self, kind: ObjectKind) -> Result<Vec<ObjectInfo>, YadbeError> {
        let types: [&str; 4] = match kind {
            ObjectKind::Table => ["table", "virtual", "shadow", "table"],
            ObjectKind::View => ["view"; 4],
            _ => return Ok(Vec::new()),
        };
        self.rows(OBJECTS_SQL, types, |r| {
            let name: String = r.get(0)?;
            let table_type: String = r.get(1)?;
            Ok(ObjectInfo {
                kind,
                id: name.clone(),
                system: is_system(&name, &table_type),
                name,
                comment: None,
                detail: ObjectDetail::Relation(RelationSummary {
                    row_estimate: None,
                    partitioned: false,
                    foreign: false,
                }),
            })
        })
    }

    fn details(&self, table: &ObjectRef) -> Result<TableDetails, YadbeError> {
        let name = table.name.as_str();
        let relation = self.rows(RELATION_SQL, [name], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        let Some((table_type, without_rowid, sql)) = relation.into_iter().next() else {
            return Err(YadbeError::object_not_found(name));
        };
        let kind = if table_type == "view" {
            ObjectKind::View
        } else {
            ObjectKind::Table
        };
        let ddl = sql.as_deref().map(parse_table).unwrap_or_default();

        struct Column {
            name: String,
            type_name: String,
            not_null: bool,
            default: Option<String>,
            pk: i64,
            hidden: i64,
        }
        let columns = self.rows(COLUMNS_SQL, [name], |r| {
            Ok(Column {
                name: r.get(0)?,
                type_name: r.get(1)?,
                not_null: r.get(2)?,
                default: r.get(3)?,
                pk: r.get(4)?,
                hidden: r.get(5)?,
            })
        })?;
        let mut pk: Vec<(i64, String)> = columns
            .iter()
            .filter(|c| c.pk > 0)
            .map(|c| (c.pk, c.name.clone()))
            .collect();
        pk.sort();
        // `INTEGER PRIMARY KEY` aliases the rowid: generated when omitted.
        let rowid_alias = !without_rowid
            && kind == ObjectKind::Table
            && pk.len() == 1
            && columns
                .iter()
                .any(|c| c.pk == 1 && c.type_name.eq_ignore_ascii_case("INTEGER"));

        let visible = columns.into_iter().filter(|c| c.hidden != 1);
        let mut details = TableDetails {
            table: table.clone(),
            kind,
            comment: None,
            row_estimate: None,
            columns: Vec::new(),
            primary_key: (!pk.is_empty()).then(|| KeyConstraint {
                name: None,
                columns: pk.iter().map(|(_, n)| n.clone()).collect(),
            }),
            unique_keys: Vec::new(),
            foreign_keys: Vec::new(),
            checks: ddl
                .checks
                .iter()
                .map(|(name, expression)| CheckConstraint {
                    name: name.clone(),
                    expression: expression.clone(),
                })
                .collect(),
            indexes: Vec::new(),
            triggers: Vec::new(),
        };
        for (index, c) in visible.enumerate() {
            let generated = (c.hidden == 2 || c.hidden == 3).then(|| Generated {
                stored: c.hidden == 3,
                expression: ddl
                    .generated
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(&c.name))
                    .map(|(_, e)| e.clone()),
            });
            details.columns.push(ColumnInfo {
                kind: kind_of(Some(&c.type_name)),
                ordinal: index_u32(index + 1),
                // A rowid alias never holds NULL, whatever its declaration says.
                nullable: !c.not_null && !(rowid_alias && c.pk == 1),
                identity: (rowid_alias && c.pk == 1).then_some(Identity::ByDefault),
                default: c.default,
                generated,
                comment: None,
                primary_key: false,
                foreign_key: false,
                type_name: c.type_name,
                name: c.name,
            });
        }

        let fk_rows = self.rows(FOREIGN_KEYS_SQL, [name], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut current: Option<i64> = None;
        for (id, parent, from, to, on_update, on_delete) in fk_rows {
            if current != Some(id) {
                current = Some(id);
                details.foreign_keys.push(ForeignKey {
                    name: None,
                    columns: Vec::new(),
                    referenced_table: ObjectRef {
                        database: table.database.clone(),
                        schema: None,
                        name: parent,
                    },
                    referenced_columns: Vec::new(),
                    on_update: fk_action(&on_update),
                    on_delete: fk_action(&on_delete),
                    deferrable: false,
                });
            }
            if let Some(fk) = details.foreign_keys.last_mut() {
                fk.columns.push(from);
                fk.referenced_columns.extend(to);
            }
        }
        // `REFERENCES parent` without columns targets the parent's primary key.
        for fk in &mut details.foreign_keys {
            if fk.referenced_columns.len() != fk.columns.len() {
                fk.referenced_columns =
                    self.rows(PRIMARY_KEY_SQL, [fk.referenced_table.name.as_str()], |r| {
                        r.get(0)
                    })?;
            }
        }

        let index_rows = self.rows(INDEXES_SQL, [name], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        // One entry per index: its pragma key columns (`None` for an expression).
        let mut groups: Vec<IndexGroup> = Vec::new();
        for (index_name, unique, origin, column, sql) in index_rows {
            match groups.last_mut() {
                Some(group) if group.0 == index_name => group.4.push(column),
                _ => groups.push((index_name, unique, origin, sql, vec![column])),
            }
        }
        for (index_name, unique, origin, sql, names) in groups {
            let (keys, predicate) = sql.as_deref().map(parse_index).unwrap_or_default();
            // Plain keys by their pragma name, expressions by their text in the statement.
            let columns = names
                .iter()
                .enumerate()
                .map(|(i, name)| match name {
                    Some(name) => name.clone(),
                    None => keys.get(i).cloned().unwrap_or_else(|| "?".to_owned()),
                })
                .collect();
            if origin == "u" && names.iter().all(Option::is_some) {
                details.unique_keys.push(KeyConstraint {
                    name: None,
                    columns: names.into_iter().flatten().collect(),
                });
            }
            details.indexes.push(IndexInfo {
                name: index_name,
                columns,
                unique,
                primary: origin == "pk",
                method: None,
                predicate,
                definition: sql,
            });
        }

        details.triggers = self
            .rows(TRIGGERS_SQL, [name], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?
            .into_iter()
            .map(|(name, sql)| {
                let (timing, events) = sql
                    .as_deref()
                    .and_then(parse_trigger)
                    .unwrap_or((crate::db::meta::TriggerTiming::Before, Vec::new()));
                TriggerInfo {
                    name,
                    timing,
                    events,
                    for_each_row: true,
                    enabled: true,
                    function: None,
                    definition: sql,
                }
            })
            .collect();
        details.mark_key_columns();
        Ok(details)
    }

    fn catalog(&self, include_system: bool) -> Result<CompletionCatalog, YadbeError> {
        let rows = self.rows(CATALOG_COLUMNS_SQL, [include_system], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<i64>>(4)?,
            ))
        })?;
        let mut types = TypeInterner::default();
        let mut relations: Vec<CatalogRelation> = Vec::new();
        let mut primary_keys: Vec<Vec<(i64, u32)>> = Vec::new();
        let mut by_name: HashMap<String, u32> = HashMap::new();
        for (table, table_type, column, column_type, pk) in rows {
            if relations.last().is_none_or(|r| r.name != table) {
                by_name.insert(table.to_ascii_lowercase(), index_u32(relations.len()));
                relations.push(CatalogRelation {
                    schema: None,
                    name: table,
                    kind: if table_type == "view" {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    },
                    columns: Vec::new(),
                    column_types: Vec::new(),
                });
                primary_keys.push(Vec::new());
            }
            let (Some(relation), Some(keys), Some(column)) =
                (relations.last_mut(), primary_keys.last_mut(), column)
            else {
                continue;
            };
            if let Some(pk) = pk.filter(|&pk| pk > 0) {
                keys.push((pk, index_u32(relation.columns.len())));
            }
            relation.columns.push(column);
            relation
                .column_types
                .push(types.intern(column_type.as_deref().unwrap_or_default()));
        }
        for keys in &mut primary_keys {
            keys.sort();
        }

        let fk_rows = self.rows(CATALOG_FOREIGN_KEYS_SQL, rusqlite::params![], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        let mut foreign_keys: Vec<CatalogForeignKey> = Vec::new();
        let mut current: Option<(String, i64)> = None;
        let mut valid = true;
        for (table, id, parent, from, to) in fk_rows {
            let (Some(&from_rel), Some(&to_rel)) = (
                by_name.get(&table.to_ascii_lowercase()),
                by_name.get(&parent.to_ascii_lowercase()),
            ) else {
                continue;
            };
            if current.as_ref() != Some(&(table.clone(), id)) {
                if !valid {
                    foreign_keys.pop();
                }
                current = Some((table, id));
                valid = true;
                foreign_keys.push(CatalogForeignKey {
                    from: from_rel,
                    from_columns: Vec::new(),
                    to: to_rel,
                    to_columns: Vec::new(),
                });
            }
            let position = |relation: u32, name: &str| {
                relations
                    .get(relation as usize)
                    .and_then(|r| r.columns.iter().position(|c| c.eq_ignore_ascii_case(name)))
                    .map(index_u32)
            };
            let Some(fk) = foreign_keys.last_mut() else {
                continue;
            };
            let target = match &to {
                Some(to) => position(to_rel, to),
                None => primary_keys
                    .get(to_rel as usize)
                    .and_then(|keys| keys.get(fk.from_columns.len()))
                    .map(|(_, column)| *column),
            };
            match (position(from_rel, &from), target) {
                (Some(f), Some(t)) => {
                    fk.from_columns.push(f);
                    fk.to_columns.push(t);
                }
                _ => valid = false,
            }
        }
        if !valid {
            foreign_keys.pop();
        }

        Ok(CompletionCatalog {
            database: MAIN.to_owned(),
            schemas: Vec::new(),
            search_path: Vec::new(),
            type_names: types.into_names(),
            relations,
            routines: Vec::new(),
            foreign_keys,
        })
    }
}

impl Meta<'_> {
    fn incoming(&self, table: &ObjectRef) -> Result<IncomingForeignKeys, YadbeError> {
        let rows = self.rows(INCOMING_FOREIGN_KEYS_SQL, [table.name.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut keys: Vec<IncomingForeignKey> = Vec::new();
        let mut current: Option<(String, i64)> = None;
        for (name, id, from, to, on_update, on_delete) in rows {
            let key = (name.clone(), id);
            if current.as_ref() != Some(&key) {
                current = Some(key);
                keys.push(IncomingForeignKey {
                    table: ObjectRef {
                        database: table.database.clone(),
                        schema: None,
                        name,
                    },
                    foreign_key: ForeignKey {
                        name: None,
                        columns: Vec::new(),
                        referenced_table: table.clone(),
                        referenced_columns: Vec::new(),
                        on_update: fk_action(&on_update),
                        on_delete: fk_action(&on_delete),
                        deferrable: false,
                    },
                });
            }
            if let Some(last) = keys.last_mut() {
                last.foreign_key.columns.push(from);
                last.foreign_key.referenced_columns.extend(to);
            }
        }
        // `REFERENCES parent` without columns targets the parent's primary key.
        if keys
            .iter()
            .any(|k| k.foreign_key.referenced_columns.len() != k.foreign_key.columns.len())
        {
            let pk: Vec<String> =
                self.rows(PRIMARY_KEY_SQL, [table.name.as_str()], |r| r.get(0))?;
            for key in &mut keys {
                if key.foreign_key.referenced_columns.len() != key.foreign_key.columns.len() {
                    key.foreign_key.referenced_columns.clone_from(&pk);
                }
            }
        }
        Ok(IncomingForeignKeys {
            supported: true,
            keys,
        })
    }
}

impl Introspector for SqliteConnection {
    fn databases(&self) -> MetaFuture<'_, Vec<DatabaseInfo>> {
        Box::pin(async {
            Ok(vec![DatabaseInfo {
                name: MAIN.to_owned(),
                current: true,
                system: false,
                accessible: true,
                comment: None,
            }])
        })
    }

    fn schemas<'a>(&'a self, database: &'a str) -> MetaFuture<'a, Vec<SchemaInfo>> {
        Box::pin(async move {
            check_database(database)?;
            Ok(Vec::new())
        })
    }

    fn object_counts<'a>(
        &'a self,
        database: &'a str,
        _schema: Option<&'a str>,
    ) -> MetaFuture<'a, Vec<ObjectCount>> {
        Box::pin(async move {
            check_database(database)?;
            self.with_conn(|meta| meta.counts()).await
        })
    }

    fn objects<'a>(
        &'a self,
        database: &'a str,
        _schema: Option<&'a str>,
        kind: ObjectKind,
    ) -> MetaFuture<'a, Vec<ObjectInfo>> {
        Box::pin(async move {
            check_database(database)?;
            self.with_conn(move |meta| meta.objects(kind)).await
        })
    }

    fn table_details<'a>(&'a self, table: &'a ObjectRef) -> MetaFuture<'a, TableDetails> {
        Box::pin(async move {
            check_database(&table.database)?;
            let table = table.clone();
            self.with_conn(move |meta| meta.details(&table)).await
        })
    }

    fn completion_catalog<'a>(
        &'a self,
        database: &'a str,
        include_system: bool,
    ) -> MetaFuture<'a, CompletionCatalog> {
        Box::pin(async move {
            check_database(database)?;
            self.with_conn(move |meta| meta.catalog(include_system))
                .await
        })
    }

    fn incoming_foreign_keys<'a>(
        &'a self,
        table: &'a ObjectRef,
    ) -> MetaFuture<'a, IncomingForeignKeys> {
        Box::pin(async move {
            check_database(&table.database)?;
            let table = table.clone();
            self.with_conn(move |meta| meta.incoming(&table)).await
        })
    }
}
