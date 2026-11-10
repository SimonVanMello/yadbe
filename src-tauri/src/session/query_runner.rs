//! `QueryRunner`: user statements of editor tabs (M1-3).
//!
//! Each tab owns a dedicated server connection, opened lazily from its `ConnectionSession`
//! and kept until the tab closes, switches connection or the session closes, so its
//! transaction, `search_path` and temporary tables survive between runs. One execution runs
//! per tab at a time. Rows stream from the driver through a bounded channel into the
//! `ResultStore`; at a result's limit the runner stops reading the channel, which stops the
//! driver reading the server (backpressure), until "load more" or "load all".
//!
//! Progress is reported with a leading-edge throttle: the first change of an execution is
//! emitted at once, then at most one `query-progress` per interval, then `query-finished`.

use std::collections::{BTreeSet, HashMap};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard, mpsc};
use tokio::task::JoinHandle;

use crate::db::classify::{
    TransactionEffect, read_only_refusal, reports_row_count, transaction_effect,
};
use crate::db::dialect::Dialect;
use crate::db::driver::{
    CancelHandle, Connection, ErrorLocation, ExecError, ExecEvent, ExecSummary,
};
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::split::{SqlSyntax, Statement, Utf16Map, split, statement_at};
use crate::db::value::Value;
use crate::events::{
    BackendEvent, EventSink, QueryFinished, QueryProgress, TransactionStateChanged,
};
use crate::session::ConnectionManager;
use crate::session::connection::ConnectionSession;
use crate::session::history_hook::{HistoryEntry, HistoryRecorder};
use crate::session::query_model::{
    ExecuteRequest, ExecuteScope, ExecutionDelta, ExecutionSnapshot, ExecutionStarted,
    ExecutionStatus, MAX_WINDOW_ROWS, MessageBody, PauseReason, QueryMessage, QueryTabInfo,
    ResultLimits, ResultStatus, ResultSummary, ResultWindow, ResumeMode, StatementCompleted,
    StatementError, TextPosition, TextRange, TransactionMode, TransactionState, TransactionStatus,
};
use crate::session::result_store::{ResultStore, StoredResult};
use crate::session::result_tap::{ResultStream, TAP_CAPACITY, TapEnd, TapMsg};

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// Shortest time between two `query-progress` events of an execution.
    pub progress_interval: Duration,
    /// Row batches buffered between a driver and the runner.
    pub channel_capacity: usize,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            progress_interval: Duration::from_millis(100),
            channel_capacity: 4,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn millis(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// A flag with a way to wait for it.
#[derive(Default)]
struct Signal {
    raised: AtomicBool,
    notify: Notify,
}

impl Signal {
    fn raise(&self) {
        self.raised.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_raised(&self) -> bool {
        self.raised.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        loop {
            let mut notified = pin!(self.notify.notified());
            notified.as_mut().enable();
            if self.is_raised() {
                return;
            }
            notified.await;
        }
    }
}

struct ResultEntry {
    stored: Arc<StoredResult>,
    statement_index: u32,
    status: ResultStatus,
    paused_by: Option<PauseReason>,
    row_count: usize,
    bytes: usize,
    limit_rows: u64,
    limit_bytes: u64,
    /// An export reads the rows as they arrive (M2-7), see `result_tap`.
    tap: Option<mpsc::Sender<TapMsg>>,
    /// Rows past the limits went to an export only: the store lacks them.
    truncated: bool,
}

/// What a paused result waited for.
enum Wake {
    Resume(ResumeMode),
    /// An export attached: the rest of the stream goes to it instead of waiting.
    Tapped,
}

/// What became of a batch offered to the store.
enum Accepted {
    Stored,
    Paused(Vec<Vec<Value>>, PauseReason),
    /// An export reads this result: the batch goes to it.
    Tapped(Vec<Vec<Value>>),
}

impl ResultEntry {
    fn summary(&self) -> ResultSummary {
        ResultSummary {
            result_id: self.stored.id(),
            statement_index: self.statement_index,
            columns: self.stored.columns().to_vec(),
            row_count: to_u32(self.row_count),
            status: self.status,
            paused_by: self.paused_by,
            bytes: to_u32(self.bytes),
        }
    }
}

struct ExecState {
    status: ExecutionStatus,
    current_statement: Option<u32>,
    results: Vec<ResultEntry>,
    messages: Vec<QueryMessage>,
    dirty: BTreeSet<usize>,
    sent_messages: usize,
    finished_ms: Option<u32>,
}

struct Execution {
    id: u32,
    tab_id: String,
    connection_id: String,
    database: Option<String>,
    text: String,
    syntax: SqlSyntax,
    statements: Vec<Statement>,
    ranges: Vec<TextRange>,
    started_at: SystemTime,
    started: Instant,
    limits: ResultLimits,
    state: Mutex<ExecState>,
    /// Something changed: the emitter sends a `query-progress`.
    wake: Notify,
    /// The first rows of a result arrived: sent without waiting for the throttle (P-03).
    urgent: Notify,
    cancel: Signal,
    cancel_handle: Mutex<Option<Arc<dyn CancelHandle>>>,
    resume: Notify,
    resume_request: Mutex<Option<(u32, ResumeMode)>>,
}

impl Execution {
    fn elapsed_ms(&self, state: &ExecState) -> u32 {
        state
            .finished_ms
            .unwrap_or_else(|| millis(self.started.elapsed()))
    }

    fn delta(&self, state: &mut ExecState) -> ExecutionDelta {
        let results = std::mem::take(&mut state.dirty)
            .into_iter()
            .filter_map(|i| state.results.get(i).map(ResultEntry::summary))
            .collect();
        let messages = state.messages[state.sent_messages..].to_vec();
        state.sent_messages = state.messages.len();
        ExecutionDelta {
            status: state.status,
            elapsed_ms: self.elapsed_ms(state),
            current_statement: state.current_statement,
            results,
            messages,
        }
    }

    fn update<T>(&self, change: impl FnOnce(&mut ExecState) -> T) -> T {
        let out = change(&mut lock(&self.state));
        self.wake.notify_one();
        out
    }

    fn message(&self, statement: Option<usize>, body: MessageBody) {
        self.update(|state| {
            let message = QueryMessage {
                seq: to_u32(state.messages.len()),
                statement_index: statement.map(to_u32),
                at_ms: self.elapsed_ms(state),
                body,
            };
            state.messages.push(message);
        });
    }

    /// Sends what changed; `false` once the execution finished.
    fn emit_progress(&self, sink: &dyn EventSink) -> bool {
        let mut state = lock(&self.state);
        if state.finished_ms.is_some() {
            return false;
        }
        let delta = self.delta(&mut state);
        // Emitted under the lock so no progress can follow `query-finished`.
        sink.emit(BackendEvent::QueryProgress(QueryProgress {
            tab_id: self.tab_id.clone(),
            execution_id: self.id,
            delta,
        }));
        true
    }

    fn finish(&self, sink: &dyn EventSink, status: ExecutionStatus) {
        let mut state = lock(&self.state);
        state.status = status;
        state.current_statement = None;
        state.finished_ms = Some(millis(self.started.elapsed()));
        let delta = self.delta(&mut state);
        sink.emit(BackendEvent::QueryFinished(QueryFinished {
            tab_id: self.tab_id.clone(),
            execution_id: self.id,
            delta,
        }));
        drop(state);
        self.wake.notify_one();
    }

    fn is_finished(&self) -> bool {
        lock(&self.state).finished_ms.is_some()
    }

    fn result_ids(&self) -> Vec<u32> {
        lock(&self.state)
            .results
            .iter()
            .map(|r| r.stored.id())
            .collect()
    }

    fn snapshot(&self) -> ExecutionSnapshot {
        let state = lock(&self.state);
        ExecutionSnapshot {
            execution_id: self.id,
            connection_id: self.connection_id.clone(),
            database: self.database.clone(),
            statements: self.ranges.clone(),
            started_at: self
                .started_at
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |d| (d.as_secs_f64() * 1000.0).floor()),
            status: state.status,
            elapsed_ms: self.elapsed_ms(&state),
            current_statement: state.current_statement,
            results: state.results.iter().map(ResultEntry::summary).collect(),
            messages: state.messages.clone(),
        }
    }

    /// The editor position of a server-reported error location.
    fn position(&self, statement: &Statement, location: ErrorLocation) -> TextPosition {
        let sql = &self.text[statement.range()];
        let relative = match location {
            ErrorLocation::Char(n) => sql.char_indices().nth(n).map_or(sql.len(), |(i, _)| i),
            ErrorLocation::Byte(n) => n.min(sql.len()),
            ErrorLocation::Line(line) => sql
                .match_indices('\n')
                .nth(usize::try_from(line).unwrap_or(1).saturating_sub(2))
                .map_or(0, |(i, _)| if line <= 1 { 0 } else { i + 1 }),
        };
        let map = Utf16Map::new(&self.text);
        let byte = statement.start + relative;
        let (line, column) = map.line_column(byte);
        TextPosition {
            offset: map.to_utf16(byte),
            line,
            column,
        }
    }

    async fn wait_resume(&self, result_id: u32) -> Option<Wake> {
        loop {
            let mut notified = pin!(self.resume.notified());
            notified.as_mut().enable();
            {
                let mut request = lock(&self.resume_request);
                if let Some((id, mode)) = *request
                    && id == result_id
                {
                    *request = None;
                    return Some(Wake::Resume(mode));
                }
            }
            if lock(&self.state)
                .results
                .iter()
                .any(|r| r.stored.id() == result_id && r.tap.is_some())
            {
                return Some(Wake::Tapped);
            }
            tokio::select! {
                () = notified => {}
                () = self.cancel.wait() => return None,
            }
        }
    }
}

/// A tab's own server connection.
struct TabConnection {
    conn: Arc<dyn Connection>,
    connection_id: String,
    database: Option<String>,
    /// Closed under the tab: link lost or session closed.
    dead: Arc<AtomicBool>,
    watcher: JoinHandle<()>,
}

impl TabConnection {
    fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst) && !self.conn.link().is_lost()
    }

    async fn close(self) {
        self.watcher.abort();
        self.conn.close().await;
    }
}

