//! The real [`HistoryRecorder`]: statements are queued from the runner's task and written
//! to the store in batches by a dedicated thread, which also prunes the history and emits
//! the (debounced) `history-changed` event.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::db::config::ConnectionDefinition;
use crate::events::{BackendEvent, EventSink, HistoryChanged};
use crate::session::history_hook::{HistoryEntry, HistoryRecorder};
use crate::store::{HistoryOutcome, HistoryRetention, NewHistoryEntry, Store};

/// At most one `history-changed` per this interval.
const EMIT_DEBOUNCE: Duration = Duration::from_millis(250);
const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
/// Also prune after this many writes, whatever the clock says.
const PRUNE_EVERY_WRITES: usize = 1000;
const MAX_BATCH: usize = 500;

enum Msg {
    Entry(Box<HistoryEntry>),
    /// Something else changed the history (delete, clear): tell the panel.
    Changed,
    /// The retention preferences changed: apply them now.
    Prune,
    /// Answers once everything queued before it is written.
    Flush(SyncSender<()>),
    Shutdown,
}

pub struct StoreHistory {
    tx: Sender<Msg>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl StoreHistory {
    pub fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("history-writer".into())
            .spawn(move || Writer::new(store, sink).run(&rx))
            .map_err(|err| tracing::error!(error = %err, "cannot start the history writer"))
            .ok();
        Arc::new(Self {
            tx,
            thread: Mutex::new(thread),
        })
    }

    /// Announces a change made outside the writer (an entry deleted, the history cleared).
    pub fn notify_changed(&self) {
        let _ = self.tx.send(Msg::Changed);
    }

    /// Applies the retention of the preferences now (they were just changed).
    pub fn prune_now(&self) {
        let _ = self.tx.send(Msg::Prune);
    }

    /// Blocks until every statement recorded so far is in the store (tests, shutdown).
    pub fn flush(&self) {
        let (ack, done) = mpsc::sync_channel(1);
        if self.tx.send(Msg::Flush(ack)).is_ok() {
            let _ = done.recv_timeout(Duration::from_secs(10));
        }
    }
}

impl HistoryRecorder for StoreHistory {
    fn record(&self, entry: HistoryEntry) {
        let _ = self.tx.send(Msg::Entry(Box::new(entry)));
    }
}

impl Drop for StoreHistory {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Shutdown);
        let thread = self
            .thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }
}

fn unix_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

struct Writer {
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
    last_emit: Option<Instant>,
    emit_at: Option<Instant>,
    last_prune: Instant,
    writes_since_prune: usize,
}

