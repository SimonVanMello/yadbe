//! Typed events pushed to the frontend. Names are derived by tauri-specta
//! (`ConnectionStateChanged` → `connection-state-changed`).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::session::SessionInfo;
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

/// Every event the services emit, so they can be tested without Tauri.
#[derive(Debug, Clone)]
pub enum BackendEvent {
    ConnectionStateChanged(ConnectionStateChanged),
    StatementLogged(StatementLogged),
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
        };
        if let Err(err) = result {
            tracing::warn!(error = %err, "failed to emit event");
        }
    }
}
