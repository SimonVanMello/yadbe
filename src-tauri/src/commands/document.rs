//! Document connections (MongoDB, M4-2): the explorer (databases, collections, indexes,
//! sampled fields), the collection tab (pages, counts) and the console (one JSON command).
//! Every operation goes through the command gate (`session::document::gate`): read-only,
//! danger confirmation, statement log, timeout. A SQL connection answers `documentOnly`.
//!
//! A tab's results live in the backend until it reads again or `mongo_close_tab`: the grid
//! with `fetch_result_window`, the whole documents with `mongo_fetch_documents`.

use tauri::State;

use crate::db::document::meta::{DocCollection, DocDatabase, DocIndex, FieldSample};
use crate::db::document::ops::Namespace;
use crate::db::errors::YadbeError;
use crate::session::document::model::{
    CollectionInfo, CollectionPage, CollectionQuery, CommandOutcome,
};
use crate::state::AppState;

/// The databases of the server (`listDatabases`), system ones flagged.
#[tauri::command]
#[specta::specta]
pub async fn mongo_list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DocDatabase>, YadbeError> {
    state.documents.databases(&connection_id).await
}

/// The collections, views and time series of a database, by name.
#[tauri::command]
#[specta::specta]
pub async fn mongo_list_collections(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> Result<Vec<DocCollection>, YadbeError> {
    state.documents.collections(&connection_id, &database).await
}

/// The indexes of a collection.
#[tauri::command]
#[specta::specta]
pub async fn mongo_list_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    collection: String,
) -> Result<Vec<DocIndex>, YadbeError> {
    state
        .documents
        .indexes(&connection_id, &database, &collection)
        .await
}

/// The fields of a collection estimated from a random sample (`$sample`, 200 documents by
/// default, at most 1000): paths, types seen and how often.
#[tauri::command]
#[specta::specta]
pub async fn mongo_sample_fields(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    collection: String,
    size: Option<u32>,
) -> Result<FieldSample, YadbeError> {
    state
        .documents
        .sample(&connection_id, &database, &collection, size)
        .await
}

/// Opens a collection in the collection tab `tabId`: its kind and estimated size.
#[tauri::command]
#[specta::specta]
pub async fn mongo_open_collection(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    database: String,
    collection: String,
) -> Result<CollectionInfo, YadbeError> {
    state
        .documents
        .open_collection(
            &tab_id,
            &connection_id,
            Namespace::new(database, collection),
        )
        .await
}

/// Reads page `page` (0-based) of a collection with the query's filter, projection and
/// sort. Frees the tab's previous page. Fails with `invalidArgument` for a field that is
/// not a JSON object.
#[tauri::command]
#[specta::specta]
pub async fn mongo_fetch_page(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    database: String,
    collection: String,
    query: CollectionQuery,
    page: u32,
) -> Result<CollectionPage, YadbeError> {
    state
        .documents
        .page(
            &tab_id,
            &connection_id,
            Namespace::new(database, collection),
            query,
            page,
        )
        .await
}

/// Counts exactly the documents matching `filter` (`countDocuments`); cancellable.
#[tauri::command]
#[specta::specta]
pub async fn mongo_count_documents(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    database: String,
    collection: String,
    filter: String,
) -> Result<f64, YadbeError> {
    state
        .documents
        .count(
            &tab_id,
            &connection_id,
            Namespace::new(database, collection),
            &filter,
        )
        .await
}

/// Runs one JSON command (`runCommand`) typed in a document console tab, as written. A
/// dangerous one answers `confirm` with its effect and runs only when sent again with
/// `confirmed`. Recorded in the history.
#[tauri::command]
#[specta::specta]
pub async fn mongo_run_command(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    database: String,
    command: String,
    confirmed: bool,
) -> Result<CommandOutcome, YadbeError> {
    state
        .documents
        .run_command(&tab_id, &connection_id, &database, &command, confirmed)
        .await
}

/// Stops what the tab runs (`killOp`); the call it made fails with `cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn mongo_cancel(state: State<'_, AppState>, tab_id: String) -> Result<(), YadbeError> {
    state.documents.cancel(&tab_id).await
}

/// Forgets a collection or console tab: stops what it runs and frees its results.
#[tauri::command]
#[specta::specta]
pub async fn mongo_close_tab(state: State<'_, AppState>, tab_id: String) -> Result<(), YadbeError> {
    state.documents.close_tab(&tab_id).await;
    Ok(())
}

/// Whole documents `offset .. offset + limit` (at most 500) of a document result, as
/// canonical Extended JSON texts.
#[tauri::command]
#[specta::specta]
pub async fn mongo_fetch_documents(
    state: State<'_, AppState>,
    documents_id: u32,
    offset: u32,
    limit: u32,
) -> Result<Vec<String>, YadbeError> {
    state.documents.documents(documents_id, offset, limit)
}
