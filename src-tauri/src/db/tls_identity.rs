//! TLS client certificate and private key (F-009): read from PEM files at connect time.
//!
//! The paths are part of the connection definition; the key's passphrase, when the key is
//! encrypted, is a secret (keychain only). The decrypted key lives only in memory, in a
//! buffer that is wiped on drop, and is handed to the drivers as PEM: PostgreSQL feeds it to
//! rustls itself, MySQL to `mysql_async`.

use std::fmt;
use std::path::Path;

use pkcs8::der::{Decode, SecretDocument};
use pkcs8::{EncryptedPrivateKeyInfoRef, LineEnding};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use zeroize::Zeroizing;

use crate::db::errors::YadbeError;
use crate::secrets::Secret;

const ENCRYPTED_BEGIN: &str = "-----BEGIN ENCRYPTED PRIVATE KEY-----";
const ENCRYPTED_END: &str = "-----END ENCRYPTED PRIVATE KEY-----";

/// The certificate chain the client presents and the matching, decrypted private key.
#[derive(Clone)]
pub struct TlsIdentity {
    cert_pem: Vec<u8>,
    key_pem: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for TlsIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TlsIdentity(***)")
    }
}

impl PartialEq for TlsIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.cert_pem == other.cert_pem && *self.key_pem == *other.key_pem
    }
}

impl Eq for TlsIdentity {}

fn invalid(detail: impl Into<String>) -> YadbeError {
    YadbeError::tls_client_cert_invalid(detail.into())
}

fn read(path: &Path, what: &str) -> Result<Zeroizing<Vec<u8>>, YadbeError> {
    std::fs::read(path)
        .map(Zeroizing::new)
        .map_err(|e| invalid(format!("cannot read the {what} {}: {e}", path.display())))
}

impl TlsIdentity {
    /// Reads and checks the two files. `key_path` `None`: the key sits in the certificate
    /// file (one combined PEM). Blocking: file reads and, for an encrypted key, the
    /// passphrase hashing.
    pub fn load(
        cert_path: &Path,
        key_path: Option<&Path>,
        passphrase: Option<&Secret>,
    ) -> Result<Self, YadbeError> {
        let cert = read(cert_path, "client certificate file")?;
        let key = match key_path {
            Some(path) => read(path, "client key file")?,
            None => cert.clone(),
        };
        Self::from_pem(&cert, &key, passphrase)
    }

    pub fn from_pem(
        cert_pem: &[u8],
        key_pem: &[u8],
        passphrase: Option<&Secret>,
    ) -> Result<Self, YadbeError> {
        let chain = CertificateDer::pem_slice_iter(cert_pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| invalid(format!("the certificate file is not valid PEM: {e}")))?;
        if chain.is_empty() {
            return Err(invalid("no certificate in the client certificate file"));
        }
        let key_pem = plain_key_pem(key_pem, passphrase)?;
        let key = PrivateKeyDer::from_pem_slice(&key_pem).map_err(|e| {
            invalid(format!(
                "no usable private key in the key file (PKCS#8, PKCS#1 or SEC1 PEM expected): {e}"
            ))
        })?;
        let signing = rustls::crypto::ring::sign::any_supported_type(&key)
            .map_err(|e| invalid(format!("unsupported private key: {e}")))?;
        rustls::sign::CertifiedKey::new(chain, signing)
            .keys_match()
            .map_err(|e| {
                invalid(format!(
                    "the private key does not match the certificate: {e}"
                ))
            })?;
        Ok(Self {
            cert_pem: cert_pem.to_vec(),
            key_pem,
        })
    }

    pub fn cert_chain(&self) -> Vec<CertificateDer<'static>> {
        CertificateDer::pem_slice_iter(&self.cert_pem)
            .filter_map(Result::ok)
            .collect()
    }

    pub fn private_key(&self) -> Result<PrivateKeyDer<'static>, YadbeError> {
        PrivateKeyDer::from_pem_slice(&self.key_pem).map_err(|e| invalid(e.to_string()))
    }

    pub fn cert_pem(&self) -> &[u8] {
        &self.cert_pem
    }

    /// The decrypted key as PEM, for drivers that read PEM themselves.
    pub fn key_pem(&self) -> &[u8] {
        &self.key_pem
    }
}