#[derive(Default)]
struct TabShared {
    transaction: TransactionState,
    connection_id: Option<String>,
    database: Option<String>,
    execution: Option<Arc<Execution>>,
}

struct Tab {
    id: String,
    shared: Mutex<TabShared>,
    conn: Arc<AsyncMutex<Option<TabConnection>>>,
}

impl Tab {
    fn transaction(&self) -> TransactionState {
        lock(&self.shared).transaction
    }

    fn set_transaction(&self, sink: &dyn EventSink, change: impl FnOnce(&mut TransactionState)) {
        let mut shared = lock(&self.shared);
        let before = shared.transaction;
        change(&mut shared.transaction);
        if shared.transaction != before {
            sink.emit(BackendEvent::TransactionStateChanged(
                TransactionStateChanged {
                    tab_id: self.id.clone(),
                    transaction: shared.transaction,
                },
            ));
        }
    }

    fn execution(&self) -> Option<Arc<Execution>> {
        lock(&self.shared).execution.clone()
    }

    fn try_conn(&self) -> Result<OwnedMutexGuard<Option<TabConnection>>, YadbeError> {
        Arc::clone(&self.conn)
            .try_lock_owned()
            .map_err(|_| YadbeError::execution_running())
    }
}

/// How one statement ended.
enum Outcome {
    Done,
    Failed(YadbeError),
}

