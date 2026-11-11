//! What a table tab knows about its table: the columns, the row identity and what can be
//! edited (F-086), from the cached metadata and the dialect.

use std::collections::HashMap;

use crate::db::bound::SqlBuilder;
use crate::db::dialect::Dialect;
use crate::db::edit_dialect::plain_text;
use crate::db::errors::YadbeError;
use crate::db::meta::{ColumnInfo, Identity, ObjectKind, TableDetails};
use crate::db::value::{ColumnMeta, Value};
use crate::session::table_model::{
    ColumnReadOnlyReason, SortDirection, SortKey, TableColumn, TableDataInfo, TableReadOnlyReason,
};

#[derive(Debug, Clone)]
pub struct TableShape {
    pub details: TableDetails,
    pub info: TableDataInfo,
    /// Indices of the row identity columns in `details.columns`.
    pub identity: Vec<usize>,
    /// Per column: read through the dialect's select expression (its text form).
    pub as_text: Vec<bool>,
    /// The table has enabled triggers (SQL Server refuses `OUTPUT` then).
    pub has_triggers: bool,
}

/// The primary key, else a unique key on non-null columns, of a table.
fn row_identity(details: &TableDetails) -> Option<Vec<String>> {
    if details.kind != ObjectKind::Table {
        return None;
    }
    if let Some(pk) = &details.primary_key
        && !pk.columns.is_empty()
    {
        return Some(pk.columns.clone());
    }
    let not_null = |name: &String| {
        details
            .columns
            .iter()
            .any(|c| &c.name == name && !c.nullable)
    };
    details
        .unique_keys
        .iter()
        .find(|key| !key.columns.is_empty() && key.columns.iter().all(not_null))
        .map(|key| key.columns.clone())
}

impl TableShape {
    /// `enums`: labels of the enum columns, by column name.
    pub fn new(
        dialect: &dyn Dialect,
        details: TableDetails,
        read_only_connection: bool,
        enums: &HashMap<String, Vec<String>>,
    ) -> Self {
        let identity_names = row_identity(&details);
        let mut reasons = Vec::new();
        if details.kind != ObjectKind::Table {
            reasons.push(TableReadOnlyReason::View);
        } else if identity_names.is_none() {
            reasons.push(TableReadOnlyReason::NoRowIdentity);
        }
        if read_only_connection {
            reasons.push(TableReadOnlyReason::ReadOnlyConnection);
        }
        let columns = details
            .columns
            .iter()
            .map(|c| TableColumn {
                name: c.name.clone(),
                type_name: c.type_name.clone(),
                kind: c.kind,
                nullable: c.nullable,
                default: c.default.clone(),
                optional_on_insert: c.nullable
                    || c.default.is_some()
                    || c.identity.is_some()
                    || c.generated.is_some(),
                primary_key: c.primary_key,
                read_only_reason: if !reasons.is_empty() {
                    Some(ColumnReadOnlyReason::Table)
                } else {
                    column_reason(dialect, c)
                },
                enum_values: enums
                    .get(&c.name)
                    .cloned()
                    .or_else(|| dialect.enum_labels(c)),
            })
            .collect();
        let identity: Vec<usize> = identity_names
            .iter()
            .flatten()
            .filter_map(|name| details.columns.iter().position(|c| &c.name == name))
            .collect();
        let as_text = details
            .columns
            .iter()
            .map(|c| {
                dialect
                    .select_expression(c, &dialect.quote_identifier(&c.name))
                    .is_some()
            })
            .collect();
        let info = TableDataInfo {
            table: details.table.clone(),
            kind: details.kind,
            columns,
            default_order: identity_names
                .iter()
                .flatten()
                .map(|column| SortKey {
                    column: column.clone(),
                    direction: SortDirection::Asc,
                })
                .collect(),
            row_identity: identity_names,
            read_only_reasons: reasons,
            row_estimate: details.row_estimate,
        };
        let has_triggers = details.triggers.iter().any(|t| t.enabled);
        Self {
            details,
            info,
            identity,
            as_text,
            has_triggers,
        }
    }

    pub fn column(&self, name: &str) -> Option<(usize, &ColumnInfo)> {
        self.details
            .columns
            .iter()
            .enumerate()
            .find(|(_, c)| c.name == name)
    }

