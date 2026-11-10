//! SQLite driver: `rusqlite` (bundled SQLite) on blocking threads.

mod ddl;
mod introspect;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{InterruptHandle, OpenFlags};

use crate::db::dialect::Engine;
use crate::db::driver::{
    BoxFuture, CancelHandle, ConnectRequest, Connection, Driver, LinkWatch, StatementRecorder,
    recorded_sync,
};
use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, QueryResult, Value, ValueKind};

const VERSION_SQL: &str = "SELECT sqlite_version()";
/// Reads the database header: fails on a file that is not a database.
const CHECK_SQL: &str = "PRAGMA schema_version";
const PING_SQL: &str = "SELECT 1";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SqliteDriver;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, YadbeError> + Send + 'static,
) -> Result<T, YadbeError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| YadbeError::internal(format!("SQLite task failed: {e}")))?
}

fn classify(err: &rusqlite::Error, path: &Path) -> YadbeError {
    use rusqlite::ErrorCode;
    match err.sqlite_error_code() {
        Some(ErrorCode::NotADatabase) => {
            YadbeError::not_a_database(&path.display().to_string()).with_detail(err.to_string())
        }
        Some(ErrorCode::CannotOpen) => {
            YadbeError::file_not_found(&path.display().to_string()).with_detail(err.to_string())
        }
        Some(ErrorCode::OperationInterrupted) => YadbeError::cancelled(),
        _ => YadbeError::query_failed(err.to_string()),
    }
}

impl Driver for SqliteDriver {
    fn engine(&self) -> Engine {
        Engine::Sqlite
    }

    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Box<dyn Connection>, YadbeError>> {
        let path = request.target.file_path.clone();
        let recorder = request.recorder;
        Box::pin(async move {
            let opened = blocking(move || {
                if !path.is_file() {
                    return Err(YadbeError::file_not_found(&path.display().to_string()));
                }
                // Never create a file: a typo must not leave an empty database behind.
                let flags = OpenFlags::default() - OpenFlags::SQLITE_OPEN_CREATE;
                let conn = rusqlite::Connection::open_with_flags(&path, flags)
                    .map_err(|e| classify(&e, &path))?;
                conn.busy_timeout(BUSY_TIMEOUT)
                    .map_err(|e| classify(&e, &path))?;
                recorded_sync(
                    &*recorder,
                    CHECK_SQL,
                    |_| Some(1),
                    || {
                        conn.query_row(CHECK_SQL, [], |row| row.get::<_, i64>(0))
                            .map_err(|e| classify(&e, &path))
                    },
                )?;
                let version = recorded_sync(
                    &*recorder,
                    VERSION_SQL,
                    |_| Some(1),
                    || {
                        conn.query_row(VERSION_SQL, [], |row| row.get::<_, String>(0))
                            .map_err(|e| classify(&e, &path))
                    },
                )?;
                Ok(SqliteConnection {
                    interrupt: Arc::new(conn.get_interrupt_handle()),
                    conn: Arc::new(Mutex::new(conn)),
                    path,
                    server_version: format!("SQLite {version}"),
                    recorder,
                })
            })
            .await?;
            Ok(Box::new(opened) as Box<dyn Connection>)
        })
    }
}

struct SqliteConnection {
    conn: Arc<Mutex<rusqlite::Connection>>,
    interrupt: Arc<InterruptHandle>,
    path: std::path::PathBuf,
    server_version: String,
    recorder: Arc<dyn StatementRecorder>,
}

