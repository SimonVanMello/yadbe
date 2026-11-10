//! Query execution (M1-3): statement splitting, runs, result windows, transactions.
//! Progress arrives as `query-progress` / `query-finished` / `transaction-state-changed`.

use tauri::State;

use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::db::value::Value;
use crate::session::query_model::{
    ExecuteRequest, ExecutionStarted, QueryTabInfo, ResultWindow, ResumeMode, TextRange,
    TransactionMode, TransactionState,
};
use crate::state::AppState;

/// The statements of `text`, split the way `engine` reads them (dollar quoting, `GO`
/// batches, `DELIMITER`…), as ranges without their delimiter. Comment-only parts are
/// skipped.
#[tauri::command]
#[specta::specta]
pub async fn split_statements(engine: Engine, text: String) -> Result<Vec<TextRange>, YadbeError> {
    let _ = (engine, text);
    Err(YadbeError::not_implemented())
}

/// The statement "under the cursor" at `offset` (F-041): the one containing it (its
/// delimiter included), else the closest one on an adjacent line, `null` when the cursor
/// sits between paragraphs.
#[tauri::command]
#[specta::specta]
pub async fn statement_at(
    engine: Engine,
    text: String,
    offset: u32,
) -> Result<Option<TextRange>, YadbeError> {
    let _ = (engine, text, offset);
    Err(YadbeError::not_implemented())
}

/// Starts running statements in a tab and returns at once; progress, results and messages
/// arrive as events. Fails with `executionRunning` while the tab runs, `transactionOpen`
/// when switching connection or database with a transaction open, `notConnected` when the
/// connection is not open. Frees the tab's previous results.
#[tauri::command]
#[specta::specta]
pub async fn execute_query(
    state: State<'_, AppState>,
    request: ExecuteRequest,
) -> Result<ExecutionStarted, YadbeError> {
    let _ = (state, request);
    Err(YadbeError::not_implemented())
}

/// Cancels the tab's running execution with the engine's native mechanism (F-042). Does
/// nothing when nothing runs.
#[tauri::command]
#[specta::specta]
pub async fn cancel_query(state: State<'_, AppState>, tab_id: String) -> Result<(), YadbeError> {
    let _ = (state, tab_id);
    Err(YadbeError::not_implemented())
}

/// Continues a paused result (load more / load all, F-062).
#[tauri::command]
#[specta::specta]
pub async fn resume_result(
    state: State<'_, AppState>,
    result_id: u32,
    mode: ResumeMode,
) -> Result<(), YadbeError> {
    let _ = (state, result_id, mode);
    Err(YadbeError::not_implemented())
}

/// Rows `offset .. offset + limit` of a result (at most 2 000; the grid asks for 500),
/// fewer at the end. Readable while the result streams.
#[tauri::command]
#[specta::specta]
pub async fn fetch_result_window(
    state: State<'_, AppState>,
    result_id: u32,
    offset: u32,
    limit: u32,
) -> Result<ResultWindow, YadbeError> {
    let _ = (state, result_id, offset, limit);
    Err(YadbeError::not_implemented())
}

/// One whole cell (windows cut long values), for the cell viewer (F-064).
#[tauri::command]
#[specta::specta]
pub async fn fetch_result_cell(
    state: State<'_, AppState>,
    result_id: u32,
    row: u32,
    column: u32,
) -> Result<Value, YadbeError> {
    let _ = (state, result_id, row, column);
    Err(YadbeError::not_implemented())
}

/// The tab's transaction state, connection and running or last execution.
#[tauri::command]
#[specta::specta]
pub async fn get_query_tab(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<QueryTabInfo, YadbeError> {
    let _ = (state, tab_id);
    Err(YadbeError::not_implemented())
}

/// Switches the tab between auto-commit and manual transactions (F-047). Fails with
/// `transactionOpen` while a transaction is open, `executionRunning` while the tab runs.
#[tauri::command]
#[specta::specta]
pub async fn set_transaction_mode(
    state: State<'_, AppState>,
    tab_id: String,
    mode: TransactionMode,
) -> Result<TransactionState, YadbeError> {
    let _ = (state, tab_id, mode);
    Err(YadbeError::not_implemented())
}

/// Commits the tab's open transaction (a failed one is rolled back by the engine). Does
/// nothing without a transaction.
#[tauri::command]
#[specta::specta]
pub async fn commit_transaction(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<TransactionState, YadbeError> {
    let _ = (state, tab_id);
    Err(YadbeError::not_implemented())
}

/// Rolls back the tab's open transaction. Does nothing without a transaction.
#[tauri::command]
#[specta::specta]
pub async fn rollback_transaction(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<TransactionState, YadbeError> {
    let _ = (state, tab_id);
    Err(YadbeError::not_implemented())
}

/// The tab closed: cancels its execution, closes its connection (an open transaction is
/// rolled back by the server) and frees its results.
#[tauri::command]
#[specta::specta]
pub async fn close_query_tab(state: State<'_, AppState>, tab_id: String) -> Result<(), YadbeError> {
    let _ = (state, tab_id);
    Err(YadbeError::not_implemented())
}
