//! The inverse of an applied change set (F-090), as a change set of its own: an `UPDATE` back
//! to the values read, a `DELETE` of each inserted row (by its key, server-generated values
//! included, as read back), an `INSERT` of each deleted row with every loaded column. Its
//! updates and deletes carry the values the change left, so a revert is checked like any
//! edit (F-089): a row changed since is a conflict, not an overwrite.
//!
//! When the change cannot be undone exactly, there is no inverse but a [`RevertBlocker`]:
//! yadbe refuses rather than guess.

use crate::db::dialect::Dialect;
use crate::db::edit_dialect::IdentityInsert;
use crate::db::value::Value;
use crate::edit::model::{CellUpdate, ChangeSet, ColumnValue, PlannedChange, RowDelete, RowInsert};
use crate::edit::planner::PlannedEdit;
use crate::session::table_model::ColumnReadOnlyReason;
use crate::session::table_shape::TableShape;
use crate::store::RevertBlocker;

/// What an apply did, as needed to undo it.
pub struct AppliedSet<'a> {
    pub changes: &'a ChangeSet,
    pub planned: &'a [PlannedEdit],
    /// Per entry of `changes.inserts`, the row as stored (columns as in a page).
    pub inserted: &'a [Option<Vec<Value>>],
    /// Per planned update, in plan order, the row as stored after it.
    pub updated: &'a [Option<Vec<Value>>],
}

fn named(shape: &TableShape, index: usize) -> String {
    shape.details.columns[index].name.clone()
}

/// The change set that undoes `applied`.
pub fn inverse(
    dialect: &dyn Dialect,
    shape: &TableShape,
    applied: &AppliedSet<'_>,
) -> Result<ChangeSet, RevertBlocker> {
    let mut undo = ChangeSet::default();
    let key_of = |row: &[Value]| -> Vec<Value> {
        shape
            .identity
            .iter()
            .map(|&i| row.get(i).cloned().unwrap_or(Value::Null))
            .collect()
    };

    let mut updates = applied.updated.iter();
    for edit in applied.planned {
        match &edit.change {
            PlannedChange::Update { .. } => {
                let row = updates
                    .next()
                    .and_then(Option::as_ref)
                    .ok_or(RevertBlocker::UpdatedRowUnknown)?;
                let key = key_of(row);
                for (index, _, original) in &edit.written {
                    let original =
                        original
                            .clone()
                            .ok_or_else(|| RevertBlocker::OriginalUnknown {
                                column: named(shape, *index),
                            })?;
                    undo.updates.push(CellUpdate {
                        key: key.clone(),
                        column: named(shape, *index),
                        value: original,
                        original: row.get(*index).cloned(),
                    });
                }
            }
            PlannedChange::Insert { insert } => {
                let row = applied
                    .inserted
                    .get(*insert as usize)
                    .and_then(Option::as_ref)
                    .ok_or(RevertBlocker::InsertedRowUnknown)?;
                undo.deletes.push(RowDelete {
                    key: key_of(row),
                    values: row
                        .iter()
                        .enumerate()
                        .map(|(index, value)| ColumnValue {
                            column: named(shape, index),
                            value: value.clone(),
                        })
                        .collect(),
                });
            }
            PlannedChange::Delete { delete, .. } => {
                let deleted = applied
                    .changes
                    .deletes
                    .get(*delete as usize)
                    .ok_or(RevertBlocker::DeletedRowUnknown)?;
                undo.inserts
                    .push(reinsert(dialect, shape, &deleted.values)?);
            }
        }
    }
    Ok(undo)
}

