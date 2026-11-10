//! Typed errors sent to the frontend, and the catalog of known failures (network, TLS,
//! authentication, keychain…) with their FR / EN message and suggested action.
//!
//! Drivers classify their native errors into these constructors; nothing else builds a
//! user-facing message. Messages never contain a secret: details are redacted with
//! [`redact`] before they are attached.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Stable machine-readable error code; the frontend switches on it, never on messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The command exists in the contract but has no backend implementation yet.
    NotImplemented,
    /// A frontend-provided argument was rejected by validation.
    InvalidArgument,
    /// Unexpected internal failure (bug, I/O error…).
    Internal,
    /// Reading or writing the local app database failed.
    Storage,
    /// No saved connection has this id.
    ConnectionNotFound,
    /// No connection group has this id.
    GroupNotFound,
    /// The engine is known but its driver is not available yet.
    EngineNotSupported,
    /// The connection is not open (never opened, closed, or reconnecting).
    NotConnected,
    /// The connection needs a password and none was given or stored.
    PasswordRequired,
    /// A password extracted from a connection string expired or was already used.
    PendingSecretExpired,
    /// The host name could not be resolved (DNS).
    HostNotFound,
    /// The host answered but nothing listens on that port.
    ConnectionRefused,
    /// The server did not answer in time.
    ConnectionTimeout,
    /// The TLS handshake failed (certificate, protocol…).
    TlsFailed,
    /// TLS is required but the server does not offer it.
    TlsNotSupported,
    /// The server rejected the user name or the password.
    AuthFailed,
    /// The database does not exist on the server.
    UnknownDatabase,
    /// The SQLite file does not exist.
    FileNotFound,
    /// The file exists but is not a database of the expected engine.
    NotADatabase,
    /// The connection to the server dropped.
    ConnectionLost,
    /// No OS keychain is available: secrets are kept for the session only.
    KeychainUnavailable,
    /// The keychain refused an operation (locked, access denied…).
    KeychainFailed,
    /// The connection string could not be understood.
    InvalidConnectionString,
    /// The server rejected a statement.
    QueryFailed,
    /// The operation was cancelled by the user.
    Cancelled,
}

/// A message in every supported UI language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LocalizedText {
    pub en: String,
    pub fr: String,
}

impl LocalizedText {
    pub fn new(en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self {
            en: en.into(),
            fr: fr.into(),
        }
    }
}

/// What the UI can offer to do about an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorAction {
    /// Try the same thing again (transient failure).
    Retry,
    /// Open the connection form: host, port, database or user is probably wrong.
    EditConnection,
    /// Ask the user for the password.
    EnterPassword,
    /// Open the connection form on the TLS settings.
    ChangeTlsMode,
    /// Let the user pick another file.
    ChooseFile,
    /// Open the connection again.
    Reconnect,
}

/// Error returned by every fallible command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct YadbeError {
    pub code: ErrorCode,
    pub message: LocalizedText,
    pub action: Option<ErrorAction>,
    /// Raw technical detail (driver message, I/O error), redacted, shown in a collapsible area.
    pub detail: Option<String>,
}

impl std::fmt::Display for YadbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message.en)
    }
}

impl std::error::Error for YadbeError {}

impl YadbeError {
    pub fn new(code: ErrorCode, en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self {
            code,
            message: LocalizedText::new(en, fr),
            action: None,
            detail: None,
        }
    }

    pub fn with_action(mut self, action: ErrorAction) -> Self {
        self.action = Some(action);
        self
    }

    /// Attaches a technical detail, redacted (connection strings, `password=` pairs).
    pub fn with_detail(mut self, detail: impl AsRef<str>) -> Self {
        let detail = redact(detail.as_ref());
        let trimmed = detail.trim();
        if !trimmed.is_empty() {
            self.detail = Some(trimmed.to_owned());
        }
        self
    }

    pub fn not_implemented() -> Self {
        Self::new(
            ErrorCode::NotImplemented,
            "Not implemented yet.",
            "Pas encore implémenté.",
        )
    }

