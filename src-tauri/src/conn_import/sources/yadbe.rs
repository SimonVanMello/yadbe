//! yadbe's own connection file: groups and connection definitions, no secret. Versioned so
//! a later release can read old files and refuse files from a newer one.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{Parsed, ParsedConnection, found};
use crate::conn_import::model::{SkipReason, SkippedEntry};
use crate::db::config::ConnectionDefinition;
use crate::db::errors::YadbeError;
use crate::store::{ConnectionGroup, SavedConnection};

pub const FORMAT: &str = "yadbe-connections";
/// Bumped when a change cannot be read by an older yadbe.
pub const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileGroup {
    id: String,
    name: String,
    parent_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionsFile {
    format: String,
    version: u32,
    /// The yadbe that wrote the file.
    app_version: String,
    groups: Vec<FileGroup>,
    /// `groupId` refers to `groups` of this file.
    connections: Vec<serde_json::Value>,
}

/// The JSON of `connections` and the groups they sit in. No password, passphrase or token
/// exists in a `ConnectionDefinition`: a connection's secrets stay in the keychain.
pub fn export(
    connections: &[SavedConnection],
    groups: &[ConnectionGroup],
    app_version: &str,
) -> Result<String, YadbeError> {
    // Only the groups the connections sit in, and their ancestors.
    let by_id: HashMap<&str, &ConnectionGroup> =
        groups.iter().map(|g| (g.id.as_str(), g)).collect();
    let mut needed: Vec<&ConnectionGroup> = Vec::new();
    for connection in connections {
        let mut current = connection.definition.group_id.as_deref();
        while let Some(id) = current {
            let Some(group) = by_id.get(id) else { break };
            if needed.iter().any(|g| g.id == group.id) {
                break;
            }
            needed.push(group);
            current = group.parent_id.as_deref();
        }
    }
    needed.sort_by_key(|g| (g.parent_id.is_some(), g.position));
    let file = ConnectionsFile {
        format: FORMAT.to_owned(),
        version: VERSION,
        app_version: app_version.to_owned(),
        groups: needed
            .into_iter()
            .map(|g| FileGroup {
                id: g.id.clone(),
                name: g.name.clone(),
                parent_id: g.parent_id.clone(),
            })
            .collect(),
        connections: connections
            .iter()
            .map(|c| serde_json::to_value(&c.definition))
            .collect::<Result<_, _>>()
            .map_err(|e| YadbeError::internal(e.to_string()))?,
    };
    serde_json::to_string_pretty(&file).map_err(|e| YadbeError::internal(e.to_string()))
}

pub fn parse(text: &str) -> Result<Parsed, YadbeError> {
    let file: ConnectionsFile = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))
        .map_err(|_| not_yadbe())?;
    if file.format != FORMAT {
        return Err(not_yadbe());
    }
    if file.version > VERSION {
        return Err(YadbeError::connection_file_invalid(
            "This file was written by a newer version of yadbe: update yadbe to read it.",
            "Ce fichier a été écrit par une version plus récente de yadbe : mettez yadbe à jour pour le lire.",
        ));
    }
    let groups: HashMap<&str, &FileGroup> =
        file.groups.iter().map(|g| (g.id.as_str(), g)).collect();
    let path_of = |id: &str| {
        let mut path = Vec::new();
        let mut current = Some(id);
        let mut guard = 0;
        while let Some(at) = current {
            let Some(group) = groups.get(at) else { break };
            path.push(group.name.clone());
            current = group.parent_id.as_deref();
            guard += 1;
            if guard > 32 {
                break;
            }
        }
        path.reverse();
        path
    };
    let mut parsed = Parsed::default();
    for (index, value) in file.connections.into_iter().enumerate() {
        let name = value
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("?")
            .to_owned();
        let definition: ConnectionDefinition = match serde_json::from_value(value) {
            Ok(definition) => definition,
            Err(error) => {
                parsed.skipped.push(SkippedEntry {
                    name,
                    reason: SkipReason::Invalid,
                    detail: Some(error.to_string()),
                });
                continue;
            }
        };
        let group_path = definition
            .group_id
            .as_deref()
            .map(path_of)
            .unwrap_or_default();
        let mut definition = match definition.normalized() {
            Ok(definition) => definition,
            Err(error) => {
                parsed.skipped.push(SkippedEntry {
                    name,
                    reason: SkipReason::Invalid,
                    detail: Some(error.message.en),
                });
                continue;
            }
        };
        definition.group_id = None;
        parsed.connections.push(ParsedConnection {
            found: found(
                format!("#{}", index + 1),
                definition,
                group_path,
                Vec::new(),
                false,
            ),
            password: None,
        });
    }
    Ok(parsed)
}

