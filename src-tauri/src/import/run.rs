//! The import loop: records from a reader thread, converted, written in multi-row batches on
//! the import's own connection.
//!
//! **Atomicity.** By default everything runs in one transaction: the import is all or
//! nothing, and a dry run is the same run rolled back. `PerBatch` commits every batch on its
//! own (no transaction at all: each `INSERT` is atomic), so a failure or a cancel keeps what
//! was written before. A batch the server refuses is written again row by row to find the
//! rows at fault: on PostgreSQL, where an error aborts the transaction, each attempt sits in
//! a savepoint; the other engines keep the transaction after a failed statement.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::model::{ImportCommit, ImportIssueKind, ImportOnError, ImportReject, ImportStatus};
use super::parse::{OpenedFile, ParseError, Record, RecordSource};
use super::plan::{CellIssue, ImportPlan, convert_record, insert_statement};
use super::rejects::RejectsFile;
use crate::db::dialect::Dialect;
use crate::db::driver::{BoundFailure, BoundStatement, Connection};
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::value::Value;

/// Rejected rows kept for the report.
const SAMPLE_REJECTS: usize = 50;
const SAVEPOINT: &str = "yadbe_import";

pub struct Job {
    pub conn: Arc<dyn Connection>,
    pub dialect: &'static dyn Dialect,
    pub plan: ImportPlan,
    pub opened: OpenedFile,
    pub on_error: ImportOnError,
    pub commit: ImportCommit,
    pub dry_run: bool,
    pub rejects: Option<RejectsFile>,
    /// Shown in errors about the file.
    pub path: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    pub rows_read: u64,
    pub inserted: u64,
    pub rejected: u64,
    pub bytes_read: u64,
}

pub struct Outcome {
    pub status: ImportStatus,
    pub rows_read: u64,
    pub inserted: u64,
    pub kept: u64,
    pub rejected: u64,
    pub batches: u32,
    pub reject_samples: Vec<ImportReject>,
    pub invalid_bytes: u64,
    pub dropped_keys: u64,
    pub total_bytes: u64,
    pub error: Option<YadbeError>,
}

/// Why the loop ended early.
enum Stop {
    Cancelled,
    Failed(YadbeError),
}

impl From<YadbeError> for Stop {
    fn from(error: YadbeError) -> Self {
        if error.code == ErrorCode::Cancelled {
            Stop::Cancelled
        } else {
            Stop::Failed(error)
        }
    }
}

/// A failed statement: a row the server refuses, or something that ends the import.
enum Failure {
    Data(Box<BoundFailure>),
    Fatal(YadbeError),
}

type Chunk = Result<Vec<Record>, ParseError>;

