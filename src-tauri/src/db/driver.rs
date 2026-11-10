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
use crate::db::errors::YadbeError;
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

    /// Whether a transaction is open, when the engine tells exactly (SQLite); `None` lets
    /// the caller track it from the statements it runs.
    fn in_transaction(&self) -> Option<bool> {
        None
    }
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
