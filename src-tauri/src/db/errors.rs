//! Typed errors sent to the frontend. The driver error catalog (DNS, refused, timeout, TLS,
//! auth…) is added by M0-2; this is the serialized shape every fallible command returns.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Stable machine-readable error code; the frontend switches on it, never on messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The command exists in the contract but has no backend implementation yet.
    NotImplemented,
    /// A frontend-provided argument was rejected by validation.
    InvalidArgument,
    /// Unexpected internal failure (bug, I/O error…).
    Internal,
}

/// A message in every supported UI language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LocalizedText {
    pub en: String,
    pub fr: String,
}

/// What the UI can offer to do about an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorAction {
    Retry,
}

/// Error returned by every fallible command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct YadbeError {
    pub code: ErrorCode,
    pub message: LocalizedText,
    pub action: Option<ErrorAction>,
    /// Raw technical detail (driver message, I/O error), shown in a collapsible area.
    pub detail: Option<String>,
}

impl std::fmt::Display for YadbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message.en)
    }
}

impl std::error::Error for YadbeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_camel_case_codes() {
        let error = YadbeError {
            code: ErrorCode::NotImplemented,
            message: LocalizedText {
                en: "Not implemented".into(),
                fr: "Non implémenté".into(),
            },
            action: None,
            detail: None,
        };
        let json = serde_json::to_value(&error).expect("serializes");
        assert_eq!(json["code"], "notImplemented");
        assert_eq!(json["message"]["fr"], "Non implémenté");
        assert_eq!(error.to_string(), "NotImplemented: Not implemented");
    }
}
