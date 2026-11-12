//! Statements yadbe authors with bound values (table browsing, edits). Values are bound with
//! the storage class of their kind (integers, reals, blobs, text); the column's affinity then
//! converts them as SQLite always does.

use std::path::Path;

use rusqlite::types::Value as SqlValue;

use super::{classify, kind_of, to_value};
use crate::db::driver::{BoundFailure, BoundStatement};
use crate::db::edit_dialect::plain_text;
use crate::db::errors::{ConstraintKind, ConstraintViolation, YadbeError};
use crate::db::value::{ColumnMeta, QueryResult, Value};
use crate::session::query_model::ServerMessage;

/// Extended result codes of constraint failures (`sqlite3.h`).
const CONSTRAINT_CHECK: i32 = 275;
const CONSTRAINT_FOREIGNKEY: i32 = 787;
const CONSTRAINT_NOTNULL: i32 = 1299;
const CONSTRAINT_PRIMARYKEY: i32 = 1555;
const CONSTRAINT_UNIQUE: i32 = 2067;
const CONSTRAINT_DATATYPE: i32 = 3091;

fn unhex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

fn param(value: &Value) -> Result<SqlValue, BoundFailure> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Int(s) => s
            .trim()
            .parse::<i64>()
            .map_or_else(|_| SqlValue::Text(s.clone()), SqlValue::Integer),
        Value::Float(s) => s
            .trim()
            .parse::<f64>()
            .map_or_else(|_| SqlValue::Text(s.clone()), SqlValue::Real),
        Value::Bytes(hex) => SqlValue::Blob(unhex(hex).ok_or_else(|| {
            BoundFailure::from(YadbeError::invalid_value(format!(
                "\"{hex}\" is not hexadecimal binary data"
            )))
        })?),
        other => SqlValue::Text(plain_text(other).unwrap_or_default()),
    })
}

/// `UNIQUE constraint failed: t.a` → `a`; several columns → none.
fn single_column(list: &str) -> Option<String> {
    let list = list.trim();
    if list.contains(',') {
        return None;
    }
    Some(list.rsplit('.').next().unwrap_or(list).to_owned())
}

fn failure(err: &rusqlite::Error, path: &Path) -> BoundFailure {
    let rusqlite::Error::SqliteFailure(sqlite, message) = err else {
        return classify(err, path).into();
    };
    let message = message.clone().unwrap_or_else(|| sqlite.to_string());
    let after_colon = message.split_once(": ").map(|(_, rest)| rest);
    let violation = match sqlite.extended_code {
        CONSTRAINT_UNIQUE | CONSTRAINT_PRIMARYKEY => Some(ConstraintViolation {
            kind: ConstraintKind::Unique,
            name: None,
            column: after_colon.and_then(single_column),
        }),
        CONSTRAINT_FOREIGNKEY => Some(ConstraintViolation {
            kind: ConstraintKind::ForeignKey,
            name: None,
            column: None,
        }),
        CONSTRAINT_CHECK => Some(ConstraintViolation {
            kind: ConstraintKind::Check,
            name: after_colon.map(str::to_owned),
            column: None,
        }),
        CONSTRAINT_NOTNULL => Some(ConstraintViolation {
            kind: ConstraintKind::NotNull,
            name: None,
            column: after_colon.and_then(single_column),
        }),
        _ => None,
    };
    let error = match (&violation, sqlite.code) {
        (Some(violation), _) => YadbeError::constraint_violation(violation).with_detail(&message),
        (None, _) if sqlite.extended_code == CONSTRAINT_DATATYPE => {
            YadbeError::invalid_value(&message)
        }
        (None, rusqlite::ErrorCode::TypeMismatch) => YadbeError::invalid_value(&message),
        (None, rusqlite::ErrorCode::ReadOnly) => {
            YadbeError::read_only_violation("").with_detail(&message)
        }
        // SQLite has no distinct code for it: the message is fixed by the engine.
        (None, _) if message.starts_with("no such table:") => YadbeError::table_gone(&message),
        _ => classify(err, path),
    };
    BoundFailure {
        error,
        server: Some(Box::new(ServerMessage {
            severity: "ERROR".to_owned(),
            code: Some(sqlite.extended_code.to_string()),
            message,
            detail: None,
            hint: None,
        })),
        violation: violation.map(Box::new),
    }
}

pub(super) fn run(
    conn: &rusqlite::Connection,
    statement: &BoundStatement,
    max_rows: usize,
    path: &Path,
) -> Result<QueryResult, BoundFailure> {
    let mut stmt = conn
        .prepare(&statement.sql)
        .map_err(|e| failure(&e, path))?;
    for (index, value) in statement.params.iter().enumerate() {
        stmt.raw_bind_parameter(index + 1, param(value)?)
            .map_err(|e| failure(&e, path))?;
    }
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .map(|c| ColumnMeta {
            name: c.name().to_owned(),
            type_name: c.decl_type().unwrap_or_default().to_owned(),
            kind: kind_of(c.decl_type()),
        })
        .collect();
    let readonly = stmt.readonly();
    let mut out = Vec::new();
    let mut truncated = false;
    let mut rows = stmt.raw_query();
    while let Some(row) = rows.next().map_err(|e| failure(&e, path))? {
        if out.len() == max_rows {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            values.push(to_value(row.get_ref(index).map_err(|e| failure(&e, path))?));
        }
        out.push(values);
    }
    drop(rows);
    Ok(QueryResult {
        rows_affected: (!readonly && columns.is_empty()).then(|| conn.changes()),
        columns,
        rows: out,
        truncated,
    })
}
