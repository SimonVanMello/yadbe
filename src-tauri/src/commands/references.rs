//! Foreign key navigation (M3-2, F-088): the foreign keys that reference a table, the row a
//! foreign key value references, how many rows reference a row, and a page of a referenced
//! table for the foreign key cell editor.
//!
//! The lookups run on a server connection of the table tab `tabId` (opened on first use,
//! closed with the tab), one at a time per tab. Each takes a `requestId`:
//! `cancel_reference_lookup` with it stops the call with the engine's native cancel (it then
//! fails with `cancelled`). Every statement is recorded in the statement log, values written
//! as literals.

use tauri::State;

use crate::db::errors::YadbeError;
use crate::db::meta::{IncomingForeignKeys, ObjectRef};
use crate::session::reference_model::{
    BoundedCount, KeyValue, LookupPage, LookupRequest, ReferencedRow,
};
use crate::state::AppState;

/// The foreign keys of every table of `table`'s database that reference it, self-references
/// and other schemas included (cached metadata). `supported: false` on an engine whose
/// driver cannot list them yet.
#[tauri::command]
#[specta::specta]
pub async fn get_incoming_foreign_keys(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    table: ObjectRef,
) -> Result<IncomingForeignKeys, YadbeError> {
    state
        .meta
        .incoming_foreign_keys(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &table,
        )
        .await
}

/// The row of `table` whose columns equal `key` (a foreign key value, composite or not): the
/// window holds it (none when nothing matches, two when the key is not unique). Fails with
/// `invalidArgument` for an unknown column or a `NULL` value, `objectNotFound` when the
/// table no longer exists.
#[tauri::command]
#[specta::specta]
pub async fn fetch_referenced_row(
    state: State<'_, AppState>,
    tab_id: String,
    request_id: String,
    table: ObjectRef,
    key: Vec<KeyValue>,
) -> Result<ReferencedRow, YadbeError> {
    state
        .references
        .referenced_row(&tab_id, &request_id, &table, &key)
        .await
}

/// Counts the rows of `table` whose columns equal `key` (the rows referencing a row through
/// one foreign key), stopping after `limit` rows (1 to 100 000): exact below it, `more`
/// above.
#[tauri::command]
#[specta::specta]
pub async fn count_referencing_rows(
    state: State<'_, AppState>,
    tab_id: String,
    request_id: String,
    table: ObjectRef,
    key: Vec<KeyValue>,
    limit: u32,
) -> Result<BoundedCount, YadbeError> {
    state
        .references
        .count_rows(&tab_id, &request_id, &table, &key, limit)
        .await
}

/// A page of a referenced table for the foreign key cell editor: its key and display
/// columns, ordered by the key, rows whose columns contain `search` (bound).
#[tauri::command]
#[specta::specta]
pub async fn search_referenced_rows(
    state: State<'_, AppState>,
    tab_id: String,
    request_id: String,
    request: LookupRequest,
) -> Result<LookupPage, YadbeError> {
    state
        .references
        .lookup(&tab_id, &request_id, &request)
        .await
}

/// Stops a lookup or an incoming foreign keys read started with `requestId`. Does nothing
/// when it already ended.
#[tauri::command]
#[specta::specta]
pub async fn cancel_reference_lookup(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), YadbeError> {
    state.references.cancel(&request_id).await;
    Ok(())
}