pub struct QueryRunner {
    manager: Arc<ConnectionManager>,
    sink: Arc<dyn EventSink>,
    history: Arc<dyn HistoryRecorder>,
    store: Arc<ResultStore>,
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
    next_execution: AtomicU32,
    config: RunnerConfig,
}

impl QueryRunner {
    pub fn new(
        manager: Arc<ConnectionManager>,
        sink: Arc<dyn EventSink>,
        history: Arc<dyn HistoryRecorder>,
    ) -> Self {
        Self {
            manager,
            sink,
            history,
            store: Arc::new(ResultStore::default()),
            tabs: Mutex::new(HashMap::new()),
            next_execution: AtomicU32::new(0),
            config: RunnerConfig::default(),
        }
    }

    pub fn with_config(mut self, config: RunnerConfig) -> Self {
        self.config = config;
        self
    }

    /// Replaces the history hook (M1-6).
    pub fn with_history(mut self, history: Arc<dyn HistoryRecorder>) -> Self {
        self.history = history;
        self
    }

    pub fn store(&self) -> &ResultStore {
        &self.store
    }

    fn tab(&self, tab_id: &str) -> Arc<Tab> {
        Arc::clone(
            lock(&self.tabs)
                .entry(tab_id.to_owned())
                .or_insert_with(|| {
                    Arc::new(Tab {
                        id: tab_id.to_owned(),
                        shared: Mutex::new(TabShared::default()),
                        conn: Arc::new(AsyncMutex::new(None)),
                    })
                }),
        )
    }

    fn existing_tab(&self, tab_id: &str) -> Option<Arc<Tab>> {
        lock(&self.tabs).get(tab_id).cloned()
    }

    /// Starts an execution and returns at once.
    pub fn execute(
        self: &Arc<Self>,
        request: ExecuteRequest,
    ) -> Result<ExecutionStarted, YadbeError> {
        let session = self.manager.session(&request.connection_id)?;
        session.connection()?;
        let target = session.target();
        let dialect = target.engine.dialect();
        let database = request.database.filter(|db| {
            dialect.capabilities().multiple_databases && !db.is_empty() && *db != target.database
        });
        let text = request.text;
        let syntax = dialect.syntax();
        let map = Utf16Map::new(&text);
        let statements: Vec<Statement> = match request.scope {
            ExecuteScope::All => split(&text, &syntax),
            ExecuteScope::Range { from, to } => {
                let (from, to) = (map.to_byte(from), map.to_byte(to));
                let (from, to) = (from.min(to), from.max(to));
                split(&text[from..to], &syntax)
                    .into_iter()
                    .map(|s| Statement {
                        start: s.start + from,
                        end: s.end + from,
                        delimiter_end: s.delimiter_end + from,
                        repeat: s.repeat,
                    })
                    .collect()
            }
            ExecuteScope::StatementAt { offset } => {
                let all = split(&text, &syntax);
                statement_at(&text, &all, map.to_byte(offset))
                    .into_iter()
                    .collect()
            }
        };
        if statements.is_empty() {
            return Err(YadbeError::invalid_argument(
                "There is no statement to run.",
                "Il n'y a aucune instruction à exécuter.",
            ));
        }
        let ranges: Vec<TextRange> = statements
            .iter()
            .map(|s| TextRange {
                from: map.to_utf16(s.start),
                to: map.to_utf16(s.end),
            })
            .collect();

        let tab = self.tab(&request.tab_id);
        let guard = tab.try_conn()?;
        let reusable = guard.as_ref().is_some_and(|c| {
            c.is_alive() && c.connection_id == request.connection_id && c.database == database
        });
        if !reusable
            && guard.as_ref().is_some_and(TabConnection::is_alive)
            && tab.transaction().status != TransactionStatus::Idle
        {
            return Err(YadbeError::transaction_open());
        }

        let limits = request.limits.unwrap_or_default();
        let execution = Arc::new(Execution {
            id: self.next_execution.fetch_add(1, Ordering::Relaxed) + 1,
            tab_id: request.tab_id.clone(),
            connection_id: request.connection_id.clone(),
            database,
            text,
            syntax,
            statements,
            ranges: ranges.clone(),
            started_at: SystemTime::now(),
            started: Instant::now(),
            limits,
            state: Mutex::new(ExecState {
                status: if reusable {
                    ExecutionStatus::Running
                } else {
                    ExecutionStatus::Connecting
                },
                current_statement: None,
                results: Vec::new(),
                messages: Vec::new(),
                dirty: BTreeSet::new(),
                sent_messages: 0,
                finished_ms: None,
            }),
            wake: Notify::new(),
            urgent: Notify::new(),
            cancel: Signal::default(),
            cancel_handle: Mutex::new(None),
            resume: Notify::new(),
            resume_request: Mutex::new(None),
        });
        let previous = lock(&tab.shared).execution.replace(Arc::clone(&execution));
        if let Some(previous) = previous {
            self.store.remove(previous.result_ids());
        }

        let emitter = Arc::clone(&execution);
        let sink = Arc::clone(&self.sink);
        let interval = self.config.progress_interval;
        tokio::spawn(async move {
            loop {
                emitter.wake.notified().await;
                if !emitter.emit_progress(&*sink) {
                    return;
                }
                tokio::select! {
                    () = tokio::time::sleep(interval) => {}
                    () = emitter.urgent.notified() => {}
                }
            }
        });
        let runner = Arc::clone(self);
        let run = Arc::clone(&execution);
        tokio::spawn(async move { runner.run(tab, run, guard, session).await });
        Ok(ExecutionStarted {
            execution_id: execution.id,
            statements: ranges,
        })
    }

