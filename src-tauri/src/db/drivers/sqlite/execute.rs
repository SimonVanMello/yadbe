//! Streaming execution of user statements (M1-3) on the connection's blocking thread: rows
//! are stepped and sent in batches; a full channel blocks the thread, so stepping pauses.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::ErrorCode;
use rusqlite::types::Value as SqlValue;

use super::{SqliteConnection, blocking, kind_of, to_value};
use crate::db::driver::{
    ColumnOrigin, ErrorLocation, ExecError, ExecEvent, ExecSender, ExecSummary, Explained,
    recorded_sync,
};
use crate::db::errors::YadbeError;
use crate::db::params::{BoundParam, ParamStatement};
use crate::db::plan::{RawPlan, SqlitePlanRow};
use crate::db::value::{ColumnMeta, Value};
use crate::session::query_model::ServerMessage;

const BATCH_ROWS: usize = 500;
const BATCH_DELAY: Duration = Duration::from_millis(20);

fn server_message(code: Option<i32>, message: String) -> ServerMessage {
    ServerMessage {
        severity: "ERROR".to_owned(),
        code: code.map(|c| c.to_string()),
        message,
        detail: None,
        hint: None,
    }
}

fn exec_error(err: &rusqlite::Error, path: &Path) -> ExecError {
    match err {
        rusqlite::Error::SqlInputError {
            error, msg, offset, ..
        } => ExecError {
            error: YadbeError::query_failed(msg),
            server: Some(Box::new(server_message(
                Some(error.extended_code),
                msg.clone(),
            ))),
            location: usize::try_from(*offset).ok().map(ErrorLocation::Byte),
        },
        rusqlite::Error::SqliteFailure(failure, msg) => {
            let message = msg.clone().unwrap_or_else(|| failure.to_string());
            let error = match failure.code {
                ErrorCode::OperationInterrupted => YadbeError::cancelled(),
                ErrorCode::ReadOnly => {
                    YadbeError::read_only_refused_by_engine().with_detail(&message)
                }
                _ => super::classify(err, path),
            };
            ExecError {
                error,
                server: Some(Box::new(server_message(
                    Some(failure.extended_code),
                    message,
                ))),
                location: None,
            }
        }
        other => super::classify(other, path).into(),
    }
}

fn send(events: &ExecSender, event: ExecEvent) -> Result<(), ExecError> {
    events
        .blocking_send(event)
        .map_err(|_| YadbeError::cancelled().into())
}

/// A query parameter as SQLite stores it: integers and reals as numbers, the rest as text.
fn user_param(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Int(s) => s
            .parse::<i64>()
            .map_or_else(|_| SqlValue::Text(s.clone()), SqlValue::Integer),
        Value::Decimal(s) | Value::Float(s) => s
            .parse::<f64>()
            .map_or_else(|_| SqlValue::Text(s.clone()), SqlValue::Real),
        other => SqlValue::Text(crate::db::edit_dialect::plain_text(other).unwrap_or_default()),
    }
}

/// Binds query parameters by the names SQLite reads in the statement (`:a`, `@a`, `$a`,
/// `?2`); anonymous `?` take the positional values in order.
fn bind(stmt: &mut rusqlite::Statement<'_>, params: &[BoundParam]) -> rusqlite::Result<()> {
    let mut anonymous = params.iter().filter(|p| p.name == "?");
    for index in 1..=stmt.parameter_count() {
        let param = match stmt.parameter_name(index) {
            Some(name) => params.iter().find(|p| p.name == name),
            None => anonymous.next(),
        };
        let value = param.map_or(SqlValue::Null, |p| user_param(&p.value));
        stmt.raw_bind_parameter(index, value)?;
    }
    Ok(())
}

/// Where each result column comes from (`sqlite3_column_table_name` and its siblings, F-087):
/// SQLite follows views and subqueries to the base table.
fn origins(stmt: &rusqlite::Statement<'_>, width: usize) -> Vec<Option<ColumnOrigin>> {
    (0..width)
        .map(|col| {
            let (database, table, column, ..) = stmt.column_metadata(col).ok().flatten()?;
            Some(ColumnOrigin {
                database: Some(database.to_str().ok()?.to_owned()),
                schema: None,
                table: table.to_str().ok()?.to_owned(),
                column: column.to_str().ok()?.to_owned(),
            })
        })
        .collect()
}

