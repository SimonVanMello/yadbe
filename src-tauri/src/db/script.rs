//! "Script as" templates (F-023), built from a table's metadata with the dialect's quoting
//! and row limit. Values are placeholders such as `<email, text>`: the template fails to
//! parse until the user fills them, so running it by accident changes nothing.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::dialect::Dialect;
use crate::db::meta::{ColumnInfo, Identity, RowLimitSyntax, TableDetails, qualified_name};

/// Rows a scripted `SELECT` reads.
pub const SCRIPT_SELECT_LIMIT: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ScriptKind {
    /// `SELECT` of every column, limited to the first 1000 rows.
    Select,
    Insert,
    /// `UPDATE` of one row, by key.
    Update,
    /// `DELETE` of one row, by key.
    Delete,
    /// The qualified, quoted name alone.
    QualifiedName,
}

pub fn script(dialect: &dyn Dialect, table: &TableDetails, kind: ScriptKind) -> String {
    let name = qualified_name(dialect, &table.table);
    let quote = |c: &ColumnInfo| dialect.quote_identifier(&c.name);
    match kind {
        ScriptKind::QualifiedName => name,
        ScriptKind::Select => {
            let columns = if table.columns.is_empty() {
                "  *".to_owned()
            } else {
                list(
                    table.columns.iter().map(|c| format!("  {}", quote(c))),
                    ",\n",
                )
            };
            match dialect.meta_capabilities().row_limit {
                RowLimitSyntax::Limit => {
                    format!("SELECT\n{columns}\nFROM {name}\nLIMIT {SCRIPT_SELECT_LIMIT};")
                }
                RowLimitSyntax::Top => {
                    format!("SELECT TOP ({SCRIPT_SELECT_LIMIT})\n{columns}\nFROM {name};")
                }
            }
        }
        ScriptKind::Insert => {
            let columns: Vec<&ColumnInfo> =
                table.columns.iter().filter(|c| insertable(c)).collect();
            if columns.is_empty() {
                return format!("INSERT INTO {name} {};", dialect.default_values());
            }
            format!(
                "INSERT INTO {name} (\n{}\n) VALUES (\n{}\n);",
                list(columns.iter().map(|c| format!("  {}", quote(c))), ",\n"),
                list(
                    columns.iter().map(|c| format!("  {}", placeholder(c))),
                    ",\n"
                ),
            )
        }
        ScriptKind::Update => {
            let key = key_columns(table);
            let mut set: Vec<&ColumnInfo> = table
                .columns
                .iter()
                .filter(|c| updatable(c) && !key.iter().any(|k| k.name == c.name))
                .collect();
            if set.is_empty() {
                set = table.columns.iter().filter(|c| updatable(c)).collect();
            }
            format!(
                "UPDATE {name}\nSET\n{}\n{};",
                list(
                    set.iter()
                        .map(|c| format!("  {} = {}", quote(c), placeholder(c))),
                    ",\n"
                ),
                where_clause(dialect, &key),
            )
        }
        ScriptKind::Delete => {
            format!(
                "DELETE FROM {name}\n{};",
                where_clause(dialect, &key_columns(table))
            )
        }
    }
}

fn list(items: impl Iterator<Item = String>, separator: &str) -> String {
    items.collect::<Vec<_>>().join(separator)
}

fn placeholder(column: &ColumnInfo) -> String {
    format!("<{}, {}>", column.name, column.type_name)
}

fn insertable(column: &ColumnInfo) -> bool {
    column.generated.is_none() && column.identity != Some(Identity::Always)
}

fn updatable(column: &ColumnInfo) -> bool {
    column.generated.is_none() && column.identity.is_none()
}