/// The `INSERT` that brings a deleted row back: every column the server does not maintain
/// itself (computed, row version), identity values included.
fn reinsert(
    dialect: &dyn Dialect,
    shape: &TableShape,
    values: &[ColumnValue],
) -> Result<RowInsert, RevertBlocker> {
    if values.is_empty() {
        return Err(RevertBlocker::DeletedRowUnknown);
    }
    let missing: Vec<String> = shape
        .details
        .columns
        .iter()
        .filter(|c| !values.iter().any(|v| v.column == c.name))
        .map(|c| c.name.clone())
        .collect();
    if !missing.is_empty() {
        return Err(RevertBlocker::ColumnsNotLoaded { columns: missing });
    }
    let mut row = Vec::new();
    for (index, column) in shape.details.columns.iter().enumerate() {
        let Some(value) = values.iter().find(|v| v.column == column.name) else {
            continue;
        };
        match shape.info.columns[index].read_only_reason {
            Some(ColumnReadOnlyReason::Generated | ColumnReadOnlyReason::RowVersion) => continue,
            Some(ColumnReadOnlyReason::Identity)
                if dialect.identity_insert() == IdentityInsert::Refused =>
            {
                return Err(RevertBlocker::IdentityNotRestorable {
                    column: column.name.clone(),
                });
            }
            Some(
                ColumnReadOnlyReason::UnsupportedType
                | ColumnReadOnlyReason::Table
                | ColumnReadOnlyReason::Computed,
            ) => {
                // Left out, the column takes its default: only right for a NULL without one.
                if value.value == Value::Null && column.default.is_none() {
                    continue;
                }
                return Err(RevertBlocker::UnwritableColumn {
                    column: column.name.clone(),
                });
            }
            Some(ColumnReadOnlyReason::Identity) | None => {}
        }
        row.push(value.clone());
    }
    Ok(RowInsert { values: row })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::db::dialect::Engine;
    use crate::db::meta::{
        ColumnInfo, Generated, Identity, KeyConstraint, ObjectKind, ObjectRef, TableDetails,
    };
    use crate::db::value::ValueKind;
    use crate::edit::planner::plan;

    fn column(name: &str, type_name: &str, kind: ValueKind) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            ordinal: 1,
            type_name: type_name.into(),
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

    fn shape(engine: Engine, extra: Vec<ColumnInfo>) -> TableShape {
        let mut id = column("id", "int", ValueKind::Int);
        id.identity = Some(Identity::Always);
        id.nullable = false;
        let mut total = column("total", "int", ValueKind::Int);
        total.generated = Some(Generated {
            stored: true,
            expression: None,
        });
        let mut columns = vec![id, column("name", "text", ValueKind::Text), total];
        columns.extend(extra);
        TableShape::new(
            engine.dialect(),
            TableDetails {
                table: ObjectRef {
                    database: "db".into(),
                    schema: Some("s".into()),
                    name: "t".into(),
                },
                kind: ObjectKind::Table,
                comment: None,
                row_estimate: None,
                columns,
                primary_key: Some(KeyConstraint {
                    name: None,
                    columns: vec!["id".into()],
                }),
                unique_keys: vec![],
                foreign_keys: vec![],
                checks: vec![],
                indexes: vec![],
                triggers: vec![],
            },
            false,
            &HashMap::new(),
        )
    }

    fn cv(column: &str, value: Value) -> ColumnValue {
        ColumnValue {
            column: column.into(),
            value,
        }
    }

    #[test]
    fn inverts_updates_inserts_and_deletes() {
        let shape = shape(Engine::Postgres, vec![]);
        let d = Engine::Postgres.dialect();
        let changes = ChangeSet {
            updates: vec![CellUpdate {
                key: vec![Value::int(1)],
                column: "name".into(),
                value: Value::Text("new".into()),
                original: Some(Value::Text("old".into())),
            }],
            inserts: vec![RowInsert {
                values: vec![cv("name", Value::Text("added".into()))],
            }],
            deletes: vec![RowDelete {
                key: vec![Value::int(2)],
                values: vec![
                    cv("id", Value::int(2)),
                    cv("name", Value::Text("gone".into())),
                    cv("total", Value::int(9)),
                ],
            }],
        };
        let planned = plan(d, &shape, &changes).expect("plan");
        let stored_update = vec![Value::int(1), Value::Text("new ".into()), Value::int(4)];
        let stored_insert = vec![Value::int(3), Value::Text("added".into()), Value::int(5)];
        let undo = inverse(
            d,
            &shape,
            &AppliedSet {
                changes: &changes,
                planned: &planned,
                inserted: &[Some(stored_insert.clone())],
                updated: &[Some(stored_update)],
            },
        )
        .expect("inverse");
        assert_eq!(
            undo.updates,
            [CellUpdate {
                key: vec![Value::int(1)],
                column: "name".into(),
                value: Value::Text("old".into()),
                // The value as stored, not as written.
                original: Some(Value::Text("new ".into())),
            }]
        );
        assert_eq!(undo.deletes[0].key, [Value::int(3)]);
        assert_eq!(undo.deletes[0].values.len(), 3);
        // The computed column is left to the server; the identity value comes back.
        assert_eq!(
            undo.inserts[0].values,
            [
                cv("id", Value::int(2)),
                cv("name", Value::Text("gone".into()))
            ]
        );

        // What is unknown blocks the inverse.
        let blocked = inverse(
            d,
            &shape,
            &AppliedSet {
                changes: &changes,
                planned: &planned,
                inserted: &[None],
                updated: &[Some(vec![Value::int(1), Value::Null, Value::Null])],
            },
        );
        assert_eq!(blocked, Err(RevertBlocker::InsertedRowUnknown));
        let mut partial = changes.clone();
        partial.deletes[0].values.remove(2);
        partial.updates[0].original = None;
        let planned = plan(d, &shape, &partial).expect("plan");
        let blocked = inverse(
            d,
            &shape,
            &AppliedSet {
                changes: &partial,
                planned: &planned,
                inserted: &[Some(stored_insert)],
                updated: &[Some(vec![Value::int(1), Value::Null, Value::Null])],
            },
        );
        assert_eq!(
            blocked,
            Err(RevertBlocker::ColumnsNotLoaded {
                columns: vec!["total".into()]
            })
        );
    }

    #[test]
    fn refuses_values_it_cannot_write_back() {
        let shape = shape(
            Engine::Mssql,
            vec![column("variant", "sql_variant", ValueKind::Other)],
        );
        let d = Engine::Mssql.dialect();
        let row = |variant: Value| {
            vec![
                cv("id", Value::int(2)),
                cv("name", Value::Null),
                cv("total", Value::Null),
                cv("variant", variant),
            ]
        };
        let insert = reinsert(d, &shape, &row(Value::Null)).expect("NULL is left out");
        assert_eq!(insert.values.len(), 2);
        assert_eq!(
            reinsert(d, &shape, &row(Value::Other("1".into()))),
            Err(RevertBlocker::UnwritableColumn {
                column: "variant".into()
            })
        );
        assert_eq!(
            reinsert(d, &shape, &[]),
            Err(RevertBlocker::DeletedRowUnknown)
        );
    }
}
