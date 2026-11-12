//! Search connections (Elasticsearch, OpenSearch, M4-7): the explorer (indices, data streams,
//! aliases, index templates, an index's fields and settings), the index tab (pages, counts)
//! and the console. Every request goes through the request gate (`session::search::gate`):
//! read-only, danger confirmation, statement log or history, timeout and cancel. A connection
//! of another family answers `searchOnly`.
//!
//! A tab's results live in the backend until it reads again or `search_close_tab`: grids with
//! `fetch_result_window`, whole documents and answers with `search_fetch_documents`.

use tauri::State;

use crate::db::errors::YadbeError;
use crate::db::search::meta::{
    SearchAlias, SearchDataStream, SearchIndexDetails, SearchIndexInfo, SearchTemplate,
};
use crate::session::search::model::{
    IndexPage, IndexQuery, IndexTabInfo, LineRange, SearchConsoleOutcome,
};
use crate::state::AppState;

/// The indices of the cluster (`_cat/indices`), hidden and system ones included (flagged).
#[tauri::command]
#[specta::specta]
pub async fn search_list_indices(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SearchIndexInfo>, YadbeError> {
    state.searches.indices(&connection_id).await
}

/// The data streams of the cluster; empty where the server has none.
#[tauri::command]
#[specta::specta]
pub async fn search_list_data_streams(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SearchDataStream>, YadbeError> {
    state.searches.data_streams(&connection_id).await
}

/// The aliases of the cluster, with the indices behind each.
#[tauri::command]
#[specta::specta]
pub async fn search_list_aliases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SearchAlias>, YadbeError> {
    state.searches.aliases(&connection_id).await
}

/// The composable index templates of the cluster.
#[tauri::command]
#[specta::specta]
pub async fn search_list_templates(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<SearchTemplate>, YadbeError> {
    state.searches.templates(&connection_id).await
}

/// The mapping fields (flattened paths with their types) and a settings summary of an index,
/// or of every index a pattern, alias or data stream resolves to.
#[tauri::command]
#[specta::specta]
pub async fn search_index_details(
    state: State<'_, AppState>,
    connection_id: String,
    target: String,
) -> Result<SearchIndexDetails, YadbeError> {
    state.searches.index_details(&connection_id, &target).await
}

/// Opens an index (data stream, alias) in the index tab `tabId`.
#[tauri::command]
#[specta::specta]
pub async fn search_open_index(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    target: String,
) -> Result<IndexTabInfo, YadbeError> {
    state
        .searches
        .open_index(&tab_id, &connection_id, &target)
        .await
}

/// Page `page` (0-based) of a query on the tab's index: on a point in time with
/// `search_after` where the server has both, otherwise by `from` / `size` up to the result
/// window. Page 0 starts over (a fresh point in time and count).
#[tauri::command]
#[specta::specta]
pub async fn search_fetch_page(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    target: String,
    query: IndexQuery,
    page: u32,
) -> Result<IndexPage, YadbeError> {
    state
        .searches
        .fetch_page(&tab_id, &connection_id, &target, query, page)
        .await
}

/// The exact number of documents of a query (`_count`); cancellable with `search_cancel`.
#[tauri::command]
#[specta::specta]
pub async fn search_count(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    target: String,
    query: IndexQuery,
) -> Result<f64, YadbeError> {
    state
        .searches
        .count(&tab_id, &connection_id, &target, query)
        .await
}

/// Runs console requests: the ones on `lines` (the cursor's line or the selection), else all.
/// Without `confirmed`, nothing is sent when one is dangerous: the answer lists them with
/// their effect.
#[tauri::command]
#[specta::specta]
pub async fn search_console_run(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    text: String,
    lines: Option<LineRange>,
    confirmed: bool,
) -> Result<SearchConsoleOutcome, YadbeError> {
    state
        .searches
        .console_run(&tab_id, &connection_id, &text, lines, confirmed)
        .await
}

/// Stops what the tab runs: its request is dropped and its task cancelled on the server; a
/// console run sends nothing more.
#[tauri::command]
#[specta::specta]
pub async fn search_cancel(state: State<'_, AppState>, tab_id: String) -> Result<(), YadbeError> {
    state.searches.cancel(&tab_id);
    Ok(())
}

/// Frees what a closed tab holds (results, point in time); unknown tabs are ignored.
#[tauri::command]
#[specta::specta]
pub async fn search_close_tab(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), YadbeError> {
    state.searches.close_tab(&tab_id).await;
    Ok(())
}

/// Whole documents (hits, or a console answer) `offset .. offset + limit`, as JSON text.
#[tauri::command]
#[specta::specta]
pub async fn search_fetch_documents(
    state: State<'_, AppState>,
    documents_id: u32,
    offset: u32,
    limit: u32,
) -> Result<Vec<String>, YadbeError> {
    state.searches.documents(documents_id, offset, limit)
}
