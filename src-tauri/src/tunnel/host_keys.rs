//! Host key verification: no silent trust. A host key is trusted when yadbe's own store
//! (keys the user accepted) or the user's `~/.ssh/known_hosts` (read, never written) has it.
//! A different key of the same type is a changed key: a hard refusal.

use std::path::PathBuf;
use std::sync::Arc;

use russh::keys::{HashAlg, PublicKey};

use crate::db::errors::YadbeError;
use crate::store::Store;
use crate::tunnel::model::KnownHost;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Trusted,
    Unknown,
    Changed,
}

/// `SHA256:…`, as OpenSSH prints it.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn key_type(key: &PublicKey) -> String {
    key.algorithm().as_str().to_owned()
}

/// Host names compare case-insensitively, without IPv6 brackets.
pub fn normalized_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

pub struct HostKeys {
    store: Arc<Store>,
    /// The user's OpenSSH `known_hosts`, an additional trusted source (read only). `None` in
    /// tests: they never read the user's `~/.ssh`.
    user_known_hosts: Option<PathBuf>,
}

impl HostKeys {
    pub fn new(store: Arc<Store>, user_known_hosts: Option<PathBuf>) -> Self {
        Self {
            store,
            user_known_hosts,
        }
    }

    /// `~/.ssh/known_hosts`, when there is a home folder.
    pub fn default_user_known_hosts() -> Option<PathBuf> {
        crate::tunnel::keys::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
    }

    /// Blocking (store and file reads).
    pub fn verify(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<HostKeyVerdict, YadbeError> {
        let host = normalized_host(host);
        let key_type = key_type(key);
        let fingerprint = fingerprint(key);
        let mut changed = false;
        for known in self.store.known_hosts_for(&host, port)? {
            if known.key_type == key_type {
                if known.fingerprint == fingerprint {
                    return Ok(HostKeyVerdict::Trusted);
                }
                changed = true;
            }
        }
        if let Some(path) = &self.user_known_hosts {
            match russh::keys::known_hosts::known_host_keys_path(&host, port, path) {
                Ok(keys) => {
                    for (_, recorded) in keys {
                        if recorded.algorithm() == key.algorithm() {
                            if recorded.key_data() == key.key_data() {
                                return Ok(HostKeyVerdict::Trusted);
                            }
                            changed = true;
                        }
                    }
                }
                // An unreadable or malformed file is no trust source; yadbe's store still is.
                Err(err) => tracing::warn!(error = %err, "could not read the user's known_hosts"),
            }
        }
        Ok(if changed {
            HostKeyVerdict::Changed
        } else {
            HostKeyVerdict::Unknown
        })
    }

    /// Stores a key the user accepted after seeing its fingerprint. Blocking.
    pub fn trust(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<KnownHost, YadbeError> {
        if !fingerprint.starts_with("SHA256:") || fingerprint.len() > 100 || key_type.len() > 100 {
            return Err(YadbeError::invalid_argument(
                "This is not an SSH host key fingerprint.",
                "Ce n'est pas une empreinte de clé d'hôte SSH.",
            ));
        }
        let host = normalized_host(host);
        if host.is_empty() || port == 0 {
            return Err(YadbeError::invalid_argument(
                "An SSH host needs a name and a port.",
                "Un hôte SSH doit avoir un nom et un port.",
            ));
        }
        // Trusting never replaces a known key of the same type: a changed key must be
        // forgotten first, deliberately.
        if self
            .store
            .known_hosts_for(&host, port)?
            .iter()
            .any(|k| k.key_type == key_type && k.fingerprint != fingerprint)
        {
            return Err(YadbeError::invalid_argument(
                "Another key of this type is already known for this host: forget it first in Preferences › SSH known hosts.",
                "Une autre clé de ce type est déjà connue pour cet hôte : oubliez-la d'abord dans Préférences › Hôtes SSH connus.",
            ));
        }
        self.store
            .add_known_host(&host, port, key_type, fingerprint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::PrivateKey;
    use russh::keys::ssh_key::private::Ed25519Keypair;

    fn key(seed: u8) -> PublicKey {
        PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
            .public_key()
            .clone()
    }

    fn keys(user_file: Option<PathBuf>) -> HostKeys {
        HostKeys::new(Arc::new(Store::open_in_memory().expect("store")), user_file)
    }

    #[test]
    fn unknown_then_trusted_then_changed() {
        let keys = keys(None);
        let first = key(1);
        assert_eq!(
            keys.verify("Bastion", 22, &first).expect("verify"),
            HostKeyVerdict::Unknown
        );
        keys.trust("bastion", 22, &key_type(&first), &fingerprint(&first))
            .expect("trust");
        assert_eq!(
            keys.verify("BASTION", 22, &first).expect("verify"),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            keys.verify("bastion", 2222, &first).expect("verify"),
            HostKeyVerdict::Unknown,
            "another port is another host"
        );
        let second = key(2);
        assert_eq!(
            keys.verify("bastion", 22, &second).expect("verify"),
            HostKeyVerdict::Changed
        );
        assert!(
            keys.trust("bastion", 22, &key_type(&second), &fingerprint(&second))
                .is_err(),
            "a changed key is never trusted over the known one"
        );
    }

    #[test]
    fn reads_the_user_known_hosts_file() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("known_hosts");
        let known = key(3);
        std::fs::write(
            &path,
            format!(
                "[db.example.com]:2222 {}\n",
                known.to_openssh().expect("encode")
            ),
        )
        .expect("write");
        let keys = keys(Some(path));
        assert_eq!(
            keys.verify("db.example.com", 2222, &known).expect("verify"),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            keys.verify("db.example.com", 2222, &key(4))
                .expect("verify"),
            HostKeyVerdict::Changed
        );
        assert_eq!(
            keys.verify("other", 22, &known).expect("verify"),
            HostKeyVerdict::Unknown
        );
    }

    #[test]
    fn fingerprints_look_like_openssh() {
        assert!(fingerprint(&key(5)).starts_with("SHA256:"));
        assert_eq!(key_type(&key(5)), "ssh-ed25519");
    }
}
