//! Secrets (F-005) and connection strings (F-006). A secret is received once and never
//! returned: commands only say where it is.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::connstring::{self, ParsedConnectionString};
use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::secrets::{KeychainStatus, Secret, SecretInput, SecretKind, SecretLocation};
use crate::state::AppState;

/// Whether the OS keychain can be used; when it cannot, "remember password" keeps the
/// secret for the session only.
#[tauri::command]
#[specta::specta]
pub async fn keychain_status(state: State<'_, AppState>) -> Result<KeychainStatus, YadbeError> {
    let secrets = Arc::clone(&state.secrets);
    blocking(move || Ok(secrets.status())).await
}

/// Stores a secret of a saved connection: in the keychain when `remember` and a keychain
/// exists, otherwise for the session. Returns where it went.
#[tauri::command]
#[specta::specta]
pub async fn set_connection_secret(
    state: State<'_, AppState>,
    connection_id: String,
    kind: SecretKind,
    secret: SecretInput,
    remember: bool,
) -> Result<SecretLocation, YadbeError> {
    let store = Arc::clone(&state.store);
    let secrets = Arc::clone(&state.secrets);
    blocking(move || {
        store.connection(&connection_id)?;
        let secret = secrets.resolve(secret, true)?;
        secrets.set(&connection_id, kind, secret, remember)
    })
    .await
}

/// Forgets a secret everywhere (keychain and session).
#[tauri::command]
#[specta::specta]
pub async fn delete_connection_secret(
    state: State<'_, AppState>,
    connection_id: String,
    kind: SecretKind,
) -> Result<(), YadbeError> {
    let secrets = Arc::clone(&state.secrets);
    blocking(move || secrets.delete(&connection_id, kind)).await
}

/// Where a secret is kept, `null` when there is none.
#[tauri::command]
#[specta::specta]
pub async fn has_connection_secret(
    state: State<'_, AppState>,
    connection_id: String,
    kind: SecretKind,
) -> Result<Option<SecretLocation>, YadbeError> {
    let secrets = Arc::clone(&state.secrets);
    blocking(move || secrets.location(&connection_id, kind)).await
}

/// Parses a pasted connection string into form fields. A password in it is kept by the
/// backend for 15 minutes under `passwordId`; it is never sent back.
#[tauri::command]
#[specta::specta]
pub async fn parse_connection_string(
    state: State<'_, AppState>,
    input: Secret,
    engine_hint: Option<Engine>,
) -> Result<ParsedConnectionString, YadbeError> {
    let parsed = connstring::parse(input.expose(), engine_hint)?;
    let mut fields = parsed.fields;
    fields.password_id = parsed.password.map(|p| state.secrets.stash_pending(p));
    Ok(fields)
}

/// Drops a password held from a parsed connection string (dialog cancelled).
#[tauri::command]
#[specta::specta]
pub async fn discard_pending_secret(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), YadbeError> {
    state.secrets.discard_pending(&id);
    Ok(())
}
