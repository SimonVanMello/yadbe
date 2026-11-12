//! TLS client certificates (M3-12, F-009) against servers that require one: PostgreSQL
//! (`cert` authentication) and MySQL (`REQUIRE X509`), from `dev/mtls.yml`. Unset
//! `YADBE_TEST_PG_MTLS_URL` / `YADBE_TEST_MYSQL_MTLS_URL`: SKIPPED. SQL Server and SQLite cannot
//! present a certificate (no capability), which `a_definition_without_the_capability_…` checks.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{blank, from_url, mysql_ca, pg_ca, skip};
use yadbe_lib::db::config::{ConnectionDefinition, TlsMode};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::{ErrorCode, YadbeError};
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretKind, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::manager::TunnelSecrets;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

const PASSPHRASE: &str = "yadbe-test-passphrase";

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tls")
        .join(name)
        .display()
        .to_string()
}

struct Harness {
    manager: Arc<ConnectionManager>,
    secrets: Arc<SecretStore>,
    store: Arc<Store>,
}

fn harness() -> Harness {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(RecordingSink::default());
    let log = Arc::new(StatementLog::new(sink.clone()));
    let manager = Arc::new(ConnectionManager::new(
        Arc::clone(&store),
        Arc::clone(&secrets),
        log,
        sink,
    ));
    Harness {
        manager,
        secrets,
        store,
    }
}

fn typed(passphrase: &str) -> TunnelSecrets {
    TunnelSecrets::from([(SecretKind::TlsKeyPassphrase, Secret::new(passphrase))])
}

fn with_identity(
    mut def: ConnectionDefinition,
    cert: &str,
    key: Option<&str>,
) -> ConnectionDefinition {
    def.tls_client_cert_path = Some(fixture(cert));
    def.tls_client_key_path = key.map(fixture);
    def
}

impl Harness {
    async fn test(
        &self,
        def: &ConnectionDefinition,
        password: Option<Secret>,
        secrets: TunnelSecrets,
    ) -> Result<(), YadbeError> {
        self.manager
            .test_with_tunnel("t".into(), def.clone(), password, None, secrets)
            .await
            .map(|_| ())
    }
}

/// Every way the identity can be given, against one server: no certificate is refused by the
/// server, each key format works, an encrypted key asks for its passphrase and refuses a wrong
/// one, and a key of another certificate is refused before any connection.
async fn check_identity(h: &Harness, base: ConnectionDefinition, password: Option<Secret>) {
    // Without a certificate the server refuses (the failure is the server's, not ours).
    let err = h
        .test(&base, password.clone(), TunnelSecrets::new())
        .await
        .expect_err("the server requires a client certificate");
    assert_ne!(err.code, ErrorCode::TlsClientCertInvalid, "{err:?}");

    // EC key in SEC1 form, in PKCS#8, and the same key encrypted with its passphrase.
    for key in ["client.sec1.key", "client.pkcs8.key"] {
        let def = with_identity(base.clone(), "client.crt", Some(key));
        h.test(&def, password.clone(), TunnelSecrets::new())
            .await
            .unwrap_or_else(|e| panic!("{key}: {e:?}"));
    }
    let encrypted = with_identity(base.clone(), "client.crt", Some("client.encrypted.key"));
    let err = h
        .test(&encrypted, password.clone(), TunnelSecrets::new())
        .await
        .expect_err("a passphrase is needed");
    assert_eq!(err.code, ErrorCode::TlsKeyPassphraseRequired, "{err:?}");
    let err = h
        .test(&encrypted, password.clone(), typed("nope"))
        .await
        .expect_err("wrong passphrase");
    assert_eq!(err.code, ErrorCode::TlsKeyPassphraseWrong, "{err:?}");
    h.test(&encrypted, password.clone(), typed(PASSPHRASE))
        .await
        .expect("the right passphrase connects");

    // The passphrase kept for the connection (keychain or session) is used without typing.
    let saved = h.store.create_connection(&encrypted).expect("save");
    h.secrets.set_session(
        &saved.id,
        SecretKind::TlsKeyPassphrase,
        Secret::new(PASSPHRASE),
    );
    h.manager
        .connect(&saved.id, password.clone())
        .await
        .expect("connects with the stored passphrase");
    let session = h.manager.session(&saved.id).expect("session");
    let conn = session.connection().expect("connection");
    let status = conn
        .query(
            // PostgreSQL shows the certificate's subject, MySQL the cipher of the TLS session.
            match base.engine {
                Engine::Postgres => {
                    "SELECT client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
                }
                _ => "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
            },
            1,
        )
        .await
        .expect("status");
    let shown = format!("{:?}", status.rows);
    match base.engine {
        Engine::Postgres => assert!(shown.contains("yadbe_client"), "{shown}"),
        _ => assert!(!shown.contains("\"\""), "{shown}"),
    }
    h.manager.disconnect(&saved.id).await;

    // A key that is not the certificate's is caught on our side, with a precise detail.
    let mismatched = with_identity(base.clone(), "client.crt", Some("other.pkcs8.key"));
    let err = h
        .test(&mismatched, password, TunnelSecrets::new())
        .await
        .expect_err("mismatched key");
    assert_eq!(err.code, ErrorCode::TlsClientCertInvalid, "{err:?}");
    assert!(
        err.detail.as_deref().unwrap_or("").contains("match"),
        "{err:?}"
    );
}

#[tokio::test]
async fn postgres_presents_its_client_certificate() {
    let Some(url) = std::env::var("YADBE_TEST_PG_MTLS_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
    else {
        skip(
            "postgres_presents_its_client_certificate",
            "YADBE_TEST_PG_MTLS_URL is not set",
        );
        return;
    };
    let Some(ca) = pg_ca("postgres_presents_its_client_certificate") else {
        return;
    };
    let (mut def, password) = from_url(&url);
    def.tls_mode = TlsMode::VerifyFull;
    def.ca_cert_path = Some(ca);
    check_identity(&harness(), def, password).await;
}

#[tokio::test]
async fn mysql_presents_its_client_certificate() {
    let Some(url) = std::env::var("YADBE_TEST_MYSQL_MTLS_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
    else {
        skip(
            "mysql_presents_its_client_certificate",
            "YADBE_TEST_MYSQL_MTLS_URL is not set",
        );
        return;
    };
    let Some(ca) = mysql_ca("mysql_presents_its_client_certificate") else {
        return;
    };
    let (mut def, password) = from_url(&url);
    def.tls_mode = TlsMode::VerifyFull;
    def.ca_cert_path = Some(ca);
    check_identity(&harness(), def, password).await;
}

/// SQL Server and SQLite have no client certificate: a definition that carries one (an old
/// file, a switched engine) loses it when normalized, so it is never half used.
#[test]
fn a_definition_without_the_capability_drops_its_certificate() {
    for engine in [Engine::Mssql, Engine::Sqlite] {
        let mut def = blank(engine, "x");
        def.host = if engine == Engine::Sqlite {
            String::new()
        } else {
            "localhost".into()
        };
        def.file_path = if engine == Engine::Sqlite {
            "/tmp/x.db".into()
        } else {
            String::new()
        };
        def.tls_client_cert_path = Some("/c/client.crt".into());
        def.tls_client_key_path = Some("/c/client.key".into());
        let def = def.normalized().expect("valid");
        assert_eq!(def.tls_client_cert_path, None, "{engine:?}");
        assert_eq!(def.tls_client_key_path, None, "{engine:?}");
        assert!(def.target().tls_identity.is_none());
    }
}