    /// The column, or `invalidArgument`.
    pub fn require(&self, name: &str) -> Result<(usize, &ColumnInfo), YadbeError> {
        self.column(name).ok_or_else(|| {
            YadbeError::invalid_argument(
                format!("The table has no column \"{name}\"."),
                format!("La table n'a pas de colonne « {name} »."),
            )
        })
    }

    pub fn column_meta(&self) -> Vec<ColumnMeta> {
        self.details
            .columns
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                type_name: c.type_name.clone(),
                kind: c.kind,
            })
            .collect()
    }

    /// The columns of a page, comma-separated, each prefixed with `prefix` (`INSERTED.`).
    pub fn select_list(&self, b: &mut SqlBuilder<'_>, prefix: &str) {
        let dialect = b.dialect();
        for (index, column) in self.details.columns.iter().enumerate() {
            if index > 0 {
                b.push(", ");
            }
            let quoted = format!("{prefix}{}", dialect.quote_identifier(&column.name));
            match dialect.select_expression(column, &quoted) {
                Some(expression) => {
                    b.push(&expression).push(" AS ").ident(&column.name);
                }
                None => {
                    b.push(&quoted);
                }
            }
        }
    }

    /// Rows as read by a page: values read as text are reported with the column's kind.
    pub fn normalize(&self, rows: &mut [Vec<Value>]) {
        if !self.as_text.iter().any(|t| *t) {
            return;
        }
        for row in rows {
            for (value, as_text) in row.iter_mut().zip(&self.as_text) {
                if *as_text && let Value::Text(text) = value {
                    *value = Value::Other(std::mem::take(text));
                }
            }
        }
    }

    /// Fails with `tableNotEditable` for a view or a table without row identity.
    pub fn check_editable(&self) -> Result<(), YadbeError> {
        if self
            .info
            .read_only_reasons
            .contains(&TableReadOnlyReason::View)
        {
            return Err(YadbeError::table_not_editable(
                "A view cannot be edited from its rows.",
                "Une vue ne peut pas être modifiée depuis ses lignes.",
            ));
        }
        if self.identity.is_empty() {
            return Err(YadbeError::table_not_editable(
                "This table has neither a primary key nor a unique key on non-null columns: its rows cannot be told apart.",
                "Cette table n'a ni clé primaire ni clé unique sur des colonnes non nulles : ses lignes ne peuvent pas être distinguées.",
            ));
        }
        Ok(())
    }

    /// Checks a row key against the row identity.
    pub fn check_key(&self, key: &[Value]) -> Result<(), YadbeError> {
        if key.len() != self.identity.len() || key.contains(&Value::Null) {
            let n = self.identity.len();
            return Err(YadbeError::invalid_argument(
                format!("A row key needs {n} non-null values, one per identity column."),
                format!(
                    "Une clé de ligne demande {n} valeurs non nulles, une par colonne d'identité."
                ),
            ));
        }
        Ok(())
    }

    /// `WHERE`-ready conditions on the row identity: `"a" = $1 AND "b" = $2`.
    pub fn push_key(&self, b: &mut SqlBuilder<'_>, key: &[Value]) {
        for (n, (index, value)) in self.identity.iter().zip(key).enumerate() {
            if n > 0 {
                b.push(" AND ");
            }
            let column = &self.details.columns[*index];
            b.ident(&column.name).push(" = ").value(value, Some(column));
        }
    }

    /// The row as the user knows it: `id = 42`, `order_id = 1, line_no = 2`.
    pub fn describe_key(&self, key: &[Value]) -> String {
        self.identity
            .iter()
            .zip(key)
            .map(|(index, value)| {
                format!(
                    "{} = {}",
                    self.details.columns[*index].name,
                    plain_text(value).unwrap_or_else(|| "NULL".to_owned())
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn column_reason(dialect: &dyn Dialect, column: &ColumnInfo) -> Option<ColumnReadOnlyReason> {
    if column.generated.is_some() {
        Some(ColumnReadOnlyReason::Generated)
    } else if column.identity == Some(Identity::Always) {
        Some(ColumnReadOnlyReason::Identity)
    } else {
        dialect.column_read_only(column)
    }
}
