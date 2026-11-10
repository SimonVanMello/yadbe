//! Streaming execution of user statements (M1-3) on the connection's blocking thread: rows
//! are stepped and sent in batches; a full channel blocks the thread, so stepping pauses.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::ErrorCode;

use super::{SqliteConnection, blocking, kind_of, to_value};
use crate::db::driver::{ErrorLocation, ExecError, ExecEvent, ExecSender, ExecSummary};
use crate::db::errors::YadbeError;
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
                ErrorCode::ReadOnly => YadbeError::read_only_violation("").with_detail(&message),
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

fn run(
    conn: &rusqlite::Connection,
    sql: &str,
    path: &Path,
    read_only: bool,
    events: &ExecSender,
) -> Result<ExecSummary, ExecError> {
    let mut stmt = conn.prepare(sql).map_err(|e| exec_error(&e, path))?;
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
    }
    let mut rows = stmt.query([]).map_err(|e| exec_error(&e, path))?;
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
    sql: &str,
    events: ExecSender,
) -> Result<ExecSummary, ExecError> {
    let conn: Arc<Mutex<rusqlite::Connection>> = Arc::clone(&connection.conn);
    let path = connection.path.clone();
    let read_only = connection.read_only;
    let sql = sql.to_owned();
    let result = blocking(move || {
        let conn = conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(run(&conn, &sql, &path, read_only, &events))
    })
    .await;
    result.map_err(ExecError::from)?
}
