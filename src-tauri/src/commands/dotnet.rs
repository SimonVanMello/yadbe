//! EF Core awareness (F-143): the migrations timeline, and a connection as a .NET connection
//! string.

use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::db::dotnet::{self, ConnectionStringCopy, ConnectionStringFlavor};
use crate::db::ef::EfMigrations;
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::secrets::SecretKind;
use crate::state::AppState;

/// The migrations recorded in a `__EFMigrationsHistory` table, oldest first, with the
/// timestamp and the name of each id parsed.
#[tauri::command]
#[specta::specta]
pub async fn get_ef_migrations(
    state: State<'_, AppState>,
    request_id: Option<String>,
    connection_id: String,
    table: ObjectRef,
) -> Result<EfMigrations, YadbeError> {
    state
        .meta
        .ef_migrations(
            &state.connections,
            request_id.as_deref(),
            &connection_id,
            &table,
        )
        .await
}

/// A saved connection as an ADO.NET connection string, or as the EF Core call that uses it,
/// for the engine's .NET provider. The password is left out unless `includePassword`: then it
/// is read from the keychain (or the session) here, written into the returned text only, and
/// never logged or stored; the caller puts it on the clipboard and lets it go. Fails with
/// `passwordRequired` when none is stored.
#[tauri::command]
#[specta::specta]
pub async fn copy_connection_string(
    state: State<'_, AppState>,
    connection_id: String,
    flavor: ConnectionStringFlavor,
    include_password: bool,
) -> Result<ConnectionStringCopy, YadbeError> {
    let store = Arc::clone(&state.store);
    let secrets = Arc::clone(&state.secrets);
    blocking(move || {
        let definition = store.connection(&connection_id)?.definition;
        let password = if include_password {
            Some(
                secrets
                    .get(&connection_id, SecretKind::Password)?
                    .ok_or_else(YadbeError::password_required)?,
            )
        } else {
            None
        };
        Ok(dotnet::build(
            definition.engine.dialect(),
            &definition,
            flavor,
            password.as_ref(),
        ))
    })
    .await
}
