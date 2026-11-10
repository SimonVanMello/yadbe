//! Helpers of the query execution tests (M1-3): a `QueryRunner` over a real connection, and
//! the deltas of an execution folded the way the frontend applies them.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::errors::YadbeError;
use yadbe_lib::events::{BackendEvent, EventSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::history_hook::{HistoryEntry, HistoryRecorder};
use yadbe_lib::session::query_model::{
    ExecuteRequest, ExecuteScope, ExecutionStatus, MessageBody, QueryMessage, ResultLimits,
    ResultSummary, ResultWindow, TextRange, TransactionState,
};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::{ConnectionManager, QueryRunner};
use yadbe_lib::store::Store;

/// Keeps every event with the instant it was emitted.
#[derive(Default)]
pub struct TimedSink(Mutex<Vec<(Instant, BackendEvent)>>);

impl EventSink for TimedSink {
    fn emit(&self, event: BackendEvent) {
        self.0.lock().expect("sink").push((Instant::now(), event));
    }
}

impl TimedSink {
    pub fn events(&self) -> Vec<BackendEvent> {
        self.timed().into_iter().map(|(_, e)| e).collect()
    }

    pub fn timed(&self) -> Vec<(Instant, BackendEvent)> {
        self.0.lock().expect("sink").clone()
    }
}

#[derive(Default)]
pub struct History(pub Mutex<Vec<HistoryEntry>>);

impl HistoryRecorder for History {
    fn record(&self, entry: HistoryEntry) {
        self.0.lock().expect("history").push(entry);
    }
}

impl History {
    pub fn entries(&self) -> Vec<HistoryEntry> {
        self.0.lock().expect("history").clone()
    }
}

pub struct Bench {
    pub runner: Arc<QueryRunner>,
    pub manager: Arc<ConnectionManager>,
    pub sink: Arc<TimedSink>,
    pub log: Arc<StatementLog>,
    pub history: Arc<History>,
    pub store: Arc<Store>,
    pub connection_id: String,
}

/// Saves `definition`, connects it and builds a runner on top.
pub async fn bench(definition: ConnectionDefinition, password: Option<Secret>) -> Bench {
    let history = Arc::new(History::default());
    let recorder = history.clone();
    build(definition, password, history, move |_, _| recorder).await
}

/// Like [`bench`], with the history hook built from the store and the event sink (the real
/// `StoreHistory`); `Bench::history` stays empty.
pub async fn bench_with_history(
    definition: ConnectionDefinition,
    password: Option<Secret>,
    recorder: impl FnOnce(&Arc<Store>, &Arc<TimedSink>) -> Arc<dyn HistoryRecorder>,
) -> Bench {
    build(definition, password, Arc::default(), recorder).await
}

async fn build(
    definition: ConnectionDefinition,
    password: Option<Secret>,
    history: Arc<History>,
    recorder: impl FnOnce(&Arc<Store>, &Arc<TimedSink>) -> Arc<dyn HistoryRecorder>,
) -> Bench {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(TimedSink::default());
    let log = Arc::new(StatementLog::new(sink.clone()));
    let manager = Arc::new(ConnectionManager::new(
        Arc::clone(&store),
        secrets,
        Arc::clone(&log),
        sink.clone(),
    ));
    let saved = store.create_connection(&definition).expect("save");
    manager.connect(&saved.id, password).await.expect("connect");
    let runner = Arc::new(QueryRunner::new(
        Arc::clone(&manager),
        sink.clone(),
        recorder(&store, &sink),
    ));
    Bench {
        runner,
        manager,
        sink,
        log,
        history,
        store,
        connection_id: saved.id,
    }
}

/// An execution folded from its events.
#[derive(Debug)]
pub struct Run {
    pub execution_id: u32,
    pub statements: Vec<TextRange>,
    pub status: ExecutionStatus,
    pub results: Vec<ResultSummary>,
    pub messages: Vec<QueryMessage>,
    pub progress_events: usize,
}

impl Run {
    pub fn errors(&self) -> Vec<&yadbe_lib::session::query_model::StatementError> {
        self.messages
            .iter()
            .filter_map(|m| match &m.body {
                MessageBody::Error(e) => Some(e),
                _ => None,
            })
            .collect()
    }

    pub fn error_code(&self) -> Option<yadbe_lib::db::errors::ErrorCode> {
        self.errors().first().map(|e| e.error.code)
    }

    pub fn notices(&self) -> Vec<String> {
        self.messages
            .iter()
            .filter_map(|m| match &m.body {
                MessageBody::Notice(n) => Some(n.message.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn affected(&self) -> Vec<Option<f64>> {
        self.messages
            .iter()
            .filter_map(|m| match &m.body {
                MessageBody::StatementCompleted(c) => Some(c.rows_affected),
                _ => None,
            })
            .collect()
    }
}

impl Bench {
    pub fn request(&self, tab: &str, text: &str, scope: ExecuteScope) -> ExecuteRequest {
        ExecuteRequest {
            tab_id: tab.to_owned(),
            connection_id: self.connection_id.clone(),
            database: None,
            text: text.to_owned(),
            scope,
            limits: None,
        }
    }

    pub fn start(&self, request: ExecuteRequest) -> Result<(u32, Vec<TextRange>), YadbeError> {
        self.runner
            .execute(request)
            .map(|s| (s.execution_id, s.statements))
    }

    /// The execution's events so far, folded; `finished` once `query-finished` arrived.
    pub fn fold(&self, execution_id: u32) -> (Run, bool) {
        let mut results = BTreeMap::new();
        let mut messages = Vec::new();
        let mut status = ExecutionStatus::Connecting;
        let mut finished = false;
        let mut progress_events = 0;
        for event in self.sink.events() {
            let (delta, last) = match event {
                BackendEvent::QueryProgress(e) if e.execution_id == execution_id => {
                    progress_events += 1;
                    (e.delta, false)
                }
                BackendEvent::QueryFinished(e) if e.execution_id == execution_id => (e.delta, true),
                _ => continue,
            };
            assert!(!finished, "an event after query-finished");
            status = delta.status;
            for result in delta.results {
                results.insert(result.result_id, result);
            }
            messages.extend(delta.messages);
            finished |= last;
        }
        for (index, message) in messages.iter().enumerate() {
            assert_eq!(message.seq as usize, index, "messages in order, none lost");
        }
        (
            Run {
                execution_id,
                statements: Vec::new(),
                status,
                results: results.into_values().collect(),
                messages,
                progress_events,
            },
            finished,
        )
    }

    pub async fn wait(&self, execution_id: u32) -> Run {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let (run, finished) = self.fold(execution_id);
            if finished {
                return run;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "execution {execution_id} did not finish: {run:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Waits until `check` holds on the folded events.
    pub async fn wait_for(&self, execution_id: u32, check: impl Fn(&Run) -> bool) -> Run {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let (run, _) = self.fold(execution_id);
            if check(&run) {
                return run;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "condition not reached: {run:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn run_scoped(&self, tab: &str, text: &str, scope: ExecuteScope) -> Run {
        let (id, statements) = self.start(self.request(tab, text, scope)).expect("start");
        let mut run = self.wait(id).await;
        run.statements = statements;
        run
    }

    pub async fn run(&self, tab: &str, text: &str) -> Run {
        self.run_scoped(tab, text, ExecuteScope::All).await
    }

    pub async fn run_limited(&self, tab: &str, text: &str, limits: ResultLimits) -> u32 {
        let mut request = self.request(tab, text, ExecuteScope::All);
        request.limits = Some(limits);
        self.start(request).expect("start").0
    }

    pub fn window(&self, result_id: u32, offset: u32, limit: u32) -> ResultWindow {
        self.runner
            .window(result_id, offset, limit)
            .expect("window")
    }

    /// Column `column` of a whole small result, as text.
    pub fn column(&self, result: &ResultSummary, column: usize) -> Vec<Option<String>> {
        self.window(result.result_id, 0, result.row_count.min(2000))
            .columns[column]
            .values
            .clone()
    }

    pub fn transaction(&self, tab: &str) -> TransactionState {
        self.runner.tab_info(tab).transaction
    }

    pub fn logged(&self) -> Vec<String> {
        self.log.entries().into_iter().map(|e| e.sql).collect()
    }
}
