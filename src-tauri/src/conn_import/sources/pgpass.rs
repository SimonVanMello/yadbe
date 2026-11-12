//! PostgreSQL's password file: `hostname:port:database:username:password`, one entry per
//! line, `\:` and `\\` escaping. The only source whose passwords are offered for the
//! keychain.

use std::collections::HashSet;

use super::{Parsed, ParsedConnection, blank, found};
use crate::conn_import::model::{SkipReason, SkippedEntry};
use crate::db::config::{AuthMethod, TlsMode};
use crate::db::dialect::Engine;
use crate::secrets::Secret;

/// The five fields of a line, unescaped; `None` for a comment, a blank line or a malformed
/// one.
fn fields(line: &str) -> Option<[String; 5]> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() || line.trim_start().starts_with('#') {
        return None;
    }
    let mut parts: Vec<String> = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    parts.last_mut()?.push(next);
                }
            }
            ':' if parts.len() < 5 => parts.push(String::new()),
            other => parts.last_mut()?.push(other),
        }
    }
    <[String; 5]>::try_from(parts).ok()
}

pub fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut seen: HashSet<(String, String, String, String)> = HashSet::new();
    for (index, line) in text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .lines()
        .enumerate()
    {
        let Some([host, port, database, user, password]) = fields(line) else {
            continue;
        };
        let label = format!("{user}@{host}:{port}/{database}");
        if host == "*" || user == "*" || host.is_empty() || user.is_empty() {
            parsed.skipped.push(SkippedEntry {
                name: label,
                reason: SkipReason::Wildcard,
                detail: None,
            });
            continue;
        }
        // libpq takes the first line that matches.
        if !seen.insert((host.clone(), port.clone(), database.clone(), user.clone())) {
            continue;
        }
        let port_number = port.parse::<u16>().ok().filter(|p| *p != 0);
        let database = if database == "*" {
            String::new()
        } else {
            database
        };
        let mut name = format!("{user}@{host}");
        if let Some(p) = port_number.filter(|p| *p != 5432) {
            name.push_str(&format!(":{p}"));
        }
        if !database.is_empty() {
            name.push_str(&format!("/{database}"));
        }
        let mut definition = blank(Engine::Postgres, &name);
        definition.host = host.clone();
        definition.port = port_number;
        definition.database = database;
        definition.username = user;
        definition.auth = AuthMethod::Password;
        definition.tls_mode = TlsMode::default_for_host(&host);
        let has_password = !password.is_empty();
        parsed.connections.push(ParsedConnection {
            found: found(
                format!("line {}", index + 1),
                definition,
                Vec::new(),
                Vec::new(),
                has_password,
            ),
            password: has_password.then(|| Secret::new(password)),
        });
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_entries_with_escapes_and_skips_patterns() {
        let parsed = parse(
            "# comment\n\
             db.example.com:5433:shop:app:p\\:ss\\\\word\n\
             localhost:*:*:postgres:\n\
             *:5432:*:bob:x\n\
             db.example.com:5433:shop:app:second-line-is-ignored\n\
             \n\
             too:few:fields\n\
             pg.local:5432:app:me:pw",
        );
        assert_eq!(parsed.connections.len(), 3);
        let first = &parsed.connections[0];
        assert_eq!(first.found.definition.name, "app@db.example.com:5433/shop");
        assert_eq!(first.found.definition.port, Some(5433));
        assert_eq!(
            first
                .password
                .as_ref()
                .map(|p| p.expose().to_owned())
                .as_deref(),
            Some("p:ss\\word")
        );
        assert!(first.found.has_password);
        let local = &parsed.connections[1];
        assert_eq!(local.found.definition.host, "localhost");
        assert_eq!(local.found.definition.port, None);
        assert_eq!(local.found.definition.database, "");
        assert!(local.password.is_none() && !local.found.has_password);
        assert_eq!(
            parsed.connections[2].found.definition.name,
            "me@pg.local/app"
        );
        assert_eq!(parsed.skipped.len(), 1);
        assert_eq!(parsed.skipped[0].reason, SkipReason::Wildcard);
        assert!(!format!("{:?}", parsed.connections[0].found).contains("p:ss"));
    }
}