fn run(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[BoundParam],
    path: &Path,
    read_only: bool,
    events: &ExecSender,
) -> Result<ExecSummary, ExecError> {
    let mut stmt = conn.prepare(sql).map_err(|e| exec_error(&e, path))?;
    bind(&mut stmt, params).map_err(|e| exec_error(&e, path))?;
    // Third guard after the classifier and the read-only open: SQLite's own verdict.
    if read_only && !stmt.readonly() {
        return Err(YadbeError::read_only_violation("").into());
    }
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .map(|c| ColumnMeta {
            name: c.name().to_owned(),
            type_name: c.decl_type().unwrap_or_default().to_owned(),
            kind: kind_of(c.decl_type()),
        })
        .collect();
    let width = columns.len();
    let writes = !stmt.readonly();
    if width > 0 {
        send(events, ExecEvent::Columns(columns))?;
        send(events, ExecEvent::Origins(origins(&stmt, width)))?;
    }
    let mut rows = stmt.raw_query();
    let mut batch: Vec<Vec<Value>> = Vec::with_capacity(BATCH_ROWS);
    let mut batch_started = Instant::now();
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(err) => {
                if !batch.is_empty() {
                    send(events, ExecEvent::Rows(std::mem::take(&mut batch)))?;
                }
                return Err(exec_error(&err, path));
            }
        };
        if batch.is_empty() {
            batch_started = Instant::now();
        }
        let mut values = Vec::with_capacity(width);
        for index in 0..width {
            values.push(to_value(
                row.get_ref(index).map_err(|e| exec_error(&e, path))?,
            ));
        }
        batch.push(values);
        if batch.len() >= BATCH_ROWS || batch_started.elapsed() >= BATCH_DELAY {
            send(
                events,
                ExecEvent::Rows(std::mem::replace(
                    &mut batch,
                    Vec::with_capacity(BATCH_ROWS),
                )),
            )?;
        }
    }
    drop(rows);
    if !batch.is_empty() {
        send(events, ExecEvent::Rows(batch))?;
    }
    Ok(ExecSummary {
        rows_affected: (writes && width == 0).then(|| conn.changes()),
    })
}

pub(super) async fn execute(
    connection: &SqliteConnection,
    statement: ParamStatement,
    events: ExecSender,
) -> Result<ExecSummary, ExecError> {
    let conn: Arc<Mutex<rusqlite::Connection>> = Arc::clone(&connection.conn);
    let path = connection.path.clone();
    let read_only = connection.read_only;
    let result = blocking(move || {
        let conn = conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(run(
            &conn,
            &statement.sql,
            &statement.params,
            &path,
            read_only,
            &events,
        ))
    })
    .await;
    result.map_err(ExecError::from)?
}

/// `EXPLAIN QUERY PLAN` of a user statement, its parameters bound (F-053).
pub(super) async fn explain(
    connection: &SqliteConnection,
    statement: ParamStatement,
) -> Result<Explained, ExecError> {
    let conn: Arc<Mutex<rusqlite::Connection>> = Arc::clone(&connection.conn);
    let recorder = Arc::clone(&connection.recorder);
    let path = connection.path.clone();
    let sql = format!("EXPLAIN QUERY PLAN {}", statement.sql);
    let result = blocking(move || {
        let conn = conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut failure = None;
        let rows_of = |rows: &Vec<SqlitePlanRow>| u64::try_from(rows.len()).ok();
        let read = recorded_sync(&*recorder, &sql, rows_of, || {
            let fail = |e: rusqlite::Error, failure: &mut Option<ExecError>| {
                let error = exec_error(&e, &path);
                let yadbe = error.error.clone();
                *failure = Some(error);
                yadbe
            };
            let mut stmt = conn.prepare(&sql).map_err(|e| fail(e, &mut failure))?;
            bind(&mut stmt, &statement.params).map_err(|e| fail(e, &mut failure))?;
            let mut rows = stmt.raw_query();
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(|e| fail(e, &mut failure))? {
                out.push(SqlitePlanRow {
                    id: row.get(0).map_err(|e| fail(e, &mut failure))?,
                    parent: row.get(1).map_err(|e| fail(e, &mut failure))?,
                    detail: row.get(3).map_err(|e| fail(e, &mut failure))?,
                });
            }
            Ok(out)
        });
        Ok(match read {
            Ok(rows) => Ok(Explained {
                raw: RawPlan::SqliteRows(rows),
                sent: sql,
            }),
            Err(error) => {
                let mut failure = failure.unwrap_or_else(|| error.into());
                failure.location = None;
                Err(failure)
            }
        })
    })
    .await;
    result.map_err(ExecError::from)?
}
