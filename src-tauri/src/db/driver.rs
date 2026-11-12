//! The traits every engine driver implements. Services only see these; driver crates stay
//! under `drivers/<engine>/`.
//!
//! - **Streaming (M1-3)**: [`Connection::execute`] pushes result-set columns, row batches and
//!   notices into a bounded channel owned by the `QueryRunner` (backpressure: a full channel
//!   stops the driver reading the server); `query` stays the small buffered path for
//!   yadbe's own statements.
//! - **Cancellation (M1-3)**: [`Connection::cancel_handle`] is detached from the connection
//!   (Postgres cancel request, `sqlite3_interrupt`), so it can fire while a statement runs.
//! - **Dedicated connections (M1-3)**: each editor tab calls [`Driver::connect`] again with
//!   the session's target and password (`ConnectionSession::open_dedicated`).
//! - **Introspection (M1-1)**: an `introspect` family of methods (or an `Introspector`
//!   obtained from the connection) returns the metadata model; queries it runs go through
//!   the [`StatementRecorder`] like every statement yadbe authors.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::watch;

use crate::db::config::ConnectTarget;
use crate::db::dialect::Engine;
use crate::db::errors::{ConstraintViolation, YadbeError};
use crate::db::params::ParamStatement;
use crate::db::plan::RawPlan;
use crate::db::value::{ColumnMeta, QueryResult, Value};
use crate::secrets::Secret;
pub use crate::session::query_model::ServerMessage;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A statement yadbe ran on its own, as reported by a driver.
#[derive(Debug, Clone)]
pub struct RecordedStatement {
    pub sql: String,
    pub started_at: SystemTime,
    pub duration: Duration,
    /// Rows returned or affected, or the failure.
    pub outcome: Result<Option<u64>, YadbeError>,
}

/// Receives every statement a driver runs on yadbe's behalf (version query, session setup,
/// metadata…). User statements go to the history instead, never here.
pub trait StatementRecorder: Send + Sync {
    fn record(&self, statement: RecordedStatement);
}

/// Records nothing (unit tests of drivers that do not care).
pub struct NoRecorder;

impl StatementRecorder for NoRecorder {
    fn record(&self, _statement: RecordedStatement) {}
}

/// Runs `work` and records `sql` with its duration and outcome.
pub async fn recorded<T>(
    recorder: &dyn StatementRecorder,
    sql: &str,
    rows: impl FnOnce(&T) -> Option<u64>,
    work: impl Future<Output = Result<T, YadbeError>>,
) -> Result<T, YadbeError> {
    let started_at = SystemTime::now();
    let start = Instant::now();
    let result = work.await;
    recorder.record(RecordedStatement {
        sql: sql.to_owned(),
        started_at,
        duration: start.elapsed(),
        outcome: match &result {
            Ok(value) => Ok(rows(value)),
            Err(err) => Err(err.clone()),
        },
    });
    result
}

/// Blocking twin of [`recorded`], for drivers running on a blocking thread.
pub fn recorded_sync<T>(
    recorder: &dyn StatementRecorder,
    sql: &str,
    rows: impl FnOnce(&T) -> Option<u64>,
    work: impl FnOnce() -> Result<T, YadbeError>,
) -> Result<T, YadbeError> {
    let started_at = SystemTime::now();
    let start = Instant::now();
    let result = work();
    recorder.record(RecordedStatement {
        sql: sql.to_owned(),
        started_at,
        duration: start.elapsed(),
        outcome: match &result {
            Ok(value) => Ok(rows(value)),
            Err(err) => Err(err.clone()),
        },
    });
    result
}

fn rows_of(result: &QueryResult) -> Option<u64> {
    result
        .rows_affected
        .or_else(|| u64::try_from(result.rows.len()).ok())
}

/// Runs a bound statement and records its display form with its duration and outcome.
pub async fn recorded_bound(
    recorder: &dyn StatementRecorder,
    statement: &BoundStatement,
    work: impl Future<Output = Result<QueryResult, BoundFailure>>,
) -> Result<QueryResult, BoundFailure> {
    let started_at = SystemTime::now();
    let start = Instant::now();
    let result = work.await;
    recorder.record(RecordedStatement {
        sql: statement.display.clone(),
        started_at,
        duration: start.elapsed(),
        outcome: match &result {
            Ok(value) => Ok(rows_of(value)),
            Err(err) => Err(err.error.clone()),
        },
    });
    result
}