    async fn run(
        self: Arc<Self>,
        tab: Arc<Tab>,
        exec: Arc<Execution>,
        mut guard: OwnedMutexGuard<Option<TabConnection>>,
        session: Arc<ConnectionSession>,
    ) {
        let status = self.run_statements(&tab, &exec, &mut guard, &session).await;
        // Free the tab before announcing the end, so a run started on `query-finished` is
        // accepted.
        drop(guard);
        exec.finish(&*self.sink, status);
    }

    async fn run_statements(
        &self,
        tab: &Arc<Tab>,
        exec: &Arc<Execution>,
        guard: &mut Option<TabConnection>,
        session: &Arc<ConnectionSession>,
    ) -> ExecutionStatus {
        let dialect = session.target().engine.dialect();
        if session.target().read_only {
            let syntax = dialect.syntax();
            for (index, statement) in exec.statements.iter().enumerate() {
                let sql = &exec.text[statement.range()];
                if let Some(keyword) = read_only_refusal(sql, &syntax) {
                    let error = YadbeError::read_only_violation(&keyword);
                    self.record(
                        exec,
                        index,
                        SystemTime::now(),
                        Duration::ZERO,
                        None,
                        Err(error.clone()),
                    );
                    exec.message(
                        Some(index),
                        MessageBody::Error(StatementError {
                            error,
                            server: None,
                            position: Some(exec.position(statement, ErrorLocation::Byte(0))),
                        }),
                    );
                    return ExecutionStatus::Failed;
                }
            }
        }

        let conn = match self.ensure_connection(tab, exec, guard, session).await {
            Ok(conn) => conn,
            Err(error) => {
                if exec.cancel.is_raised() {
                    return ExecutionStatus::Cancelled;
                }
                exec.message(
                    None,
                    MessageBody::Error(StatementError {
                        error,
                        server: None,
                        position: None,
                    }),
                );
                return ExecutionStatus::Failed;
            }
        };
        *lock(&exec.cancel_handle) = Some(conn.cancel_handle());
        if exec.cancel.is_raised() {
            // Cancelled while connecting.
            return ExecutionStatus::Cancelled;
        }

        // `GO n` runs its batch n times, each run with its own results and history entry.
        let runs: Vec<usize> = exec
            .statements
            .iter()
            .enumerate()
            .flat_map(|(index, s)| std::iter::repeat_n(index, s.repeat as usize))
            .collect();
        for index in runs {
            if exec.cancel.is_raised() {
                return ExecutionStatus::Cancelled;
            }
            exec.update(|state| {
                state.status = ExecutionStatus::Running;
                state.current_statement = Some(to_u32(index));
            });
            let transaction = tab.transaction();
            if transaction.mode == TransactionMode::Manual
                && transaction.status == TransactionStatus::Idle
            {
                // Recorded in the statement log by the driver.
                if let Err(error) = conn.query(dialect.begin_transaction(), 0).await {
                    exec.message(
                        Some(index),
                        MessageBody::Error(StatementError {
                            error,
                            server: None,
                            position: None,
                        }),
                    );
                    return ExecutionStatus::Failed;
                }
                tab.set_transaction(&*self.sink, |t| t.status = TransactionStatus::Open);
            }
            let outcome = self.run_statement(exec, &conn, index).await;
            let sql = &exec.text[exec.statements[index].range()];
            self.track_transaction(tab, &conn, dialect, sql, &outcome);
            if let Outcome::Failed(error) = outcome {
                return if error.code == ErrorCode::Cancelled || exec.cancel.is_raised() {
                    ExecutionStatus::Cancelled
                } else {
                    ExecutionStatus::Failed
                };
            }
        }
        if exec.cancel.is_raised() {
            ExecutionStatus::Cancelled
        } else {
            ExecutionStatus::Succeeded
        }
    }