/// The column family from its declared type, following SQLite's affinity rules.
fn kind_of(decl: Option<&str>) -> ValueKind {
    let Some(decl) = decl.map(str::to_ascii_uppercase) else {
        return ValueKind::Other;
    };
    if decl.contains("BOOL") {
        ValueKind::Bool
    } else if decl.contains("INT") {
        ValueKind::Int
    } else if decl.contains("CHAR") || decl.contains("CLOB") || decl.contains("TEXT") {
        ValueKind::Text
    } else if decl.contains("BLOB") || decl.is_empty() {
        ValueKind::Bytes
    } else if decl.contains("REAL") || decl.contains("FLOA") || decl.contains("DOUB") {
        ValueKind::Float
    } else if decl.contains("DATETIME") || decl.contains("TIMESTAMP") {
        ValueKind::Timestamp
    } else if decl.contains("DATE") {
        ValueKind::Date
    } else if decl.contains("TIME") {
        ValueKind::Time
    } else if decl.contains("JSON") {
        ValueKind::Json
    } else {
        ValueKind::Decimal
    }
}

fn to_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::int(i),
        ValueRef::Real(f) => Value::float(f),
        ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::bytes(b),
    }
}

fn run(
    conn: &rusqlite::Connection,
    sql: &str,
    max_rows: usize,
    path: &Path,
) -> Result<QueryResult, YadbeError> {
    let mut stmt = conn.prepare(sql).map_err(|e| classify(&e, path))?;
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .map(|c| ColumnMeta {
            name: c.name().to_owned(),
            type_name: c.decl_type().unwrap_or_default().to_owned(),
            kind: kind_of(c.decl_type()),
        })
        .collect();
    let readonly = stmt.readonly();
    let mut rows_out = Vec::new();
    let mut truncated = false;
    let mut rows = stmt.query([]).map_err(|e| classify(&e, path))?;
    while let Some(row) = rows.next().map_err(|e| classify(&e, path))? {
        if rows_out.len() == max_rows {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            values.push(to_value(
                row.get_ref(index).map_err(|e| classify(&e, path))?,
            ));
        }
        rows_out.push(values);
    }
    drop(rows);
    Ok(QueryResult {
        rows_affected: (!readonly && columns.is_empty()).then(|| conn.changes()),
        columns,
        rows: rows_out,
        truncated,
    })
}

impl Connection for SqliteConnection {
    fn server_version(&self) -> &str {
        &self.server_version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move { self.query(PING_SQL, 1).await.map(|_| ()) })
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, YadbeError>> {
        let conn = Arc::clone(&self.conn);
        let recorder = Arc::clone(&self.recorder);
        let path = self.path.clone();
        let sql = sql.to_owned();
        Box::pin(async move {
            blocking(move || {
                let conn = conn
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let rows_of =
                    |r: &QueryResult| r.rows_affected.or_else(|| u64::try_from(r.rows.len()).ok());
                recorded_sync(&*recorder, &sql, rows_of, || {
                    run(&conn, &sql, max_rows, &path)
                })
            })
            .await
        })
    }

    fn link(&self) -> LinkWatch {
        LinkWatch::never()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        Arc::new(SqliteCancel(Arc::clone(&self.interrupt)))
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        self.interrupt.interrupt();
        Box::pin(async {})
    }

    fn introspector(&self) -> Option<&dyn crate::db::introspect::Introspector> {
        Some(self)
    }
}

struct SqliteCancel(Arc<InterruptHandle>);

impl CancelHandle for SqliteCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        self.0.interrupt();
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affinity_of_declared_types() {
        assert_eq!(kind_of(Some("INTEGER")), ValueKind::Int);
        assert_eq!(kind_of(Some("varchar(20)")), ValueKind::Text);
        assert_eq!(kind_of(Some("DOUBLE PRECISION")), ValueKind::Float);
        assert_eq!(kind_of(Some("NUMERIC(10,2)")), ValueKind::Decimal);
        assert_eq!(kind_of(Some("BOOLEAN")), ValueKind::Bool);
        assert_eq!(kind_of(Some("DATETIME")), ValueKind::Timestamp);
        assert_eq!(kind_of(Some("")), ValueKind::Bytes);
        assert_eq!(kind_of(None), ValueKind::Other);
    }
}
