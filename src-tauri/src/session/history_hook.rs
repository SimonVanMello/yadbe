//! Hook through which every user statement reaches the history (F-100). The store and the
//! panel arrive with M1-6; the query runner only calls the hook.

use std::time::{Duration, SystemTime};

use crate::db::errors::YadbeError;

/// A user statement that ran (or was refused / cancelled).
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub tab_id: String,
    pub connection_id: String,
    /// `None`: the connection's database.
    pub database: Option<String>,
    /// Exactly as sent.
    pub sql: String,
    pub started_at: SystemTime,
    pub duration: Duration,
    /// Rows returned (result set) or affected (DML), when known.
    pub rows: Option<u64>,
    /// `Err`: failed, refused (`readOnlyViolation`) or cancelled.
    pub outcome: Result<(), YadbeError>,
}

/// Called once per user statement, from the runner's task: keep it quick (queue the write).
pub trait HistoryRecorder: Send + Sync {
    fn record(&self, entry: HistoryEntry);
}

/// Records nothing (until M1-6, and in tests that do not care).
pub struct NoHistory;

impl HistoryRecorder for NoHistory {
    fn record(&self, _entry: HistoryEntry) {}
}