    pub fn invalid_argument(en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, en, fr)
    }

    pub fn internal(detail: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::Internal,
            "Unexpected internal error.",
            "Erreur interne inattendue.",
        )
        .with_detail(detail)
    }

    pub fn storage(detail: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::Storage,
            "The local yadbe database could not be read or written.",
            "La base locale de yadbe n'a pas pu être lue ou écrite.",
        )
        .with_action(ErrorAction::Retry)
        .with_detail(detail)
    }

    pub fn connection_not_found(id: &str) -> Self {
        Self::new(
            ErrorCode::ConnectionNotFound,
            "This connection no longer exists.",
            "Cette connexion n'existe plus.",
        )
        .with_detail(format!("connection id {id}"))
    }

    pub fn group_not_found(id: &str) -> Self {
        Self::new(
            ErrorCode::GroupNotFound,
            "This group no longer exists.",
            "Ce groupe n'existe plus.",
        )
        .with_detail(format!("group id {id}"))
    }

    pub fn engine_not_supported(label: &str) -> Self {
        Self::new(
            ErrorCode::EngineNotSupported,
            format!("{label} is not supported yet by this version of yadbe."),
            format!("{label} n'est pas encore pris en charge par cette version de yadbe."),
        )
    }

    pub fn not_connected() -> Self {
        Self::new(
            ErrorCode::NotConnected,
            "The connection is not open.",
            "La connexion n'est pas ouverte.",
        )
        .with_action(ErrorAction::Reconnect)
    }

    pub fn password_required() -> Self {
        Self::new(
            ErrorCode::PasswordRequired,
            "A password is required for this connection.",
            "Un mot de passe est requis pour cette connexion.",
        )
        .with_action(ErrorAction::EnterPassword)
    }

    pub fn pending_secret_expired() -> Self {
        Self::new(
            ErrorCode::PendingSecretExpired,
            "The password taken from the connection string expired. Paste the string again or type the password.",
            "Le mot de passe extrait de la chaîne de connexion a expiré. Collez à nouveau la chaîne ou saisissez le mot de passe.",
        )
        .with_action(ErrorAction::EnterPassword)
    }

    pub fn host_not_found(host: &str) -> Self {
        Self::new(
            ErrorCode::HostNotFound,
            format!("The host \"{host}\" could not be found. Check its name and your network (VPN, DNS)."),
            format!("L'hôte « {host} » est introuvable. Vérifiez son nom et votre réseau (VPN, DNS)."),
        )
        .with_action(ErrorAction::EditConnection)
    }

    pub fn connection_refused(host: &str, port: u16) -> Self {
        Self::new(
            ErrorCode::ConnectionRefused,
            format!("{host}:{port} refused the connection. Check that the server is running and listens on this port."),
            format!("{host}:{port} a refusé la connexion. Vérifiez que le serveur est démarré et écoute sur ce port."),
        )
        .with_action(ErrorAction::EditConnection)
    }

    pub fn connection_timeout(host: &str, seconds: u32) -> Self {
        Self::new(
            ErrorCode::ConnectionTimeout,
            format!("{host} did not answer within {seconds} s. A firewall may block the port, or the server is overloaded."),
            format!("{host} n'a pas répondu en {seconds} s. Un pare-feu bloque peut-être le port, ou le serveur est surchargé."),
        )
        .with_action(ErrorAction::Retry)
    }

    pub fn tls_failed() -> Self {
        Self::new(
            ErrorCode::TlsFailed,
            "The secure (TLS) connection failed: the server certificate could not be verified or the handshake was refused.",
            "La connexion sécurisée (TLS) a échoué : le certificat du serveur n'a pas pu être vérifié ou la négociation a été refusée.",
        )
        .with_action(ErrorAction::ChangeTlsMode)
    }

    pub fn tls_not_supported() -> Self {
        Self::new(
            ErrorCode::TlsNotSupported,
            "The server does not accept TLS connections, but this connection requires TLS.",
            "Le serveur n'accepte pas les connexions TLS, mais cette connexion l'exige.",
        )
        .with_action(ErrorAction::ChangeTlsMode)
    }

    pub fn auth_failed(user: &str) -> Self {
        Self::new(
            ErrorCode::AuthFailed,
            format!("The server rejected the user \"{user}\" or its password."),
            format!("Le serveur a refusé l'utilisateur « {user} » ou son mot de passe."),
        )
        .with_action(ErrorAction::EnterPassword)
    }

    pub fn unknown_database(database: &str) -> Self {
        Self::new(
            ErrorCode::UnknownDatabase,
            format!("The database \"{database}\" does not exist on this server."),
            format!("La base « {database} » n'existe pas sur ce serveur."),
        )
        .with_action(ErrorAction::EditConnection)
    }

    pub fn file_not_found(path: &str) -> Self {
        Self::new(
            ErrorCode::FileNotFound,
            format!("The file \"{path}\" does not exist."),
            format!("Le fichier « {path} » n'existe pas."),
        )
        .with_action(ErrorAction::ChooseFile)
    }

    pub fn not_a_database(path: &str) -> Self {
        Self::new(
            ErrorCode::NotADatabase,
            format!("\"{path}\" is not a database file."),
            format!("« {path} » n'est pas un fichier de base de données."),
        )
        .with_action(ErrorAction::ChooseFile)
    }

    pub fn connection_lost() -> Self {
        Self::new(
            ErrorCode::ConnectionLost,
            "The connection to the server was lost. The statement was not run again.",
            "La connexion au serveur a été perdue. L'instruction n'a pas été relancée.",
        )
        .with_action(ErrorAction::Reconnect)
    }

    pub fn keychain_unavailable() -> Self {
        Self::new(
            ErrorCode::KeychainUnavailable,
            "No system keychain is available: passwords are kept for this session only.",
            "Aucun trousseau système n'est disponible : les mots de passe sont gardés pour cette session seulement.",
        )
    }

    pub fn keychain_failed(detail: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::KeychainFailed,
            "The system keychain refused the operation (locked or access denied).",
            "Le trousseau système a refusé l'opération (verrouillé ou accès refusé).",
        )
        .with_action(ErrorAction::Retry)
        .with_detail(detail)
    }

    pub fn invalid_connection_string(en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidConnectionString, en, fr)
    }

    pub fn query_failed(message: impl AsRef<str>) -> Self {
        Self::new(
            ErrorCode::QueryFailed,
            "The server rejected the statement.",
            "Le serveur a refusé l'instruction.",
        )
        .with_detail(message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Cancelled.", "Annulé.")
    }

    /// Whether the failure is worth retrying automatically when reconnecting: network and
    /// server-side transient failures, not wrong settings or credentials.
    pub fn is_transient(&self) -> bool {
        matches!(
            self.code,
            ErrorCode::HostNotFound
                | ErrorCode::ConnectionRefused
                | ErrorCode::ConnectionTimeout
                | ErrorCode::ConnectionLost
                | ErrorCode::QueryFailed
                | ErrorCode::Internal
        )
    }
}

