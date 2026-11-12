//! DBeaver: `data-sources.json` of a workspace. The user names and passwords live in the
//! encrypted `credentials-config.json`, which is never read: a connection comes without
//! them (the user name is kept only when the file has it in the clear).

use std::collections::HashMap;

use serde_json::Value as Json;

use super::{Parsed, ParsedConnection, blank, found};
use crate::conn_import::model::{ConnectionNote, ConnectionNoteKind, SkipReason, SkippedEntry};
use crate::db::config::{AuthMethod, EnvironmentKind, TlsMode};
use crate::db::engine::Engine;
use crate::db::errors::YadbeError;
use crate::tunnel::{SshAuthMethod, SshHop, SshTunnel};

fn string(value: &Json, key: &str) -> Option<String> {
    match value.get(key)? {
        Json::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Json::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn engine_of(provider: &str, driver: &str, url: &str) -> Option<Engine> {
    let url = url.to_ascii_lowercase();
    for (prefix, engine) in [
        ("jdbc:postgresql:", Engine::Postgres),
        ("jdbc:mysql:", Engine::Mysql),
        ("jdbc:mariadb:", Engine::Mysql),
        ("jdbc:sqlserver:", Engine::Mssql),
        ("jdbc:microsoft:sqlserver:", Engine::Mssql),
        ("jdbc:jtds:sqlserver:", Engine::Mssql),
        ("jdbc:sqlite:", Engine::Sqlite),
    ] {
        if url.starts_with(prefix) {
            return Some(engine);
        }
    }
    let provider = provider.to_ascii_lowercase();
    let driver = driver.to_ascii_lowercase();
    match provider.as_str() {
        "postgresql" | "postgres" => return Some(Engine::Postgres),
        "mysql" | "mariadb" => return Some(Engine::Mysql),
        "sqlserver" | "mssql" => return Some(Engine::Mssql),
        "sqlite" => return Some(Engine::Sqlite),
        _ => {}
    }
    if driver.contains("postgres") {
        Some(Engine::Postgres)
    } else if driver.contains("mysql") || driver.contains("mariadb") {
        Some(Engine::Mysql)
    } else if driver.contains("sqlserver") || driver.contains("mssql") || driver.contains("jtds") {
        Some(Engine::Mssql)
    } else if driver.contains("sqlite") {
        Some(Engine::Sqlite)
    } else {
        None
    }
}

/// The folder path of a connection: `"Prod/EU"`, or a folder id the `folders` object nests.
fn folder_path(folder: &str, folders: &HashMap<String, String>) -> Vec<String> {
    let mut path = vec![folder.to_owned()];
    let mut current = folder;
    let mut guard = 0;
    while let Some(parent) = folders.get(current) {
        path.push(parent.clone());
        current = parent;
        guard += 1;
        if guard > 32 {
            break;
        }
    }
    path.reverse();
    path.into_iter()
        .flat_map(|p| p.split('/').map(str::to_owned).collect::<Vec<_>>())
        .filter(|p| !p.is_empty())
        .collect()
}

fn ssh_of(configuration: &Json) -> Option<Result<SshTunnel, ()>> {
    let handler = configuration.get("handlers")?.get("ssh_tunnel")?;
    if handler.get("enabled").and_then(Json::as_bool) != Some(true) {
        return None;
    }
    let properties = handler.get("properties")?;
    let host = string(properties, "host")?;
    let username = string(properties, "user").or_else(|| string(handler, "user"));
    let Some(username) = username else {
        return Some(Err(()));
    };
    let key_path = string(properties, "keyPath");
    let auth = match string(properties, "authType")
        .unwrap_or_default()
        .to_ascii_uppercase()
        .as_str()
    {
        "PUBLIC_KEY" if key_path.is_some() => SshAuthMethod::Key,
        "AGENT" => SshAuthMethod::Agent,
        _ => SshAuthMethod::Password,
    };
    Some(Ok(SshTunnel {
        server: SshHop {
            host,
            port: string(properties, "port").and_then(|p| p.parse().ok()),
            username,
            auth,
            key_path: key_path.filter(|_| auth == SshAuthMethod::Key),
            remember_secret: false,
        },
        jump: None,
        keepalive_secs: None,
    }))
}

pub fn parse(text: &str) -> Result<Parsed, YadbeError> {
    let root: Json =
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).map_err(|_| {
            YadbeError::connection_file_invalid(
                "This file is not a readable DBeaver data-sources.json.",
                "Ce fichier n'est pas un data-sources.json de DBeaver lisible.",
            )
        })?;
    let folders: HashMap<String, String> = root
        .get("folders")
        .and_then(Json::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, folder)| Some((name.clone(), string(folder, "parent")?)))
        .collect();
    let mut parsed = Parsed::default();
    for (id, entry) in root
        .get("connections")
        .and_then(Json::as_object)
        .into_iter()
        .flatten()
    {
        let name = string(entry, "name").unwrap_or_else(|| id.clone());
        let configuration = entry.get("configuration").cloned().unwrap_or(Json::Null);
        let url = string(&configuration, "url").unwrap_or_default();
        let provider = string(entry, "provider").unwrap_or_default();
        let driver = string(entry, "driver").unwrap_or_default();
        let Some(engine) = engine_of(&provider, &driver, &url) else {
            parsed.skipped.push(SkippedEntry {
                name,
                reason: SkipReason::UnsupportedEngine,
                detail: Some(if driver.is_empty() { provider } else { driver }),
            });
            continue;
        };
        let mut definition = blank(engine, &name);
        let mut notes = Vec::new();
        if engine.capabilities().uses_file {
            let file = string(&configuration, "database")
                .or_else(|| url.strip_prefix("jdbc:sqlite:").map(str::to_owned))
                .unwrap_or_default();
            if file.is_empty() {
                parsed.skipped.push(SkippedEntry {
                    name,
                    reason: SkipReason::Incomplete,
                    detail: None,
                });
                continue;
            }
            definition.file_path = file;
            definition.auth = AuthMethod::None;
        } else {
            let host = string(&configuration, "host").unwrap_or_default();
            if host.is_empty() {
                parsed.skipped.push(SkippedEntry {
                    name,
                    reason: SkipReason::Incomplete,
                    detail: None,
                });
                continue;
            }
            definition.host = host;
            definition.port = string(&configuration, "port").and_then(|p| p.parse().ok());
            definition.database = string(&configuration, "database").unwrap_or_default();
            definition.username = string(&configuration, "user").unwrap_or_default();
            definition.tls_mode = TlsMode::default_for_host(&definition.host);
            if definition.username.is_empty() {
                notes.push(ConnectionNote {
                    kind: ConnectionNoteKind::UserMissing,
                    detail: None,
                });
            }
        }
        if string(&configuration, "password").is_some() {
            notes.push(ConnectionNote {
                kind: ConnectionNoteKind::PasswordNotImported,
                detail: None,
            });
        }
        definition.environment.kind = match string(&configuration, "type")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "dev" => EnvironmentKind::Dev,
            "test" => EnvironmentKind::Staging,
            "prod" => EnvironmentKind::Prod,
            _ => EnvironmentKind::None,
        };
        definition.read_only = entry
            .get("read-only")
            .or_else(|| configuration.get("read-only"))
            .and_then(Json::as_bool)
            .unwrap_or(false);
        definition.favorite = entry
            .get("favorite")
            .and_then(Json::as_bool)
            .unwrap_or(false);
        match ssh_of(&configuration) {
            Some(Ok(tunnel)) if !engine.capabilities().uses_file => definition.ssh = Some(tunnel),
            Some(_) => notes.push(ConnectionNote {
                kind: ConnectionNoteKind::SshIncomplete,
                detail: None,
            }),
            None => {}
        }
        let group_path = string(entry, "folder")
            .map(|f| folder_path(&f, &folders))
            .unwrap_or_default();
        parsed.connections.push(ParsedConnection {
            found: found(id.clone(), definition, group_path, notes, false),
            password: None,
        });
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATA_SOURCES: &str = r#"{
  "folders": { "Prod": {}, "EU": { "parent": "Prod" } },
  "connections": {
    "postgres-jdbc-1": {
      "provider": "postgresql", "driver": "postgres-jdbc", "name": "Shop (prod)",
      "save-password": true, "folder": "EU", "read-only": true, "favorite": true,
      "configuration": { "host": "db.example.com", "port": "5433", "database": "shop",
        "url": "jdbc:postgresql://db.example.com:5433/shop", "type": "prod",
        "auth-model": "native" } },
    "mysql8-2": {
      "provider": "mysql", "driver": "mysql8", "name": "Local MySQL",
      "configuration": { "host": "localhost", "port": 3306, "user": "root", "type": "dev",
        "password": "oops", "handlers": { "ssh_tunnel": { "type": "tunnel", "enabled": true,
          "properties": { "host": "bastion.example.com", "port": 2222, "authType": "PUBLIC_KEY",
            "keyPath": "/home/me/.ssh/id_ed25519", "user": "deploy" } } } } },
    "mssql-3": {
      "provider": "sqlserver", "driver": "microsoft", "name": "Reports",
      "configuration": { "host": "sql", "database": "rep", "type": "test",
        "handlers": { "ssh_tunnel": { "enabled": true, "properties": { "host": "b" } } } } },
    "sqlite-4": {
      "provider": "sqlite", "driver": "sqlite_jdbc", "name": "Notes",
      "configuration": { "database": "/home/me/notes.sqlite" } },
    "oracle-5": { "provider": "oracle", "driver": "oracle_thin", "name": "Legacy",
      "configuration": { "host": "ora" } }
  }
}"#;

    #[test]
    fn reads_connections_folders_flags_and_tunnels_without_secrets() {
        let parsed = parse(DATA_SOURCES).expect("parses");
        assert_eq!(parsed.connections.len(), 4);
        let by = |key: &str| {
            &parsed
                .connections
                .iter()
                .find(|c| c.found.key == key)
                .unwrap_or_else(|| panic!("{key}"))
                .found
        };
        let shop = by("postgres-jdbc-1");
        assert_eq!(shop.definition.engine, Engine::Postgres);
        assert_eq!(shop.definition.host, "db.example.com");
        assert_eq!(shop.definition.port, Some(5433));
        assert_eq!(shop.definition.environment.kind, EnvironmentKind::Prod);
        assert!(shop.definition.read_only);
        assert!(shop.definition.favorite);
        assert_eq!(shop.group_path, ["Prod", "EU"]);
        assert_eq!(shop.notes[0].kind, ConnectionNoteKind::UserMissing);

        let mysql = by("mysql8-2");
        assert_eq!(mysql.definition.username, "root");
        assert_eq!(mysql.definition.environment.kind, EnvironmentKind::Dev);
        let ssh = mysql.definition.ssh.as_ref().expect("tunnel");
        assert_eq!(ssh.server.endpoint(), "deploy@bastion.example.com:2222");
        assert_eq!(ssh.server.auth, SshAuthMethod::Key);
        assert_eq!(
            ssh.server.key_path.as_deref(),
            Some("/home/me/.ssh/id_ed25519")
        );
        assert!(
            mysql
                .notes
                .iter()
                .any(|n| n.kind == ConnectionNoteKind::PasswordNotImported)
        );
        assert!(!format!("{mysql:?}").contains("oops"));

        let reports = by("mssql-3");
        assert_eq!(
            reports.definition.environment.kind,
            EnvironmentKind::Staging
        );
        assert!(reports.definition.ssh.is_none());
        assert!(
            reports
                .notes
                .iter()
                .any(|n| n.kind == ConnectionNoteKind::SshIncomplete)
        );

        let notes = by("sqlite-4");
        assert_eq!(notes.definition.file_path, "/home/me/notes.sqlite");
        assert_eq!(notes.definition.auth, AuthMethod::None);

        assert_eq!(parsed.skipped.len(), 1);
        assert_eq!(parsed.skipped[0].reason, SkipReason::UnsupportedEngine);
        assert!(parsed.connections.iter().all(|c| c.password.is_none()));
    }

    #[test]
    fn rejects_something_that_is_not_data_sources() {
        assert!(
            parse("[1]")
                .map(|p| p.connections.len())
                .is_ok_and(|n| n == 0)
        );
        assert!(parse("garbage").is_err());
    }
}
