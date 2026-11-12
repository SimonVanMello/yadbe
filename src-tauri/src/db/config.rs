//! Connection definitions: what the user saves (without any secret) and what a driver needs
//! to connect.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::db::tls_identity::TlsIdentity;
use crate::tunnel::SshTunnel;

/// Connect timeout when the definition does not set one.
pub const DEFAULT_CONNECT_TIMEOUT_SECS: u32 = 15;
pub const MAX_CONNECT_TIMEOUT_SECS: u32 = 600;
/// Longest statement timeout a definition may set: a day.
pub const MAX_STATEMENT_TIMEOUT_SECS: u32 = 86_400;
/// Keep-alive interval when the definition does not set one (F-014).
pub const DEFAULT_KEEP_ALIVE_SECS: u32 = 60;
pub const MIN_KEEP_ALIVE_SECS: u32 = 5;
pub const MAX_KEEP_ALIVE_SECS: u32 = 3_600;
pub const MAX_NAME_CHARS: usize = 100;
const MAX_FIELD_CHARS: usize = 1024;
const MAX_OPTIONS: usize = 64;

/// How the transport is protected. `verifyFull` is the default for non-local hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TlsMode {
    /// Plain text.
    Disable,
    /// TLS when the server offers it, without certificate verification; plain text otherwise.
    Prefer,
    /// TLS mandatory. The certificate chain is verified only when a custom CA is set
    /// (libpq's `verify-ca`), and the host name never.
    Require,
    /// TLS mandatory, certificate chain and host name verified.
    VerifyFull,
}

impl TlsMode {
    pub fn id(self) -> &'static str {
        match self {
            TlsMode::Disable => "disable",
            TlsMode::Prefer => "prefer",
            TlsMode::Require => "require",
            TlsMode::VerifyFull => "verifyFull",
        }
    }

    pub fn from_id(id: &str) -> Option<TlsMode> {
        [
            TlsMode::Disable,
            TlsMode::Prefer,
            TlsMode::Require,
            TlsMode::VerifyFull,
        ]
        .into_iter()
        .find(|mode| mode.id() == id)
    }

    /// The mode a new connection to `host` starts with: certificate checks for any remote
    /// host, opportunistic TLS on the local machine (SPEC §9).
    pub fn default_for_host(host: &str) -> TlsMode {
        if is_local_host(host) {
            TlsMode::Prefer
        } else {
            TlsMode::VerifyFull
        }
    }
}

pub fn is_local_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host.is_empty()
        || host.eq_ignore_ascii_case("localhost")
        || host.starts_with('/')
        || host == "::1"
        || host.starts_with("127.")
}

/// How the user authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    /// User name and password (the password lives in the keychain or in the session).
    Password,
    /// No secret: trust / peer authentication, SQLite files.
    None,
}

impl AuthMethod {
    pub fn id(self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::None => "none",
        }
    }

    pub fn from_id(id: &str) -> Option<AuthMethod> {
        match id {
            "password" => Some(AuthMethod::Password),
            "none" => Some(AuthMethod::None),
            _ => None,
        }
    }
}

/// Environment tag shown as a color on the connection, its tabs and the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentKind {
    None,
    Dev,
    Staging,
    Prod,
    /// User-named environment with its own color.
    Custom,
}

impl EnvironmentKind {
    pub fn id(self) -> &'static str {
        match self {
            EnvironmentKind::None => "none",
            EnvironmentKind::Dev => "dev",
            EnvironmentKind::Staging => "staging",
            EnvironmentKind::Prod => "prod",
            EnvironmentKind::Custom => "custom",
        }
    }

    pub fn from_id(id: &str) -> Option<EnvironmentKind> {
        [
            EnvironmentKind::None,
            EnvironmentKind::Dev,
            EnvironmentKind::Staging,
            EnvironmentKind::Prod,
            EnvironmentKind::Custom,
        ]
        .into_iter()
        .find(|kind| kind.id() == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub kind: EnvironmentKind,
    /// Name of a `custom` environment (ignored for the others).
    pub label: Option<String>,
    /// `#rrggbb` color of a `custom` environment; the predefined ones use theme tokens.
    pub color: Option<String>,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            kind: EnvironmentKind::None,
            label: None,
            color: None,
        }
    }
}

/// Extra engine parameter passed through to the driver (`application_name`…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConnectionOption {
    pub key: String,
    pub value: String,
}

