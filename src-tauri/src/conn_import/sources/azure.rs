//! Azure Data Studio and the Visual Studio Code `mssql` extension: connections and groups in
//! `settings.json` (`datasource.connections`, `mssql.connections`). Passwords are not in
//! these files (the editors keep them in their own credential store) and are never read.

use std::collections::HashMap;

use serde_json::Value as Json;

use super::{Parsed, ParsedConnection, blank, found, parse_bool, split_server};
use crate::conn_import::model::{ConnectionNote, ConnectionNoteKind, SkipReason, SkippedEntry};
use crate::db::config::{AuthMethod, TlsMode};
use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;

fn text<'a>(object: &'a Json, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Json::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The folders of each group id, outermost first (the `ROOT` group is the top level).
fn group_paths(settings: &Json) -> HashMap<String, Vec<String>> {
    struct Group {
        name: String,
        parent: Option<String>,
    }
    let mut groups: HashMap<String, Group> = HashMap::new();
    for key in ["datasource.connectionGroups", "mssql.connectionGroups"] {
        for group in settings
            .get(key)
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(id), Some(name)) = (text(group, &["id"]), text(group, &["name"])) {
                groups.insert(
                    id.to_owned(),
                    Group {
                        name: name.to_owned(),
                        parent: text(group, &["parentId"]).map(str::to_owned),
                    },
                );
            }
        }
    }
    let mut paths = HashMap::new();
    for id in groups.keys() {
        let mut path = Vec::new();
        let mut current = Some(id.as_str());
        let mut guard = 0;
        while let Some(at) = current {
            let Some(group) = groups.get(at) else { break };
            if !(group.parent.is_none() && group.name.eq_ignore_ascii_case("ROOT")) {
                path.push(group.name.clone());
            }
            current = group.parent.as_deref();
            guard += 1;
            if guard > 32 {
                break;
            }
        }
        path.reverse();
        paths.insert(id.clone(), path);
    }
    paths
}

fn tls_of(options: &Json, host: &str) -> TlsMode {
    let encrypt = options.get("encrypt").and_then(|v| match v {
        Json::Bool(b) => Some(*b),
        Json::String(s) => parse_bool(s),
        _ => None,
    });
    let trust = options
        .get("trustServerCertificate")
        .and_then(|v| match v {
            Json::Bool(b) => Some(*b),
            Json::String(s) => parse_bool(s),
            _ => None,
        })
        .unwrap_or(false);
    match encrypt {
        Some(false) => TlsMode::Prefer,
        Some(true) if trust => TlsMode::Require,
        Some(true) => TlsMode::VerifyFull,
        None => TlsMode::default_for_host(host),
    }
}

