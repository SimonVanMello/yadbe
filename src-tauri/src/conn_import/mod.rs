//! Importing connections from other tools and exchanging yadbe's own (M3-10, F-012).
//!
//! `sources/` parses each file format; this module finds the file, marks the connections
//! that already exist, and writes the chosen ones to the store (groups included) and the
//! passwords a source holds to the keychain, through `secrets/` only. A scan returns
//! definitions without secrets; `import` reads the file again for the passwords, so none
//! travels between calls or reaches the frontend.

pub mod locations;
pub mod model;
pub mod sources;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use locations::Locations;
use model::{
    ConflictKind, ConnectionConflict, ConnectionImportFailure, ConnectionImportResult,
    ConnectionScan, ConnectionSourceInfo, ConnectionSourceKind, FoundConnection,
};
use sources::Parsed;

use crate::db::config::ConnectionDefinition;
use crate::db::errors::YadbeError;
use crate::secrets::{SecretKind, SecretLocation, SecretStore};
use crate::store::{ConnectionGroup, MAX_GROUP_NAME_CHARS, SavedConnection, Store};

/// Largest connections file read.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

pub fn list_sources(locations: &Locations) -> Vec<ConnectionSourceInfo> {
    ConnectionSourceKind::ALL
        .into_iter()
        .map(|kind| ConnectionSourceInfo {
            kind,
            default_path: locations
                .default_path(kind)
                .map(|p| p.display().to_string()),
            supports_passwords: kind.supports_passwords(),
        })
        .collect()
}

/// The file to read: the given absolute path, or the source's default.
pub fn resolve_path(
    kind: ConnectionSourceKind,
    path: Option<&str>,
    locations: &Locations,
) -> Result<PathBuf, YadbeError> {
    match path {
        Some(path) => {
            if !locations::is_absolute(path) {
                return Err(YadbeError::invalid_argument(
                    "The file path must be absolute.",
                    "Le chemin du fichier doit être absolu.",
                ));
            }
            Ok(PathBuf::from(path))
        }
        None => locations.default_path(kind).ok_or_else(|| {
            YadbeError::file_not_found(
                &locations
                    .candidates(kind)
                    .first()
                    .map_or_else(|| "?".to_owned(), |p| p.display().to_string()),
            )
        }),
    }
}

