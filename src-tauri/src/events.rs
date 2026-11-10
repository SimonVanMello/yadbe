//! Typed events pushed to the frontend. Names are derived by tauri-specta
//! (`ConnectionStateChanged` → `connection-state-changed`).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::db::meta::MetaNode;
use crate::session::SessionInfo;
use crate::session::query_model::{ExecutionDelta, TransactionState};
use crate::session::statement_log::StatementLogEntry;

/// Emitted once the backend is ready; proves the event channel end to end.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AppReady {
    pub app_version: String,
}

/// A connection changed state: connecting, connected, lost, reconnecting or closed.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStateChanged {
    pub session: SessionInfo,
}

/// yadbe ran a statement on its own (version query, ping, metadata…) and logged it.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct StatementLogged {
    pub entry: StatementLogEntry,
}

/// Why cached metadata was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MetaRefreshReason {
    /// The user asked for a refresh (`refresh_meta`).
    Refresh,
    /// The connection came back after a drop: everything is read again.
    Reconnected,
}

/// The cached metadata of `node` and everything below it was dropped: what is displayed
/// there must be read again (lazily, as nodes are shown).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct MetaRefreshed {
    pub connection_id: String,
    pub node: MetaNode,
    pub reason: MetaRefreshReason,
}

/// An execution progressed: rows streamed, a result set or a message appeared, a statement
/// started. Throttled (at most about ten per second per execution); apply `delta` in order.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct QueryProgress {
    pub tab_id: String,
    pub execution_id: u32,
    pub delta: ExecutionDelta,
}

/// An execution ended (`delta.status`: succeeded, failed or cancelled). Always the last
/// event of an execution; carries what changed since the last `query-progress`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct QueryFinished {
    pub tab_id: String,
    pub execution_id: u32,
    pub delta: ExecutionDelta,
}

/// A tab's transaction mode or status changed (statement run, commit, rollback, mode switch,
/// connection lost).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TransactionStateChanged {
    pub tab_id: String,
    pub transaction: TransactionState,
}

/// Every event the services emit, so they can be tested without Tauri.
#[derive(Debug, Clone)]
pub enum BackendEvent {
    ConnectionStateChanged(ConnectionStateChanged),
    StatementLogged(StatementLogged),
    MetaRefreshed(MetaRefreshed),
    QueryProgress(QueryProgress),
    QueryFinished(QueryFinished),
    TransactionStateChanged(TransactionStateChanged),
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: BackendEvent);
}

/// Drops every event.
#[derive(Debug, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: BackendEvent) {}
}

/// Keeps every event, for tests.
#[derive(Debug, Default)]
pub struct RecordingSink {
    events: Mutex<Vec<BackendEvent>>,
}

impl RecordingSink {
    pub fn events(&self) -> Vec<BackendEvent> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, event: BackendEvent) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event);
    }
}

/// Forwards events to the webview.
pub struct TauriSink(pub tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: BackendEvent) {
        let app = &self.0;
        let result = match event {
            BackendEvent::ConnectionStateChanged(e) => e.emit(app),
            BackendEvent::StatementLogged(e) => e.emit(app),
            BackendEvent::MetaRefreshed(e) => e.emit(app),
            BackendEvent::QueryProgress(e) => e.emit(app),
            BackendEvent::QueryFinished(e) => e.emit(app),
            BackendEvent::TransactionStateChanged(e) => e.emit(app),
        };
        if let Err(err) = result {
            tracing::warn!(error = %err, "failed to emit event");
        }
    }
}
