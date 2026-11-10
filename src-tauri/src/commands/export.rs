//! Exports (M2-7): a result written to CSV or JSON. The path comes from the native save
//! dialog; progress and the outcome arrive as `export-progress` / `export-finished`.

use tauri::State;

use crate::db::errors::YadbeError;
use crate::export::model::{ExportFormat, ExportRequest, ExportSourceSpec, ExportStarted};
use crate::state::AppState;

/// Starts exporting and returns at once. Fails with `invalidArgument` for a relative path or
/// an extension that does not fit the format, `resultNotFound` when the result was freed.
/// Scope `all` follows a paused or streaming result to its end without growing it in memory.
#[tauri::command]
#[specta::specta]
pub async fn start_export(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<ExportStarted, YadbeError> {
    state.exports.start(request)
}

/// Cancels an export; the partial file is removed. Does nothing for an unknown id.
#[tauri::command]
#[specta::specta]
pub async fn cancel_export(state: State<'_, AppState>, export_id: u32) -> Result<(), YadbeError> {
    state.exports.cancel(export_id);
    Ok(())
}

/// The first `limit` rows (at most 100) as the file will contain them, for the dialog's preview.
#[tauri::command]
#[specta::specta]
pub async fn preview_export(
    state: State<'_, AppState>,
    source: ExportSourceSpec,
    format: ExportFormat,
    limit: u32,
) -> Result<String, YadbeError> {
    state.exports.preview(&source, &format, limit)
}
