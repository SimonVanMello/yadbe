//! Editable query results (M3-7, F-087): a result set of a `SELECT` reading one table that
//! includes its row identity is edited like a table tab. Its changes are previewed and applied
//! in one transaction on a server connection of their own (not the query tab's), with the same
//! one-row rule, original-value checks (F-089) and change journal (F-090) as a table tab.
//! Refused on read-only connections (`readOnlyViolation`) and while the query tab's
//! transaction is open (`tableNotEditable`).

use tauri::State;

use crate::db::errors::YadbeError;
use crate::edit::model::{ApplyOutcome, ChangeSet, EditPreview};
use crate::session::result_edit_model::{ResultEditInfo, ResultRowRef};
use crate::session::table_model::RefreshedRows;
use crate::state::AppState;

/// Whether result `resultId` can be edited, and how: the table its rows come from (as the
/// engine reported it), the table column of each result column and the row identity, or why
/// not. Reads the cached metadata; runs nothing on the query tab's connection.
#[tauri::command]
#[specta::specta]
pub async fn describe_result_edit(
    state: State<'_, AppState>,
    result_id: u32,
) -> Result<ResultEditInfo, YadbeError> {
    state.result_edits.describe(&state.meta, result_id).await
}

/// The statements Apply would run for `changes` on the result's table (table column names,
/// keys in `rowIdentity` order), as readable SQL. Runs nothing.
#[tauri::command]
#[specta::specta]
pub async fn preview_result_changes(
    state: State<'_, AppState>,
    result_id: u32,
    changes: ChangeSet,
) -> Result<EditPreview, YadbeError> {
    state
        .result_edits
        .preview(&state.meta, result_id, &changes)
        .await
}

/// Applies `changes` to the result's table in one transaction, like `apply_table_changes`.
/// Conflicting rows (`conflicted`) come back in the result's columns, the ones the query
/// computed being `NULL`. Inserts are refused (`invalidArgument`).
#[tauri::command]
#[specta::specta]
pub async fn apply_result_changes(
    state: State<'_, AppState>,
    result_id: u32,
    changes: ChangeSet,
) -> Result<ApplyOutcome, YadbeError> {
    state
        .result_edits
        .apply(&state.meta, result_id, &changes)
        .await
}

/// Reads rows of the result's table again by their identity, in the result's columns: a
/// column the query computed keeps the value it has in row `row` of the result (it is not
/// computed again). `positions` follow `rows` (`null`: the row no longer exists).
#[tauri::command]
#[specta::specta]
pub async fn refresh_result_rows(
    state: State<'_, AppState>,
    result_id: u32,
    rows: Vec<ResultRowRef>,
) -> Result<RefreshedRows, YadbeError> {
    state
        .result_edits
        .refresh(&state.meta, result_id, &rows)
        .await
}

/// Rows an apply deleted leave the result (stored row numbers): a sort or a filter of it no
/// longer shows them, and the others keep their numbers.
#[tauri::command]
#[specta::specta]
pub async fn remove_result_rows(
    state: State<'_, AppState>,
    result_id: u32,
    rows: Vec<u32>,
) -> Result<(), YadbeError> {
    state.result_edits.remove_rows(result_id, &rows)
}

/// Stops what an edit of the result runs (an apply waiting for a lock), with the engine's
/// native cancel.
#[tauri::command]
#[specta::specta]
pub async fn cancel_result_edit(
    state: State<'_, AppState>,
    result_id: u32,
) -> Result<(), YadbeError> {
    state.result_edits.cancel(result_id).await;
    Ok(())
}

/// Forgets the result's edits: the rows read again for it and its server connection.
#[tauri::command]
#[specta::specta]
pub async fn close_result_edit(
    state: State<'_, AppState>,
    result_id: u32,
) -> Result<(), YadbeError> {
    state.result_edits.close(result_id).await;
    Ok(())
}
