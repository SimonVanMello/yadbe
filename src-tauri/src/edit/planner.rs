//! `EditPlanner`: a change set and the table's shape → ordered, parameterized DML (F-082 to
//! F-086). Deletes run first, then one `UPDATE` per row (its cell updates merged), then the
//! inserts, each returning the stored row.
//!
//! **Optimistic concurrency (F-089).** An `UPDATE` matches its row by key *and* by the values
//! the edited columns were read with; a `DELETE` by key and every value of the row as read.
//! A row changed by someone else meanwhile matches nothing, which the apply reports as a
//! conflict. Edited columns only for an update (the spec's rule: changes made elsewhere to
//! other columns survive, and are not conflicts); the whole row for a delete, which would
//! otherwise destroy a change it never saw. Columns the engine cannot compare exactly are
//! left out (`OriginalCheck::Unchecked`), the key never is.

use std::collections::{HashMap, HashSet};

use crate::db::bound::SqlBuilder;
use crate::db::dialect::Dialect;
use crate::db::driver::BoundStatement;
use crate::db::edit_dialect::{IdentityInsert, InsertReturning, plain_text};
use crate::db::errors::YadbeError;
use crate::db::meta::Identity;
use crate::db::value::Value;
use crate::edit::model::{ChangeSet, EditPreview, PlannedChange, PlannedStatement};
use crate::session::table_model::ColumnReadOnlyReason;
use crate::session::table_shape::TableShape;

/// A column an `UPDATE` writes: its index, the value written, the value read.
pub type WrittenCell = (usize, Value, Option<Value>);

/// A row's key, the cell updates merged into its statement, and the cells written.
type MergedRow = (Vec<Value>, Vec<u32>, Vec<WrittenCell>);

/// What a plan is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanMode {
    /// The user's pending changes.
    Edit,
    /// Reverting a change set (F-090): rows are inserted back with their identity values,
    /// even where the server always generates them.
    Restore,
}

/// One statement of a plan.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedEdit {
    pub change: PlannedChange,
    pub statement: BoundStatement,
    /// The row as the user knows it, for an update or a delete (`id = 42`).
    pub row: Option<String>,
    /// For an update, the cells it writes.
    pub written: Vec<WrittenCell>,
    /// To run on the connection when the apply fails after this statement started (a session
    /// setting the statement turns off itself when it succeeds).
    pub cleanup: Option<String>,
}

impl PlannedEdit {
    /// Updates and deletes must affect exactly one row.
    pub fn one_row(&self) -> bool {
        !matches!(self.change, PlannedChange::Insert { .. })
    }
}

