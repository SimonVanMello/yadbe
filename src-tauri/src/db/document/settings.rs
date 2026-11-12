//! The connection fields of the document family (MongoDB) and its connection strings
//! (`mongodb://`, `mongodb+srv://`). A pasted URI is split: the password goes apart as a
//! `Secret` (keychain, rule 4), the rest fills the form.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::config::{ConnectionOption, TlsMode};
use crate::db::errors::YadbeError;
use crate::secrets::Secret;

/// How a MongoDB connection authenticates, beyond user and password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MongoAuthMechanism {
    /// What the server offers (SCRAM-SHA-256, else SCRAM-SHA-1) when a user is given.
    #[default]
    Default,
    ScramSha1,
    ScramSha256,
    /// The TLS client certificate is the identity (`MONGODB-X509`): no password.
    X509,
}

impl MongoAuthMechanism {
    fn from_uri(value: &str) -> Option<Self> {
        match value.to_ascii_uppercase().as_str() {
            "SCRAM-SHA-1" => Some(Self::ScramSha1),
            "SCRAM-SHA-256" => Some(Self::ScramSha256),
            "MONGODB-X509" => Some(Self::X509),
            _ => None,
        }
    }
}

/// The fields only MongoDB connections have. `host` of the definition holds the seed list
/// (`a:27017,b,c:27019`) or the SRV name; `port` is the port of hosts written without one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MongoSettings {
    /// `mongodb+srv://`: the hosts (and default options) come from DNS records of `host`.
    #[serde(default)]
    pub srv: bool,
    /// Name of the replica set to join; `null`: discovered.
    #[serde(default)]
    pub replica_set: Option<String>,
    /// Database the user is defined in; `null`: the connection's database, else `admin`.
    #[serde(default)]
    pub auth_source: Option<String>,
    #[serde(default)]
    pub auth_mechanism: MongoAuthMechanism,
    /// Talk to the one host given, without discovering the other members (required through
    /// an SSH tunnel).
    #[serde(default)]
    pub direct_connection: bool,
}

/// One host of a seed list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedHost {
    pub host: String,
    pub port: Option<u16>,
}

/// `a:27017, b ,[::1]:27018` → hosts; `None` when one of them is malformed.
pub fn seed_hosts(list: &str) -> Option<Vec<SeedHost>> {
    list.split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(|item| {
            let (host, port) = if let Some(rest) = item.strip_prefix('[') {
                let (host, after) = rest.split_once(']')?;
                (host, after.strip_prefix(':'))
            } else if item.matches(':').count() == 1 {
                let (host, port) = item.split_once(':')?;
                (host, Some(port))
            } else {
                (item, None)
            };
            let port = match port {
                Some(p) => Some(p.parse::<u16>().ok().filter(|p| *p > 0)?),
                None => None,
            };
            (!host.is_empty()).then(|| SeedHost {
                host: host.to_owned(),
                port,
            })
        })
        .collect()
}

impl MongoSettings {
    pub fn normalized(mut self) -> Self {
        let trim = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        self.replica_set = trim(self.replica_set);
        self.auth_source = trim(self.auth_source);
        self
    }

    /// Checks the fields against the rest of the definition.
    pub fn check(&self, host: &str, port: Option<u16>, tunnel: bool) -> Result<(), YadbeError> {
        let hosts = seed_hosts(host).ok_or_else(|| {
            YadbeError::invalid_argument(
                "The hosts must be written host[:port], separated by commas.",
                "Les hôtes s'écrivent hôte[:port], séparés par des virgules.",
            )
        })?;
        if self.srv
            && (hosts.len() != 1 || hosts.iter().any(|h| h.port.is_some()) || port.is_some())
        {
            return Err(YadbeError::invalid_argument(
                "An SRV connection names one host, without a port: DNS gives the servers.",
                "Une connexion SRV nomme un seul hôte, sans port : le DNS donne les serveurs.",
            ));
        }
        if self.direct_connection && hosts.len() > 1 {
            return Err(YadbeError::invalid_argument(
                "A direct connection goes to one host only.",
                "Une connexion directe ne vise qu'un seul hôte.",
            ));
        }
        if tunnel && (self.srv || hosts.len() > 1) {
            return Err(YadbeError::invalid_argument(
                "Through an SSH tunnel, yadbe connects directly to one host: give a single host, not an SRV name or a list.",
                "Par un tunnel SSH, yadbe se connecte directement à un seul hôte : indiquez un hôte, pas un nom SRV ni une liste.",
            ));
        }
        Ok(())
    }
}