/// Everything the user defines for a connection, without any secret. Server engines use
/// `host` / `port` / `database` / `username`; file engines use `filePath` (see the
/// engine's capabilities). Empty strings mean "not set".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDefinition {
    pub name: String,
    pub engine: Engine,
    pub host: String,
    /// `null`: the engine's default port.
    pub port: Option<u16>,
    pub database: String,
    pub username: String,
    pub file_path: String,
    pub auth: AuthMethod,
    pub tls_mode: TlsMode,
    /// PEM file of the CA that signs the server certificate (instead of the OS trust store).
    pub ca_cert_path: Option<String>,
    /// PEM file of the TLS client certificate (chain) presented to the server (F-009). The
    /// key's passphrase, when it has one, is a secret kept in the keychain, not here.
    #[serde(default)]
    pub tls_client_cert_path: Option<String>,
    /// PEM file of the client certificate's private key; `null`: the key is in the
    /// certificate file.
    #[serde(default)]
    pub tls_client_key_path: Option<String>,
    /// `null`: 15 s.
    pub connect_timeout_secs: Option<u32>,
    /// A statement that runs longer than this is cancelled with the engine's own mechanism
    /// (F-014). `null`: no limit. Applies to the statements of query tabs.
    #[serde(default)]
    pub statement_timeout_secs: Option<u32>,
    /// Seconds between the pings that keep an idle connection open through firewalls and NAT
    /// (F-014). `null`: 60 s; `0`: none. Not used by file engines.
    #[serde(default)]
    pub keep_alive_secs: Option<u32>,
    pub options: Vec<ConnectionOption>,
    pub group_id: Option<String>,
    pub environment: Environment,
    pub favorite: bool,
    /// Enforced by the backend (F-008): the engine's read-only session where it has one,
    /// and a statement classifier that refuses anything not provably read-only.
    pub read_only: bool,
    /// The password goes to the OS keychain; otherwise it is asked at connect time and kept
    /// in memory for the session.
    pub remember_password: bool,
    /// Statements run on this connection go to the history (F-104). `true` unless the user
    /// opts out; absent in older payloads.
    #[serde(default = "default_true")]
    pub history_enabled: bool,
    /// SSH tunnel in front of a server connection (F-010); absent in older payloads.
    #[serde(default)]
    pub ssh: Option<SshTunnel>,
}

fn default_true() -> bool {
    true
}

