//! The activity monitor (F-140): sessions, locks and who blocks whom, and kill. A read takes an
//! optional `requestId`: `cancel_meta_request` with the same id stops it.

use tauri::State;

use crate::db::activity::{ActivitySnapshot, KillOutcome, KillRequest};
use crate::db::errors::YadbeError;
use crate::state::AppState;

/// The sessions of the server with what they run, their locks and who blocks whom. Fails with
/// `notSupported` on an engine without sessions (SQLite) and with `insufficientPrivilege` when
/// the user cannot see other sessions at all; a partial view (PostgreSQL without
/// `pg_read_all_stats`) comes back with a note saying what is hidden.
#[tauri::command]
#[specta::specta]
pub async fn get_activity(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
) -> Result<ActivitySnapshot, YadbeError> {
    state
        .meta
        .activity(&state.connections, request_id.as_deref(), &connection_id)
        .await
}

/// Cancels the running statement of a session, or ends the session, after the user confirmed
/// what the list showed. Refused with `readOnlyViolation` on a read-only connection, with
/// `sessionChanged` when the session is no longer the one the list showed, and with
/// `insufficientPrivilege` when the server refuses. Recorded in the statement log.
#[tauri::command]
#[specta::specta]
pub async fn kill_session(
    state: State<'_, AppState>,
    connection_id: String,
    request: KillRequest,
) -> Result<KillOutcome, YadbeError> {
    state
        .meta
        .kill_session(&state.connections, &connection_id, &request)
        .await
}