    /// The tab's connection for this execution, opened (or reopened) when needed.
    async fn ensure_connection(
        &self,
        tab: &Arc<Tab>,
        exec: &Arc<Execution>,
        guard: &mut Option<TabConnection>,
        session: &Arc<ConnectionSession>,
    ) -> Result<Arc<dyn Connection>, YadbeError> {
        if let Some(current) = guard.as_ref()
            && current.is_alive()
            && current.connection_id == exec.connection_id
            && current.database == exec.database
        {
            return Ok(Arc::clone(&current.conn));
        }
        if let Some(old) = guard.take() {
            old.close().await;
        }
        {
            let mut shared = lock(&tab.shared);
            shared.connection_id = None;
            shared.database = None;
        }
        tab.set_transaction(&*self.sink, |t| t.status = TransactionStatus::Idle);
        exec.update(|state| state.status = ExecutionStatus::Connecting);
        let opened = tokio::select! {
            opened = session.open_dedicated(exec.database.as_deref()) => opened?,
            () = exec.cancel.wait() => return Err(YadbeError::cancelled()),
        };
        let conn: Arc<dyn Connection> = Arc::from(opened);
        let dead = Arc::new(AtomicBool::new(false));
        let watcher = spawn_watcher(
            Arc::downgrade(tab),
            Arc::clone(&self.sink),
            Arc::clone(&conn),
            session.closed(),
            Arc::clone(&dead),
        );
        *guard = Some(TabConnection {
            conn: Arc::clone(&conn),
            connection_id: exec.connection_id.clone(),
            database: exec.database.clone(),
            dead,
            watcher,
        });
        {
            let mut shared = lock(&tab.shared);
            shared.connection_id = Some(exec.connection_id.clone());
            shared.database.clone_from(&exec.database);
        }
        Ok(conn)
    }

    fn track_transaction(
        &self,
        tab: &Tab,
        conn: &Arc<dyn Connection>,
        dialect: &dyn Dialect,
        sql: &str,
        outcome: &Outcome,
    ) {
        let exact = conn.in_transaction();
        tab.set_transaction(&*self.sink, |t| {
            if let Some(open) = exact {
                t.status = if open {
                    TransactionStatus::Open
                } else {
                    TransactionStatus::Idle
                };
                return;
            }
            match outcome {
                Outcome::Done => match transaction_effect(sql, &dialect.syntax()) {
                    TransactionEffect::Begin => t.status = TransactionStatus::Open,
                    TransactionEffect::End => t.status = TransactionStatus::Idle,
                    TransactionEffect::None => {}
                },
                Outcome::Failed(error) if error.code == ErrorCode::ConnectionLost => {
                    t.status = TransactionStatus::Idle;
                }
                Outcome::Failed(_) => {
                    if t.status == TransactionStatus::Open && dialect.error_aborts_transaction() {
                        t.status = TransactionStatus::Failed;
                    }
                }
            }
        });
    }

    fn record(
        &self,
        exec: &Execution,
        index: usize,
        started_at: SystemTime,
        duration: Duration,
        rows: Option<u64>,
        outcome: Result<(), YadbeError>,
    ) {
        self.history.record(HistoryEntry {
            tab_id: exec.tab_id.clone(),
            connection_id: exec.connection_id.clone(),
            database: exec.database.clone(),
            sql: exec.text[exec.statements[index].range()].to_owned(),
            started_at,
            duration,
            rows,
            outcome,
        });
    }

    /// Stores rows within the result's limits. The decision and the append happen under the
    /// state lock, so an export attaching meanwhile sees a consistent row count.
    fn accept_rows(exec: &Execution, position: usize, mut rows: Vec<Vec<Value>>) -> Accepted {
        let mut state = lock(&exec.state);
        let entry = &mut state.results[position];
        if entry.tap.is_some() {
            return Accepted::Tapped(rows);
        }
        if entry.row_count as u64 >= entry.limit_rows {
            return Accepted::Paused(rows, PauseReason::RowLimit);
        }
        if entry.bytes as u64 >= entry.limit_bytes {
            return Accepted::Paused(rows, PauseReason::MemoryLimit);
        }
        let room = usize::try_from(entry.limit_rows - entry.row_count as u64).unwrap_or(usize::MAX);
        let rest = rows.split_off(room.min(rows.len()));
        let (row_count, bytes) = entry.stored.append(rows);
        if entry.row_count == 0 && row_count > 0 {
            exec.urgent.notify_one();
        }
        entry.row_count = row_count;
        entry.bytes = bytes;
        state.dirty.insert(position);
        drop(state);
        exec.wake.notify_one();
        if rest.is_empty() {
            Accepted::Stored
        } else {
            Accepted::Paused(rest, PauseReason::RowLimit)
        }
    }

    /// A batch of a result an export reads: sent to the export, and stored while it fits
    /// under the limits. Gives the rows back when the export is gone and nothing was lost,
    /// so they take the usual path.
    async fn feed_tap(
        exec: &Execution,
        position: usize,
        rows: Vec<Vec<Value>>,
    ) -> Option<Vec<Vec<Value>>> {
        let tap = lock(&exec.state).results[position].tap.clone()?;
        if tap.send(TapMsg::Rows(rows.clone())).await.is_err() {
            let truncated = exec.update(|state| {
                let entry = &mut state.results[position];
                entry.tap = None;
                entry.truncated
            });
            if truncated {
                // The rows between the limit and here are gone: resuming would leave a gap.
                exec.cancel.raise();
                let handle = lock(&exec.cancel_handle).clone();
                if let Some(handle) = handle
                    && let Err(err) = handle.cancel().await
                {
                    tracing::warn!(error = %err, "cancel request failed");
                }
                return None;
            }
            return Some(rows);
        }
        exec.update(|state| {
            let entry = &mut state.results[position];
            let memory_full = entry.bytes as u64 >= entry.limit_bytes;
            let room = if memory_full {
                0
            } else {
                usize::try_from(entry.limit_rows.saturating_sub(entry.row_count as u64))
                    .unwrap_or(usize::MAX)
            };
            let mut rows = rows;
            if room < rows.len() {
                rows.truncate(room);
                entry.truncated = true;
                entry.paused_by.get_or_insert(if memory_full {
                    PauseReason::MemoryLimit
                } else {
                    PauseReason::RowLimit
                });
            }
            if !rows.is_empty() {
                let (row_count, bytes) = entry.stored.append(rows);
                entry.row_count = row_count;
                entry.bytes = bytes;
            }
            state.dirty.insert(position);
        });
        None
    }