/// The primary key, else the first unique key whose columns are all non-null.
fn key_columns(table: &TableDetails) -> Vec<&ColumnInfo> {
    let column = |name: &String| table.columns.iter().find(|c| &c.name == name);
    if let Some(pk) = &table.primary_key {
        let columns: Vec<_> = pk.columns.iter().filter_map(column).collect();
        if !columns.is_empty() {
            return columns;
        }
    }
    for key in &table.unique_keys {
        let columns: Vec<_> = key.columns.iter().filter_map(column).collect();
        if !columns.is_empty()
            && columns.len() == key.columns.len()
            && columns.iter().all(|c| !c.nullable)
        {
            return columns;
        }
    }
    Vec::new()
}

fn where_clause(dialect: &dyn Dialect, key: &[&ColumnInfo]) -> String {
    if key.is_empty() {
        return "WHERE <condition>".to_owned();
    }
    let conditions: Vec<String> = key
        .iter()
        .map(|c| format!("{} = {}", dialect.quote_identifier(&c.name), placeholder(c)))
        .collect();
    format!("WHERE {}", conditions.join("\n  AND "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;
    use crate::db::meta::{Generated, KeyConstraint, ObjectKind, ObjectRef};
    use crate::db::value::ValueKind;

    fn column(name: &str, type_name: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            ordinal: 0,
            type_name: type_name.into(),
            kind: ValueKind::Text,
            nullable: false,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            primary_key: false,
            foreign_key: false,
        }
    }

    fn orders() -> TableDetails {
        let mut id = column("id", "integer");
        id.identity = Some(Identity::Always);
        id.primary_key = true;
        let mut total = column("total with tax", "numeric(10,2)");
        total.generated = Some(Generated {
            stored: true,
            expression: Some("(total * 1.2)".into()),
        });
        TableDetails {
            table: ObjectRef {
                database: "shop".into(),
                schema: Some("sales".into()),
                name: "orders".into(),
            },
            kind: ObjectKind::Table,
            comment: None,
            row_estimate: None,
            columns: vec![id, column("note", "text"), total],
            primary_key: Some(KeyConstraint {
                name: Some("orders_pkey".into()),
                columns: vec!["id".into()],
            }),
            unique_keys: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            indexes: Vec::new(),
            triggers: Vec::new(),
        }
    }

    #[test]
    fn select_uses_the_dialect_row_limit() {
        let table = orders();
        assert_eq!(
            script(Engine::Postgres.dialect(), &table, ScriptKind::Select),
            "SELECT\n  \"id\",\n  \"note\",\n  \"total with tax\"\nFROM \"sales\".\"orders\"\nLIMIT 1000;"
        );
        assert_eq!(
            script(Engine::Mssql.dialect(), &table, ScriptKind::Select),
            "SELECT TOP (1000)\n  [id],\n  [note],\n  [total with tax]\nFROM [sales].[orders];"
        );
    }

    #[test]
    fn insert_skips_generated_and_always_identity_columns() {
        assert_eq!(
            script(Engine::Postgres.dialect(), &orders(), ScriptKind::Insert),
            "INSERT INTO \"sales\".\"orders\" (\n  \"note\"\n) VALUES (\n  <note, text>\n);"
        );
    }

    #[test]
    fn update_and_delete_target_one_row_by_key() {
        let table = orders();
        assert_eq!(
            script(Engine::Postgres.dialect(), &table, ScriptKind::Update),
            "UPDATE \"sales\".\"orders\"\nSET\n  \"note\" = <note, text>\nWHERE \"id\" = <id, integer>;"
        );
        assert_eq!(
            script(Engine::Postgres.dialect(), &table, ScriptKind::Delete),
            "DELETE FROM \"sales\".\"orders\"\nWHERE \"id\" = <id, integer>;"
        );
    }

    #[test]
    fn without_key_the_condition_is_left_to_the_user() {
        let mut table = orders();
        table.primary_key = None;
        assert!(
            script(Engine::Sqlite.dialect(), &table, ScriptKind::Delete)
                .ends_with("WHERE <condition>;")
        );
        assert_eq!(
            script(Engine::Sqlite.dialect(), &table, ScriptKind::QualifiedName),
            "\"orders\""
        );
    }
}
