//! Typed events pushed to the frontend. Names are derived by tauri-specta (`AppReady` → `app-ready`).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Sample event that proves the event channel end to end (backend → bindings → both clients).
/// Real events (connection state, statement log, progress…) arrive with M0-2.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AppReady {
    pub app_version: String,
}
