//! Preferences, tabs and the statement log.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::session::statement_log::StatementLogEntry;
use crate::state::AppState;
use crate::store::{Preferences, TabsState};

#[tauri::command]
#[specta::specta]
pub async fn get_preferences(state: State<'_, AppState>) -> Result<Preferences, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.preferences()).await
}

/// Saves every preference; returns them as stored.
#[tauri::command]
#[specta::specta]
pub async fn set_preferences(
    state: State<'_, AppState>,
    preferences: Preferences,
) -> Result<Preferences, YadbeError> {
    let store = Arc::clone(&state.store);
    let saved = blocking(move || store.set_preferences(&preferences)).await?;
    // A lower retention applies now, not at the next hourly prune.
    state.history.prune_now();
    Ok(saved)
}

/// Tabs saved by the last `save_tabs`, for restoration at startup.
#[tauri::command]
#[specta::specta]
pub async fn load_tabs(state: State<'_, AppState>) -> Result<TabsState, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.tabs()).await
}

/// Replaces the saved tabs (called on every change, debounced by the frontend).
#[tauri::command]
#[specta::specta]
pub async fn save_tabs(state: State<'_, AppState>, tabs: TabsState) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.save_tabs(&tabs)).await
}

/// Statements yadbe ran on its own, oldest first (bounded).
#[tauri::command]
#[specta::specta]
pub async fn get_statement_log(
    state: State<'_, AppState>,
) -> Result<Vec<StatementLogEntry>, YadbeError> {
    Ok(state.log.entries())
}

#[tauri::command]
#[specta::specta]
pub async fn clear_statement_log(state: State<'_, AppState>) -> Result<(), YadbeError> {
    state.log.clear();
    Ok(())
}
