//! Secrets: the `Secret` type, the OS keychain and the session-only fallback (F-005).
//!
//! A secret lives in the keychain (when the user asked to remember it and a keychain
//! exists) or in memory for the session. Nothing here is ever serialized: commands only
//! return where a secret is, never its value.

mod keychain;
mod secret;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;
pub use keychain::{
    KeychainBackend, KeychainError, MemoryKeychain, NoKeychain, OsKeychain, SERVICE,
};
pub use secret::Secret;

/// How long a password extracted from a pasted connection string waits to be used.
pub const PENDING_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    Password,
    SshPassphrase,
    Token,
    /// Password of the SSH tunnel's server.
    SshPassword,
    /// Password and key passphrase of the SSH tunnel's jump host.
    JumpPassword,
    JumpPassphrase,
    /// Passphrase of the encrypted private key of a TLS client certificate (F-009).
    TlsKeyPassphrase,
}

impl SecretKind {
    pub const ALL: [SecretKind; 7] = [
        SecretKind::Password,
        SecretKind::SshPassphrase,
        SecretKind::Token,
        SecretKind::SshPassword,
        SecretKind::JumpPassword,
        SecretKind::JumpPassphrase,
        SecretKind::TlsKeyPassphrase,
    ];

    fn account_suffix(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::SshPassphrase => "ssh-passphrase",
            SecretKind::Token => "token",
            SecretKind::SshPassword => "ssh-password",
            SecretKind::JumpPassword => "jump-password",
            SecretKind::JumpPassphrase => "jump-passphrase",
            SecretKind::TlsKeyPassphrase => "tls-key-passphrase",
        }
    }
}

/// Where a secret is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SecretLocation {
    /// The OS keychain: survives restarts.
    Keychain,
    /// Memory only: forgotten when yadbe quits.
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeychainStatus {
    /// `false`: "remember password" is not possible, secrets are kept for the session only.
    pub available: bool,
    /// Why the keychain is unavailable (technical).
    pub detail: Option<String>,
}

/// A secret sent by the frontend: typed by the user, or extracted earlier from a pasted
/// connection string and held by the backend under an id.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SecretInput {
    Value { value: Secret },
    Pending { id: String },
}

type SessionKey = (String, SecretKind);

