use serde::{Deserialize, Serialize};
use specta::Type;
use zeroize::Zeroize;

/// A password, token or passphrase. Deserializable (the frontend sends it once) but never
/// serializable, redacted in `Debug` / `Display`, and zeroized when dropped.
///
/// The JSON buffer the IPC layer parsed it from is outside our control; everything yadbe
/// copies is wiped.
#[derive(Clone, Deserialize, Type, PartialEq, Eq)]
#[serde(transparent)]
#[specta(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The clear value, for the keychain and the driver only.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

/// Text that may hold a secret and is handed to the user on purpose, once (a connection
/// string copied with its password). Serializable because the user asked for it; redacted in
/// `Debug`, zeroized when dropped, and never kept: the caller writes it to the clipboard and
/// lets it go.
#[derive(Serialize, Type)]
#[serde(transparent)]
#[specta(transparent)]
pub struct RevealedText(String);

impl RevealedText {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for RevealedText {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for RevealedText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RevealedText(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_prints_its_value() {
        let secret = Secret::new("hunter2");
        assert_eq!(format!("{secret:?}"), "Secret(***)");
        assert_eq!(format!("{secret}"), "***");
        assert_eq!(format!("{:?}", Some(&secret)), "Some(Secret(***))");
        assert_eq!(secret.expose(), "hunter2");
    }

    #[test]
    fn deserializes_from_a_plain_string() {
        let secret: Secret = serde_json::from_str("\"p@ss\"").expect("deserializes");
        assert_eq!(secret.expose(), "p@ss");
    }

    #[test]
    fn wipes_its_buffer_on_drop() {
        let mut secret = Secret::new("hunter2");
        // What `Drop` does, observed before the memory is released.
        secret.0.zeroize();
        assert!(secret.is_empty());
    }
}