/// Blocking twin of [`recorded_bound`].
pub fn recorded_bound_sync(
    recorder: &dyn StatementRecorder,
    statement: &BoundStatement,
    work: impl FnOnce() -> Result<QueryResult, BoundFailure>,
) -> Result<QueryResult, BoundFailure> {
    let started_at = SystemTime::now();
    let start = Instant::now();
    let result = work();
    recorder.record(RecordedStatement {
        sql: statement.display.clone(),
        started_at,
        duration: start.elapsed(),
        outcome: match &result {
            Ok(value) => Ok(rows_of(value)),
            Err(err) => Err(err.error.clone()),
        },
    });
    result
}

/// Everything a driver needs to open a connection.
pub struct ConnectRequest<'a> {
    pub target: &'a ConnectTarget,
    pub password: Option<&'a Secret>,
    pub recorder: Arc<dyn StatementRecorder>,
}

pub trait Driver: Send + Sync {
    fn engine(&self) -> Engine;

    /// Opens a connection and reads the server version. Must honor
    /// `target.connect_timeout` and classify failures through the catalog
    /// (`db::errors`). Dropping the future abandons the attempt.
    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Box<dyn Connection>, YadbeError>>;
}

/// An open connection. Shared (`&self`): engines that serialize statements do it inside.
pub trait Connection: Send + Sync {
    /// Server product and version, read at connect time (`16.4`, `3.46.0`…).
    fn server_version(&self) -> &str;

    /// A cheap round trip proving the server still answers. Recorded.
    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>>;

    /// Runs one statement authored by yadbe and buffers at most `max_rows` rows. Recorded.
    /// A connection-level failure returns `connectionLost`; the statement is never retried.
    fn query<'a>(
        &'a self,
        sql: &'a str,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, YadbeError>>;

    /// Watches the link to the server; it flips once, when the link is gone.
    fn link(&self) -> LinkWatch;

    /// Cancels the statement running on this connection, from any task.
    fn cancel_handle(&self) -> Arc<dyn CancelHandle>;

    /// Closes the connection politely when the engine supports it.
    fn close(&self) -> BoxFuture<'_, ()>;

    /// Metadata reads on this connection; `None` for a driver without introspection.
    fn introspector(&self) -> Option<&dyn crate::db::introspect::Introspector> {
        None
    }

    /// Runs one user statement exactly as written, pushing what it produces into `events`
    /// (columns, row batches, notices). Never recorded in the statement log: the caller
    /// records user statements in the history. The channel is bounded: while the receiver
    /// stops reading, the driver stops reading from the server (backpressure). Fails with
    /// `cancelled` when the receiver is gone.
    fn execute<'a>(
        &'a self,
        sql: &'a str,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        let _ = (sql, events);
        Box::pin(async { Err(ExecError::from(YadbeError::not_implemented())) })
    }

    /// Runs one statement yadbe authored with its values bound as parameters (table
    /// browsing, edits) and buffers at most `max_rows` rows. Recorded in the statement log as
    /// `statement.display`. Server errors keep the server's message and, for broken
    /// constraints, which one.
    fn query_bound<'a>(
        &'a self,
        statement: &'a BoundStatement,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, BoundFailure>> {
        let _ = (statement, max_rows);
        Box::pin(async { Err(BoundFailure::from(YadbeError::not_implemented())) })
    }

    /// Whether a transaction is open, when the engine tells exactly (SQLite); `None` lets
    /// the caller track it from the statements it runs.
    fn in_transaction(&self) -> Option<bool> {
        None
    }

    /// Runs one user statement with its query parameters bound (F-048), like `execute`.
    /// `statement.sql` is sent as it is (see `db::params` for what the engine needs).
    fn execute_params<'a>(
        &'a self,
        statement: &'a ParamStatement,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        if statement.params.is_empty() {
            return self.execute(&statement.sql, events);
        }
        Box::pin(async { Err(ExecError::from(YadbeError::not_implemented())) })
    }

    /// Where the columns of `statement`'s first result set come from, asked of the engine
    /// without running the statement (F-087): PostgreSQL prepares it and reads its column
    /// origins, SQL Server describes it (`sp_describe_first_result_set`). What yadbe sends
    /// is recorded in the statement log. `Ok(None)`: the engine reports origins with the
    /// result itself ([`ExecEvent::Origins`]), or not at all.
    fn describe_origins<'a>(
        &'a self,
        statement: &'a ParamStatement,
    ) -> BoxFuture<'a, Result<Option<Vec<Option<ColumnOrigin>>>, YadbeError>> {
        let _ = statement;
        Box::pin(async { Ok(None) })
    }

    /// The plan of one user statement in the engine's native form (F-053); with `analyze`,
    /// the statement runs and the plan carries actual figures. What yadbe sends is recorded
    /// in the statement log.
    fn explain<'a>(
        &'a self,
        statement: &'a ParamStatement,
        analyze: bool,
    ) -> BoxFuture<'a, Result<Explained, ExecError>> {
        let _ = (statement, analyze);
        Box::pin(async { Err(ExecError::from(YadbeError::not_implemented())) })
    }
}

