//! The query library (F-050): saved queries, snippets and their folders. Changes are announced
//! with `saved-queries-changed`.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::state::AppState;
use crate::store::{
    FolderDeletion, ImportReport, NewSavedQuery, QueryFolder, SavedQuery, SavedQueryLibrary,
    SavedQueryUpdate, SnippetDefinition,
};

/// Every folder and query; statements are cut to a preview (`sqlTruncated`).
#[tauri::command]
#[specta::specta]
pub async fn list_saved_queries(
    state: State<'_, AppState>,
) -> Result<SavedQueryLibrary, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.library()).await
}

/// A query with its whole statement; `null` once deleted.
#[tauri::command]
#[specta::specta]
pub async fn get_saved_query(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<SavedQuery>, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.get(&id)).await
}

/// Ids of the queries matching `text` in their name, statement, description or tags, best
/// first. `connectionId`: only the global queries and that connection's.
#[tauri::command]
#[specta::specta]
pub async fn search_saved_queries(
    state: State<'_, AppState>,
    text: String,
    connection_id: Option<String>,
) -> Result<Vec<String>, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.search(&text, connection_id.as_deref())).await
}

/// The snippets (queries with a trigger word), whole templates.
#[tauri::command]
#[specta::specta]
pub async fn list_snippets(
    state: State<'_, AppState>,
) -> Result<Vec<SnippetDefinition>, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.snippets()).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_saved_query(
    state: State<'_, AppState>,
    query: NewSavedQuery,
) -> Result<SavedQuery, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.create(&query)).await
}

/// Replaces every field of a query (`sql` `null`: keep the text).
#[tauri::command]
#[specta::specta]
pub async fn update_saved_query(
    state: State<'_, AppState>,
    id: String,
    update: SavedQueryUpdate,
) -> Result<SavedQuery, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.update(&id, &update)).await
}

/// Moves a query into a folder (`null`: the root of the library).
#[tauri::command]
#[specta::specta]
pub async fn move_saved_query(
    state: State<'_, AppState>,
    id: String,
    folder_id: Option<String>,
) -> Result<SavedQuery, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.move_query(&id, folder_id.as_ref())).await
}

/// A copy in the same folder, named like the original followed by `copySuffix`.
#[tauri::command]
#[specta::specta]
pub async fn duplicate_saved_query(
    state: State<'_, AppState>,
    id: String,
    copy_suffix: String,
) -> Result<SavedQuery, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.duplicate(&id, &copy_suffix)).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_saved_query(state: State<'_, AppState>, id: String) -> Result<(), YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.delete(&id)).await
}

/// Notes that a query was just opened, inserted or run (no event).
#[tauri::command]
#[specta::specta]
pub async fn touch_saved_query(state: State<'_, AppState>, id: String) -> Result<(), YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.touch(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_query_folder(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<QueryFolder, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.create_folder(&name, parent_id.as_ref())).await
}

#[tauri::command]
#[specta::specta]
pub async fn rename_query_folder(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<QueryFolder, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.rename_folder(&id, &name)).await
}

/// Moves a folder under another (`null`: the root); never into itself or its subfolders.
#[tauri::command]
#[specta::specta]
pub async fn move_query_folder(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> Result<QueryFolder, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.move_folder(&id, parent_id.as_ref())).await
}

/// Deletes a folder with its subfolders and every query in them; returns what went.
#[tauri::command]
#[specta::specta]
pub async fn delete_query_folder(
    state: State<'_, AppState>,
    id: String,
) -> Result<FolderDeletion, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.delete_folder(&id)).await
}

/// Writes the library to a JSON file (chosen in a save dialog). Scope is not exported.
#[tauri::command]
#[specta::specta]
pub async fn export_saved_queries(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.export_to(&path)).await
}

/// Adds the content of an exported library file; what is already there is skipped.
#[tauri::command]
#[specta::specta]
pub async fn import_saved_queries(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportReport, YadbeError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.import_from(&path)).await
}