    async fn run_statement(
        &self,
        exec: &Arc<Execution>,
        conn: &Arc<dyn Connection>,
        index: usize,
    ) -> Outcome {
        let statement = exec.statements[index];
        let started_at = SystemTime::now();
        let started = Instant::now();
        let (sender, mut events) = mpsc::channel(self.config.channel_capacity.max(1));
        let driver_conn = Arc::clone(conn);
        let sql = exec.text[statement.range()].to_owned();
        let task: JoinHandle<Result<ExecSummary, ExecError>> =
            tokio::spawn(async move { driver_conn.execute(&sql, sender).await });

        let mut result: Option<usize> = None;
        let mut pending: Option<Vec<Vec<Value>>> = None;
        let mut cancelling = false;
        loop {
            if let Some(rows) = pending.take()
                && !cancelling
                && let Some(position) = result
            {
                match Self::accept_rows(exec, position, rows) {
                    Accepted::Stored => {}
                    Accepted::Tapped(rows) => {
                        pending = Self::feed_tap(exec, position, rows).await;
                        continue;
                    }
                    Accepted::Paused(rest, reason) => {
                        let result_id = exec.update(|state| {
                            state.status = ExecutionStatus::Paused;
                            let entry = &mut state.results[position];
                            entry.status = ResultStatus::Paused;
                            entry.paused_by = Some(reason);
                            state.dirty.insert(position);
                            entry.stored.id()
                        });
                        // Not reading the channel: the driver stops reading the server.
                        match exec.wait_resume(result_id).await {
                            Some(Wake::Resume(mode)) => {
                                exec.update(|state| {
                                    state.status = ExecutionStatus::Running;
                                    let entry = &mut state.results[position];
                                    entry.status = ResultStatus::Streaming;
                                    entry.paused_by = None;
                                    match mode {
                                        ResumeMode::More => {
                                            entry.limit_rows = entry
                                                .limit_rows
                                                .saturating_add(u64::from(exec.limits.max_rows));
                                            entry.limit_bytes = entry
                                                .limit_bytes
                                                .saturating_add(u64::from(exec.limits.max_bytes));
                                        }
                                        ResumeMode::All => {
                                            entry.limit_rows = u64::MAX;
                                            entry.limit_bytes = u64::MAX;
                                        }
                                    }
                                    state.dirty.insert(position);
                                });
                                pending = Some(rest);
                            }
                            Some(Wake::Tapped) => {
                                exec.update(|state| {
                                    state.status = ExecutionStatus::Running;
                                    let entry = &mut state.results[position];
                                    entry.status = ResultStatus::Streaming;
                                    // The batch in hand is past the limit: it goes to the
                                    // export only, the store stays as it is.
                                    entry.truncated = true;
                                    state.dirty.insert(position);
                                });
                                pending = Some(rest);
                            }
                            None => cancelling = true,
                        }
                        continue;
                    }
                }
            }
            let event = tokio::select! {
                biased;
                () = exec.cancel.wait(), if !cancelling => {
                    // Keep draining: the driver finishes once the engine stops the statement.
                    cancelling = true;
                    continue;
                }
                event = events.recv() => event,
            };
            match event {
                None => break,
                Some(ExecEvent::Columns(columns)) => {
                    let stored = self.store.create(columns);
                    let limits = exec.limits;
                    let previous = result;
                    let mut ended_tap = None;
                    result = Some(exec.update(|state| {
                        // A batch with several result sets (SQL Server): the previous one
                        // is complete once the next one starts.
                        if let Some(previous) = previous {
                            state.results[previous].status = ResultStatus::Complete;
                            ended_tap = state.results[previous].tap.take();
                            state.dirty.insert(previous);
                        }
                        state.results.push(ResultEntry {
                            stored,
                            statement_index: to_u32(index),
                            status: ResultStatus::Streaming,
                            paused_by: None,
                            row_count: 0,
                            bytes: 0,
                            limit_rows: u64::from(limits.max_rows),
                            limit_bytes: u64::from(limits.max_bytes),
                            tap: None,
                            truncated: false,
                        });
                        let position = state.results.len() - 1;
                        state.dirty.insert(position);
                        position
                    }));
                    if let Some(tap) = ended_tap {
                        let _ = tap.send(TapMsg::End(TapEnd::Complete)).await;
                    }
                }
                Some(ExecEvent::Rows(rows)) => {
                    if !cancelling {
                        pending = Some(rows);
                    }
                }
                Some(ExecEvent::Notice(notice)) => {
                    exec.message(Some(index), MessageBody::Notice(notice));
                }
            }
        }
        let summary = match task.await {
            Ok(summary) => summary,
            Err(err) => Err(YadbeError::internal(format!("statement task failed: {err}")).into()),
        };
        let duration = started.elapsed();
        let (result_id, rows_returned) = result.map_or((None, None), |position| {
            let state = lock(&exec.state);
            let entry = &state.results[position];
            (Some(entry.stored.id()), Some(entry.row_count))
        });
        // The status and the tap change together, so an export cannot attach to a result
        // whose stream already ended.
        let final_status = match &summary {
            Ok(_) if !cancelling => ResultStatus::Complete,
            Err(failure) if !cancelling && failure.error.code != ErrorCode::Cancelled => {
                ResultStatus::Failed
            }
            _ => ResultStatus::Cancelled,
        };
        let ended_tap = result.and_then(|position| {
            exec.update(|state| {
                let entry = &mut state.results[position];
                entry.status = final_status;
                state.dirty.insert(position);
                entry.tap.take()
            })
        });
        if let Some(tap) = ended_tap {
            let end = match final_status {
                ResultStatus::Complete => TapEnd::Complete,
                ResultStatus::Failed => TapEnd::Failed,
                _ => TapEnd::Cancelled,
            };
            let _ = tap.send(TapMsg::End(end)).await;
        }
        let set_result_status = |status: ResultStatus| {
            if let Some(position) = result {
                exec.update(|state| {
                    state.results[position].status = status;
                    state.dirty.insert(position);
                });
            }
        };
        match summary {
            Ok(mut summary) if !cancelling => {
                set_result_status(ResultStatus::Complete);
                if !reports_row_count(&exec.text[statement.range()], &exec.syntax) {
                    summary.rows_affected = None;
                }
                let rows = summary
                    .rows_affected
                    .or_else(|| rows_returned.map(|r| r as u64));
                self.record(exec, index, started_at, duration, rows, Ok(()));
                #[allow(clippy::cast_precision_loss)]
                exec.message(
                    Some(index),
                    MessageBody::StatementCompleted(StatementCompleted {
                        duration_ms: (duration.as_secs_f64() * 10_000.0).round() / 10.0,
                        rows_affected: summary.rows_affected.map(|r| r as f64),
                        rows_returned: rows_returned.map(to_u32),
                        result_id,
                    }),
                );
                Outcome::Done
            }
            outcome => {
                let failure = match outcome {
                    Err(failure) => failure,
                    // Finished although cancelled: report the cancel all the same.
                    Ok(_) => YadbeError::cancelled().into(),
                };
                let cancelled = cancelling || failure.error.code == ErrorCode::Cancelled;
                let error = if cancelled {
                    YadbeError::cancelled()
                } else {
                    failure.error
                };
                set_result_status(if cancelled {
                    ResultStatus::Cancelled
                } else {
                    ResultStatus::Failed
                });
                self.record(
                    exec,
                    index,
                    started_at,
                    duration,
                    rows_returned.map(|r| r as u64),
                    Err(error.clone()),
                );
                exec.message(
                    Some(index),
                    MessageBody::Error(StatementError {
                        error: error.clone(),
                        server: failure.server.map(|s| *s),
                        position: failure.location.map(|l| exec.position(&statement, l)),
                    }),
                );
                Outcome::Failed(error)
            }
        }
    }

