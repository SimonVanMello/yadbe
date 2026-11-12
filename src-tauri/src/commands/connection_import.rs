//! Importing connections from other tools and exchanging yadbe's own (M3-10, F-012). Paths
//! come from the native open and save dialogs, or are the sources' usual places; no secret
//! is ever returned.

use std::path::Path;
use std::sync::Arc;

use tauri::State;

use super::blocking;
use crate::conn_import::locations::Locations;
use crate::conn_import::model::{
    ConnectionImportResult, ConnectionScan, ConnectionSourceInfo, ConnectionSourceKind,
    ImportConnectionsRequest,
};
use crate::conn_import::{self, import, parse_source, resolve_path};
use crate::db::errors::YadbeError;
use crate::state::AppState;

/// The sources connections can be imported from, with the file each has on this computer
/// (`null` when it does not exist there).
#[tauri::command]
#[specta::specta]
pub async fn list_connection_sources() -> Result<Vec<ConnectionSourceInfo>, YadbeError> {
    blocking(|| Ok(conn_import::list_sources(&Locations::from_env()))).await
}

/// Reads a source file (its default place when `path` is `null`) and lists the connections it
/// defines, with the ones that already exist marked. Passwords are never returned. Fails
/// with `fileNotFound`, `connectionFileInvalid` for a file that is not of that source's
/// format (or a yadbe file from a newer version).
#[tauri::command]
#[specta::specta]
pub async fn scan_connection_source(
    state: State<'_, AppState>,
    kind: ConnectionSourceKind,
    path: Option<String>,
) -> Result<ConnectionScan, YadbeError> {
    let store = Arc::clone(&state.store);
    blocking(move || {
        let file = resolve_path(kind, path.as_deref(), &Locations::from_env())?;
        conn_import::scan(kind, &file, &store.list_connections()?)
    })
    .await
}

/// Imports the chosen connections as new ones (new ids, a unique name, folders recreated).
/// The file is read again for the passwords; those of a `.pgpass` go to the OS keychain when
/// `importPasswords`, nowhere else. A connection that cannot be saved is listed in `failed`.
#[tauri::command]
#[specta::specta]
pub async fn import_connections(
    state: State<'_, AppState>,
    request: ImportConnectionsRequest,
) -> Result<ConnectionImportResult, YadbeError> {
    let store = Arc::clone(&state.store);
    let secrets = Arc::clone(&state.secrets);
    blocking(move || {
        let file = resolve_path(
            request.kind,
            request.path.as_deref(),
            &Locations::from_env(),
        )?;
        let text = conn_import::read_source_file(&file)?;
        let parsed = parse_source(request.kind, &text)?;
        import(
            &store,
            &secrets,
            parsed,
            &request.keys,
            request.import_passwords,
        )
    })
    .await
}

/// Writes the chosen connections (all when the list is empty) to a yadbe connections file:
/// definitions, folders, environment tags and flags, SSH tunnel settings, and no password,
/// passphrase or token. Returns how many were written. `path` must be absolute, `.json`.
#[tauri::command]
#[specta::specta]
pub async fn export_connections(
    state: State<'_, AppState>,
    path: String,
    connection_ids: Vec<String>,
) -> Result<u32, YadbeError> {
    let file = Path::new(&path);
    let json = file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !file.is_absolute() || !json || file.file_name().is_none() {
        return Err(YadbeError::invalid_argument(
            "A connections file is saved at an absolute path ending in .json.",
            "Un fichier de connexions est enregistré à un chemin absolu qui se termine par .json.",
        ));
    }
    let store = Arc::clone(&state.store);
    let file = file.to_path_buf();
    blocking(move || {
        conn_import::export_file(&store, &connection_ids, &file, env!("CARGO_PKG_VERSION"))
    })
    .await
}