impl ConnectionDefinition {
    /// Trims the text fields and checks lengths and engine-specific requirements.
    pub fn normalized(mut self) -> Result<Self, YadbeError> {
        let caps = self.engine.dialect().capabilities();
        self.name = self.name.trim().to_owned();
        self.host = self.host.trim().to_owned();
        self.database = self.database.trim().to_owned();
        self.username = self.username.trim().to_owned();
        self.file_path = self.file_path.trim().to_owned();
        self.ca_cert_path = self
            .ca_cert_path
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
        let path = |p: Option<String>| p.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
        self.tls_client_cert_path = path(self.tls_client_cert_path);
        self.tls_client_key_path = path(self.tls_client_key_path);
        // Only an engine that can present a certificate keeps one, and a key goes with a cert.
        if !caps.client_certificate || self.tls_client_cert_path.is_none() {
            self.tls_client_cert_path = None;
            self.tls_client_key_path = None;
        }
        self.group_id = self.group_id.filter(|g| !g.is_empty());

        if self.name.is_empty() {
            return Err(YadbeError::invalid_argument(
                "A connection needs a name.",
                "Une connexion doit avoir un nom.",
            ));
        }
        if self.name.chars().count() > MAX_NAME_CHARS {
            return Err(YadbeError::invalid_argument(
                format!("A connection name has at most {MAX_NAME_CHARS} characters."),
                format!("Un nom de connexion compte au plus {MAX_NAME_CHARS} caractères."),
            ));
        }
        for field in [&self.host, &self.database, &self.username, &self.file_path] {
            if field.chars().count() > MAX_FIELD_CHARS {
                return Err(YadbeError::invalid_argument(
                    format!("A connection field has at most {MAX_FIELD_CHARS} characters."),
                    format!("Un champ de connexion compte au plus {MAX_FIELD_CHARS} caractères."),
                ));
            }
        }
        if caps.uses_file {
            if self.file_path.is_empty() {
                return Err(YadbeError::invalid_argument(
                    "Choose the database file.",
                    "Choisissez le fichier de la base.",
                ));
            }
        } else if self.host.is_empty() {
            return Err(YadbeError::invalid_argument(
                "A server connection needs a host.",
                "Une connexion à un serveur doit avoir un hôte.",
            ));
        }
        if self.port == Some(0) {
            return Err(YadbeError::invalid_argument(
                "The port must be between 1 and 65535.",
                "Le port doit être compris entre 1 et 65535.",
            ));
        }
        if let Some(secs) = self.connect_timeout_secs
            && !(1..=MAX_CONNECT_TIMEOUT_SECS).contains(&secs)
        {
            return Err(YadbeError::invalid_argument(
                format!(
                    "The connect timeout must be between 1 and {MAX_CONNECT_TIMEOUT_SECS} seconds."
                ),
                format!(
                    "Le délai de connexion doit être compris entre 1 et {MAX_CONNECT_TIMEOUT_SECS} secondes."
                ),
            ));
        }
        // 0 means "no limit" for a statement: the same as none.
        self.statement_timeout_secs = self.statement_timeout_secs.filter(|&secs| secs != 0);
        if let Some(secs) = self.statement_timeout_secs
            && secs > MAX_STATEMENT_TIMEOUT_SECS
        {
            return Err(YadbeError::invalid_argument(
                format!(
                    "The statement timeout must be between 1 and {MAX_STATEMENT_TIMEOUT_SECS} seconds."
                ),
                format!(
                    "Le délai d'une instruction doit être compris entre 1 et {MAX_STATEMENT_TIMEOUT_SECS} secondes."
                ),
            ));
        }
        if let Some(secs) = self.keep_alive_secs
            && secs != 0
            && !(MIN_KEEP_ALIVE_SECS..=MAX_KEEP_ALIVE_SECS).contains(&secs)
        {
            return Err(YadbeError::invalid_argument(
                format!(
                    "The keep-alive interval must be between {MIN_KEEP_ALIVE_SECS} and {MAX_KEEP_ALIVE_SECS} seconds, or 0 for none."
                ),
                format!(
                    "L'intervalle de maintien de connexion doit être compris entre {MIN_KEEP_ALIVE_SECS} et {MAX_KEEP_ALIVE_SECS} secondes, ou 0 pour aucun."
                ),
            ));
        }
        if self.options.len() > MAX_OPTIONS {
            return Err(YadbeError::invalid_argument(
                format!("A connection has at most {MAX_OPTIONS} options."),
                format!("Une connexion a au plus {MAX_OPTIONS} options."),
            ));
        }
        self.options.retain(|o| !o.key.trim().is_empty());
        for option in &mut self.options {
            option.key = option.key.trim().to_owned();
        }
        self.environment = normalized_environment(self.environment)?;
        self.ssh = match self.ssh {
            Some(_) if caps.uses_file => None,
            ssh => ssh.map(SshTunnel::normalized).transpose()?,
        };
        if self.ssh.is_some() && self.host.starts_with('/') {
            return Err(YadbeError::invalid_argument(
                "A Unix socket cannot be reached through an SSH tunnel: give a host name.",
                "Un socket Unix ne peut pas être joint par un tunnel SSH : indiquez un nom d'hôte.",
            ));
        }
        Ok(self)
    }

    /// The parameters a driver needs, without the organization fields.
    pub fn target(&self) -> ConnectTarget {
        self.target_with_timeout(DEFAULT_CONNECT_TIMEOUT_SECS)
    }

    /// Like [`Self::target`], with the app-wide connect timeout (preferences) standing in for
    /// the one this definition does not set.
    pub fn target_with_timeout(&self, default_timeout_secs: u32) -> ConnectTarget {
        let caps = self.engine.dialect().capabilities();
        ConnectTarget {
            engine: self.engine,
            host: self.host.clone(),
            port: self.port.or(caps.default_port).unwrap_or(0),
            database: self.database.clone(),
            username: self.username.clone(),
            file_path: PathBuf::from(&self.file_path),
            tls_mode: self.tls_mode,
            ca_cert_path: self.ca_cert_path.as_ref().map(PathBuf::from),
            tls_identity: None,
            connect_timeout: Duration::from_secs(u64::from(
                self.connect_timeout_secs.unwrap_or(default_timeout_secs),
            )),
            statement_timeout: self
                .statement_timeout_secs
                .map(|secs| Duration::from_secs(u64::from(secs))),
            keep_alive: (!caps.uses_file)
                .then(|| self.keep_alive_secs.unwrap_or(DEFAULT_KEEP_ALIVE_SECS))
                .filter(|&secs| secs != 0)
                .map(|secs| Duration::from_secs(u64::from(secs))),
            options: self.options.clone(),
            read_only: self.read_only,
            dial: None,
        }
    }
}

