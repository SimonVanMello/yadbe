//! Table edits (M2-2, F-082 to F-086): a change set buffered by the grid, previewed as SQL
//! and applied in one transaction on the table tab's connection. Each `UPDATE` / `DELETE`
//! must affect exactly one row, or everything is rolled back. Refused on read-only
//! connections (`readOnlyViolation`), views and tables without row identity
//! (`tableNotEditable`).

use tauri::State;

use crate::db::errors::YadbeError;
use crate::edit::model::{ApplyOutcome, ChangeSet, EditPreview};
use crate::state::AppState;

/// The statements Apply would run for `changes`, as readable SQL (values written as
/// literals). Runs nothing. Fails with `invalidArgument` for an unknown or read-only column,
/// a key of the wrong length or an empty change set.
#[tauri::command]
#[specta::specta]
pub async fn preview_table_changes(
    state: State<'_, AppState>,
    tab_id: String,
    changes: ChangeSet,
) -> Result<EditPreview, YadbeError> {
    state.tables.preview(&tab_id, &changes)
}

/// Applies `changes` in one transaction. A failing statement rolls everything back and is
/// reported as `rolledBack` (not as an error); errors are for what prevents starting (not
/// editable, read-only, not connected, invalid change set). On success, emits
/// `table-data-changed` and returns the inserted rows as stored.
#[tauri::command]
#[specta::specta]
pub async fn apply_table_changes(
    state: State<'_, AppState>,
    tab_id: String,
    changes: ChangeSet,
) -> Result<ApplyOutcome, YadbeError> {
    state.tables.apply(&tab_id, &changes).await
}