/// The key as unencrypted PEM: as is when it is not encrypted, decrypted (PKCS#8,
/// PBES2) when it is.
fn plain_key_pem(
    key_pem: &[u8],
    passphrase: Option<&Secret>,
) -> Result<Zeroizing<Vec<u8>>, YadbeError> {
    let text = std::str::from_utf8(key_pem)
        .map_err(|_| invalid("the key file must be PEM text, not binary (DER)"))?;
    if text.contains("Proc-Type: 4,ENCRYPTED") {
        return Err(invalid(
            "this key uses the legacy OpenSSL encryption; convert it with `openssl pkcs8 -topk8 -in key.pem -out key.pk8.pem`",
        ));
    }
    let Some(start) = text.find(ENCRYPTED_BEGIN) else {
        return Ok(Zeroizing::new(key_pem.to_vec()));
    };
    let block = &text[start..];
    let block = block
        .find(ENCRYPTED_END)
        .map_or(block, |end| &block[..end + ENCRYPTED_END.len()]);
    let passphrase = passphrase
        .filter(|p| !p.is_empty())
        .ok_or_else(YadbeError::tls_key_passphrase_required)?;
    let (_, document) = SecretDocument::from_pem(block)
        .map_err(|e| invalid(format!("the encrypted key is not valid PEM: {e}")))?;
    let info = EncryptedPrivateKeyInfoRef::from_der(document.as_bytes())
        .map_err(|e| invalid(format!("the encrypted key is malformed: {e}")))?;
    let decrypted = info
        .decrypt(passphrase.expose())
        .map_err(|e| YadbeError::tls_key_passphrase_wrong().with_detail(e.to_string()))?;
    let pem = decrypted
        .to_pem("PRIVATE KEY", LineEnding::LF)
        .map_err(|e| invalid(e.to_string()))?;
    Ok(Zeroizing::new(pem.as_bytes().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;

    const CERT: &[u8] = include_bytes!("../../tests/fixtures/tls/client.crt");
    const KEY_SEC1: &[u8] = include_bytes!("../../tests/fixtures/tls/client.sec1.key");
    const KEY_PKCS8: &[u8] = include_bytes!("../../tests/fixtures/tls/client.pkcs8.key");
    const KEY_ENCRYPTED: &[u8] = include_bytes!("../../tests/fixtures/tls/client.encrypted.key");
    const KEY_OTHER: &[u8] = include_bytes!("../../tests/fixtures/tls/other.pkcs8.key");
    const KEY_LEGACY: &[u8] = include_bytes!("../../tests/fixtures/tls/legacy.encrypted.key");
    const PASSPHRASE: &str = "yadbe-test-passphrase";

    fn code(result: Result<TlsIdentity, YadbeError>) -> ErrorCode {
        result.expect_err("an error").code
    }

    #[test]
    fn loads_every_unencrypted_key_format() {
        for key in [KEY_SEC1, KEY_PKCS8] {
            let identity = TlsIdentity::from_pem(CERT, key, None).expect("identity");
            assert_eq!(identity.cert_chain().len(), 1);
            identity.private_key().expect("key");
        }
    }

    #[test]
    fn decrypts_an_encrypted_key_with_its_passphrase() {
        let passphrase = Secret::new(PASSPHRASE);
        let identity = TlsIdentity::from_pem(CERT, KEY_ENCRYPTED, Some(&passphrase)).expect("ok");
        assert!(
            identity
                .key_pem()
                .starts_with(b"-----BEGIN PRIVATE KEY-----")
        );
        // The same key as the unencrypted export of the fixture.
        let plain = TlsIdentity::from_pem(CERT, KEY_PKCS8, None).expect("plain");
        assert_eq!(
            identity.private_key().expect("key"),
            plain.private_key().expect("key")
        );
    }

    #[test]
    fn asks_for_the_passphrase_of_an_encrypted_key() {
        assert_eq!(
            code(TlsIdentity::from_pem(CERT, KEY_ENCRYPTED, None)),
            ErrorCode::TlsKeyPassphraseRequired
        );
        let empty = Secret::new("");
        assert_eq!(
            code(TlsIdentity::from_pem(CERT, KEY_ENCRYPTED, Some(&empty))),
            ErrorCode::TlsKeyPassphraseRequired
        );
    }

    #[test]
    fn a_wrong_passphrase_is_told_apart() {
        let wrong = Secret::new("not the passphrase");
        let err =
            TlsIdentity::from_pem(CERT, KEY_ENCRYPTED, Some(&wrong)).expect_err("wrong passphrase");
        assert_eq!(err.code, ErrorCode::TlsKeyPassphraseWrong);
        // Neither the passphrase nor key material reaches the message or the detail.
        let shown = format!("{err:?}");
        assert!(!shown.contains("not the passphrase"));
    }

    #[test]
    fn a_key_that_does_not_match_the_certificate_is_refused() {
        let err = TlsIdentity::from_pem(CERT, KEY_OTHER, None).expect_err("mismatch");
        assert_eq!(err.code, ErrorCode::TlsClientCertInvalid);
        assert!(err.detail.as_deref().unwrap_or("").contains("match"));
    }

    #[test]
    fn reads_a_combined_pem_file() {
        let mut combined = CERT.to_vec();
        combined.extend_from_slice(KEY_PKCS8);
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("client.pem");
        std::fs::write(&path, combined).expect("write");
        TlsIdentity::load(&path, None, None).expect("combined");
    }

    #[test]
    fn bad_files_are_reported_with_a_detail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing.pem");
        let err = TlsIdentity::load(&missing, None, None).expect_err("missing");
        assert_eq!(err.code, ErrorCode::TlsClientCertInvalid);
        assert!(err.detail.as_deref().unwrap_or("").contains("missing.pem"));

        assert_eq!(
            code(TlsIdentity::from_pem(b"not a pem", KEY_PKCS8, None)),
            ErrorCode::TlsClientCertInvalid
        );
        assert_eq!(
            code(TlsIdentity::from_pem(CERT, b"-----BEGIN NOPE-----", None)),
            ErrorCode::TlsClientCertInvalid
        );
        assert_eq!(
            code(TlsIdentity::from_pem(CERT, &[0xff, 0xfe, 0x00], None)),
            ErrorCode::TlsClientCertInvalid
        );
    }

    #[test]
    fn the_legacy_openssl_encryption_says_how_to_convert() {
        let err = TlsIdentity::from_pem(CERT, KEY_LEGACY, None).expect_err("legacy");
        assert_eq!(err.code, ErrorCode::TlsClientCertInvalid);
        assert!(
            err.detail
                .as_deref()
                .unwrap_or("")
                .contains("openssl pkcs8")
        );
    }

    #[test]
    fn debug_never_prints_the_key() {
        let identity = TlsIdentity::from_pem(CERT, KEY_PKCS8, None).expect("identity");
        assert_eq!(format!("{identity:?}"), "TlsIdentity(***)");
    }
}
