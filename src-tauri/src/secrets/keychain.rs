//! Keychain backends: the OS keychain through `keyring`, an in-memory one for tests, and one
//! that is never available (to exercise the session-only path).

use std::collections::HashMap;
use std::sync::Mutex;

use super::Secret;

/// Service name of every yadbe entry in the OS keychain (SPEC §8).
pub const SERVICE: &str = "dev.tropico.yadbe";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeychainError {
    /// No keychain at all (headless Linux without Secret Service…).
    Unavailable(String),
    /// The keychain exists but refused the operation (locked, denied…).
    Failed(String),
}

/// Blocking: call from a blocking thread (D-Bus, macOS Security framework).
pub trait KeychainBackend: Send + Sync {
    /// Ok when the keychain can be used, otherwise the reason.
    fn probe(&self) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<Secret>, KeychainError>;
    fn set(&self, account: &str, secret: &Secret) -> Result<(), KeychainError>;
    /// Deleting an absent entry is not an error.
    fn delete(&self, account: &str) -> Result<(), KeychainError>;
}

/// The OS keychain: macOS Keychain, Windows Credential Manager, Secret Service on Linux.
pub struct OsKeychain;

const PROBE_ACCOUNT: &str = "yadbe:availability-probe";

impl OsKeychain {
    fn entry(account: &str) -> Result<keyring::Entry, KeychainError> {
        keyring::Entry::new(SERVICE, account).map_err(map_error)
    }
}

fn map_error(err: keyring::Error) -> KeychainError {
    match err {
        keyring::Error::NoDefaultStore => KeychainError::Unavailable(err.to_string()),
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => {
            KeychainError::Failed(err.to_string())
        }
        other => KeychainError::Failed(other.to_string()),
    }
}

impl KeychainBackend for OsKeychain {
    fn probe(&self) -> Result<(), String> {
        if let Err(err) = keyring::Entry::store_status() {
            return Err(err.to_string());
        }
        // A store can initialize yet fail on first use (no Secret Service on the session
        // bus): read an entry that never exists.
        match Self::entry(PROBE_ACCOUNT)
            .map_err(|e| format!("{e:?}"))?
            .get_password()
        {
            Ok(mut value) => {
                zeroize::Zeroize::zeroize(&mut value);
                Ok(())
            }
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, KeychainError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(Secret::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(map_error(err)),
        }
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), KeychainError> {
        Self::entry(account)?
            .set_password(secret.expose())
            .map_err(map_error)
    }

    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(map_error(err)),
        }
    }
}

/// Keychain kept in memory: tests never touch the real OS keychain.
#[derive(Default)]
pub struct MemoryKeychain {
    entries: Mutex<HashMap<String, Secret>>,
}

impl MemoryKeychain {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Secret>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Number of stored entries (tests).
    pub fn len(&self) -> usize {
        self.entries().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl KeychainBackend for MemoryKeychain {
    fn probe(&self) -> Result<(), String> {
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, KeychainError> {
        Ok(self.entries().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), KeychainError> {
        self.entries().insert(account.to_owned(), secret.clone());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        self.entries().remove(account);
        Ok(())
    }
}

/// A machine without keychain.
pub struct NoKeychain;

impl KeychainBackend for NoKeychain {
    fn probe(&self) -> Result<(), String> {
        Err("no keychain on this machine".to_owned())
    }

    fn get(&self, _account: &str) -> Result<Option<Secret>, KeychainError> {
        Err(KeychainError::Unavailable("no keychain".to_owned()))
    }

    fn set(&self, _account: &str, _secret: &Secret) -> Result<(), KeychainError> {
        Err(KeychainError::Unavailable("no keychain".to_owned()))
    }

    fn delete(&self, _account: &str) -> Result<(), KeychainError> {
        Err(KeychainError::Unavailable("no keychain".to_owned()))
    }
}
