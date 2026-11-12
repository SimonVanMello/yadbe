//! SQL Server Management Studio: the registered servers file (`RegSrvr.xml`). Its
//! connection strings hold the server, the database and the authentication mode; a password
//! in them is encrypted by Windows and is not read. The most-recently-used server list of
//! SSMS (`SqlStudio.bin`, a binary .NET serialization) is not practical to read and is not
//! imported.

use super::xml::{self, Node};
use super::{Parsed, ParsedConnection, blank, found, parse_bool, split_server};
use crate::conn_import::model::{ConnectionNote, ConnectionNoteKind, SkipReason, SkippedEntry};
use crate::db::config::{AuthMethod, TlsMode};
use crate::db::engine::Engine;
use crate::db::errors::YadbeError;

/// Only the database engine servers: other groups hold Analysis or Reporting Services.
const ENGINE_GROUP: &str = "DatabaseEngineServerGroup";
const STORE_GROUP: &str = "RegisteredServersStore";

/// `key=value` pairs of an ADO.NET connection string, keys in lower case.
fn pairs(connection_string: &str) -> Vec<(String, String)> {
    connection_string
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((
                key.trim().to_ascii_lowercase().replace([' ', '_'], ""),
                value.trim().to_owned(),
            ))
        })
        .collect()
}

fn walk(
    group: &Node,
    path: &mut Vec<String>,
    in_engine_group: bool,
    parsed: &mut Parsed,
    counter: &mut usize,
) {
    for server in group
        .child("Servers")
        .into_iter()
        .flat_map(|s| s.children_named("RegisteredServer"))
    {
        if !in_engine_group {
            continue;
        }
        *counter += 1;
        let name = server.attribute("name").unwrap_or_default().trim();
        let connection = server
            .child("ConnectionStringWithEncryptedPassword")
            .or_else(|| server.child("ConnectionString"))
            .map(|n| n.text.as_str())
            .unwrap_or_default();
        let keys = pairs(connection);
        let get = |names: &[&str]| {
            keys.iter()
                .find(|(key, _)| names.contains(&key.as_str()))
                .map(|(_, value)| value.as_str())
        };
        let server_name = server
            .child("ServerName")
            .map(|n| n.text.trim().to_owned())
            .filter(|s| !s.is_empty())
            .or_else(|| get(&["datasource", "server", "address", "addr"]).map(str::to_owned));
        let Some(server_name) = server_name else {
            parsed.skipped.push(SkippedEntry {
                name: name.to_owned(),
                reason: SkipReason::Incomplete,
                detail: None,
            });
            continue;
        };
        let (host, port) = split_server(&server_name);
        let label = if name.is_empty() {
            host.clone()
        } else {
            name.to_owned()
        };
        let mut definition = blank(Engine::Mssql, &label);
        definition.host = host.clone();
        definition.port = port;
        definition.database = get(&["initialcatalog", "database"])
            .unwrap_or_default()
            .to_owned();
        let integrated = get(&["integratedsecurity", "trustedconnection"])
            .and_then(parse_bool)
            .unwrap_or(false);
        let mut notes = Vec::new();
        if integrated {
            definition.auth = AuthMethod::None;
            notes.push(ConnectionNote {
                kind: ConnectionNoteKind::IntegratedAuth,
                detail: None,
            });
        } else {
            definition.username = get(&["userid", "uid", "user"])
                .unwrap_or_default()
                .to_owned();
        }
        let trust = get(&["trustservercertificate"])
            .and_then(parse_bool)
            .unwrap_or(false);
        definition.tls_mode = match get(&["encrypt"]).and_then(parse_bool) {
            Some(true) if trust => TlsMode::Require,
            Some(true) => TlsMode::VerifyFull,
            Some(false) => TlsMode::Prefer,
            None => TlsMode::default_for_host(&host),
        };
        parsed.connections.push(ParsedConnection {
            found: found(
                format!("#{counter}"),
                definition,
                path.clone(),
                notes,
                false,
            ),
            password: None,
        });
    }
    let nested = group
        .child("ServerGroups")
        .into_iter()
        .flat_map(|g| g.children_named("ServerGroup"));
    for child in group.children_named("ServerGroup").chain(nested) {
        let name = child.attribute("name").unwrap_or_default().to_owned();
        let engine = in_engine_group || name == ENGINE_GROUP;
        // The store's own groups are the top level, not folders.
        let folder = name != ENGINE_GROUP && name != STORE_GROUP;
        if folder {
            path.push(name);
        }
        walk(child, path, engine, parsed, counter);
        if folder {
            path.pop();
        }
    }
}

