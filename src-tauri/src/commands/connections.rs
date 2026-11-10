//! Saved connections and their groups (F-001, F-007).

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::config::ConnectionDefinition;
use crate::db::dialect::EngineInfo;
use crate::db::errors::YadbeError;
use crate::state::AppState;
use crate::store::{ConnectionGroup, SavedConnection};

/// Engines yadbe knows, with their capabilities and whether this build can connect.
#[tauri::command]
#[specta::specta]
pub async fn list_engines(state: State<'_, AppState>) -> Result<Vec<EngineInfo>, YadbeError> {
    Ok(state.connections.engines())
}

/// Every saved connection, by group then position.
#[tauri::command]
#[specta::specta]
pub async fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<SavedConnection>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.list_connections()).await
}

/// Saves a new connection at the end of its group. The password is set apart with
/// `set_connection_secret`.
#[tauri::command]
#[specta::specta]
pub async fn create_connection(
    state: State<'_, AppState>,
    definition: ConnectionDefinition,
) -> Result<SavedConnection, YadbeError> {
    let definition = definition.normalized()?;
    let store = Arc::clone(&state.store);
    blocking(move || store.create_connection(&definition)).await
}

/// Replaces a connection's definition. An open session keeps its current settings until it
/// reconnects.
#[tauri::command]
#[specta::specta]
pub async fn update_connection(
    state: State<'_, AppState>,
    connection_id: String,
    definition: ConnectionDefinition,
) -> Result<SavedConnection, YadbeError> {
    let definition = definition.normalized()?;
    let store = Arc::clone(&state.store);
    blocking(move || store.update_connection(&connection_id, &definition)).await
}

/// Copies a connection under a new name (secrets are not copied).
#[tauri::command]
#[specta::specta]
pub async fn duplicate_connection(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<SavedConnection, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || {
        let source = store.connection(&connection_id)?;
        let definition = ConnectionDefinition {
            name,
            ..source.definition
        }
        .normalized()?;
        store.create_connection(&definition)
    })
    .await
}

/// Closes the connection if open, forgets its secrets and deletes it.
#[tauri::command]
#[specta::specta]
pub async fn delete_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), YadbeError> {
    state.connections.disconnect(&connection_id).await;
    let store = Arc::clone(&state.store);
    let secrets = Arc::clone(&state.secrets);
    blocking(move || {
        store.delete_connection(&connection_id)?;
        if let Err(err) = secrets.delete_all(&connection_id) {
            tracing::warn!(error = %err, "could not delete the secrets of a deleted connection");
        }
        Ok(())
    })
    .await
}

/// Moves a connection into a group (`null`: top level) at a position among its siblings.
#[tauri::command]
#[specta::specta]
pub async fn move_connection(
    state: State<'_, AppState>,
    connection_id: String,
    group_id: Option<String>,
    position: u32,
) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.move_connection(&connection_id, group_id.as_ref(), position)).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_connection_groups(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionGroup>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.list_groups()).await
}

/// Creates a group at the end of its parent (`null`: top level).
#[tauri::command]
#[specta::specta]
pub async fn create_connection_group(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<ConnectionGroup, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.create_group(&name, parent_id.as_ref())).await
}

#[tauri::command]
#[specta::specta]
pub async fn rename_connection_group(
    state: State<'_, AppState>,
    group_id: String,
    name: String,
) -> Result<ConnectionGroup, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.rename_group(&group_id, &name)).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_connection_group_collapsed(
    state: State<'_, AppState>,
    group_id: String,
    collapsed: bool,
) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.set_group_collapsed(&group_id, collapsed)).await
}

/// Moves a group under another (`null`: top level); never into itself or a descendant.
#[tauri::command]
#[specta::specta]
pub async fn move_connection_group(
    state: State<'_, AppState>,
    group_id: String,
    parent_id: Option<String>,
    position: u32,
) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.move_group(&group_id, parent_id.as_ref(), position)).await
}

/// Deletes a group; its subgroups and connections move to its parent.
#[tauri::command]
#[specta::specta]
pub async fn delete_connection_group(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.delete_group(&group_id)).await
}