    /// Cancels the tab's running execution with the engine's native mechanism.
    pub async fn cancel(&self, tab_id: &str) {
        let Some(exec) = self.existing_tab(tab_id).and_then(|t| t.execution()) else {
            return;
        };
        if exec.is_finished() {
            return;
        }
        exec.cancel.raise();
        let handle = lock(&exec.cancel_handle).clone();
        if let Some(handle) = handle
            && let Err(err) = handle.cancel().await
        {
            tracing::warn!(error = %err, "cancel request failed");
        }
    }

    /// Load more / load all on a paused result.
    pub fn resume(&self, result_id: u32, mode: ResumeMode) -> Result<(), YadbeError> {
        let tabs: Vec<Arc<Tab>> = lock(&self.tabs).values().cloned().collect();
        let exec = tabs
            .iter()
            .filter_map(|t| t.execution())
            .find(|e| e.result_ids().contains(&result_id))
            .ok_or_else(|| YadbeError::result_not_found(result_id))?;
        *lock(&exec.resume_request) = Some((result_id, mode));
        exec.resume.notify_waiters();
        Ok(())
    }

    /// Opens a result for an export (M2-7): its stored rows, then, while the statement is
    /// still streaming or paused at its limit, the rest of the stream, read from the
    /// server without growing the stored result.
    pub fn open_result_stream(&self, result_id: u32) -> Result<ResultStream, YadbeError> {
        let tabs: Vec<Arc<Tab>> = lock(&self.tabs).values().cloned().collect();
        let exec = tabs
            .iter()
            .filter_map(|t| t.execution())
            .find(|e| e.result_ids().contains(&result_id))
            .ok_or_else(|| YadbeError::result_not_found(result_id))?;
        let mut state = lock(&exec.state);
        let finished = state.finished_ms.is_some();
        let entry = state
            .results
            .iter_mut()
            .find(|r| r.stored.id() == result_id)
            .ok_or_else(|| YadbeError::result_not_found(result_id))?;
        let live =
            !finished && matches!(entry.status, ResultStatus::Streaming | ResultStatus::Paused);
        let stored = Arc::clone(&entry.stored);
        let stored_rows = entry.row_count;
        if !live {
            return Ok(ResultStream {
                stored,
                stored_rows,
                tail: None,
                truncated: entry.truncated,
            });
        }
        if entry.tap.is_some() {
            return Err(YadbeError::invalid_argument(
                "This result is already being exported.",
                "Ce résultat est déjà en cours d'export.",
            ));
        }
        let (sender, receiver) = mpsc::channel(TAP_CAPACITY);
        entry.tap = Some(sender);
        drop(state);
        exec.resume.notify_waiters();
        Ok(ResultStream {
            stored,
            stored_rows,
            tail: Some(receiver),
            truncated: false,
        })
    }

