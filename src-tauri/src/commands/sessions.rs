//! Testing, opening and closing connections (F-004, F-013).

use std::sync::Arc;

use serde::Deserialize;
use specta::Type;
use tauri::State;

use super::blocking;
use crate::db::config::ConnectionDefinition;
use crate::db::errors::YadbeError;
use crate::secrets::{SecretInput, SecretKind, SecretStore};
use crate::session::manager::TunnelSecrets;
use crate::session::{SessionInfo, TestConnectionResult};
use crate::state::AppState;

/// An SSH password or key passphrase typed for one attempt (F-010).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSecretInput {
    /// `sshPassword`, `sshPassphrase`, `jumpPassword` or `jumpPassphrase`.
    pub kind: SecretKind,
    pub secret: SecretInput,
}

async fn resolve_tunnel(
    secrets: &Arc<SecretStore>,
    inputs: Option<Vec<TunnelSecretInput>>,
) -> Result<TunnelSecrets, YadbeError> {
    let inputs = inputs.unwrap_or_default();
    if inputs.iter().any(|i| {
        !matches!(
            i.kind,
            SecretKind::SshPassword
                | SecretKind::SshPassphrase
                | SecretKind::JumpPassword
                | SecretKind::JumpPassphrase
        )
    }) {
        return Err(YadbeError::invalid_argument(
            "Only SSH secrets go with the tunnel.",
            "Seuls des secrets SSH accompagnent le tunnel.",
        ));
    }
    let secrets = Arc::clone(secrets);
    blocking(move || {
        inputs
            .into_iter()
            .map(|i| Ok((i.kind, secrets.resolve(i.secret, false)?)))
            .collect()
    })
    .await
}

async fn resolve(
    secrets: &Arc<SecretStore>,
    input: Option<SecretInput>,
) -> Result<Option<crate::secrets::Secret>, YadbeError> {
    match input {
        // A pending secret stays available: the user may test, then save.
        Some(input) => {
            let secrets = Arc::clone(secrets);
            blocking(move || secrets.resolve(input, false).map(Some)).await
        }
        None => Ok(None),
    }
}

/// Tests a definition, saved or not: connects, reads the server version, pings and closes.
/// Without `password`, the stored secret of `connectionId` is used; likewise for the SSH
/// secrets missing from `tunnelSecrets`. A tunnel failure names its hop (`error.tunnel`).
/// `requestId` lets `cancel_test_connection` abort it.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(
    state: State<'_, AppState>,
    request_id: String,
    definition: ConnectionDefinition,
    password: Option<SecretInput>,
    connection_id: Option<String>,
    tunnel_secrets: Option<Vec<TunnelSecretInput>>,
) -> Result<TestConnectionResult, YadbeError> {
    let definition = definition.normalized()?;
    let password = resolve(&state.secrets, password).await?;
    let tunnel_secrets = resolve_tunnel(&state.secrets, tunnel_secrets).await?;
    state
        .connections
        .test_with_tunnel(
            request_id,
            definition,
            password,
            connection_id,
            tunnel_secrets,
        )
        .await
}

/// Aborts a running `test_connection` (it then fails with `cancelled`).
#[tauri::command]
#[specta::specta]
pub async fn cancel_test_connection(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), YadbeError> {
    state.connections.cancel_test(&request_id);
    Ok(())
}

/// Opens a saved connection. `password` (typed at connect time) is kept for the session;
/// without it, the session or keychain secret is used. State changes are also pushed as
/// `connection-state-changed`.
#[tauri::command]
#[specta::specta]
pub async fn connect(
    state: State<'_, AppState>,
    connection_id: String,
    password: Option<SecretInput>,
) -> Result<SessionInfo, YadbeError> {
    let password = resolve(&state.secrets, password).await?;
    state.connections.connect(&connection_id, password).await
}

/// `connect` with SSH secrets typed at connect time (F-010), kept for the session once they
/// worked, like the password.
#[tauri::command]
#[specta::specta]
pub async fn connect_with_secrets(
    state: State<'_, AppState>,
    connection_id: String,
    password: Option<SecretInput>,
    tunnel_secrets: Vec<TunnelSecretInput>,
) -> Result<SessionInfo, YadbeError> {
    let password = resolve(&state.secrets, password).await?;
    let tunnel_secrets = resolve_tunnel(&state.secrets, Some(tunnel_secrets)).await?;
    state
        .connections
        .connect_with_tunnel(&connection_id, password, tunnel_secrets)
        .await
}

/// Closes a connection (also aborts a connection attempt or a reconnection).
#[tauri::command]
#[specta::specta]
pub async fn disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), YadbeError> {
    state.connections.disconnect(&connection_id).await;
    Ok(())
}

/// State of every connection that is not closed.
#[tauri::command]
#[specta::specta]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, YadbeError> {
    Ok(state.connections.sessions())
}
