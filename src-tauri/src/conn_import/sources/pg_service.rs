//! PostgreSQL's connection service file (`pg_service.conf`): `[name]` sections of
//! `key=value` lines. A `password` in a service is not imported.

use std::collections::HashMap;

use super::{Parsed, ParsedConnection, blank, found};
use crate::conn_import::model::{ConnectionNote, ConnectionNoteKind, SkipReason, SkippedEntry};
use crate::db::config::{AuthMethod, TlsMode};
use crate::db::engine::Engine;

fn sections(text: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut out: Vec<(String, HashMap<String, String>)> = Vec::new();
    for line in text.strip_prefix('\u{feff}').unwrap_or(text).lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            out.push((name.trim().to_owned(), HashMap::new()));
        } else if let Some((key, value)) = line.split_once('=')
            && let Some((_, map)) = out.last_mut()
        {
            map.insert(key.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    out
}

fn tls_of(mode: &str, host: &str) -> TlsMode {
    match mode {
        "disable" => TlsMode::Disable,
        "allow" | "prefer" => TlsMode::Prefer,
        "require" | "verify-ca" => TlsMode::Require,
        "verify-full" => TlsMode::VerifyFull,
        _ => TlsMode::default_for_host(host),
    }
}

pub fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    for (name, keys) in sections(text) {
        let host = keys
            .get("host")
            .or_else(|| keys.get("hostaddr"))
            .cloned()
            .unwrap_or_default();
        // libpq connects through the local socket without a host: yadbe needs a name.
        let host = if host.is_empty() {
            "localhost".to_owned()
        } else {
            host
        };
        if name.is_empty() {
            parsed.skipped.push(SkippedEntry {
                name,
                reason: SkipReason::Incomplete,
                detail: None,
            });
            continue;
        }
        let mut definition = blank(Engine::Postgres, &name);
        definition.host = host.clone();
        definition.port = keys
            .get("port")
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p != 0);
        definition.database = keys.get("dbname").cloned().unwrap_or_default();
        definition.username = keys.get("user").cloned().unwrap_or_default();
        definition.auth = AuthMethod::Password;
        definition.tls_mode = tls_of(keys.get("sslmode").map_or("", String::as_str), &host);
        definition.ca_cert_path = keys.get("sslrootcert").filter(|p| !p.is_empty()).cloned();
        // libpq's client certificate and key (the key's passphrase is never in the file).
        definition.tls_client_cert_path = keys.get("sslcert").filter(|p| !p.is_empty()).cloned();
        definition.tls_client_key_path = definition
            .tls_client_cert_path
            .as_ref()
            .and_then(|_| keys.get("sslkey").filter(|p| !p.is_empty()).cloned());
        definition.connect_timeout_secs = keys
            .get("connect_timeout")
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|s| (1..=600).contains(s));
        let mut notes = Vec::new();
        if keys.contains_key("password") {
            notes.push(ConnectionNote {
                kind: ConnectionNoteKind::PasswordNotImported,
                detail: None,
            });
        }
        parsed.connections.push(ParsedConnection {
            found: found(format!("[{name}]"), definition, Vec::new(), notes, false),
            password: None,
        });
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_services() {
        let parsed = parse(
            "# services\n[shop]\nhost=db.example.com\nport=5433\ndbname=shop\nuser=app\n\
             sslmode=verify-ca\nsslrootcert=/etc/ca.pem\nsslcert=/etc/client.crt\nsslkey=/etc/client.key\nconnect_timeout=10\npassword=hunter2\n\n\
             [local]\ndbname=dev\n",
        );
        assert_eq!(parsed.connections.len(), 2);
        let shop = &parsed.connections[0];
        assert_eq!(shop.found.key, "[shop]");
        assert_eq!(shop.found.definition.host, "db.example.com");
        assert_eq!(shop.found.definition.port, Some(5433));
        assert_eq!(shop.found.definition.database, "shop");
        assert_eq!(shop.found.definition.username, "app");
        assert_eq!(shop.found.definition.tls_mode, TlsMode::Require);
        assert_eq!(
            shop.found.definition.ca_cert_path.as_deref(),
            Some("/etc/ca.pem")
        );
        assert_eq!(
            shop.found.definition.tls_client_cert_path.as_deref(),
            Some("/etc/client.crt")
        );
        assert_eq!(
            shop.found.definition.tls_client_key_path.as_deref(),
            Some("/etc/client.key")
        );
        assert_eq!(shop.found.definition.connect_timeout_secs, Some(10));
        assert_eq!(
            shop.found.notes[0].kind,
            ConnectionNoteKind::PasswordNotImported
        );
        assert!(shop.password.is_none());
        assert!(!format!("{:?}", shop.found).contains("hunter2"));
        let local = &parsed.connections[1];
        assert_eq!(local.found.definition.host, "localhost");
        assert_eq!(local.found.definition.tls_mode, TlsMode::Prefer);
    }
}