/// What a `mongodb://` or `mongodb+srv://` string holds, for the form.
#[derive(Debug)]
pub struct ParsedMongoUri {
    pub hosts: String,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<Secret>,
    pub settings: MongoSettings,
    pub tls_mode: Option<TlsMode>,
    pub ca_cert_path: Option<String>,
    pub options: Vec<ConnectionOption>,
    pub ignored_keys: Vec<String>,
}

fn invalid(detail: &str) -> YadbeError {
    YadbeError::new(
        crate::db::errors::ErrorCode::InvalidConnectionString,
        "This MongoDB connection string could not be understood.",
        "Cette chaîne de connexion MongoDB n'a pas pu être comprise.",
    )
    .with_detail(detail)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = text
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encodes a URI component (everything but unreserved characters).
pub fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn is_true(value: &str) -> bool {
    value.eq_ignore_ascii_case("true") || value == "1"
}

/// Parses a MongoDB connection string. The password, if any, is returned apart.
pub fn parse_uri(text: &str) -> Result<ParsedMongoUri, YadbeError> {
    let text = text.trim();
    let lower = text.to_ascii_lowercase();
    let (srv, rest) = if lower.starts_with("mongodb+srv://") {
        (true, &text["mongodb+srv://".len()..])
    } else if lower.starts_with("mongodb://") {
        (false, &text["mongodb://".len()..])
    } else {
        return Err(invalid("expected mongodb:// or mongodb+srv://"));
    };
    let (authority, tail) = match rest.find(['/', '?']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let (userinfo, hosts) = match authority.rfind('@') {
        Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
        None => (None, authority),
    };
    if hosts.is_empty() || seed_hosts(&percent_decode(hosts)).is_none() {
        return Err(invalid("no valid host"));
    }
    let (username, password) = match userinfo {
        Some(info) => {
            let (user, pass) = info.split_once(':').unwrap_or((info, ""));
            (
                Some(percent_decode(user)).filter(|u| !u.is_empty()),
                Some(Secret::new(percent_decode(pass))).filter(|p| !p.is_empty()),
            )
        }
        None => (None, None),
    };
    let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
    let database = Some(percent_decode(path.trim_start_matches('/'))).filter(|d| !d.is_empty());
    let mut parsed = ParsedMongoUri {
        hosts: percent_decode(hosts),
        database,
        username,
        password,
        settings: MongoSettings {
            srv,
            ..MongoSettings::default()
        },
        tls_mode: srv.then_some(TlsMode::VerifyFull),
        ca_cert_path: None,
        options: Vec::new(),
        ignored_keys: Vec::new(),
    };
    let mut tls_on: Option<bool> = None;
    let mut insecure = false;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(key);
        let value = percent_decode(value);
        match key.to_ascii_lowercase().as_str() {
            "replicaset" => parsed.settings.replica_set = Some(value).filter(|v| !v.is_empty()),
            "authsource" => parsed.settings.auth_source = Some(value).filter(|v| !v.is_empty()),
            "authmechanism" => match MongoAuthMechanism::from_uri(&value) {
                Some(mechanism) => parsed.settings.auth_mechanism = mechanism,
                None => parsed.ignored_keys.push(key),
            },
            "directconnection" => parsed.settings.direct_connection = is_true(&value),
            "tls" | "ssl" => tls_on = Some(is_true(&value)),
            "tlscafile" => parsed.ca_cert_path = Some(value).filter(|v| !v.is_empty()),
            "tlsallowinvalidcertificates" | "tlsinsecure" => insecure = is_true(&value),
            // Secrets and files the form keeps elsewhere, or that yadbe decides itself.
            "password"
            | "tlscertificatekeyfilepassword"
            | "tlscertificatekeyfile"
            | "tlsallowinvalidhostnames" => parsed.ignored_keys.push(key),
            _ => parsed.options.push(ConnectionOption { key, value }),
        }
    }
    parsed.tls_mode = match (tls_on, insecure) {
        (Some(false), _) => Some(TlsMode::Disable),
        (_, true) => Some(TlsMode::Require),
        (Some(true), false) => Some(TlsMode::VerifyFull),
        (None, false) => parsed.tls_mode,
    };
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replica_set_uris_and_keeps_the_password_apart() {
        let parsed = parse_uri(
            "mongodb://app:p%40ss@db1:27017,db2:27018/shop?replicaSet=rs0&authSource=admin&readPreference=secondary&tls=true",
        )
        .expect("parses");
        assert_eq!(parsed.hosts, "db1:27017,db2:27018");
        assert_eq!(parsed.database.as_deref(), Some("shop"));
        assert_eq!(parsed.username.as_deref(), Some("app"));
        assert_eq!(parsed.password.as_ref().map(Secret::expose), Some("p@ss"));
        assert_eq!(parsed.settings.replica_set.as_deref(), Some("rs0"));
        assert_eq!(parsed.settings.auth_source.as_deref(), Some("admin"));
        assert_eq!(parsed.tls_mode, Some(TlsMode::VerifyFull));
        assert_eq!(
            parsed.options,
            vec![ConnectionOption {
                key: "readPreference".into(),
                value: "secondary".into()
            }]
        );
    }

    #[test]
    fn srv_and_x509() {
        let parsed = parse_uri(
            "mongodb+srv://cluster0.example.net/?authMechanism=MONGODB-X509&tlsCertificateKeyFile=/c.pem",
        )
        .expect("parses");
        assert!(parsed.settings.srv);
        assert_eq!(parsed.hosts, "cluster0.example.net");
        assert_eq!(parsed.settings.auth_mechanism, MongoAuthMechanism::X509);
        assert_eq!(
            parsed.tls_mode,
            Some(TlsMode::VerifyFull),
            "SRV turns TLS on"
        );
        assert_eq!(
            parsed.ignored_keys,
            vec!["tlsCertificateKeyFile".to_owned()]
        );
        assert!(parsed.password.is_none());
        assert!(parse_uri("mongodb://").is_err());
        assert!(parse_uri("postgres://x").is_err());
    }

    #[test]
    fn seed_lists_and_checks() {
        assert_eq!(
            seed_hosts("a:1, b ,[::1]:3").expect("valid"),
            vec![
                SeedHost {
                    host: "a".into(),
                    port: Some(1)
                },
                SeedHost {
                    host: "b".into(),
                    port: None
                },
                SeedHost {
                    host: "::1".into(),
                    port: Some(3)
                },
            ]
        );
        assert!(seed_hosts("a:x").is_none());
        let srv = MongoSettings {
            srv: true,
            ..MongoSettings::default()
        };
        assert!(srv.check("c.example.net", None, false).is_ok());
        assert!(srv.check("a,b", None, false).is_err());
        assert!(
            srv.check("c.example.net", None, true).is_err(),
            "no SRV through SSH"
        );
        let plain = MongoSettings::default();
        assert!(plain.check("a,b", None, true).is_err());
        assert!(plain.check("a", Some(27017), true).is_ok());
        let direct = MongoSettings {
            direct_connection: true,
            ..MongoSettings::default()
        };
        assert!(direct.check("a,b", None, false).is_err());
    }
}
