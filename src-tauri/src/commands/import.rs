//! Data import (M3-10, F-091): a CSV or JSON file into a table, with a column mapping, a type
//! check and a dry run. The path comes from the native open dialog; progress and the outcome
//! arrive as `import-progress` / `import-finished`.

use tauri::State;

use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::import::model::{
    ImportAnalysis, ImportParseOptions, ImportPreview, ImportRequest, ImportStarted, ImportTarget,
};
use crate::state::AppState;

/// The first `limit` rows (at most 200) of an import file as `options` read them; without
/// options the encoding, format, delimiter, header and null token are detected and returned
/// in the preview. Fails with `invalidArgument` for a relative path or an extension that is
/// not a data file, `fileNotFound`, `importFileInvalid` for a file that does not follow the
/// format.
#[tauri::command]
#[specta::specta]
pub async fn preview_import_file(
    state: State<'_, AppState>,
    path: String,
    options: Option<ImportParseOptions>,
    limit: u32,
) -> Result<ImportPreview, YadbeError> {
    state.imports.preview(&path, options, limit).await
}

/// The columns of a table as an import sees them (which can be written, which the server
/// fills). `objectNotFound` when the table no longer exists.
#[tauri::command]
#[specta::specta]
pub async fn get_import_target(
    state: State<'_, AppState>,
    connection_id: String,
    table: ObjectRef,
) -> Result<ImportTarget, YadbeError> {
    state.imports.target(&connection_id, &table).await
}

/// Checks the mapping against the table and counts, per mapped column, the values among the
/// first 10 000 rows that will not convert. Reads the file only; writes nothing.
#[tauri::command]
#[specta::specta]
pub async fn analyze_import(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportAnalysis, YadbeError> {
    state.imports.analyze(request).await
}

/// Starts an import (a dry run when `request.dryRun`) and returns at once. Fails with
/// `readOnlyViolation` on a read-only connection, `invalidArgument` for a bad mapping, a
/// column that cannot be written or a `NOT NULL` column left without a value. Values are
/// converted exactly (nothing is coerced), bound as parameters and written in multi-row
/// inserts; a single transaction by default.
#[tauri::command]
#[specta::specta]
pub async fn start_import(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportStarted, YadbeError> {
    state.imports.start(request).await
}

/// Cancels an import: rolled back in a single transaction, batches already committed kept in
/// per-batch mode. Does nothing for an unknown id.
#[tauri::command]
#[specta::specta]
pub async fn cancel_import(state: State<'_, AppState>, import_id: u32) -> Result<(), YadbeError> {
    state.imports.cancel(import_id);
    Ok(())
}