/// Classification of a standard SQLSTATE returned while connecting, shared by every engine
/// that reports one (PostgreSQL, MySQL, SQL Server through ODBC states).
pub fn from_connect_sqlstate(
    sqlstate: &str,
    user: &str,
    database: &str,
    message: &str,
) -> Option<YadbeError> {
    let error = match sqlstate {
        // invalid_password, invalid_authorization_specification (no pg_hba entry, unknown user)
        "28P01" | "28000" => YadbeError::auth_failed(user),
        // invalid_catalog_name
        "3D000" => YadbeError::unknown_database(database),
        // admin_shutdown, crash_shutdown, cannot_connect_now: the server is going away
        "57P01" | "57P02" | "57P03" => YadbeError::connection_lost(),
        _ => return None,
    };
    Some(error.with_detail(message))
}

/// Removes secrets from a technical message: the password of URLs
/// (`scheme://user:secret@host`) and the value of `password=` / `pwd=` pairs.
pub fn redact(text: &str) -> String {
    let mut out = redact_url_passwords(text);
    for key in ["password", "pwd"] {
        out = redact_pairs(&out, key);
    }
    out
}

fn redact_url_passwords(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let (before, after) = rest.split_at(scheme_end + 3);
        out.push_str(before);
        // The authority ends at the first `/`, `?`, `#` or whitespace.
        let authority_end = after
            .find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace())
            .unwrap_or(after.len());
        let authority = &after[..authority_end];
        match (authority.rfind('@'), authority.find(':')) {
            (Some(at), Some(colon)) if colon < at => {
                out.push_str(&authority[..colon]);
                out.push_str(":***");
                out.push_str(&authority[at..]);
            }
            _ => out.push_str(authority),
        }
        rest = &after[authority_end..];
    }
    out.push_str(rest);
    out
}