pub struct SecretStore {
    backend: Arc<dyn KeychainBackend>,
    status: Mutex<Option<KeychainStatus>>,
    session: Mutex<HashMap<SessionKey, Secret>>,
    pending: Mutex<HashMap<String, (Secret, Instant)>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn account(connection_id: &str, kind: SecretKind) -> String {
    format!("{connection_id}:{}", kind.account_suffix())
}

impl SecretStore {
    pub fn new(backend: Arc<dyn KeychainBackend>) -> Self {
        Self {
            backend,
            status: Mutex::new(None),
            session: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Whether the keychain can be used; probed once (blocking), then cached.
    pub fn status(&self) -> KeychainStatus {
        if let Some(status) = lock(&self.status).clone() {
            return status;
        }
        let status = match self.backend.probe() {
            Ok(()) => KeychainStatus {
                available: true,
                detail: None,
            },
            Err(detail) => {
                tracing::warn!(%detail, "no keychain available: secrets are session-only");
                KeychainStatus {
                    available: false,
                    detail: Some(detail),
                }
            }
        };
        *lock(&self.status) = Some(status.clone());
        status
    }

    fn mark_unavailable(&self, detail: &str) {
        tracing::warn!(%detail, "the keychain became unavailable: secrets are session-only");
        *lock(&self.status) = Some(KeychainStatus {
            available: false,
            detail: Some(detail.to_owned()),
        });
    }

    fn keychain_error(&self, err: KeychainError) -> YadbeError {
        match err {
            KeychainError::Unavailable(detail) => {
                self.mark_unavailable(&detail);
                YadbeError::keychain_unavailable().with_detail(detail)
            }
            KeychainError::Failed(detail) => YadbeError::keychain_failed(detail),
        }
    }

    /// Stores a secret: in the keychain when `remember` and a keychain exists, otherwise in
    /// memory for the session. Returns where it went. Blocking.
    pub fn set(
        &self,
        connection_id: &str,
        kind: SecretKind,
        secret: Secret,
        remember: bool,
    ) -> Result<SecretLocation, YadbeError> {
        let key = (connection_id.to_owned(), kind);
        let keychain = self.status().available;
        if remember && keychain {
            match self.backend.set(&account(connection_id, kind), &secret) {
                Ok(()) => {
                    lock(&self.session).remove(&key);
                    return Ok(SecretLocation::Keychain);
                }
                Err(KeychainError::Unavailable(detail)) => self.mark_unavailable(&detail),
                Err(err) => return Err(self.keychain_error(err)),
            }
        } else if keychain {
            // Not remembered: a copy saved earlier must not outlive the user's choice.
            if let Err(err) = self.backend.delete(&account(connection_id, kind)) {
                tracing::warn!(?err, "could not remove the remembered secret");
            }
        }
        lock(&self.session).insert(key, secret);
        Ok(SecretLocation::Session)
    }

    /// Keeps a secret for the session only (a password typed at connect time).
    pub fn set_session(&self, connection_id: &str, kind: SecretKind, secret: Secret) {
        lock(&self.session).insert((connection_id.to_owned(), kind), secret);
    }

    /// The secret, from the session first, then the keychain. Blocking.
    pub fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<Secret>, YadbeError> {
        if let Some(secret) = lock(&self.session).get(&(connection_id.to_owned(), kind)) {
            return Ok(Some(secret.clone()));
        }
        if !self.status().available {
            return Ok(None);
        }
        self.backend
            .get(&account(connection_id, kind))
            .map_err(|err| self.keychain_error(err))
    }

    /// Where the secret is, if anywhere. Blocking.
    pub fn location(
        &self,
        connection_id: &str,
        kind: SecretKind,
    ) -> Result<Option<SecretLocation>, YadbeError> {
        if lock(&self.session).contains_key(&(connection_id.to_owned(), kind)) {
            return Ok(Some(SecretLocation::Session));
        }
        if !self.status().available {
            return Ok(None);
        }
        match self.backend.get(&account(connection_id, kind)) {
            Ok(found) => Ok(found.map(|_| SecretLocation::Keychain)),
            Err(err) => Err(self.keychain_error(err)),
        }
    }

    /// Forgets the secret everywhere. Blocking.
    pub fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), YadbeError> {
        lock(&self.session).remove(&(connection_id.to_owned(), kind));
        if !self.status().available {
            return Ok(());
        }
        self.backend
            .delete(&account(connection_id, kind))
            .map_err(|err| self.keychain_error(err))
    }

    /// Forgets every secret of a deleted connection. Blocking.
    pub fn delete_all(&self, connection_id: &str) -> Result<(), YadbeError> {
        for kind in SecretKind::ALL {
            self.delete(connection_id, kind)?;
        }
        Ok(())
    }

    /// Holds a secret extracted from a connection string; the frontend gets only the id.
    pub fn stash_pending(&self, secret: Secret) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut pending = lock(&self.pending);
        pending.retain(|_, (_, at)| at.elapsed() < PENDING_TTL);
        pending.insert(id.clone(), (secret, Instant::now()));
        id
    }

    pub fn discard_pending(&self, id: &str) {
        lock(&self.pending).remove(id);
    }

