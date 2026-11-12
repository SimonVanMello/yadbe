//! Binary-safe keys and values across the IPC: a key or a value is any byte string. Text
//! that is valid UTF-8 travels as it is; anything else travels as base64 next to a readable
//! form, so the frontend can show it and send the exact bytes back.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;

/// A byte string as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvBytes {
    /// The bytes as text: themselves when they are UTF-8, else escaped the way `redis-cli`
    /// prints them (`\xff`). Read-only when `base64` is set.
    pub text: String,
    /// The exact bytes, when they are not UTF-8; `null`: `text` is the bytes.
    pub base64: Option<String>,
}

impl KvBytes {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        match std::str::from_utf8(bytes) {
            Ok(text) => Self {
                text: text.to_owned(),
                base64: None,
            },
            Err(_) => Self {
                text: escape(bytes),
                base64: Some(STANDARD.encode(bytes)),
            },
        }
    }

    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            base64: None,
        }
    }

    /// The exact bytes.
    pub fn to_bytes(&self) -> Result<Vec<u8>, YadbeError> {
        match &self.base64 {
            None => Ok(self.text.as_bytes().to_vec()),
            Some(encoded) => STANDARD.decode(encoded).map_err(|e| {
                YadbeError::invalid_argument(
                    "A binary key or value is not valid base64.",
                    "Une clé ou une valeur binaire n'est pas du base64 valide.",
                )
                .with_detail(e.to_string())
            }),
        }
    }
}

/// Bytes as `redis-cli` prints them inside double quotes: printable ASCII as is, `\"` and
/// `\\` escaped, the usual control characters by name and anything else as `\xHH`.
pub fn escape(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            b'\\' => out.push_str("\\\\"),
            b'"' => out.push_str("\\\""),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x07 => out.push_str("\\a"),
            0x08 => out.push_str("\\b"),
            0x20..=0x7e => out.push(char::from(b)),
            _ => out.push_str(&format!("\\x{b:02x}")),
        }
    }
    out
}

/// Base64 of any bytes (string windows read by the frontend).
pub fn encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_travels_as_text_and_the_rest_as_base64() {
        let plain = KvBytes::from_bytes("user:42:été".as_bytes());
        assert_eq!(plain.base64, None);
        assert_eq!(plain.to_bytes().expect("bytes"), "user:42:été".as_bytes());

        let raw = [0xff_u8, b'a', 0, b'"'];
        let binary = KvBytes::from_bytes(&raw);
        assert_eq!(binary.text, "\\xffa\\x00\\\"");
        assert_eq!(binary.to_bytes().expect("bytes"), raw);
    }

    #[test]
    fn bad_base64_is_refused() {
        let bad = KvBytes {
            text: String::new(),
            base64: Some("***".into()),
        };
        assert!(bad.to_bytes().is_err());
    }
}