fn normalized_environment(mut env: Environment) -> Result<Environment, YadbeError> {
    if env.kind != EnvironmentKind::Custom {
        env.label = None;
        env.color = None;
        return Ok(env);
    }
    env.label = env
        .label
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty());
    if env.label.as_ref().is_some_and(|l| l.chars().count() > 30) {
        return Err(YadbeError::invalid_argument(
            "An environment name has at most 30 characters.",
            "Un nom d'environnement compte au plus 30 caractères.",
        ));
    }
    if let Some(color) = &env.color
        && !is_hex_color(color)
    {
        return Err(YadbeError::invalid_argument(
            "The environment color must be written #rrggbb.",
            "La couleur d'environnement doit s'écrire #rrggbb.",
        ));
    }
    Ok(env)
}

fn is_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// What a driver needs to open a connection (the password travels separately, as a
/// `Secret`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectTarget {
    pub engine: Engine,
    pub host: String,
    /// The definition's port, or the engine default (0 for file engines).
    pub port: u16,
    pub database: String,
    pub username: String,
    pub file_path: PathBuf,
    pub tls_mode: TlsMode,
    pub ca_cert_path: Option<PathBuf>,
    /// The client certificate and key, read and decrypted by the connection manager from the
    /// definition's paths (F-009); only engines with the `client_certificate` capability use it.
    pub tls_identity: Option<Arc<TlsIdentity>>,
    pub connect_timeout: Duration,
    /// Statements of query tabs are cancelled after this long (F-014); `None`: never.
    pub statement_timeout: Option<Duration>,
    /// Pause between the pings of an idle connection; `None`: no keep-alive.
    pub keep_alive: Option<Duration>,
    pub options: Vec<ConnectionOption>,
    /// The session must refuse writes (F-008): drivers set the engine's read-only mode.
    pub read_only: bool,
    /// The local end of an SSH tunnel to `host:port`: drivers open their TCP connection
    /// there instead, and keep `host` for everything else (TLS server name and certificate
    /// checks, messages).
    pub dial: Option<SocketAddr>,
}