/// Reads the file on a blocking thread, `rows` records at a time, two chunks ahead.
fn spawn_reader(mut source: Box<dyn RecordSource>, rows: usize) -> mpsc::Receiver<Chunk> {
    let (tx, rx) = mpsc::channel(2);
    tokio::task::spawn_blocking(move || {
        loop {
            let mut chunk = Vec::with_capacity(rows);
            let mut ended = false;
            let mut failure = None;
            while chunk.len() < rows {
                match source.next_record() {
                    Ok(Some(record)) => chunk.push(record),
                    Ok(None) => {
                        ended = true;
                        break;
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            if !chunk.is_empty() && tx.blocking_send(Ok(chunk)).is_err() {
                return;
            }
            if let Some(error) = failure {
                let _ = tx.blocking_send(Err(error));
                return;
            }
            if ended {
                return;
            }
        }
    });
    rx
}

fn issue_text(issues: &[CellIssue]) -> String {
    issues
        .iter()
        .map(|issue| {
            let kind = format!("{:?}", issue.kind);
            match (&issue.column, &issue.value) {
                (Some(column), Some(value)) => format!("{column}: {kind} ({value})"),
                (Some(column), None) => format!("{column}: {kind}"),
                (None, Some(found)) => format!("{kind} ({found} fields)"),
                (None, None) => kind,
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

struct Run<'a> {
    conn: Arc<dyn Connection>,
    dialect: &'static dyn Dialect,
    plan: ImportPlan,
    on_error: ImportOnError,
    savepoints: bool,
    cancel: &'a CancellationToken,
    path: String,
    rejects: Option<RejectsFile>,
    rows_read: u64,
    inserted: u64,
    rejected: u64,
    batches: u32,
    samples: Vec<ImportReject>,
    pending: Vec<PendingReject>,
}

struct PendingReject {
    line: u64,
    reject: ImportReject,
    text: String,
    cells: Vec<Option<String>>,
}

impl Run<'_> {
    fn progress(&self, bytes_read: u64) -> Progress {
        Progress {
            rows_read: self.rows_read,
            inserted: self.inserted,
            rejected: self.rejected,
            bytes_read,
        }
    }

    async fn exec(&self, statement: &BoundStatement) -> Result<(), Failure> {
        let housekeeping = |sql: String| async move {
            self.conn
                .query(&sql, 0)
                .await
                .map(|_| ())
                .map_err(Failure::Fatal)
        };
        if self.savepoints {
            housekeeping(self.dialect.savepoint(SAVEPOINT)).await?;
        }
        match self.conn.query_bound(statement, 0).await {
            Ok(_) => {
                if self.savepoints
                    && let Some(release) = self.dialect.release_savepoint(SAVEPOINT)
                {
                    housekeeping(release).await?;
                }
                Ok(())
            }
            Err(failure) => {
                if self.savepoints {
                    housekeeping(self.dialect.rollback_to_savepoint(SAVEPOINT)).await?;
                }
                Err(Failure::Data(Box::new(failure)))
            }
        }
    }

    /// A refused row, or the error that ends the import.
    fn classify(&self, failure: Failure) -> Result<Box<BoundFailure>, Stop> {
        match failure {
            Failure::Fatal(error) => Err(error.into()),
            Failure::Data(data) => {
                if self.cancel.is_cancelled() || data.error.code == ErrorCode::Cancelled {
                    Err(Stop::Cancelled)
                } else if matches!(
                    data.error.code,
                    ErrorCode::ConstraintViolation | ErrorCode::InvalidValue
                ) {
                    Ok(data)
                } else {
                    Err(Stop::Failed(data.error))
                }
            }
        }
    }

    /// Notes a rejected row; `flush_rejects` writes the chunk's rejects in file order.
    fn record_reject(&mut self, record: &Record, reject: ImportReject, text: &str) {
        self.rejected += 1;
        self.pending.push(PendingReject {
            line: record.line,
            reject,
            text: text.to_owned(),
            cells: if self.rejects.is_some() {
                record.cells.clone()
            } else {
                Vec::new()
            },
        });
    }

    async fn flush_rejects(&mut self) -> Result<(), Stop> {
        let mut pending = std::mem::take(&mut self.pending);
        pending.sort_by_key(|p| p.line);
        for item in pending {
            if let Some(file) = &mut self.rejects {
                file.push(item.line, &item.text, &item.cells).await?;
            }
            if self.samples.len() < SAMPLE_REJECTS {
                self.samples.push(item.reject);
            }
        }
        Ok(())
    }

    async fn reject_issues(&mut self, record: &Record, issues: Vec<CellIssue>) -> Result<(), Stop> {
        let text = issue_text(&issues);
        let line = u32::try_from(record.line).unwrap_or(u32::MAX);
        let first = &issues[0];
        let reject = ImportReject {
            line,
            column: first.column.clone(),
            value: first.value.clone(),
            reason: first.kind,
            detail: None,
        };
        self.record_reject(record, reject, &text);
        match self.on_error {
            ImportOnError::Skip => Ok(()),
            ImportOnError::Stop => Err(Stop::Failed(YadbeError::import_rejected(
                record.line,
                &text,
            ))),
        }
    }

    async fn process(&mut self, records: Vec<Record>) -> Result<(), Stop> {
        let result = self.process_chunk(records).await;
        let flushed = self.flush_rejects().await;
        result.and(flushed)
    }

    async fn process_chunk(&mut self, records: Vec<Record>) -> Result<(), Stop> {
        let mut good: Vec<(Record, Vec<Value>)> = Vec::with_capacity(records.len());
        for record in records {
            self.rows_read += 1;
            match convert_record(&self.plan, &record) {
                Ok(values) => good.push((record, values)),
                Err(issues) => self.reject_issues(&record, issues).await?,
            }
        }
        if good.is_empty() {
            return Ok(());
        }
        self.batches += 1;
        let rows: Vec<&[Value]> = good.iter().map(|(_, values)| values.as_slice()).collect();
        let label = format!("batch {}", self.batches);
        let statement = insert_statement(self.dialect, &self.plan, &rows, &label);
        match self.exec(&statement).await {
            Ok(()) => {
                self.inserted += good.len() as u64;
                Ok(())
            }
            Err(failure) => {
                // Only a refused row is worth writing one by one.
                self.classify(failure)?;
                for (record, values) in good {
                    self.insert_one(&record, &values).await?;
                }
                Ok(())
            }
        }
    }

    async fn insert_one(&mut self, record: &Record, values: &[Value]) -> Result<(), Stop> {
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        let label = format!("line {}", record.line);
        let statement = insert_statement(self.dialect, &self.plan, &[values], &label);
        let Err(failure) = self.exec(&statement).await else {
            self.inserted += 1;
            return Ok(());
        };
        let data = self.classify(failure)?;
        let detail = data
            .server
            .as_ref()
            .map(|s| s.message.clone())
            .or_else(|| data.error.detail.clone());
        let reject = ImportReject {
            line: u32::try_from(record.line).unwrap_or(u32::MAX),
            column: data.violation.as_ref().and_then(|v| v.column.clone()),
            value: None,
            reason: if data.violation.is_some() {
                ImportIssueKind::Constraint
            } else {
                ImportIssueKind::ServerError
            },
            detail: detail.clone(),
        };
        let text = detail.unwrap_or_else(|| data.error.message.en.clone());
        self.record_reject(record, reject, &text);
        match self.on_error {
            ImportOnError::Skip => Ok(()),
            ImportOnError::Stop => Err(Stop::Failed(YadbeError::import_rejected(
                record.line,
                &text,
            ))),
        }
    }
}

pub async fn run_import(
    job: Job,
    cancel: &CancellationToken,
    interval: Duration,
    mut report: impl FnMut(Progress) + Send,
) -> Outcome {
    let Job {
        conn,
        dialect,
        plan,
        opened,
        on_error,
        commit,
        dry_run,
        rejects,
        path,
    } = job;
    let stats = opened.stats.clone();
    let transactional = dry_run || commit == ImportCommit::Single;
    let mut run = Run {
        conn: Arc::clone(&conn),
        dialect,
        savepoints: transactional && dialect.error_aborts_transaction(),
        plan,
        on_error,
        cancel,
        path,
        rejects,
        rows_read: 0,
        inserted: 0,
        rejected: 0,
        batches: 0,
        samples: Vec::new(),
        pending: Vec::new(),
    };
    let rows_per_chunk = run.plan.rows_per_batch;
    // The server statement is cancelled natively; the loop then sees the token.
    let finished = CancellationToken::new();
    let watcher = {
        let handle = conn.cancel_handle();
        let (cancel, finished) = (cancel.clone(), finished.clone());
        tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {
                    if let Err(error) = handle.cancel().await {
                        tracing::debug!(%error, "import cancel failed");
                    }
                }
                () = finished.cancelled() => {}
            }
        })
    };

    let ended = drive(
        &mut run,
        opened.source,
        rows_per_chunk,
        transactional,
        &stats,
        interval,
        &mut report,
    )
    .await;
    finished.cancel();
    watcher.abort();

    let (mut status, mut outcome_error) = match ended {
        Ok(()) => (ImportStatus::Done, None),
        Err(Stop::Cancelled) => (ImportStatus::Cancelled, None),
        Err(Stop::Failed(error)) => (ImportStatus::Failed, Some(error)),
    };
    // A per-batch import keeps every batch written, whatever the end.
    let mut kept = run.inserted;
    if transactional {
        if status == ImportStatus::Done && !dry_run {
            if let Err(error) = conn.query(dialect.commit(), 0).await {
                status = ImportStatus::Failed;
                outcome_error = Some(error);
                kept = 0;
                rollback(&conn, dialect).await;
            }
        } else {
            kept = 0;
            rollback(&conn, dialect).await;
        }
    }
    if let Some(file) = run.rejects.take() {
        if status == ImportStatus::Done {
            if let Err(error) = file.commit().await {
                outcome_error.get_or_insert(error);
            }
        } else {
            file.discard().await;
        }
    }
    conn.close().await;
    Outcome {
        status,
        rows_read: run.rows_read,
        inserted: run.inserted,
        kept,
        rejected: run.rejected,
        batches: run.batches,
        reject_samples: run.samples,
        invalid_bytes: stats.invalid_bytes(),
        dropped_keys: stats.dropped_keys(),
        total_bytes: opened.file_size,
        error: outcome_error,
    }
}

async fn rollback(conn: &Arc<dyn Connection>, dialect: &dyn Dialect) {
    if conn.in_transaction() == Some(false) || conn.link().is_lost() {
        return;
    }
    if let Err(error) = conn.query(dialect.rollback(), 0).await {
        tracing::warn!(%error, "rollback after an import");
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive(
    run: &mut Run<'_>,
    source: Box<dyn RecordSource>,
    rows_per_chunk: usize,
    transactional: bool,
    stats: &super::parse::SourceStats,
    interval: Duration,
    report: &mut (impl FnMut(Progress) + Send),
) -> Result<(), Stop> {
    if transactional {
        run.conn.query(run.dialect.begin_transaction(), 0).await?;
    }
    let mut chunks = spawn_reader(source, rows_per_chunk);
    let mut last_report = Instant::now();
    loop {
        let chunk = tokio::select! {
            biased;
            () = run.cancel.cancelled() => return Err(Stop::Cancelled),
            chunk = chunks.recv() => chunk,
        };
        match chunk {
            None => return Ok(()),
            Some(Err(error)) => {
                return Err(Stop::Failed(error.into_yadbe(&run.path)));
            }
            Some(Ok(records)) => run.process(records).await?,
        }
        if last_report.elapsed() >= interval {
            report(run.progress(stats.bytes_read()));
            last_report = Instant::now();
        }
    }
}
