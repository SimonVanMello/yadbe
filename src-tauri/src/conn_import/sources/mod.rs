//! One parser per source. Each turns the text of a file into the connections it defines;
//! none reads a password except `pgpass`, and none touches the disk or the keychain.

pub mod azure;
pub mod dbeaver;
pub mod jsonc;
pub mod pg_service;
pub mod pgpass;
pub mod ssms;
pub mod xml;
pub mod yadbe;

use super::model::{ConnectionNote, FoundConnection, SkippedEntry};
use crate::db::config::{AuthMethod, ConnectionDefinition, Environment, TlsMode};
use crate::db::engine::Engine;
use crate::secrets::Secret;

/// A connection found in a file, with the password the file holds (never sent anywhere
/// but the keychain).
#[derive(Debug)]
pub struct ParsedConnection {
    pub found: FoundConnection,
    pub password: Option<Secret>,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub connections: Vec<ParsedConnection>,
    pub skipped: Vec<SkippedEntry>,
}

/// A definition with the engine's defaults and nothing else.
pub fn blank(engine: Engine, name: &str) -> ConnectionDefinition {
    ConnectionDefinition {
        name: name.trim().to_owned(),
        engine,
        host: String::new(),
        port: None,
        database: String::new(),
        username: String::new(),
        file_path: String::new(),
        auth: AuthMethod::Password,
        tls_mode: TlsMode::Prefer,
        ca_cert_path: None,
        tls_client_cert_path: None,
        tls_client_key_path: None,
        connect_timeout_secs: None,
        statement_timeout_secs: None,
        keep_alive_secs: None,
        options: Vec::new(),
        group_id: None,
        environment: Environment::default(),
        favorite: false,
        read_only: false,
        remember_password: false,
        history_enabled: true,
        ssh: None,
        key_value: None,
    }
}

pub fn found(
    key: String,
    definition: ConnectionDefinition,
    group_path: Vec<String>,
    notes: Vec<ConnectionNote>,
    has_password: bool,
) -> FoundConnection {
    FoundConnection {
        key,
        definition,
        group_path,
        has_password,
        conflict: None,
        notes,
    }
}

/// `host,port`, `tcp:host,port`, `host\instance`, `host:port`: the host (with its instance
/// name) and the port.
pub fn split_server(server: &str) -> (String, Option<u16>) {
    let server = server.trim();
    let server = server
        .strip_prefix("tcp:")
        .or_else(|| server.strip_prefix("TCP:"))
        .unwrap_or(server);
    let (host, port) = match server.rsplit_once(',') {
        Some((host, port)) => (host, port.trim().parse::<u16>().ok()),
        None => match server.rsplit_once(':') {
            // Not an IPv6 address.
            Some((host, port)) if !host.contains(':') => (host, port.trim().parse::<u16>().ok()),
            _ => (server, None),
        },
    };
    (host.trim().to_owned(), port.filter(|p| *p != 0))
}

pub fn parse_bool(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" | "mandatory" | "strict" | "sspi" => Some(true),
        "false" | "no" | "0" | "optional" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_server_strings() {
        assert_eq!(
            split_server("db.example.com,1444"),
            ("db.example.com".into(), Some(1444))
        );
        assert_eq!(split_server("tcp:db,1433"), ("db".into(), Some(1433)));
        assert_eq!(
            split_server("host\\SQLEXPRESS"),
            ("host\\SQLEXPRESS".into(), None)
        );
        assert_eq!(
            split_server("localhost:5432"),
            ("localhost".into(), Some(5432))
        );
        assert_eq!(split_server("::1"), ("::1".into(), None));
        assert_eq!(split_server(" plain "), ("plain".into(), None));
    }
}