/// A key compared by its text forms, so `1` typed as text and as an integer match.
fn key_id(key: &[Value]) -> Vec<Option<String>> {
    key.iter().map(plain_text).collect()
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The column, which must be writable. `restore`: an always-generated identity column can be
/// written when the dialect has a way to (`true` is returned with it then).
fn writable(
    shape: &TableShape,
    dialect: &dyn Dialect,
    name: &str,
    restore: bool,
) -> Result<(usize, bool), YadbeError> {
    let (index, column) = shape.require(name)?;
    let restored_identity = restore
        && column.identity == Some(Identity::Always)
        && dialect.identity_insert() != IdentityInsert::Refused;
    match shape.info.columns[index].read_only_reason {
        Some(ColumnReadOnlyReason::Identity) if restored_identity => Ok((index, true)),
        Some(reason) => Err(YadbeError::invalid_argument(
            format!("The column \"{name}\" cannot be written ({reason:?})."),
            format!("La colonne « {name} » ne peut pas être modifiée ({reason:?})."),
        )),
        None => Ok((index, false)),
    }
}

/// Plans the user's `changes` on `shape`.
pub fn plan(
    dialect: &dyn Dialect,
    shape: &TableShape,
    changes: &ChangeSet,
) -> Result<Vec<PlannedEdit>, YadbeError> {
    plan_with(dialect, shape, changes, PlanMode::Edit)
}

/// Plans `changes` on `shape`. Fails with `tableNotEditable` or `invalidArgument`; never runs
/// anything.
pub fn plan_with(
    dialect: &dyn Dialect,
    shape: &TableShape,
    changes: &ChangeSet,
    mode: PlanMode,
) -> Result<Vec<PlannedEdit>, YadbeError> {
    shape.check_editable()?;
    if changes.updates.is_empty() && changes.inserts.is_empty() && changes.deletes.is_empty() {
        return Err(YadbeError::invalid_argument(
            "There is nothing to apply.",
            "Il n'y a rien à appliquer.",
        ));
    }
    let table = &shape.details.table;
    let mut planned = Vec::new();

    let mut deleted = Vec::new();
    for (index, delete) in changes.deletes.iter().enumerate() {
        let key = &delete.key;
        shape.check_key(key)?;
        deleted.push(key_id(key));
        let mut b = SqlBuilder::new(dialect);
        b.push("DELETE FROM ").table(table).push(" WHERE ");
        shape.push_key(&mut b, key);
        let mut seen = HashSet::new();
        for value in &delete.values {
            let (column, _) = shape.require(&value.column)?;
            if shape.identity.contains(&column) || !seen.insert(column) {
                continue;
            }
            shape.push_original(&mut b, column, &value.value);
        }
        planned.push(PlannedEdit {
            change: PlannedChange::Delete {
                key: key.clone(),
                delete: to_u32(index),
            },
            statement: b.finish(false),
            row: Some(shape.describe_key(key)),
            written: Vec::new(),
            cleanup: None,
        });
    }

    // Rows in the order they first appear; per row, columns in the order they first appear
    // with the last value given and the first original.
    let mut rows: Vec<MergedRow> = Vec::new();
    let mut by_key: HashMap<Vec<Option<String>>, usize> = HashMap::new();
    for (index, update) in changes.updates.iter().enumerate() {
        shape.check_key(&update.key)?;
        let (column, _) = writable(shape, dialect, &update.column, false)?;
        let id = key_id(&update.key);
        if deleted.contains(&id) {
            continue;
        }
        let at = *by_key.entry(id).or_insert_with(|| {
            rows.push((update.key.clone(), Vec::new(), Vec::new()));
            rows.len() - 1
        });
        let (_, updates, cells) = &mut rows[at];
        updates.push(to_u32(index));
        match cells.iter_mut().find(|(c, _, _)| *c == column) {
            Some(slot) => {
                slot.1 = update.value.clone();
                if slot.2.is_none() {
                    slot.2.clone_from(&update.original);
                }
            }
            None => cells.push((column, update.value.clone(), update.original.clone())),
        }
    }
    for (key, updates, cells) in rows {
        let mut b = SqlBuilder::new(dialect);
        b.push("UPDATE ").table(table).push(" SET ");
        for (n, (index, value, _)) in cells.iter().enumerate() {
            if n > 0 {
                b.push(", ");
            }
            let column = &shape.details.columns[*index];
            b.ident(&column.name).push(" = ").value(value, Some(column));
        }
        b.push(" WHERE ");
        shape.push_key(&mut b, &key);
        for (index, _, original) in &cells {
            if let Some(original) = original
                && !shape.identity.contains(index)
            {
                shape.push_original(&mut b, *index, original);
            }
        }
        planned.push(PlannedEdit {
            row: Some(shape.describe_key(&key)),
            change: PlannedChange::Update { key, updates },
            statement: b.finish(false),
            written: cells,
            cleanup: None,
        });
    }

    let returning = match dialect.insert_returning() {
        InsertReturning::Output
            if dialect.output_conflicts_with_triggers() && shape.has_triggers =>
        {
            InsertReturning::ReadBack
        }
        other => other,
    };
    for (index, insert) in changes.inserts.iter().enumerate() {
        let mut values: Vec<(usize, &Value)> = Vec::new();
        let mut identity_given = false;
        for value in &insert.values {
            let (column, identity) =
                writable(shape, dialect, &value.column, mode == PlanMode::Restore)?;
            identity_given |= identity;
            match values.iter_mut().find(|(c, _)| *c == column) {
                Some(slot) => slot.1 = &value.value,
                None => values.push((column, &value.value)),
            }
        }
        let identity = identity_given.then(|| dialect.identity_insert());
        let (statement, cleanup) = insert_statement(dialect, shape, &values, returning, identity);
        planned.push(PlannedEdit {
            change: PlannedChange::Insert {
                insert: to_u32(index),
            },
            statement,
            row: None,
            written: Vec::new(),
            cleanup,
        });
    }
    Ok(planned)
}

fn insert_statement(
    dialect: &dyn Dialect,
    shape: &TableShape,
    values: &[(usize, &Value)],
    returning: InsertReturning,
    identity: Option<IdentityInsert>,
) -> (BoundStatement, Option<String>) {
    let table = &shape.details.table;
    let switch = identity == Some(IdentityInsert::SessionSwitch);
    let quoted_table = crate::db::meta::qualified_name(dialect, table);
    let mut b = SqlBuilder::new(dialect);
    if switch {
        b.push("SET IDENTITY_INSERT ")
            .push(&quoted_table)
            .push(" ON; ");
    }
    b.push("INSERT INTO ").table(table);
    if !values.is_empty() {
        b.push(" (");
        for (n, (index, _)) in values.iter().enumerate() {
            if n > 0 {
                b.push(", ");
            }
            b.ident(&shape.details.columns[*index].name);
        }
        b.push(")");
    }
    if identity == Some(IdentityInsert::Overriding) {
        b.push(" OVERRIDING SYSTEM VALUE");
    }
    if returning == InsertReturning::Output {
        b.push(" OUTPUT ");
        shape.select_list(&mut b, "INSERTED.");
    }
    if values.is_empty() {
        b.push(" ").push(dialect.default_values());
    } else {
        b.push(" VALUES (");
        for (n, (index, value)) in values.iter().enumerate() {
            if n > 0 {
                b.push(", ");
            }
            b.value(value, Some(&shape.details.columns[*index]));
        }
        b.push(")");
    }
    let off = format!("SET IDENTITY_INSERT {quoted_table} OFF");
    let statement = match returning {
        InsertReturning::Returning => {
            b.push(" RETURNING ");
            shape.select_list(&mut b, "");
            b.finish(true)
        }
        InsertReturning::Output => {
            if switch {
                b.push("; ").push(&off);
            }
            b.finish(true)
        }
        InsertReturning::ReadBack => read_back(b, shape, values, switch.then_some(off.as_str())),
    };
    (statement, switch.then_some(off))
}

/// `INSERT …; SELECT … WHERE <key>`, the key from the values given and the identity the
/// statement generated. Without a way to find the row, the insert alone (nothing returned).
/// `last`: a statement to end the batch with.
fn read_back(
    mut b: SqlBuilder<'_>,
    shape: &TableShape,
    values: &[(usize, &Value)],
    last: Option<&str>,
) -> BoundStatement {
    let dialect = b.dialect();
    let mut key = Vec::new();
    for &index in &shape.identity {
        let column = &shape.details.columns[index];
        if let Some((_, value)) = values.iter().find(|(c, _)| *c == index) {
            key.push((index, Some(*value)));
        } else if column.identity.is_some() && dialect.last_identity().is_some() {
            key.push((index, None));
        } else {
            if let Some(last) = last {
                b.push("; ").push(last);
            }
            return b.finish(false);
        }
    }
    b.push("; SELECT ");
    shape.select_list(&mut b, "");
    b.push(" FROM ").table(&shape.details.table).push(" WHERE ");
    for (n, (index, value)) in key.iter().enumerate() {
        if n > 0 {
            b.push(" AND ");
        }
        let column = &shape.details.columns[*index];
        b.ident(&column.name).push(" = ");
        match value {
            Some(value) => {
                b.value(value, Some(column));
            }
            None => {
                b.push(dialect.last_identity().unwrap_or("NULL"));
            }
        }
    }
    if let Some(last) = last {
        b.push("; ").push(last);
    }
    b.finish(true)
}

/// The preview of a plan: its statements and the whole transaction as a script.
pub fn preview(dialect: &dyn Dialect, planned: &[PlannedEdit]) -> EditPreview {
    let statements: Vec<PlannedStatement> = planned
        .iter()
        .map(|p| PlannedStatement {
            change: p.change.clone(),
            sql: p.statement.display.clone(),
        })
        .collect();
    let mut script = format!("{};\n", dialect.begin_transaction());
    for statement in &statements {
        script.push_str(&statement.sql);
        script.push_str(";\n");
    }
    script.push_str(dialect.commit());
    script.push(';');
    EditPreview { statements, script }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::db::engine::Engine;
    use crate::db::errors::ErrorCode;
    use crate::db::meta::{
        ColumnInfo, Generated, Identity, KeyConstraint, ObjectKind, ObjectRef, TableDetails,
        TriggerEvent, TriggerInfo, TriggerTiming,
    };
    use crate::db::value::ValueKind;
    use crate::edit::model::{CellUpdate, ColumnValue, RowDelete, RowInsert};

    fn column(name: &str, kind: ValueKind) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            ordinal: 1,
            type_name: match kind {
                ValueKind::Int => "int".into(),
                ValueKind::Bytes => "varbinary(max)".into(),
                _ => "nvarchar(100)".into(),
            },
            kind,
            nullable: true,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            primary_key: false,
            foreign_key: false,
        }
    }

    fn shape(engine: Engine, triggers: bool, key: &[&str]) -> TableShape {
        let mut id = column("id", ValueKind::Int);
        id.identity = Some(Identity::Always);
        id.nullable = false;
        let mut line = column("line", ValueKind::Int);
        line.nullable = false;
        let mut total = column("total", ValueKind::Int);
        total.generated = Some(Generated {
            stored: true,
            expression: None,
        });
        let details = TableDetails {
            table: ObjectRef {
                database: "db".into(),
                schema: (engine != Engine::Sqlite).then(|| "s".into()),
                name: "Odd \"t\"".into(),
            },
            kind: ObjectKind::Table,
            comment: None,
            row_estimate: None,
            columns: vec![
                id,
                line,
                column("Select", ValueKind::Text),
                column("raw", ValueKind::Bytes),
                total,
            ],
            primary_key: Some(KeyConstraint {
                name: None,
                columns: key.iter().map(|k| (*k).to_owned()).collect(),
            }),
            unique_keys: vec![],
            foreign_keys: vec![],
            checks: vec![],
            indexes: vec![],
            triggers: if triggers {
                vec![TriggerInfo {
                    name: "t".into(),
                    timing: TriggerTiming::After,
                    events: vec![TriggerEvent::Insert],
                    for_each_row: false,
                    enabled: true,
                    function: None,
                    definition: None,
                }]
            } else {
                vec![]
            },
        };
        TableShape::new(engine.dialect(), details, false, &HashMap::new())
    }

    fn text(s: &str) -> Value {
        Value::Text(s.into())
    }

    fn update(key: &[i64], column: &str, value: Value) -> CellUpdate {
        CellUpdate {
            key: key.iter().map(|k| Value::int(*k)).collect(),
            column: column.into(),
            value,
            original: None,
        }
    }

    fn by_key(key: Vec<Value>) -> RowDelete {
        RowDelete {
            key,
            values: Vec::new(),
        }
    }

    #[test]
    fn checks_originals_per_engine() {
        let pg = shape(Engine::Postgres, false, &["id"]);
        let mut cell = update(&[1], "Select", text("new"));
        cell.original = Some(text("old"));
        let mut raw = update(&[1], "raw", Value::bytes(&[2]));
        raw.original = Some(Value::Null);
        let mut later = update(&[1], "Select", text("newer"));
        later.original = Some(text("ignored: the first original wins"));
        let changes = ChangeSet {
            updates: vec![cell, raw, later],
            deletes: vec![RowDelete {
                key: vec![Value::int(2)],
                values: vec![
                    ColumnValue {
                        column: "id".into(),
                        value: Value::int(2),
                    },
                    ColumnValue {
                        column: "Select".into(),
                        value: text("x"),
                    },
                    ColumnValue {
                        column: "raw".into(),
                        value: Value::Null,
                    },
                ],
            }],
            ..ChangeSet::default()
        };
        let planned = plan(Engine::Postgres.dialect(), &pg, &changes).expect("plan");
        assert_eq!(
            planned[0].statement.display,
            r#"DELETE FROM "s"."Odd ""t""" WHERE "id" = 2 AND "Select" = 'x' AND "raw" IS NULL"#
        );
        assert_eq!(
            planned[1].statement.sql,
            r#"UPDATE "s"."Odd ""t""" SET "Select" = $1, "raw" = $2 WHERE "id" = $3 AND "Select" = $4 AND "raw" IS NULL"#
        );
        assert_eq!(
            planned[1].statement.display,
            r#"UPDATE "s"."Odd ""t""" SET "Select" = 'newer', "raw" = '\x02' WHERE "id" = 1 AND "Select" = 'old' AND "raw" IS NULL"#
        );
        assert_eq!(planned[1].written.len(), 2);

        // SQL Server: an `ntext` column is compared through its text, `image` not at all.
        let mut ms = shape(Engine::Mssql, false, &["id"]);
        ms.details.columns[2].type_name = "ntext".into();
        ms.details.columns[3].type_name = "image".into();
        let mut cell = update(&[1], "Select", text("b"));
        cell.original = Some(text("a"));
        let mut raw = update(&[1], "raw", Value::bytes(&[2]));
        raw.original = Some(Value::bytes(&[1]));
        let planned = plan(
            Engine::Mssql.dialect(),
            &ms,
            &ChangeSet {
                updates: vec![cell, raw],
                ..ChangeSet::default()
            },
        )
        .expect("plan");
        assert_eq!(
            planned[0].statement.sql,
            "UPDATE [s].[Odd \"t\"] SET [Select] = @P1, [raw] = CONVERT(varbinary(max), @P2, 2) \
WHERE [id] = @P3 AND CAST([Select] AS nvarchar(max)) = CAST(@P4 AS nvarchar(max))"
        );
    }

    #[test]
    fn restores_identity_values() {
        let insert = ChangeSet {
            inserts: vec![RowInsert {
                values: vec![
                    ColumnValue {
                        column: "id".into(),
                        value: Value::int(7),
                    },
                    ColumnValue {
                        column: "line".into(),
                        value: Value::int(1),
                    },
                ],
            }],
            ..ChangeSet::default()
        };
        let pg = shape(Engine::Postgres, false, &["id"]);
        let err = plan(Engine::Postgres.dialect(), &pg, &insert).expect_err("identity");
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        let planned =
            plan_with(Engine::Postgres.dialect(), &pg, &insert, PlanMode::Restore).expect("plan");
        assert!(
            planned[0].statement.sql.starts_with(
                r#"INSERT INTO "s"."Odd ""t""" ("id", "line") OVERRIDING SYSTEM VALUE VALUES"#
            ),
            "{}",
            planned[0].statement.sql
        );
        assert_eq!(planned[0].cleanup, None);
        let ms = shape(Engine::Mssql, false, &["id"]);
        let planned =
            plan_with(Engine::Mssql.dialect(), &ms, &insert, PlanMode::Restore).expect("plan");
        let sql = &planned[0].statement.sql;
        assert!(
            sql.starts_with("SET IDENTITY_INSERT [s].[Odd \"t\"] ON; INSERT INTO"),
            "{sql}"
        );
        assert!(
            sql.ends_with("; SET IDENTITY_INSERT [s].[Odd \"t\"] OFF"),
            "{sql}"
        );
        assert_eq!(
            planned[0].cleanup.as_deref(),
            Some("SET IDENTITY_INSERT [s].[Odd \"t\"] OFF")
        );
        // A computed column stays out of reach.
        let computed = ChangeSet {
            inserts: vec![RowInsert {
                values: vec![ColumnValue {
                    column: "total".into(),
                    value: Value::int(1),
                }],
            }],
            ..ChangeSet::default()
        };
        assert!(plan_with(Engine::Mssql.dialect(), &ms, &computed, PlanMode::Restore).is_err());
    }

    #[test]
    fn orders_merges_and_quotes() {
        let shape = shape(Engine::Postgres, false, &["id", "line"]);
        let changes = ChangeSet {
            updates: vec![
                update(&[1, 1], "Select", text("a")),
                update(&[2, 1], "raw", Value::bytes(&[1])),
                update(&[1, 1], "raw", Value::Null),
                update(&[1, 1], "Select", text("b")),
                update(&[3, 1], "Select", text("gone")),
            ],
            inserts: vec![
                RowInsert {
                    values: vec![ColumnValue {
                        column: "line".into(),
                        value: Value::int(7),
                    }],
                },
                RowInsert { values: vec![] },
            ],
            deletes: vec![by_key(vec![Value::int(3), Value::int(1)])],
        };
        let planned = plan(Engine::Postgres.dialect(), &shape, &changes).expect("plan");
        let sql: Vec<&str> = planned
            .iter()
            .map(|p| p.statement.display.as_str())
            .collect();
        assert_eq!(
            sql,
            [
                r#"DELETE FROM "s"."Odd ""t""" WHERE "id" = 3 AND "line" = 1"#,
                r#"UPDATE "s"."Odd ""t""" SET "Select" = 'b', "raw" = NULL WHERE "id" = 1 AND "line" = 1"#,
                r#"UPDATE "s"."Odd ""t""" SET "raw" = '\x01' WHERE "id" = 2 AND "line" = 1"#,
                r#"INSERT INTO "s"."Odd ""t""" ("line") VALUES (7) RETURNING "id", "line", "Select", "raw", "total""#,
                r#"INSERT INTO "s"."Odd ""t""" DEFAULT VALUES RETURNING "id", "line", "Select", "raw", "total""#,
            ]
        );
        assert_eq!(
            planned[1].statement.sql,
            r#"UPDATE "s"."Odd ""t""" SET "Select" = $1, "raw" = $2 WHERE "id" = $3 AND "line" = $4"#
        );
        assert_eq!(
            planned[1].change,
            PlannedChange::Update {
                key: vec![Value::int(1), Value::int(1)],
                updates: vec![0, 2, 3]
            }
        );
        assert_eq!(planned[1].row.as_deref(), Some("id = 1, line = 1"));
        let preview = preview(Engine::Postgres.dialect(), &planned);
        assert!(preview.script.starts_with("BEGIN;\nDELETE FROM"));
        assert!(preview.script.ends_with(";\nCOMMIT;"));
    }

    #[test]
    fn sql_server_outputs_or_reads_back_inserts() {
        let insert = ChangeSet {
            inserts: vec![RowInsert {
                values: vec![
                    ColumnValue {
                        column: "line".into(),
                        value: Value::int(2),
                    },
                    ColumnValue {
                        column: "raw".into(),
                        value: Value::bytes(&[0xab]),
                    },
                ],
            }],
            ..ChangeSet::default()
        };
        let d = Engine::Mssql.dialect();
        let plain = plan(d, &shape(Engine::Mssql, false, &["id"]), &insert).expect("plan");
        assert_eq!(
            plain[0].statement.sql,
            "INSERT INTO [s].[Odd \"t\"] ([line], [raw]) OUTPUT INSERTED.[id], INSERTED.[line], \
INSERTED.[Select], INSERTED.[raw], INSERTED.[total] VALUES (@P1, CONVERT(varbinary(max), @P2, 2))"
        );
        assert_eq!(
            plain[0].statement.display,
            "INSERT INTO [s].[Odd \"t\"] ([line], [raw]) OUTPUT INSERTED.[id], INSERTED.[line], \
INSERTED.[Select], INSERTED.[raw], INSERTED.[total] VALUES (2, 0xAB)"
        );
        let triggered =
            plan(d, &shape(Engine::Mssql, true, &["id", "line"]), &insert).expect("plan");
        assert_eq!(
            triggered[0].statement.sql,
            "INSERT INTO [s].[Odd \"t\"] ([line], [raw]) VALUES (@P1, CONVERT(varbinary(max), @P2, 2)); \
SELECT [id], [line], [Select], [raw], [total] FROM [s].[Odd \"t\"] WHERE [id] = SCOPE_IDENTITY() AND [line] = @P3"
        );
        assert!(triggered[0].statement.returns_rows);
    }

    #[test]
    fn refuses_what_cannot_be_written() {
        let shape = shape(Engine::Sqlite, false, &["id"]);
        let d = Engine::Sqlite.dialect();
        let cases = [
            ChangeSet::default(),
            ChangeSet {
                updates: vec![update(&[1], "total", Value::int(1))],
                ..ChangeSet::default()
            },
            ChangeSet {
                updates: vec![update(&[1], "id", Value::int(2))],
                ..ChangeSet::default()
            },
            ChangeSet {
                updates: vec![update(&[1], "nope", Value::int(2))],
                ..ChangeSet::default()
            },
            ChangeSet {
                deletes: vec![by_key(vec![Value::int(1), Value::int(2)])],
                ..ChangeSet::default()
            },
            ChangeSet {
                deletes: vec![by_key(vec![Value::Null])],
                ..ChangeSet::default()
            },
        ];
        for changes in cases {
            let err = plan(d, &shape, &changes).expect_err("refused");
            assert_eq!(err.code, ErrorCode::InvalidArgument, "{changes:?}");
        }
        let mut keyless = shape.clone();
        keyless.identity.clear();
        let err = plan(
            d,
            &keyless,
            &ChangeSet {
                deletes: vec![by_key(vec![Value::int(1)])],
                ..ChangeSet::default()
            },
        )
        .expect_err("refused");
        assert_eq!(err.code, ErrorCode::TableNotEditable);
    }
}
