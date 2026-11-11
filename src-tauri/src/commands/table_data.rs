//! Table data (M2-1, F-080, F-081, F-086): a table or view browsed page by page in a table
//! tab, with a parameterized filter and sort, row counts and editability.
//!
//! Each table tab owns a dedicated server connection, opened on its first read and closed
//! by `close_table_data` (or when the connection closes). One statement runs per tab at a
//! time; `cancel_table_data` stops it with the engine's native cancel (the call then fails
//! with `cancelled`). Every statement is recorded in the statement log, with its values
//! written as literals.

use tauri::State;

use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::session::table_model::{
    CountMode, RefreshedRows, RowKey, TableDataInfo, TableFilter, TablePage, TablePageRequest,
    TableRowCount,
};
use crate::state::AppState;

/// Opens `table` (a table, view or materialized view) in the table tab `tabId`: its columns,
/// row identity and why it or its columns cannot be edited. Reads the cached metadata
/// (`objectNotFound` when it no longer exists). Opening another table in the same tab
/// replaces the previous one.
#[tauri::command]
#[specta::specta]
pub async fn open_table_data(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    table: ObjectRef,
) -> Result<TableDataInfo, YadbeError> {
    state
        .tables
        .open(&state.meta, &tab_id, &connection_id, &table)
        .await
}

/// Reads one page: `SELECT … WHERE <filter> ORDER BY <sort> <paging>` built by the dialect,
/// values bound. Frees the tab's previous page. Fails with `invalidArgument` for an unknown
/// column, a wrong number of filter values, a page size outside 1 to 50 000 or a raw
/// `WHERE` holding several statements, `queryFailed` when the engine rejects it.
#[tauri::command]
#[specta::specta]
pub async fn fetch_table_page(
    state: State<'_, AppState>,
    tab_id: String,
    request: TablePageRequest,
) -> Result<TablePage, YadbeError> {
    state.tables.page(&tab_id, request).await
}

/// Counts the rows matching `filter`: an estimate from the engine's statistics, or an exact
/// `COUNT(*)` (cancellable).
#[tauri::command]
#[specta::specta]
pub async fn count_table_rows(
    state: State<'_, AppState>,
    tab_id: String,
    filter: TableFilter,
    mode: CountMode,
) -> Result<TableRowCount, YadbeError> {
    state.tables.count(&tab_id, filter, mode).await
}

/// Reads rows again by their identity (after an apply, or to show changes made elsewhere).
/// Fails with `tableNotEditable` when the table has no row identity.
#[tauri::command]
#[specta::specta]
pub async fn refresh_table_rows(
    state: State<'_, AppState>,
    tab_id: String,
    keys: Vec<RowKey>,
) -> Result<RefreshedRows, YadbeError> {
    state.tables.refresh_rows(&tab_id, keys).await
}

/// Cancels the tab's running statement (page, count, refresh or apply) with the engine's
/// native mechanism. Does nothing when nothing runs.
#[tauri::command]
#[specta::specta]
pub async fn cancel_table_data(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), YadbeError> {
    state.tables.cancel(&tab_id).await;
    Ok(())
}

/// The table tab closed: cancels what runs, closes its connection and frees its rows.
#[tauri::command]
#[specta::specta]
pub async fn close_table_data(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), YadbeError> {
    state.tables.close(&tab_id).await;
    state.references.close(&tab_id).await;
    Ok(())
}
