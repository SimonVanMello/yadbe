//! Object tools (M3-8): DDL view (F-024), properties (F-025), drop / truncate / rename
//! (F-026) and pinned objects (F-027). Every read and action takes an optional `requestId`:
//! `cancel_meta_request` with the same id stops it.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::db::meta::{ObjectKind, ObjectRef};
use crate::db::object_model::{
    DdlTarget, ObjectAction, ObjectActionOutcome, ObjectActionPlan, ObjectActionRequest, ObjectDdl,
    ObjectProperties, PinnedObject,
};
use crate::state::AppState;

/// The definition of a table, view, materialized view, routine, sequence, type, trigger or
/// index: the engine's own text when it has one, else rebuilt (the text then starts with a
/// comment that says so, and `source` is `reconstructed`).
#[tauri::command]
#[specta::specta]
pub async fn get_object_ddl(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    target: DdlTarget,
) -> Result<ObjectDdl, YadbeError> {
    state
        .meta
        .object_ddl(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &target,
        )
        .await
}

/// Row estimate, sizes, owner, dates and the like of a table, view or materialized view; the
/// facts the engine does not have are `null`.
#[tauri::command]
#[specta::specta]
pub async fn get_object_properties(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    object: ObjectRef,
    kind: ObjectKind,
) -> Result<ObjectProperties, YadbeError> {
    state
        .meta
        .properties(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &object,
            kind,
        )
        .await
}

/// The statement a drop, truncate or rename would run, with what it affects. Runs nothing.
#[tauri::command]
#[specta::specta]
pub async fn plan_object_action(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    request: ObjectActionRequest,
) -> Result<ObjectActionPlan, YadbeError> {
    state
        .meta
        .plan_action(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &request,
        )
        .await
}

/// Runs a drop, truncate or rename (the statement `plan_object_action` shows, never `CASCADE`).
/// Refused with `readOnlyViolation` on a read-only connection. The statement is recorded in
/// the statement log; the explorer's metadata is read again afterwards (`meta-refreshed`).
#[tauri::command]
#[specta::specta]
pub async fn run_object_action(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    request: ObjectActionRequest,
) -> Result<ObjectActionOutcome, YadbeError> {
    let outcome = state
        .meta
        .run_action(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &request,
        )
        .await?;
    if let ObjectAction::Rename { new_name } = &request.action {
        // A pin follows its object to the new name; a failure here must not hide the rename.
        let store = Arc::clone(&state.store);
        let pin = PinnedObject {
            connection_id,
            database: request.object.database.clone(),
            schema: request.object.schema.clone(),
            kind: Some(request.kind),
            name: request.object.name.clone(),
            id: request.id.clone(),
        };
        let new_name = new_name.clone();
        if let Err(err) = blocking(move || store.rename_pin(&pin, &new_name)).await {
            tracing::warn!(error = %err, "could not move a pin to the renamed object");
        }
    }
    Ok(outcome)
}

/// Every pinned object and schema of every connection, in the order they were pinned.
#[tauri::command]
#[specta::specta]
pub async fn list_pinned_objects(
    state: State<'_, AppState>,
) -> Result<Vec<PinnedObject>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.list_pins()).await
}

/// Pins an object (or a schema: `kind` `null`) at the top of its connection's tree.
#[tauri::command]
#[specta::specta]
pub async fn pin_object(state: State<'_, AppState>, pin: PinnedObject) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.pin_object(&pin)).await
}

#[tauri::command]
#[specta::specta]
pub async fn unpin_object(state: State<'_, AppState>, pin: PinnedObject) -> Result<(), YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.unpin_object(&pin)).await
}