    /// The value of a secret input. A pending secret stays available until it expires,
    /// is discarded, or `consume` is set (it was saved).
    pub fn resolve(&self, input: SecretInput, consume: bool) -> Result<Secret, YadbeError> {
        match input {
            SecretInput::Value { value } => Ok(value),
            SecretInput::Pending { id } => {
                let mut pending = lock(&self.pending);
                let fresh = pending
                    .get(&id)
                    .is_some_and(|(_, at)| at.elapsed() < PENDING_TTL);
                if !fresh {
                    pending.remove(&id);
                    return Err(YadbeError::pending_secret_expired());
                }
                let secret = if consume {
                    pending.remove(&id).map(|(secret, _)| secret)
                } else {
                    pending.get(&id).map(|(secret, _)| secret.clone())
                };
                secret.ok_or_else(YadbeError::pending_secret_expired)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;

    fn store() -> (SecretStore, Arc<MemoryKeychain>) {
        let keychain = Arc::new(MemoryKeychain::default());
        (SecretStore::new(keychain.clone()), keychain)
    }

    #[test]
    fn remembered_secrets_go_to_the_keychain() {
        let (store, keychain) = store();
        let location = store
            .set("c1", SecretKind::Password, Secret::new("pw"), true)
            .expect("set");
        assert_eq!(location, SecretLocation::Keychain);
        assert_eq!(keychain.len(), 1);
        assert_eq!(
            store
                .location("c1", SecretKind::Password)
                .expect("location"),
            Some(SecretLocation::Keychain)
        );
        let got = store.get("c1", SecretKind::Password).expect("get");
        assert_eq!(got.as_ref().map(Secret::expose), Some("pw"));
    }

    #[test]
    fn not_remembering_removes_the_keychain_copy() {
        let (store, keychain) = store();
        store
            .set("c1", SecretKind::Password, Secret::new("old"), true)
            .expect("set");
        let location = store
            .set("c1", SecretKind::Password, Secret::new("new"), false)
            .expect("set");
        assert_eq!(location, SecretLocation::Session);
        assert!(keychain.is_empty());
        let got = store.get("c1", SecretKind::Password).expect("get");
        assert_eq!(got.as_ref().map(Secret::expose), Some("new"));
    }

    #[test]
    fn falls_back_to_the_session_without_keychain() {
        let store = SecretStore::new(Arc::new(NoKeychain));
        assert!(!store.status().available);
        let location = store
            .set("c1", SecretKind::Password, Secret::new("pw"), true)
            .expect("set");
        assert_eq!(location, SecretLocation::Session);
        assert_eq!(
            store
                .location("c1", SecretKind::Password)
                .expect("location"),
            Some(SecretLocation::Session)
        );
        store.delete_all("c1").expect("delete");
        assert_eq!(store.get("c1", SecretKind::Password).expect("get"), None);
    }

    #[test]
    fn pending_secrets_resolve_until_consumed() {
        let (store, _) = store();
        let id = store.stash_pending(Secret::new("from-url"));
        let input = SecretInput::Pending { id: id.clone() };
        assert_eq!(
            store.resolve(input.clone(), false).expect("peek").expose(),
            "from-url"
        );
        assert_eq!(
            store.resolve(input.clone(), true).expect("take").expose(),
            "from-url"
        );
        assert_eq!(
            store.resolve(input, false).map_err(|e| e.code).err(),
            Some(ErrorCode::PendingSecretExpired)
        );
        let value = SecretInput::Value {
            value: Secret::new("typed"),
        };
        assert_eq!(store.resolve(value, true).expect("value").expose(), "typed");
    }

    #[test]
    fn secret_input_deserializes_from_the_frontend_shape() {
        let input: SecretInput =
            serde_json::from_str(r#"{"kind":"value","value":"pw"}"#).expect("value");
        assert!(matches!(input, SecretInput::Value { value } if value.expose() == "pw"));
        let input: SecretInput =
            serde_json::from_str(r#"{"kind":"pending","id":"abc"}"#).expect("pending");
        assert!(matches!(input, SecretInput::Pending { id } if id == "abc"));
        // Debug of an input never shows the value.
        let input: SecretInput =
            serde_json::from_str(r#"{"kind":"value","value":"hunter2"}"#).expect("value");
        assert!(!format!("{input:?}").contains("hunter2"));
    }
}
