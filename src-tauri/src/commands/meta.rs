//! Metadata of open connections, node by node (F-020 to F-023), and the completion catalog
//! (F-043, F-120). Results are cached per session until `refresh_meta` or a reconnection;
//! both emit `meta-refreshed`.
//!
//! Every read takes an optional `requestId`: `cancel_meta_request` with the same id stops it
//! (it then fails with `cancelled`).

use std::sync::Arc;

use tauri::State;

use crate::db::errors::YadbeError;
use crate::db::meta::{
    CompletionCatalog, DatabaseInfo, MetaNode, ObjectCount, ObjectInfo, ObjectKind, ObjectRef,
    SchemaInfo, TableDetails,
};
use crate::db::script::ScriptKind;
use crate::state::AppState;

/// Databases of the server; a single one for file engines (`main` on SQLite).
#[tauri::command]
#[specta::specta]
pub async fn list_databases(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
) -> Result<Vec<DatabaseInfo>, YadbeError> {
    state
        .meta
        .databases(&state.connections, request_id.as_deref(), &connection_id)
        .await
}

/// Schemas of a database, system ones flagged; empty on engines without schemas.
#[tauri::command]
#[specta::specta]
pub async fn list_schemas(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    database: String,
) -> Result<Vec<SchemaInfo>, YadbeError> {
    state
        .meta
        .schemas(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &database,
        )
        .await
}

/// One count per object kind the engine has, in explorer order. `schema` is `null` exactly
/// on engines without schemas.
#[tauri::command]
#[specta::specta]
pub async fn list_object_counts(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<ObjectCount>, YadbeError> {
    state
        .meta
        .object_counts(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &database,
            schema.as_deref(),
        )
        .await
}

/// The objects of one kind in a schema, by name (empty for a kind the engine lacks).
#[tauri::command]
#[specta::specta]
pub async fn list_objects(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    kind: ObjectKind,
) -> Result<Vec<ObjectInfo>, YadbeError> {
    state
        .meta
        .objects(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &database,
            schema.as_deref(),
            kind,
        )
        .await
}

/// Columns, keys, indexes, constraints and triggers of a table, view or materialized view.
/// Fails with `objectNotFound` when it no longer exists.
#[tauri::command]
#[specta::specta]
pub async fn get_table_details(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    table: ObjectRef,
) -> Result<TableDetails, YadbeError> {
    state
        .meta
        .table_details(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &table,
        )
        .await
}

/// Everything the autocomplete and the palette need for one database, in one compact
/// payload. Objects of system schemas only with `includeSystem`.
#[tauri::command]
#[specta::specta]
pub async fn get_completion_catalog(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    database: String,
    include_system: bool,
) -> Result<Arc<CompletionCatalog>, YadbeError> {
    state
        .meta
        .completion_catalog(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &database,
            include_system,
        )
        .await
}

/// Drops the cached metadata of `node` and below, then emits `meta-refreshed`; the next
/// reads go to the server.
#[tauri::command]
#[specta::specta]
pub async fn refresh_meta(
    state: State<'_, AppState>,
    connection_id: String,
    node: MetaNode,
) -> Result<(), YadbeError> {
    state.meta.refresh(&connection_id, node);
    Ok(())
}

/// Stops the metadata read started with `requestId`; unknown or finished ids are ignored.
#[tauri::command]
#[specta::specta]
pub async fn cancel_meta_request(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), YadbeError> {
    state.meta.cancel(&request_id);
    Ok(())
}

/// "Script as" template of a table (F-023): `SELECT` limited to 1000 rows, `INSERT`,
/// `UPDATE` / `DELETE` of one row by key, or the qualified name. Identifiers are quoted
/// by the dialect; values are `<column, type>` placeholders to fill in.
#[tauri::command]
#[specta::specta]
pub async fn script_table(
    state: State<'_, AppState>,
    connection_id: String,
    table: ObjectRef,
    script: ScriptKind,
) -> Result<String, YadbeError> {
    state
        .meta
        .script(&state.connections, &connection_id, &table, script)
        .await
}
