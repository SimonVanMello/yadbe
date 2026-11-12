//! MongoDB driver errors → the catalog (`db/errors.rs`). Messages from the server are kept
//! as the detail, redacted.

use mongodb::error::{Error, ErrorKind, WriteFailure};

use crate::db::errors::{ErrorAction, ErrorCode, YadbeError};

/// Server error codes yadbe recognizes.
pub const UNAUTHORIZED: i32 = 13;
pub const AUTHENTICATION_FAILED: i32 = 18;
pub const NAMESPACE_NOT_FOUND: i32 = 26;
pub const MAX_TIME_EXPIRED: i32 = 50;
pub const INTERRUPTED: i32 = 11601;
pub const INTERRUPTED_AT_SHUTDOWN: i32 = 11600;

/// Where the connection was going, for messages.
pub struct Endpoint<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub timeout_secs: u32,
}

fn lower(text: &str) -> String {
    text.to_ascii_lowercase()
}

fn connect_message(message: &str, endpoint: &Endpoint<'_>) -> YadbeError {
    let text = lower(message);
    let error = if text.contains("connection refused") {
        YadbeError::connection_refused(endpoint.host, endpoint.port)
    } else if text.contains("failed to lookup")
        || text.contains("name or service not known")
        || text.contains("no such host")
        || text.contains("nodename nor servname")
        || text.contains("dns")
        || text.contains("no record found")
    {
        YadbeError::host_not_found(endpoint.host)
    } else if text.contains("certificate")
        || text.contains("tls")
        || text.contains("handshake")
        || text.contains("unknownissuer")
    {
        if text.contains("certificate required") || text.contains("certificaterequired") {
            YadbeError::tls_client_cert_required()
        } else {
            YadbeError::tls_failed()
        }
    } else if text.contains("authentication failed") || text.contains("auth error") {
        YadbeError::auth_failed(endpoint.user)
    } else if text.contains("timed out") || text.contains("server selection timeout") {
        YadbeError::connection_timeout(endpoint.host, endpoint.timeout_secs)
    } else {
        YadbeError::connection_lost()
    };
    error.with_detail(message)
}

/// An error while connecting (server selection, authentication, TLS).
pub fn from_connect_error(err: &Error, endpoint: &Endpoint<'_>) -> YadbeError {
    match &*err.kind {
        ErrorKind::Authentication { message, .. } => {
            YadbeError::auth_failed(endpoint.user).with_detail(message)
        }
        ErrorKind::Command(command) if command.code == AUTHENTICATION_FAILED => {
            YadbeError::auth_failed(endpoint.user).with_detail(&command.message)
        }
        ErrorKind::DnsResolve { message, .. } => {
            YadbeError::host_not_found(endpoint.host).with_detail(message)
        }
        ErrorKind::InvalidTlsConfig { message, .. } => {
            YadbeError::tls_client_cert_invalid(message.clone())
        }
        ErrorKind::ServerSelection { message, .. } => connect_message(message, endpoint),
        ErrorKind::Io(io) => connect_message(&io.to_string(), endpoint),
        ErrorKind::InvalidArgument { message, .. } => YadbeError::new(
            ErrorCode::InvalidConnectionString,
            "The MongoDB connection settings were refused.",
            "Les paramètres de connexion MongoDB ont été refusés.",
        )
        .with_action(ErrorAction::EditConnection)
        .with_detail(message),
        _ => from_error(err, None),
    }
}

/// An error of an operation. `timeout`: the statement timeout in force, for its message.
pub fn from_error(err: &Error, timeout: Option<u64>) -> YadbeError {
    match &*err.kind {
        ErrorKind::Command(command) => {
            from_code(command.code, &command.code_name, &command.message, timeout)
        }
        ErrorKind::Write(WriteFailure::WriteError(write)) => from_code(
            write.code,
            write.code_name.as_deref().unwrap_or(""),
            &write.message,
            timeout,
        ),
        ErrorKind::Write(WriteFailure::WriteConcernError(concern)) => {
            YadbeError::query_failed(&concern.message)
        }
        ErrorKind::Io(io) => YadbeError::connection_lost().with_detail(io.to_string()),
        ErrorKind::ConnectionPoolCleared { message, .. }
        | ErrorKind::ServerSelection { message, .. } => {
            YadbeError::connection_lost().with_detail(message)
        }
        ErrorKind::Authentication { message, .. } => YadbeError::new(
            ErrorCode::AuthFailed,
            "The server rejected the credentials.",
            "Le serveur a refusé les identifiants.",
        )
        .with_action(ErrorAction::EnterPassword)
        .with_detail(message),
        ErrorKind::InvalidArgument { message, .. } => YadbeError::invalid_argument(
            "MongoDB refused the arguments of this operation.",
            "MongoDB a refusé les arguments de cette opération.",
        )
        .with_detail(message),
        ErrorKind::Shutdown => YadbeError::connection_lost(),
        _ => YadbeError::query_failed(err.to_string()),
    }
}

/// A server error by its code.
pub fn from_code(code: i32, name: &str, message: &str, timeout: Option<u64>) -> YadbeError {
    match code {
        MAX_TIME_EXPIRED => {
            YadbeError::statement_timeout(timeout.unwrap_or(0)).with_detail(message)
        }
        INTERRUPTED | INTERRUPTED_AT_SHUTDOWN => YadbeError::cancelled(),
        NAMESPACE_NOT_FOUND => YadbeError::object_not_found(message),
        UNAUTHORIZED => {
            YadbeError::insufficient_privilege("run this command", "exécuter cette commande", name)
                .with_detail(message)
        }
        _ => YadbeError::query_failed(format!("{message} ({name}, code {code})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_codes_map_to_the_catalog() {
        assert_eq!(
            from_code(50, "MaxTimeMSExpired", "x", Some(3)).code,
            ErrorCode::StatementTimeout
        );
        assert_eq!(
            from_code(11601, "Interrupted", "x", None).code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            from_code(26, "NamespaceNotFound", "ns", None).code,
            ErrorCode::ObjectNotFound
        );
        assert_eq!(
            from_code(13, "Unauthorized", "no", None).code,
            ErrorCode::InsufficientPrivilege
        );
        let other = from_code(2, "BadValue", "unknown operator: $foo", None);
        assert_eq!(other.code, ErrorCode::QueryFailed);
        assert!(other.detail.as_deref().is_some_and(|d| d.contains("$foo")));
    }

    #[test]
    fn connection_failures_are_classified_from_their_message() {
        let endpoint = Endpoint {
            host: "db",
            port: 27017,
            user: "app",
            timeout_secs: 5,
        };
        let code = |m: &str| connect_message(m, &endpoint).code;
        assert_eq!(
            code("Server selection timeout: ... Connection refused (os error 111)"),
            ErrorCode::ConnectionRefused
        );
        assert_eq!(
            code("failed to lookup address information: Name or service not known"),
            ErrorCode::HostNotFound
        );
        assert_eq!(
            code("invalid peer certificate: UnknownIssuer"),
            ErrorCode::TlsFailed
        );
        assert_eq!(
            code("Server selection timeout: No available servers"),
            ErrorCode::ConnectionTimeout
        );
        let secret = connect_message(
            "mongodb://app:s3cret@db failed: Connection refused",
            &endpoint,
        );
        assert!(
            !secret.detail.unwrap_or_default().contains("s3cret"),
            "redacted"
        );
    }
}
