//! Testing, opening and closing connections (F-004, F-013).

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::config::ConnectionDefinition;
use crate::db::errors::YadbeError;
use crate::secrets::{SecretInput, SecretStore};
use crate::session::{SessionInfo, TestConnectionResult};
use crate::state::AppState;

async fn resolve(
    secrets: &Arc<SecretStore>,
    input: Option<SecretInput>,
) -> Result<Option<crate::secrets::Secret>, YadbeError> {
    match input {
        // A pending secret stays available: the user may test, then save.
        Some(input) => {
            let secrets = Arc::clone(secrets);
            blocking(move || secrets.resolve(input, false).map(Some)).await
        }
        None => Ok(None),
    }
}

/// Tests a definition, saved or not: connects, reads the server version, pings and closes.
/// Without `password`, the stored secret of `connectionId` is used. `requestId` lets
/// `cancel_test_connection` abort it.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(
    state: State<'_, AppState>,
    request_id: String,
    definition: ConnectionDefinition,
    password: Option<SecretInput>,
    connection_id: Option<String>,
) -> Result<TestConnectionResult, YadbeError> {
    let definition = definition.normalized()?;
    let password = resolve(&state.secrets, password).await?;
    state
        .connections
        .test(request_id, definition, password, connection_id)
        .await
}

/// Aborts a running `test_connection` (it then fails with `cancelled`).
#[tauri::command]
#[specta::specta]
pub async fn cancel_test_connection(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), YadbeError> {
    state.connections.cancel_test(&request_id);
    Ok(())
}

/// Opens a saved connection. `password` (typed at connect time) is kept for the session;
/// without it, the session or keychain secret is used. State changes are also pushed as
/// `connection-state-changed`.
#[tauri::command]
#[specta::specta]
pub async fn connect(
    state: State<'_, AppState>,
    connection_id: String,
    password: Option<SecretInput>,
) -> Result<SessionInfo, YadbeError> {
    let password = resolve(&state.secrets, password).await?;
    state.connections.connect(&connection_id, password).await
}

/// Closes a connection (also aborts a connection attempt or a reconnection).
#[tauri::command]
#[specta::specta]
pub async fn disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), YadbeError> {
    state.connections.disconnect(&connection_id).await;
    Ok(())
}

/// State of every connection that is not closed.
#[tauri::command]
#[specta::specta]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, YadbeError> {
    Ok(state.connections.sessions())
}
