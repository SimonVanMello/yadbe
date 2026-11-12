//! Change journal (F-090): every change set applied from a table tab, with its statements and
//! inverse; search, detail, clear, and "Revert this change set" (previewed, then applied in
//! one transaction on a table tab of the same table, rows changed since reported as conflicts).
//! `change-journal-changed` tells the journal view to query again.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::edit::model::{ApplyOutcome, EditPreview};
use crate::state::AppState;
use crate::store::{JournalDetail, JournalPage, JournalQuery, JournalTable};

/// One page of the journal, newest first (`after` is the previous page's `next`).
#[tauri::command]
#[specta::specta]
pub async fn search_change_journal(
    state: State<'_, AppState>,
    query: JournalQuery,
) -> Result<JournalPage, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.search_journal(&query)).await
}

/// An entry with its statements and inverse statements; `null` once cleared or pruned.
#[tauri::command]
#[specta::specta]
pub async fn get_change_journal_entry(
    state: State<'_, AppState>,
    id: u32,
) -> Result<Option<JournalDetail>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.journal_entry(id)).await
}

/// The tables that have entries (of one connection, or all), for the filter.
#[tauri::command]
#[specta::specta]
pub async fn list_change_journal_tables(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> Result<Vec<JournalTable>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.journal_tables(connection_id.as_deref())).await
}

/// Deletes the entries of a connection (every entry when `null`); returns how many.
#[tauri::command]
#[specta::specta]
pub async fn clear_change_journal(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> Result<u32, YadbeError> {
    let store = Arc::clone(&state.store);
    let cleared = blocking(move || store.clear_journal(connection_id.as_deref())).await?;
    state.journal.notify();
    Ok(cleared)
}

/// What reverting entry `entryId` would run on the table of table tab `tabId`, planned on the
/// table as it is now. Fails with `invalidArgument` when the entry belongs to another table,
/// was already reverted, or cannot be reverted faithfully (its `revertBlocker`).
#[tauri::command]
#[specta::specta]
pub async fn preview_change_set_revert(
    state: State<'_, AppState>,
    tab_id: String,
    entry_id: u32,
) -> Result<EditPreview, YadbeError> {
    state.tables.preview_revert(&tab_id, entry_id)
}

/// Reverts entry `entryId` on table tab `tabId`'s connection, like `apply_table_changes`: one
/// transaction, rows changed since the change set reported as `conflicted`, recorded as a
/// change set of its own (the entry is then marked reverted).
#[tauri::command]
#[specta::specta]
pub async fn apply_change_set_revert(
    state: State<'_, AppState>,
    tab_id: String,
    entry_id: u32,
) -> Result<ApplyOutcome, YadbeError> {
    state.tables.apply_revert(&tab_id, entry_id).await
}
