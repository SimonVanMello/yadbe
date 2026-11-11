//! SSH known hosts (F-010): the host keys the user accepted, trusting one after seeing its
//! fingerprint, forgetting one deliberately.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::state::AppState;
use crate::tunnel::KnownHost;
use crate::tunnel::host_keys::normalized_host;

/// Host keys yadbe trusts (its own store; `~/.ssh/known_hosts` is not listed).
#[tauri::command]
#[specta::specta]
pub async fn list_known_hosts(state: State<'_, AppState>) -> Result<Vec<KnownHost>, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || store.list_known_hosts()).await
}

/// Trusts the host key the user was shown (`sshHostKeyUnknown` error: host, port, key type,
/// fingerprint). Never replaces a different known key of the same type.
#[tauri::command]
#[specta::specta]
pub async fn trust_host_key(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
) -> Result<KnownHost, YadbeError> {
    let host_keys = state.connections.host_keys();
    blocking(move || host_keys.trust(&host, port, &key_type, &fingerprint)).await
}

/// Forgets the accepted keys of a host (`keyType`: only that one). Returns how many.
#[tauri::command]
#[specta::specta]
pub async fn forget_host_key(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    key_type: Option<String>,
) -> Result<u32, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || {
        let count = store.forget_known_host(&normalized_host(&host), port, key_type.as_deref())?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    })
    .await
}