/// A plan as the engine gave it, and what was sent to get it.
#[derive(Debug, Clone, PartialEq)]
pub struct Explained {
    pub raw: RawPlan,
    /// The statements yadbe ran, in order, for the user to read.
    pub sent: String,
}

/// What a running user statement produces, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum ExecEvent {
    /// The statement returns rows with these columns (once, before any row).
    Columns(Vec<ColumnMeta>),
    /// The next rows (at most a few hundred per batch).
    Rows(Vec<Vec<Value>>),
    /// A notice, warning or info message from the server.
    Notice(ServerMessage),
    /// Where the columns of the result set just announced come from, one per column
    /// (`None`: computed), for engines that report it with the result (MySQL, SQLite).
    Origins(Vec<Option<ColumnOrigin>>),
}

/// The table column a result column's values come from, as the engine reported it (F-087).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnOrigin {
    /// The database (SQL Server, MySQL; `main`, `temp` or an attached database on SQLite);
    /// `None`: the connection's.
    pub database: Option<String>,
    /// `None` on engines without schemas.
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
}

pub type ExecSender = tokio::sync::mpsc::Sender<ExecEvent>;

/// How a user statement ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecSummary {
    /// Rows changed by a statement without result set, when the engine says.
    pub rows_affected: Option<u64>,
}

/// Where the server located an error, relative to the statement text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorLocation {
    /// 0-based character (PostgreSQL positions).
    Char(usize),
    /// 0-based byte (SQLite offsets).
    Byte(usize),
    /// 1-based line (SQL Server, MySQL).
    Line(u32),
}

/// A user statement failure, with what the server said and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecError {
    pub error: YadbeError,
    pub server: Option<Box<ServerMessage>>,
    pub location: Option<ErrorLocation>,
}

impl From<YadbeError> for ExecError {
    fn from(error: YadbeError) -> Self {
        Self {
            error,
            server: None,
            location: None,
        }
    }
}

/// A statement yadbe authored, with its values bound: `sql` holds the dialect's
/// placeholders and `params` their values, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundStatement {
    pub sql: String,
    pub params: Vec<Value>,
    /// The same statement with the values written as literals, for reading only (SQL
    /// preview, statement log). Never run.
    pub display: String,
    /// The statement returns rows (`SELECT`, `RETURNING`, `OUTPUT`); otherwise the driver
    /// reports the rows it affected.
    pub returns_rows: bool,
}

/// A failed bound statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundFailure {
    pub error: YadbeError,
    pub server: Option<Box<ServerMessage>>,
    pub violation: Option<Box<ConstraintViolation>>,
}

impl From<YadbeError> for BoundFailure {
    fn from(error: YadbeError) -> Self {
        Self {
            error,
            server: None,
            violation: None,
        }
    }
}

pub trait CancelHandle: Send + Sync {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>>;
}

/// Observes whether the link to the server is still up.
#[derive(Clone)]
pub struct LinkWatch {
    rx: watch::Receiver<bool>,
    /// Keeps the sender of a link that never drops alive (a dropped sender reads as lost).
    _keep: Option<Arc<watch::Sender<bool>>>,
}

/// The driver side of a [`LinkWatch`].
pub struct LinkSignal(watch::Sender<bool>);

impl LinkSignal {
    pub fn lost(&self) {
        self.0.send_replace(true);
    }
}

impl LinkWatch {
    pub fn new() -> (LinkSignal, LinkWatch) {
        let (tx, rx) = watch::channel(false);
        (LinkSignal(tx), LinkWatch { rx, _keep: None })
    }

    /// A link that never drops (local files).
    pub fn never() -> LinkWatch {
        let (tx, rx) = watch::channel(false);
        LinkWatch {
            rx,
            _keep: Some(Arc::new(tx)),
        }
    }

    pub fn is_lost(&self) -> bool {
        *self.rx.borrow()
    }

    /// Resolves when the link is lost (or its driver side was dropped).
    pub async fn lost(&mut self) {
        let _ = self.rx.wait_for(|lost| *lost).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn link_watch_resolves_once_lost() {
        let (signal, mut watch) = LinkWatch::new();
        assert!(!watch.is_lost());
        signal.lost();
        watch.lost().await;
        assert!(watch.is_lost());
        let never = LinkWatch::never();
        assert!(!never.is_lost());
    }
}
