//! History (F-100, F-101, F-104): search, entry, delete, clear. Recording happens in the
//! query runner; `history-changed` tells the panel to query again.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::state::AppState;
use crate::store::{HistoryPage, HistoryQuery, HistoryRow, HistoryScope};

/// One page of the history, newest first: full-text `text`, filters, keyset pagination
/// (`after` is the previous page's `next`). Statements are cut in list rows.
#[tauri::command]
#[specta::specta]
pub async fn search_history(
    state: State<'_, AppState>,
    query: HistoryQuery,
) -> Result<HistoryPage, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.search_history(&query)).await
}

/// An entry with its whole statement and error message; `null` once deleted or pruned.
#[tauri::command]
#[specta::specta]
pub async fn get_history_entry(
    state: State<'_, AppState>,
    id: f64,
) -> Result<Option<HistoryRow>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.history_entry(id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_entry(state: State<'_, AppState>, id: f64) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.delete_history_entry(id)).await?;
    state.history.notify_changed();
    Ok(())
}

/// How many entries `clear_history` would delete: the concrete effect to confirm.
#[tauri::command]
#[specta::specta]
pub async fn count_history(
    state: State<'_, AppState>,
    scope: HistoryScope,
) -> Result<u32, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.count_history(&scope)).await
}

/// Deletes the entries inside `scope` (all, one connection, a date range); returns how
/// many.
#[tauri::command]
#[specta::specta]
pub async fn clear_history(
    state: State<'_, AppState>,
    scope: HistoryScope,
) -> Result<u32, YadbeError> {
    let store = Arc::clone(&state.store);
    let removed = blocking(move || store.clear_history(&scope)).await?;
    state.history.notify_changed();
    Ok(removed)
}