    pub fn window(
        &self,
        result_id: u32,
        offset: u32,
        limit: u32,
    ) -> Result<ResultWindow, YadbeError> {
        if limit > MAX_WINDOW_ROWS {
            return Err(YadbeError::invalid_argument(
                format!("A window has at most {MAX_WINDOW_ROWS} rows."),
                format!("Une fenêtre compte au plus {MAX_WINDOW_ROWS} lignes."),
            ));
        }
        let stored = self.store.get(result_id)?;
        Ok(stored.window(offset as usize, limit as usize))
    }

    pub fn cell(&self, result_id: u32, row: u32, column: u32) -> Result<Value, YadbeError> {
        self.store
            .get(result_id)?
            .cell(row as usize, column as usize)
            .ok_or_else(|| {
                YadbeError::invalid_argument(
                    "This cell is outside the result.",
                    "Cette cellule est hors du résultat.",
                )
            })
    }

    pub fn tab_info(&self, tab_id: &str) -> QueryTabInfo {
        let Some(tab) = self.existing_tab(tab_id) else {
            return QueryTabInfo {
                tab_id: tab_id.to_owned(),
                transaction: TransactionState::default(),
                connection_id: None,
                database: None,
                execution: None,
            };
        };
        let shared = lock(&tab.shared);
        QueryTabInfo {
            tab_id: tab_id.to_owned(),
            transaction: shared.transaction,
            connection_id: shared.connection_id.clone(),
            database: shared.database.clone(),
            execution: shared.execution.as_ref().map(|e| e.snapshot()),
        }
    }

    pub fn set_mode(
        &self,
        tab_id: &str,
        mode: TransactionMode,
    ) -> Result<TransactionState, YadbeError> {
        let tab = self.tab(tab_id);
        let _guard = tab.try_conn()?;
        if tab.transaction().status != TransactionStatus::Idle {
            return Err(YadbeError::transaction_open());
        }
        tab.set_transaction(&*self.sink, |t| t.mode = mode);
        Ok(tab.transaction())
    }

    /// Commits (`commit`) or rolls back the tab's transaction.
    pub async fn end_transaction(
        &self,
        tab_id: &str,
        commit: bool,
    ) -> Result<TransactionState, YadbeError> {
        let Some(tab) = self.existing_tab(tab_id) else {
            return Ok(TransactionState::default());
        };
        let guard = tab.try_conn()?;
        if tab.transaction().status == TransactionStatus::Idle {
            return Ok(tab.transaction());
        }
        let Some(current) = guard.as_ref().filter(|c| c.is_alive()) else {
            tab.set_transaction(&*self.sink, |t| t.status = TransactionStatus::Idle);
            return Ok(tab.transaction());
        };
        // Recorded in the statement log by the driver.
        let result = current
            .conn
            .query(if commit { "COMMIT" } else { "ROLLBACK" }, 0)
            .await;
        let open = current.conn.in_transaction().unwrap_or(false);
        tab.set_transaction(&*self.sink, |t| {
            t.status = if open {
                TransactionStatus::Open
            } else {
                TransactionStatus::Idle
            };
        });
        drop(guard);
        result.map(|_| tab.transaction())
    }

    /// The tab closed: cancel, free its results, close its connection in the background.
    pub async fn close_tab(&self, tab_id: &str) {
        let Some(tab) = lock(&self.tabs).remove(tab_id) else {
            return;
        };
        if let Some(exec) = tab.execution() {
            self.store.remove(exec.result_ids());
            if !exec.is_finished() {
                exec.cancel.raise();
                let handle = lock(&exec.cancel_handle).clone();
                if let Some(handle) = handle {
                    let _ = handle.cancel().await;
                }
            }
        }
        tokio::spawn(async move {
            let mut guard = tab.conn.lock().await;
            if let Some(conn) = guard.take() {
                conn.close().await;
            }
        });
    }
}

/// Watches a tab connection: when its link drops or its session closes, it is dead and its
/// transaction gone (a statement running on it fails with the link).
fn spawn_watcher(
    tab: Weak<Tab>,
    sink: Arc<dyn EventSink>,
    conn: Arc<dyn Connection>,
    mut session_closed: tokio::sync::watch::Receiver<bool>,
    dead: Arc<AtomicBool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut link = conn.link();
        let closed = tokio::select! {
            () = link.lost() => false,
            _ = session_closed.wait_for(|closed| *closed) => true,
        };
        dead.store(true, Ordering::SeqCst);
        if let Some(tab) = tab.upgrade() {
            {
                let mut shared = lock(&tab.shared);
                shared.connection_id = None;
                shared.database = None;
            }
            tab.set_transaction(&*sink, |t| t.status = TransactionStatus::Idle);
        }
        if closed {
            conn.close().await;
        }
    })
}