fn not_yadbe() -> YadbeError {
    YadbeError::connection_file_invalid(
        "This file is not a yadbe connections file.",
        "Ce fichier n'est pas un fichier de connexions yadbe.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn_import::sources::blank;
    use crate::db::config::{EnvironmentKind, TlsMode};
    use crate::db::engine::Engine;
    use crate::tunnel::{SshAuthMethod, SshHop, SshTunnel};

    fn saved(id: &str, definition: ConnectionDefinition) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            family: definition.engine.family(),
            definition,
            position: 0,
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
        }
    }

    fn group(id: &str, name: &str, parent: Option<&str>, position: u32) -> ConnectionGroup {
        ConnectionGroup {
            id: id.into(),
            name: name.into(),
            parent_id: parent.map(str::to_owned),
            position,
            collapsed: false,
        }
    }

    #[test]
    fn round_trips_flags_groups_and_tunnels_without_secrets() {
        let mut prod = blank(Engine::Postgres, "Shop (prod)");
        prod.host = "db.example.com".into();
        prod.port = Some(5433);
        prod.database = "shop".into();
        prod.username = "app".into();
        prod.tls_mode = TlsMode::VerifyFull;
        prod.read_only = true;
        prod.favorite = true;
        prod.remember_password = true;
        prod.environment.kind = EnvironmentKind::Prod;
        prod.group_id = Some("g2".into());
        prod.ssh = Some(SshTunnel {
            server: SshHop {
                host: "bastion".into(),
                port: Some(2222),
                username: "deploy".into(),
                auth: SshAuthMethod::Key,
                key_path: Some("/home/me/.ssh/id_ed25519".into()),
                remember_secret: true,
            },
            jump: None,
            keepalive_secs: Some(15),
        });
        let mut file = blank(Engine::Sqlite, "Notes");
        file.file_path = "/home/me/notes.sqlite".into();
        let text = export(
            &[saved("a", prod.clone()), saved("b", file)],
            &[
                group("g1", "Prod", None, 0),
                group("g2", "EU", Some("g1"), 0),
                group("unused", "Unused", None, 1),
            ],
            "0.1.0",
        )
        .expect("exports");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(value["format"], "yadbe-connections");
        assert_eq!(value["version"], 1);
        assert_eq!(
            value["groups"].as_array().map(Vec::len),
            Some(2),
            "only the used groups"
        );
        assert!(!text.to_ascii_lowercase().contains("passphrase\":"));
        assert!(!text.contains("\"password\":"));

        let parsed = parse(&text).expect("parses");
        assert_eq!(parsed.connections.len(), 2);
        let first = &parsed.connections[0].found;
        assert_eq!(first.group_path, ["Prod", "EU"]);
        assert_eq!(
            first.definition,
            ConnectionDefinition {
                group_id: None,
                ..prod
            }
        );
        assert!(parsed.connections[1].found.group_path.is_empty());
    }

    #[test]
    fn refuses_foreign_and_newer_files_and_skips_invalid_entries() {
        assert!(parse("{}").is_err());
        assert!(parse("{\"format\": \"other\", \"version\": 1, \"appVersion\": \"x\", \"groups\": [], \"connections\": []}").is_err());
        let newer = "{\"format\": \"yadbe-connections\", \"version\": 2, \"appVersion\": \"9\", \"groups\": [], \"connections\": []}";
        let error = parse(newer).expect_err("newer");
        assert!(error.message.en.contains("newer version"));
        let mixed = "{\"format\": \"yadbe-connections\", \"version\": 1, \"appVersion\": \"x\", \"groups\": [],
            \"connections\": [{\"name\": \"broken\"}, {\"name\": \"\", \"engine\": \"sqlite\", \"host\": \"\", \"port\": null,
            \"database\": \"\", \"username\": \"\", \"filePath\": \"/x\", \"auth\": \"none\", \"tlsMode\": \"disable\",
            \"caCertPath\": null, \"connectTimeoutSecs\": null, \"options\": [], \"groupId\": null,
            \"environment\": {\"kind\": \"none\", \"label\": null, \"color\": null}, \"favorite\": false,
            \"readOnly\": false, \"rememberPassword\": false}]}";
        let parsed = parse(mixed).expect("parses");
        assert!(parsed.connections.is_empty());
        assert_eq!(parsed.skipped.len(), 2);
        assert!(
            parsed
                .skipped
                .iter()
                .all(|s| s.reason == SkipReason::Invalid)
        );
    }
}