pub fn parse(text: &str) -> Result<Parsed, YadbeError> {
    let root = xml::parse(text).ok_or_else(|| {
        YadbeError::connection_file_invalid(
            "This file is not a readable SSMS registered servers file.",
            "Ce fichier n'est pas un fichier de serveurs inscrits SSMS lisible.",
        )
    })?;
    let mut parsed = Parsed::default();
    walk(&root, &mut Vec::new(), false, &mut parsed, &mut 0);
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REG_SRVR: &str = r#"<?xml version="1.0"?>
<RegisteredServers:RegisteredServersStore xmlns:RegisteredServers="http://schemas.microsoft.com/sqlserver/RegisteredServers/2007/08">
 <RegisteredServers:ServerGroup name="RegisteredServersStore">
  <RegisteredServers:ServerGroups>
   <RegisteredServers:ServerGroup name="DatabaseEngineServerGroup">
    <RegisteredServers:Servers>
     <RegisteredServers:RegisteredServer name="Dev box">
      <RegisteredServers:ServerName>DEVBOX\SQL2022</RegisteredServers:ServerName>
      <RegisteredServers:ConnectionStringWithEncryptedPassword>data source=DEVBOX\SQL2022;integrated security=True;pooling=False</RegisteredServers:ConnectionStringWithEncryptedPassword>
     </RegisteredServers:RegisteredServer>
    </RegisteredServers:Servers>
    <RegisteredServers:ServerGroups>
     <RegisteredServers:ServerGroup name="Production">
      <RegisteredServers:Servers>
       <RegisteredServers:RegisteredServer name="Billing">
        <RegisteredServers:ServerName>sql-prod.example.com,1444</RegisteredServers:ServerName>
        <RegisteredServers:ConnectionStringWithEncryptedPassword>data source=sql-prod.example.com,1444;initial catalog=billing;user id=svc_billing;password=000102;encrypt=True;trustservercertificate=True</RegisteredServers:ConnectionStringWithEncryptedPassword>
       </RegisteredServers:RegisteredServer>
      </RegisteredServers:Servers>
     </RegisteredServers:ServerGroup>
    </RegisteredServers:ServerGroups>
   </RegisteredServers:ServerGroup>
   <RegisteredServers:ServerGroup name="AnalysisServicesServerGroup">
    <RegisteredServers:Servers>
     <RegisteredServers:RegisteredServer name="Cube"><RegisteredServers:ServerName>olap</RegisteredServers:ServerName></RegisteredServers:RegisteredServer>
    </RegisteredServers:Servers>
   </RegisteredServers:ServerGroup>
  </RegisteredServers:ServerGroups>
 </RegisteredServers:ServerGroup>
</RegisteredServers:RegisteredServersStore>"#;

    #[test]
    fn reads_registered_servers_with_their_groups() {
        let parsed = parse(REG_SRVR).expect("parses");
        assert_eq!(parsed.connections.len(), 2, "Analysis Services is left out");
        let dev = &parsed.connections[0].found;
        assert_eq!(dev.definition.name, "Dev box");
        assert_eq!(dev.definition.host, "DEVBOX\\SQL2022");
        assert_eq!(dev.definition.auth, AuthMethod::None);
        assert_eq!(dev.notes[0].kind, ConnectionNoteKind::IntegratedAuth);
        assert!(dev.group_path.is_empty());
        let billing = &parsed.connections[1].found;
        assert_eq!(billing.definition.host, "sql-prod.example.com");
        assert_eq!(billing.definition.port, Some(1444));
        assert_eq!(billing.definition.database, "billing");
        assert_eq!(billing.definition.username, "svc_billing");
        assert_eq!(billing.definition.tls_mode, TlsMode::Require);
        assert_eq!(billing.group_path, ["Production"]);
        assert!(!format!("{billing:?}").contains("000102"));
        assert!(parsed.connections.iter().all(|c| c.password.is_none()));
    }

    #[test]
    fn rejects_other_files() {
        assert!(parse("{\"a\": 1}").is_err());
    }
}