#[cfg(test)]
pub(crate) fn sample_definition(engine: Engine) -> ConnectionDefinition {
    ConnectionDefinition {
        name: "Sample".into(),
        engine,
        host: if engine == Engine::Sqlite {
            String::new()
        } else {
            "localhost".into()
        },
        port: None,
        database: "app".into(),
        username: "app".into(),
        file_path: if engine == Engine::Sqlite {
            "/tmp/app.db".into()
        } else {
            String::new()
        },
        auth: if engine == Engine::Sqlite {
            AuthMethod::None
        } else {
            AuthMethod::Password
        },
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
        remember_password: true,
        history_enabled: true,
        ssh: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;

    #[test]
    fn normalizes_and_validates() {
        let mut def = sample_definition(Engine::Postgres);
        def.name = "  Shop  ".into();
        def.ca_cert_path = Some("  ".into());
        def.environment = Environment {
            kind: EnvironmentKind::Prod,
            label: Some("x".into()),
            color: Some("red".into()),
        };
        let def = def.normalized().expect("valid");
        assert_eq!(def.name, "Shop");
        assert_eq!(def.ca_cert_path, None);
        assert_eq!(def.environment.label, None, "only custom keeps a label");

        let mut no_host = sample_definition(Engine::Postgres);
        no_host.host = " ".into();
        assert_eq!(
            no_host.normalized().map_err(|e| e.code),
            Err(ErrorCode::InvalidArgument)
        );

        let mut sqlite = sample_definition(Engine::Sqlite);
        sqlite.file_path = String::new();
        assert!(sqlite.normalized().is_err());

        let mut custom = sample_definition(Engine::Postgres);
        custom.environment = Environment {
            kind: EnvironmentKind::Custom,
            label: Some("QA".into()),
            color: Some("#12ab9F".into()),
        };
        assert!(custom.clone().normalized().is_ok());
        custom.environment.color = Some("blue".into());
        assert!(custom.normalized().is_err());
    }

    #[test]
    fn target_uses_engine_default_port() {
        let def = sample_definition(Engine::Postgres);
        assert_eq!(def.target().port, 5432);
        assert_eq!(def.target().connect_timeout, Duration::from_secs(15));
    }

    #[test]
    fn the_app_wide_timeout_stands_in_for_a_missing_one() {
        let mut def = sample_definition(Engine::Postgres);
        assert_eq!(
            def.target_with_timeout(40).connect_timeout,
            Duration::from_secs(40)
        );
        def.connect_timeout_secs = Some(5);
        assert_eq!(
            def.target_with_timeout(40).connect_timeout,
            Duration::from_secs(5)
        );
    }

    #[test]
    fn local_hosts_default_to_prefer() {
        assert_eq!(TlsMode::default_for_host("localhost"), TlsMode::Prefer);
        assert_eq!(TlsMode::default_for_host("127.0.0.1"), TlsMode::Prefer);
        assert_eq!(TlsMode::default_for_host("[::1]"), TlsMode::Prefer);
        assert_eq!(
            TlsMode::default_for_host("db.example.com"),
            TlsMode::VerifyFull
        );
    }

    #[test]
    fn statement_timeout_and_keep_alive_reach_the_target() {
        let mut def = sample_definition(Engine::Postgres);
        let target = def.target();
        assert_eq!(target.statement_timeout, None);
        assert_eq!(
            target.keep_alive,
            Some(Duration::from_secs(u64::from(DEFAULT_KEEP_ALIVE_SECS)))
        );
        def.statement_timeout_secs = Some(30);
        def.keep_alive_secs = Some(20);
        let target = def.target();
        assert_eq!(target.statement_timeout, Some(Duration::from_secs(30)));
        assert_eq!(target.keep_alive, Some(Duration::from_secs(20)));
        def.keep_alive_secs = Some(0);
        assert_eq!(def.target().keep_alive, None, "0 turns it off");
        // A file has no connection to keep open.
        assert_eq!(sample_definition(Engine::Sqlite).target().keep_alive, None);
    }

    #[test]
    fn timeouts_are_checked_when_a_definition_is_saved() {
        let valid = |change: &dyn Fn(&mut ConnectionDefinition)| {
            let mut def = sample_definition(Engine::Postgres);
            change(&mut def);
            def.normalized()
        };
        // 0 is "no limit" for a statement: stored as none.
        assert_eq!(
            valid(&|d| d.statement_timeout_secs = Some(0))
                .expect("ok")
                .statement_timeout_secs,
            None
        );
        assert!(valid(&|d| d.statement_timeout_secs = Some(MAX_STATEMENT_TIMEOUT_SECS)).is_ok());
        assert!(
            valid(&|d| d.statement_timeout_secs = Some(MAX_STATEMENT_TIMEOUT_SECS + 1)).is_err()
        );
        for secs in [0, MIN_KEEP_ALIVE_SECS, 60, MAX_KEEP_ALIVE_SECS] {
            assert!(valid(&|d| d.keep_alive_secs = Some(secs)).is_ok(), "{secs}");
        }
        for secs in [1, MIN_KEEP_ALIVE_SECS - 1, MAX_KEEP_ALIVE_SECS + 1] {
            assert!(
                valid(&|d| d.keep_alive_secs = Some(secs)).is_err(),
                "{secs}"
            );
        }
    }
    #[test]
    fn a_client_certificate_is_kept_only_where_the_engine_can_present_one() {
        let normalized = |engine: Engine, cert: Option<&str>, key: Option<&str>| {
            let mut def = sample_definition(engine);
            def.tls_client_cert_path = cert.map(str::to_owned);
            def.tls_client_key_path = key.map(str::to_owned);
            def.normalized().expect("valid")
        };
        let kept = normalized(
            Engine::Postgres,
            Some("  /c/client.crt "),
            Some(" /c/client.key"),
        );
        assert_eq!(kept.tls_client_cert_path.as_deref(), Some("/c/client.crt"));
        assert_eq!(kept.tls_client_key_path.as_deref(), Some("/c/client.key"));
        let mysql = normalized(Engine::Mysql, Some("/c/client.pem"), None);
        assert_eq!(mysql.tls_client_cert_path.as_deref(), Some("/c/client.pem"));
        assert_eq!(mysql.tls_client_key_path, None);
        // No certificate: a stray key path goes too; blank paths are no paths.
        let keyless = normalized(Engine::Postgres, Some("  "), Some("/c/client.key"));
        assert_eq!(
            (keyless.tls_client_cert_path, keyless.tls_client_key_path),
            (None, None)
        );
        // SQL Server and SQLite cannot present one: nothing is stored.
        for engine in [Engine::Mssql, Engine::Sqlite] {
            let def = normalized(engine, Some("/c/client.crt"), Some("/c/client.key"));
            assert_eq!(
                (def.tls_client_cert_path, def.tls_client_key_path),
                (None, None),
                "{engine:?}"
            );
        }
    }

    #[test]
    fn older_payloads_have_no_client_certificate() {
        let mut json = serde_json::to_value(sample_definition(Engine::Postgres)).expect("json");
        let object = json.as_object_mut().expect("object");
        object.remove("tlsClientCertPath");
        object.remove("tlsClientKeyPath");
        let def: ConnectionDefinition = serde_json::from_value(json).expect("old payload");
        assert_eq!(def.tls_client_cert_path, None);
        assert_eq!(def.tls_client_key_path, None);
    }
}