impl Writer {
    fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            store,
            sink,
            last_emit: None,
            emit_at: None,
            last_prune: Instant::now(),
            writes_since_prune: 0,
        }
    }

    fn run(mut self, rx: &Receiver<Msg>) {
        self.prune();
        loop {
            let wait = self.emit_at.map_or(PRUNE_INTERVAL, |at| {
                at.saturating_duration_since(Instant::now())
            });
            let first = match rx.recv_timeout(wait) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Timeout) => {
                    self.tick();
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let mut entries = Vec::new();
            let mut acks = Vec::new();
            let mut changed = false;
            let mut prune = false;
            let mut shutdown = false;
            let mut next = Some(first);
            while let Some(msg) = next.take() {
                match msg {
                    Msg::Entry(entry) => entries.push(*entry),
                    Msg::Changed => changed = true,
                    Msg::Prune => prune = true,
                    Msg::Flush(ack) => acks.push(ack),
                    Msg::Shutdown => shutdown = true,
                }
                if entries.len() < MAX_BATCH && !shutdown {
                    next = rx.try_recv().ok();
                }
            }
            if self.write(&entries) || changed {
                self.schedule_emit();
            }
            if prune {
                self.prune();
            }
            self.tick();
            for ack in acks {
                let _ = ack.send(());
            }
            if shutdown {
                return;
            }
        }
    }

    /// Writes a batch; `true` when something was stored.
    fn write(&mut self, entries: &[HistoryEntry]) -> bool {
        // Read once per batch: the preference can change while the app runs.
        if entries.is_empty() || !self.store.preferences().is_ok_and(|p| p.history_enabled) {
            return false;
        }
        let mut definitions: HashMap<&str, Option<ConnectionDefinition>> = HashMap::new();
        let mut rows = Vec::with_capacity(entries.len());
        for entry in entries {
            let definition = definitions
                .entry(entry.connection_id.as_str())
                .or_insert_with(|| {
                    self.store
                        .connection(&entry.connection_id)
                        .ok()
                        .map(|c| c.definition)
                })
                .as_ref();
            // A connection deleted while its statement ran has nothing to attach to.
            let Some(definition) = definition else {
                continue;
            };
            if !definition.history_enabled {
                continue;
            }
            let (error_code, error_message) = match &entry.outcome {
                Ok(()) => (None, None),
                Err(e) => (
                    Some(e.code),
                    Some(e.detail.clone().unwrap_or_else(|| e.message.en.clone())),
                ),
            };
            rows.push(NewHistoryEntry {
                connection_id: entry.connection_id.clone(),
                connection_name: definition.name.clone(),
                engine: definition.engine,
                database: entry
                    .database
                    .clone()
                    .or_else(|| Some(definition.database.clone()))
                    .filter(|d| !d.is_empty()),
                sql: entry.sql.clone(),
                started_at_ms: unix_ms(entry.started_at),
                duration_ms: (entry.duration.as_secs_f64() * 10_000.0).round() / 10.0,
                rows: entry.rows.map(|r| i64::try_from(r).unwrap_or(i64::MAX)),
                outcome: HistoryOutcome::of(&entry.outcome),
                error_code,
                error_message,
            });
        }
        if rows.is_empty() {
            return false;
        }
        match self.store.insert_history(&rows) {
            Ok(()) => {
                self.writes_since_prune += rows.len();
                true
            }
            Err(err) => {
                tracing::error!(error = %err, "cannot write the history");
                false
            }
        }
    }

    /// Prunes when due, then emits when the debounce allows.
    fn tick(&mut self) {
        if self.writes_since_prune >= PRUNE_EVERY_WRITES
            || self.last_prune.elapsed() >= PRUNE_INTERVAL
        {
            self.prune();
        }
        if self.emit_at.is_some_and(|at| at <= Instant::now()) {
            self.emit_at = None;
            self.last_emit = Some(Instant::now());
            self.sink
                .emit(BackendEvent::HistoryChanged(HistoryChanged {}));
        }
    }

    fn prune(&mut self) {
        self.last_prune = Instant::now();
        self.writes_since_prune = 0;
        let retention = self
            .store
            .preferences()
            .map(|p| HistoryRetention {
                max_entries: p.history_max_entries,
                max_age_days: p.history_max_age_days,
            })
            .unwrap_or_default();
        match self
            .store
            .prune_history(retention, unix_ms(SystemTime::now()))
        {
            Ok(0) => {}
            Ok(removed) => {
                tracing::info!(removed, "pruned the history");
                self.schedule_emit();
            }
            Err(err) => tracing::warn!(error = %err, "cannot prune the history"),
        }
    }

    /// The first change after a quiet period is announced at once; the next ones wait for the
    /// debounce interval and share one event.
    fn schedule_emit(&mut self) {
        if self.emit_at.is_some() {
            return;
        }
        let now = Instant::now();
        self.emit_at = Some(
            self.last_emit
                .map_or(now, |at| (at + EMIT_DEBOUNCE).max(now)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;
    use crate::events::RecordingSink;
    use crate::store::{HistoryQuery, Preferences};

    fn entry(sql: &str, started_at_ms: i64) -> NewHistoryEntry {
        NewHistoryEntry {
            connection_id: "c".into(),
            connection_name: "shop".into(),
            engine: Engine::Postgres,
            database: None,
            sql: sql.into(),
            started_at_ms,
            duration_ms: 1.0,
            rows: None,
            outcome: HistoryOutcome::Ok,
            error_code: None,
            error_message: None,
        }
    }

    #[test]
    fn the_history_is_pruned_when_the_writer_starts_and_the_panel_is_told() {
        let store = Arc::new(Store::open_in_memory().expect("store"));
        let now = unix_ms(SystemTime::now());
        let day = 86_400_000;
        store
            .insert_history(&[
                entry("too old", now - 40 * day),
                entry("old", now - 3 * day),
                entry("recent", now - day / 2),
            ])
            .expect("insert");
        store
            .set_preferences(&Preferences {
                history_max_entries: 100,
                history_max_age_days: 30,
                ..Preferences::default()
            })
            .expect("preferences");
        let sink = Arc::new(RecordingSink::default());
        let history = StoreHistory::new(Arc::clone(&store), sink.clone());
        history.flush();
        let search = || -> Vec<String> {
            store
                .search_history(&HistoryQuery::default())
                .expect("search")
                .rows
                .into_iter()
                .map(|row| row.sql)
                .collect()
        };
        assert_eq!(search(), ["recent", "old"]);
        // Lowering the bound applies at once.
        store
            .set_preferences(&Preferences {
                history_max_entries: 100,
                history_max_age_days: 1,
                ..Preferences::default()
            })
            .expect("preferences");
        history.prune_now();
        history.flush();
        assert_eq!(search(), ["recent"]);
        drop(history);
        assert!(
            sink.events()
                .iter()
                .any(|e| matches!(e, BackendEvent::HistoryChanged(_)))
        );
    }
}
