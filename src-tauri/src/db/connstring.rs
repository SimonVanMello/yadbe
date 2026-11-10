//! Connection-string parser (F-006): URLs (`postgres://`, `mysql://`, `sqlserver://`,
//! `sqlite:`), ADO.NET (`Server=…;Database=…`) and JDBC (`jdbc:…`). The result fills the
//! connection form; the password is returned apart, as a `Secret`.

use serde::Serialize;
use specta::Type;

use crate::db::config::{ConnectionOption, TlsMode};
use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::secrets::Secret;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStringFormat {
    Url,
    AdoNet,
    Jdbc,
}

/// Form fields found in a connection string; `null`: absent from the string (keep the
/// form's value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedConnectionString {
    pub format: ConnectionStringFormat,
    pub engine: Option<Engine>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub file_path: Option<String>,
    pub tls_mode: Option<TlsMode>,
    pub ca_cert_path: Option<String>,
    /// Engine parameters to pass through (`application_name`…).
    pub options: Vec<ConnectionOption>,
    /// The string held a password: the backend keeps it under this id (see
    /// `SecretInput.pending`); it is never sent back.
    pub password_id: Option<String>,
    /// Keys yadbe did not understand and ignored.
    pub ignored_keys: Vec<String>,
}

/// Parser output: the fields, and the password kept apart.
#[derive(Debug)]
pub struct Parsed {
    pub fields: ParsedConnectionString,
    pub password: Option<Secret>,
}

/// Parses `input`; `hint` is the engine selected in the form, used when the string does
/// not say (ADO.NET).
pub fn parse(input: &str, hint: Option<Engine>) -> Result<Parsed, YadbeError> {
    let _ = (input, hint);
    Err(YadbeError::not_implemented())
}