pub fn parse(settings_text: &str) -> Result<Parsed, YadbeError> {
    let json = super::jsonc::to_json(settings_text);
    let settings: Json = serde_json::from_str(&json).map_err(|_| {
        YadbeError::connection_file_invalid(
            "This file is not a readable settings.json.",
            "Ce fichier n'est pas un fichier settings.json lisible.",
        )
    })?;
    let paths = group_paths(&settings);
    let mut parsed = Parsed::default();
    let mut seen = 0_usize;
    for key in ["datasource.connections", "mssql.connections"] {
        for entry in settings
            .get(key)
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            seen += 1;
            // Azure Data Studio nests the settings in `options`; the VS Code extension has
            // them at the top.
            let options = entry.get("options").unwrap_or(entry);
            let provider = text(entry, &["providerName"])
                .or_else(|| text(options, &["providerName"]))
                .unwrap_or("MSSQL");
            let engine = match provider.to_ascii_uppercase().as_str() {
                "MSSQL" => Engine::Mssql,
                "PGSQL" => Engine::Postgres,
                other => {
                    parsed.skipped.push(SkippedEntry {
                        name: text(options, &["connectionName", "profileName"])
                            .unwrap_or(other)
                            .to_owned(),
                        reason: SkipReason::UnsupportedEngine,
                        detail: Some(provider.to_owned()),
                    });
                    continue;
                }
            };
            let Some(server) = text(options, &["server", "host"]) else {
                parsed.skipped.push(SkippedEntry {
                    name: text(options, &["connectionName", "profileName"])
                        .unwrap_or("?")
                        .to_owned(),
                    reason: SkipReason::Incomplete,
                    detail: None,
                });
                continue;
            };
            let (host, port_in_server) = split_server(server);
            let port = options
                .get("port")
                .and_then(Json::as_u64)
                .and_then(|p| u16::try_from(p).ok())
                .or(port_in_server);
            let database = text(options, &["database"]).unwrap_or_default();
            let user = text(options, &["user", "userName"]).unwrap_or_default();
            let name = text(options, &["connectionName", "profileName", "name"]).map_or_else(
                || {
                    if database.is_empty() {
                        host.clone()
                    } else {
                        format!("{host}/{database}")
                    }
                },
                str::to_owned,
            );
            let mut definition = blank(engine, &name);
            definition.host = host.clone();
            definition.port = port;
            definition.database = database.to_owned();
            definition.username = user.to_owned();
            definition.tls_mode = tls_of(options, &host);
            let mut notes = Vec::new();
            match text(options, &["authenticationType"])
                .unwrap_or("SqlLogin")
                .to_ascii_lowercase()
                .as_str()
            {
                "integrated" => {
                    definition.auth = AuthMethod::None;
                    notes.push(ConnectionNote {
                        kind: ConnectionNoteKind::IntegratedAuth,
                        detail: None,
                    });
                }
                "azuremfa" | "activedirectoryinteractive" | "azurempa" => {
                    notes.push(ConnectionNote {
                        kind: ConnectionNoteKind::EntraAuth,
                        detail: None,
                    });
                }
                _ => {}
            }
            let group_path = text(entry, &["groupId"])
                .or_else(|| text(options, &["groupId"]))
                .and_then(|id| paths.get(id))
                .cloned()
                .unwrap_or_default();
            let id = text(entry, &["id"])
                .or_else(|| text(options, &["id"]))
                .map_or_else(|| format!("#{seen}"), str::to_owned);
            parsed.connections.push(ParsedConnection {
                found: found(id, definition, group_path, notes, false),
                password: None,
            });
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADS: &str = r#"{
  // Azure Data Studio settings
  "workbench.colorTheme": "Default Dark+",
  "datasource.connectionGroups": [
    { "name": "ROOT", "id": "root-id" },
    { "name": "Prod", "id": "g-prod", "parentId": "root-id" },
    { "name": "EU", "id": "g-eu", "parentId": "g-prod", },
  ],
  "datasource.connections": [
    { "options": { "connectionName": "Orders (prod)", "server": "sql-eu.example.com,1444",
        "database": "orders", "authenticationType": "SqlLogin", "user": "app",
        "encrypt": true, "trustServerCertificate": false, "groupId": "g-eu" },
      "providerName": "MSSQL", "id": "c1", "groupId": "g-eu" },
    { "options": { "server": "localhost\\SQLEXPRESS", "authenticationType": "Integrated",
        "encrypt": "Optional" }, "providerName": "MSSQL", "id": "c2", "groupId": "root-id" },
    { "options": { "connectionName": "pg", "server": "pg.example.com", "port": 5433,
        "user": "me", "database": "app", "authenticationType": "AzureMFA" },
      "providerName": "PGSQL", "id": "c3" },
    { "options": { "connectionName": "kusto", "server": "x" }, "providerName": "KUSTO", "id": "c4" },
    { "options": { "connectionName": "no server" }, "providerName": "MSSQL", "id": "c5" }
  ]
}"#;

    #[test]
    fn reads_azure_data_studio_connections_and_groups() {
        let parsed = parse(ADS).expect("parses");
        assert_eq!(parsed.connections.len(), 3);
        let orders = &parsed.connections[0].found;
        assert_eq!(orders.key, "c1");
        assert_eq!(orders.definition.name, "Orders (prod)");
        assert_eq!(orders.definition.engine, Engine::Mssql);
        assert_eq!(orders.definition.host, "sql-eu.example.com");
        assert_eq!(orders.definition.port, Some(1444));
        assert_eq!(orders.definition.database, "orders");
        assert_eq!(orders.definition.username, "app");
        assert_eq!(orders.definition.tls_mode, TlsMode::VerifyFull);
        assert_eq!(orders.group_path, ["Prod", "EU"]);
        assert!(orders.notes.is_empty());
        assert!(!orders.has_password);

        let express = &parsed.connections[1].found;
        assert_eq!(express.definition.host, "localhost\\SQLEXPRESS");
        assert_eq!(express.definition.name, "localhost\\SQLEXPRESS");
        assert_eq!(express.definition.tls_mode, TlsMode::Prefer);
        assert_eq!(express.definition.auth, AuthMethod::None);
        assert_eq!(express.notes[0].kind, ConnectionNoteKind::IntegratedAuth);
        assert!(express.group_path.is_empty(), "ROOT is the top level");

        let pg = &parsed.connections[2].found;
        assert_eq!(pg.definition.engine, Engine::Postgres);
        assert_eq!(pg.definition.port, Some(5433));
        assert_eq!(pg.notes[0].kind, ConnectionNoteKind::EntraAuth);

        assert_eq!(parsed.skipped.len(), 2);
        assert_eq!(parsed.skipped[0].reason, SkipReason::UnsupportedEngine);
        assert_eq!(parsed.skipped[1].reason, SkipReason::Incomplete);
    }

    #[test]
    fn reads_the_flat_vscode_shape_and_never_a_password() {
        let parsed = parse(
            r#"{ "mssql.connections": [
                { "server": "tcp:db.local,1433", "database": "", "user": "sa",
                  "password": "plain-secret", "savePassword": true, "profileName": "local",
                  "encrypt": "Mandatory", "trustServerCertificate": true } ] }"#,
        )
        .expect("parses");
        let local = &parsed.connections[0];
        assert_eq!(local.found.definition.name, "local");
        assert_eq!(local.found.definition.host, "db.local");
        assert_eq!(local.found.definition.tls_mode, TlsMode::Require);
        assert!(local.password.is_none());
        assert!(!local.found.has_password);
        assert!(!format!("{:?}", local.found).contains("plain-secret"));
        assert_eq!(local.found.key, "#1");
    }

    #[test]
    fn rejects_something_that_is_not_settings() {
        assert!(parse("not json").is_err());
        assert!(parse("{}").expect("empty settings").connections.is_empty());
    }
}
