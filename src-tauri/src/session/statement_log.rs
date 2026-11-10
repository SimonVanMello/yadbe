//! Bounded in-memory log of every statement yadbe ran on its own (F-124, SPEC §1.6).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use specta::Type;

use crate::db::driver::{RecordedStatement, StatementRecorder};
use crate::db::errors::YadbeError;
use crate::events::{BackendEvent, EventSink, StatementLogged};

/// Entries kept; the oldest go first.
pub const STATEMENT_LOG_CAPACITY: usize = 1000;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatementOutcome {
    /// `rows`: returned or affected, when known.
    Ok {
        rows: Option<f64>,
    },
    Error {
        error: YadbeError,
    },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementLogEntry {
    /// Increasing, unique for the app's lifetime.
    pub id: u32,
    /// `null` for a test of a connection that is not saved yet.
    pub connection_id: Option<String>,
    /// Name of the connection when the statement ran.
    pub connection_name: String,
    pub sql: String,
    /// Unix time in milliseconds.
    pub started_at: f64,
    pub duration_ms: f64,
    pub outcome: StatementOutcome,
}

pub struct StatementLog {
    entries: Mutex<(u32, VecDeque<StatementLogEntry>)>,
    sink: Arc<dyn EventSink>,
}

impl StatementLog {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            entries: Mutex::new((0, VecDeque::new())),
            sink,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (u32, VecDeque<StatementLogEntry>)> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Oldest first.
    pub fn entries(&self) -> Vec<StatementLogEntry> {
        self.lock().1.iter().cloned().collect()
    }

    pub fn clear(&self) {
        self.lock().1.clear();
    }

    pub fn push(
        &self,
        connection_id: Option<&str>,
        connection_name: &str,
        statement: RecordedStatement,
    ) -> StatementLogEntry {
        let entry = {
            let mut guard = self.lock();
            guard.0 = guard.0.wrapping_add(1);
            let entry = StatementLogEntry {
                id: guard.0,
                connection_id: connection_id.map(str::to_owned),
                connection_name: connection_name.to_owned(),
                sql: statement.sql,
                started_at: statement
                    .started_at
                    .duration_since(UNIX_EPOCH)
                    .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
                    .floor(),
                duration_ms: (statement.duration.as_secs_f64() * 1000.0 * 10.0).round() / 10.0,
                outcome: match statement.outcome {
                    // Row counts above 2^53 lose precision; they do not happen in practice.
                    #[allow(clippy::cast_precision_loss)]
                    Ok(rows) => StatementOutcome::Ok {
                        rows: rows.map(|r| r as f64),
                    },
                    Err(error) => StatementOutcome::Error { error },
                },
            };
            if guard.1.len() == STATEMENT_LOG_CAPACITY {
                guard.1.pop_front();
            }
            guard.1.push_back(entry.clone());
            entry
        };
        tracing::debug!(sql = %entry.sql, ms = entry.duration_ms, "statement logged");
        self.sink
            .emit(BackendEvent::StatementLogged(StatementLogged {
                entry: entry.clone(),
            }));
        entry
    }

    /// A recorder bound to one connection, handed to its driver.
    pub fn recorder(
        self: &Arc<Self>,
        connection_id: Option<String>,
        connection_name: String,
    ) -> Arc<dyn StatementRecorder> {
        Arc::new(ScopedRecorder {
            log: Arc::clone(self),
            connection_id,
            connection_name,
        })
    }
}

struct ScopedRecorder {
    log: Arc<StatementLog>,
    connection_id: Option<String>,
    connection_name: String,
}

impl StatementRecorder for ScopedRecorder {
    fn record(&self, statement: RecordedStatement) {
        self.log.push(
            self.connection_id.as_deref(),
            &self.connection_name,
            statement,
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::events::RecordingSink;

    fn statement(sql: &str) -> RecordedStatement {
        RecordedStatement {
            sql: sql.to_owned(),
            started_at: SystemTime::now(),
            duration: Duration::from_micros(1500),
            outcome: Ok(Some(1)),
        }
    }

    #[test]
    fn keeps_the_latest_entries_and_emits_events() {
        let sink = Arc::new(RecordingSink::default());
        let log = Arc::new(StatementLog::new(sink.clone()));
        let recorder = log.recorder(Some("c1".into()), "Shop".into());
        for i in 0..STATEMENT_LOG_CAPACITY + 5 {
            recorder.record(statement(&format!("SELECT {i}")));
        }
        let entries = log.entries();
        assert_eq!(entries.len(), STATEMENT_LOG_CAPACITY);
        assert_eq!(entries[0].sql, "SELECT 5");
        assert_eq!(entries[0].duration_ms, 1.5);
        assert_eq!(entries[0].connection_name, "Shop");
        assert_eq!(sink.events().len(), STATEMENT_LOG_CAPACITY + 5);
        log.clear();
        assert!(log.entries().is_empty());
    }

    #[test]
    fn serializes_outcomes_with_a_kind() {
        let log = StatementLog::new(Arc::new(crate::events::NullSink));
        let mut failed = statement("SELECT x");
        failed.outcome = Err(YadbeError::query_failed("column x does not exist"));
        let entry = log.push(None, "Test", failed);
        let json = serde_json::to_value(&entry).expect("serializes");
        assert_eq!(json["outcome"]["kind"], "error");
        assert_eq!(json["outcome"]["error"]["code"], "queryFailed");
        assert_eq!(json["connectionId"], serde_json::Value::Null);
    }
}
