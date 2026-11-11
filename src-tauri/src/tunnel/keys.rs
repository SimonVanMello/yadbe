//! Private key files: read at connect time (never copied or stored), OpenSSH and PEM
//! (PKCS#1, PKCS#8, SEC1, legacy encrypted PEM), Ed25519 / ECDSA / RSA, encrypted or not.

use std::path::{Path, PathBuf};

use russh::keys::PrivateKey;
use zeroize::Zeroizing;

use crate::db::errors::YadbeError;
use crate::secrets::{Secret, SecretKind};
use crate::tunnel::errors::HopRef;

/// Larger files are not keys (an RSA 16k key in PEM is about 12 KiB).
const MAX_KEY_FILE_BYTES: u64 = 64 * 1024;

/// The user's home folder.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `~` and `~/…` → the home folder.
pub fn expand_tilde(path: &str) -> PathBuf {
    let rest = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\"))
        .or_else(|| (path == "~").then_some(""));
    match (rest, home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// Whether the key text is encrypted (needs a passphrase).
fn is_encrypted(text: &str) -> bool {
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || text.contains("Proc-Type: 4,ENCRYPTED")
    {
        return true;
    }
    text.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
        && russh::keys::ssh_key::PrivateKey::from_openssh(text.trim())
            .is_ok_and(|key| key.is_encrypted())
}

fn read_key_file(path: &Path) -> std::io::Result<Zeroizing<String>> {
    use std::io::Read as _;
    let file = std::fs::File::open(path)?;
    let mut text = Zeroizing::new(String::new());
    file.take(MAX_KEY_FILE_BYTES).read_to_string(&mut text)?;
    Ok(text)
}

/// Reads and decodes a private key. `passphrase_kind`: the secret to ask for when the key is
/// encrypted and no passphrase was given. Blocking (file read, key derivation).
pub fn load_private_key(
    hop: &HopRef,
    path: &str,
    passphrase: Option<&Secret>,
    passphrase_kind: SecretKind,
) -> Result<PrivateKey, YadbeError> {
    let file = expand_tilde(path);
    let text = read_key_file(&file)
        .map_err(|e| YadbeError::ssh_key_unreadable(hop, path).with_detail(e.to_string()))?;
    let encrypted = is_encrypted(&text);
    if encrypted && passphrase.is_none() {
        return Err(YadbeError::ssh_secret_required(hop, passphrase_kind));
    }
    let password = if encrypted {
        passphrase.map(Secret::expose)
    } else {
        None
    };
    russh::keys::decode_secret_key(&text, password).map_err(|err| {
        if encrypted {
            YadbeError::ssh_key_passphrase_wrong(hop, path, passphrase_kind)
        } else {
            YadbeError::ssh_key_unreadable(hop, path).with_detail(err.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;
    use crate::tunnel::model::TunnelHop;

    fn hop() -> HopRef {
        HopRef {
            hop: TunnelHop::Server,
            host: "bastion".into(),
            port: 22,
        }
    }

    /// An Ed25519 key from a fixed seed, in OpenSSH format.
    fn ed25519_text() -> String {
        use russh::keys::ssh_key::{LineEnding, private::Ed25519Keypair};
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7; 32]));
        key.to_openssh(LineEnding::LF).expect("encode").to_string()
    }

    fn write(dir: &Path, name: &str, text: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, text).expect("write key");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn reads_an_unencrypted_openssh_key() {
        let dir = tempfile::tempdir().expect("dir");
        let path = write(dir.path(), "id_ed25519", &ed25519_text());
        let key = load_private_key(&hop(), &path, None, SecretKind::SshPassphrase).expect("key");
        assert_eq!(key.algorithm().as_str(), "ssh-ed25519");
    }

    #[test]
    fn typed_errors_for_missing_and_garbage_files() {
        let dir = tempfile::tempdir().expect("dir");
        let missing = dir.path().join("nope").to_string_lossy().into_owned();
        let err = load_private_key(&hop(), &missing, None, SecretKind::SshPassphrase)
            .expect_err("missing");
        assert_eq!(err.code, ErrorCode::SshKeyUnreadable);
        let garbage = write(dir.path(), "garbage", "not a key");
        let err = load_private_key(&hop(), &garbage, None, SecretKind::SshPassphrase)
            .expect_err("garbage");
        assert_eq!(err.code, ErrorCode::SshKeyUnreadable);
        assert_eq!(
            err.tunnel.map(|t| t.hop),
            Some(TunnelHop::Server),
            "the hop is named"
        );
    }

    #[test]
    fn tilde_expands_to_home() {
        if let Some(home) = home_dir() {
            assert_eq!(expand_tilde("~/.ssh/id"), home.join(".ssh/id"));
        }
        assert_eq!(expand_tilde("/abs/key"), PathBuf::from("/abs/key"));
    }
}