pub fn read_source_file(path: &Path) -> Result<String, YadbeError> {
    let display = path.display().to_string();
    let size = std::fs::metadata(path)
        .map_err(|e| YadbeError::file_read_failed(&display, &e))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(YadbeError::connection_file_invalid(
            "This file is larger than 16 MiB: it is not a connections file.",
            "Ce fichier dépasse 16 Mio : ce n'est pas un fichier de connexions.",
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| YadbeError::file_read_failed(&display, &e))?;
    String::from_utf8(bytes).map_err(|_| {
        YadbeError::connection_file_invalid(
            "This file is not UTF-8 text.",
            "Ce fichier n'est pas du texte UTF-8.",
        )
    })
}

pub fn parse_source(kind: ConnectionSourceKind, text: &str) -> Result<Parsed, YadbeError> {
    match kind {
        ConnectionSourceKind::AzureDataStudio | ConnectionSourceKind::VscodeMssql => {
            sources::azure::parse(text)
        }
        ConnectionSourceKind::Ssms => sources::ssms::parse(text),
        ConnectionSourceKind::Dbeaver => sources::dbeaver::parse(text),
        ConnectionSourceKind::Pgpass => Ok(sources::pgpass::parse(text)),
        ConnectionSourceKind::PgService => Ok(sources::pg_service::parse(text)),
        ConnectionSourceKind::Yadbe => sources::yadbe::parse(text),
    }
}

fn port_of(definition: &ConnectionDefinition) -> u16 {
    definition
        .port
        .or_else(|| definition.engine.dialect().capabilities().default_port)
        .unwrap_or(0)
}

fn same_target(a: &ConnectionDefinition, b: &ConnectionDefinition) -> bool {
    a.engine == b.engine
        && a.host.eq_ignore_ascii_case(&b.host)
        && port_of(a) == port_of(b)
        && a.database.eq_ignore_ascii_case(&b.database)
        && a.username.eq_ignore_ascii_case(&b.username)
        && a.file_path == b.file_path
}

fn conflict_of(
    definition: &ConnectionDefinition,
    existing: &[SavedConnection],
) -> Option<ConnectionConflict> {
    let of = |saved: &SavedConnection, kind| ConnectionConflict {
        existing_id: saved.id.clone(),
        existing_name: saved.definition.name.clone(),
        kind,
    };
    existing
        .iter()
        .find(|saved| same_target(&saved.definition, definition))
        .map(|saved| of(saved, ConflictKind::SameTarget))
        .or_else(|| {
            existing
                .iter()
                .find(|saved| saved.definition.name.eq_ignore_ascii_case(&definition.name))
                .map(|saved| of(saved, ConflictKind::SameName))
        })
}

/// Reads `path` as `kind` and reports what it defines, with the conflicts against the saved
/// connections. Blocking.
pub fn scan(
    kind: ConnectionSourceKind,
    path: &Path,
    existing: &[SavedConnection],
) -> Result<ConnectionScan, YadbeError> {
    let parsed = parse_source(kind, &read_source_file(path)?)?;
    let connections = parsed
        .connections
        .into_iter()
        .map(|c| FoundConnection {
            conflict: conflict_of(&c.found.definition, existing),
            ..c.found
        })
        .collect();
    Ok(ConnectionScan {
        kind,
        path: path.display().to_string(),
        connections,
        skipped: parsed.skipped,
    })
}

/// `name`, or `name (2)`… when a connection already has it.
fn unique_name(name: &str, taken: &mut HashSet<String>) -> String {
    let mut candidate = name.to_owned();
    let mut n = 2;
    while !taken.insert(candidate.to_lowercase()) {
        candidate = format!("{name} ({n})");
        n += 1;
    }
    candidate
}

/// The id of the group at `path` (created when missing), under `parent`.
fn ensure_group(
    store: &Store,
    groups: &mut Vec<ConnectionGroup>,
    path: &[String],
    created: &mut u32,
) -> Result<Option<String>, YadbeError> {
    let mut parent: Option<String> = None;
    for name in path {
        let name: String = name.trim().chars().take(MAX_GROUP_NAME_CHARS).collect();
        if name.is_empty() {
            continue;
        }
        let existing = groups
            .iter()
            .find(|g| g.parent_id == parent && g.name.eq_ignore_ascii_case(&name))
            .map(|g| g.id.clone());
        let id = match existing {
            Some(id) => id,
            None => {
                let group = store.create_group(&name, parent.as_ref())?;
                *created += 1;
                let id = group.id.clone();
                groups.push(group);
                id
            }
        };
        parent = Some(id);
    }
    Ok(parent)
}

/// Imports the connections of `parsed` whose key is in `keys`: new ids, unique names, the
/// folders recreated. Passwords go to the keychain only when `import_passwords`. A
/// connection that cannot be saved is reported, the others go on. Blocking.
pub fn import(
    store: &Store,
    secrets: &SecretStore,
    parsed: Parsed,
    keys: &[String],
    import_passwords: bool,
) -> Result<ConnectionImportResult, YadbeError> {
    let existing = store.list_connections()?;
    let mut taken: HashSet<String> = existing
        .iter()
        .map(|c| c.definition.name.to_lowercase())
        .collect();
    let mut groups = store.list_groups()?;
    let mut result = ConnectionImportResult {
        created: Vec::new(),
        groups_created: 0,
        passwords_stored: 0,
        passwords_session_only: 0,
        failed: Vec::new(),
    };
    for connection in parsed.connections {
        if !keys.contains(&connection.found.key) {
            continue;
        }
        let key = connection.found.key.clone();
        let mut definition = connection.found.definition.clone();
        let name = definition.name.clone();
        let group_id = match ensure_group(
            store,
            &mut groups,
            &connection.found.group_path,
            &mut result.groups_created,
        ) {
            Ok(id) => id,
            Err(error) => {
                tracing::warn!(%error, "a folder could not be created: the connection goes to the top level");
                None
            }
        };
        definition.group_id = group_id;
        let password = connection.password.filter(|_| import_passwords);
        if password.is_some() {
            definition.remember_password = true;
        }
        definition.name = unique_name(&definition.name, &mut taken);
        let saved = definition
            .normalized()
            .and_then(|definition| store.create_connection(&definition));
        let saved = match saved {
            Ok(saved) => saved,
            Err(error) => {
                result.failed.push(ConnectionImportFailure {
                    key,
                    name,
                    detail: error.message.en,
                });
                continue;
            }
        };
        if let Some(password) = password {
            match secrets.set(&saved.id, SecretKind::Password, password, true) {
                Ok(SecretLocation::Keychain) => result.passwords_stored += 1,
                Ok(SecretLocation::Session) => result.passwords_session_only += 1,
                Err(error) => {
                    tracing::warn!(%error, "an imported password could not be stored");
                }
            }
        }
        result.created.push(saved);
    }
    Ok(result)
}

/// Writes the chosen saved connections (all when `ids` is empty) to `path` as a yadbe
/// connections file. Returns how many. Blocking.
pub fn export_file(
    store: &Store,
    ids: &[String],
    path: &Path,
    app_version: &str,
) -> Result<u32, YadbeError> {
    let mut connections = store.list_connections()?;
    if !ids.is_empty() {
        connections.retain(|c| ids.contains(&c.id));
    }
    let groups = store.list_groups()?;
    let text = sources::yadbe::export(&connections, &groups, app_version)?;
    let display = path.display().to_string();
    let name = path.file_name().map_or_else(
        || "connections".into(),
        |n| n.to_string_lossy().into_owned(),
    );
    let tmp = path.with_file_name(format!(".{name}.yadbe-export.tmp"));
    std::fs::write(&tmp, text).map_err(|e| YadbeError::file_write_failed(&display, &e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        YadbeError::file_write_failed(&display, &e)
    })?;
    Ok(u32::try_from(connections.len()).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests;