fn redact_pairs(text: &str, key: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut search = 0;
    while let Some(found) = lower[search..].find(key) {
        let start = search + found;
        let after_key = start + key.len();
        let boundary = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
        let rest = &text[after_key..];
        let spaces = rest.len() - rest.trim_start().len();
        let eq = after_key + spaces;
        if boundary && text[eq..].starts_with('=') {
            let after_eq = &text[eq + 1..];
            let value_start = eq + 1 + (after_eq.len() - after_eq.trim_start().len());
            let value_end = text[value_start..]
                .find([';', '&', ' ', '\n'])
                .map_or(text.len(), |i| value_start + i);
            out.push_str(&text[cursor..value_start]);
            out.push_str("***");
            cursor = value_end;
            search = value_end;
        } else {
            search = after_key;
        }
        if search >= text.len() {
            break;
        }
    }
    out.push_str(&text[cursor..]);
    out
}

impl From<rusqlite::Error> for YadbeError {
    /// Only for the app store: user databases go through the SQLite driver's own mapping.
    fn from(err: rusqlite::Error) -> Self {
        Self::storage(err.to_string())
    }
}

impl From<serde_json::Error> for YadbeError {
    fn from(err: serde_json::Error) -> Self {
        Self::internal(format!("JSON: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_camel_case_codes() {
        let error = YadbeError::not_implemented();
        let json = serde_json::to_value(&error).expect("serializes");
        assert_eq!(json["code"], "notImplemented");
        assert_eq!(json["message"]["fr"], "Pas encore implémenté.");
        assert_eq!(error.to_string(), "NotImplemented: Not implemented yet.");
    }

    #[test]
    fn every_catalog_entry_has_both_languages() {
        let all = [
            YadbeError::host_not_found("db.example.com"),
            YadbeError::connection_refused("localhost", 5432),
            YadbeError::connection_timeout("db", 15),
            YadbeError::tls_failed(),
            YadbeError::tls_not_supported(),
            YadbeError::auth_failed("app"),
            YadbeError::unknown_database("shop"),
            YadbeError::file_not_found("/tmp/x.db"),
            YadbeError::not_a_database("/tmp/x.db"),
            YadbeError::connection_lost(),
            YadbeError::keychain_unavailable(),
            YadbeError::keychain_failed("locked"),
            YadbeError::password_required(),
            YadbeError::engine_not_supported("MySQL"),
        ];
        for error in all {
            assert!(!error.message.en.is_empty() && !error.message.fr.is_empty());
            assert_ne!(error.message.en, error.message.fr, "{:?}", error.code);
        }
    }

    #[test]
    fn maps_standard_sqlstates() {
        let auth = from_connect_sqlstate("28P01", "app", "shop", "password authentication failed");
        assert_eq!(auth.map(|e| e.code), Some(ErrorCode::AuthFailed));
        let db = from_connect_sqlstate("3D000", "app", "shop", "database \"shop\" does not exist");
        assert_eq!(db.map(|e| e.code), Some(ErrorCode::UnknownDatabase));
        assert!(from_connect_sqlstate("42601", "app", "shop", "syntax error").is_none());
    }

    #[test]
    fn redacts_url_passwords_and_pairs() {
        assert_eq!(
            redact("failed: postgres://app:s3cr3t@db:5432/shop?sslmode=require"),
            "failed: postgres://app:***@db:5432/shop?sslmode=require"
        );
        assert_eq!(
            redact("Server=db;User Id=sa;Password=p@ss;word=1;PWD = x"),
            "Server=db;User Id=sa;Password=***;word=1;PWD = ***"
        );
        assert_eq!(redact("no secret here"), "no secret here");
        assert_eq!(
            redact("user=app password=hunter2 host=db"),
            "user=app password=*** host=db"
        );
        assert_eq!(redact("old_password=1"), "old_password=***");
    }

    #[test]
    fn detail_is_redacted() {
        let error = YadbeError::internal("mysql://root:toor@localhost");
        assert_eq!(error.detail.as_deref(), Some("mysql://root:***@localhost"));
    }
}
