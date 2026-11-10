//! Shared helpers of the integration tests.
#![allow(dead_code)]

use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use yadbe_lib::db::config::{
    AuthMethod, ConnectionDefinition, ConnectionOption, Environment, TlsMode,
};
use yadbe_lib::db::connstring;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::driver::{ConnectRequest, Connection, Driver, NoRecorder};
use yadbe_lib::db::drivers;
use yadbe_lib::db::errors::YadbeError;
use yadbe_lib::events::{BackendEvent, RecordingSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::{ConnectionManager, ConnectionState, SessionConfig};
use yadbe_lib::store::Store;

pub const PG_URL_ENV: &str = "YADBE_TEST_PG_URL";
pub const PG_CA_ENV: &str = "YADBE_TEST_PG_CA";
pub const MSSQL_URL_ENV: &str = "YADBE_TEST_MSSQL_URL";
pub const MSSQL_CA_ENV: &str = "YADBE_TEST_MSSQL_CA";

/// Prints a skip notice that `cargo test` does not capture (it only captures the print
/// macros), so a skipped test is visible, never silently passed.
pub fn skip(test: &str, why: &str) {
    let _ = writeln!(std::io::stderr(), "SKIPPED {test}: {why}");
}

/// The PostgreSQL test URL, or `None` after printing a skip notice.
pub fn pg_url(test: &str) -> Option<String> {
    match std::env::var(PG_URL_ENV) {
        Ok(url) if !url.trim().is_empty() => Some(url),
        _ => {
            skip(test, &format!("{PG_URL_ENV} is not set"));
            None
        }
    }
}

/// The SQL Server test URL, or `None` after printing a skip notice.
pub fn mssql_url(test: &str) -> Option<String> {
    match std::env::var(MSSQL_URL_ENV) {
        Ok(url) if !url.trim().is_empty() => Some(url),
        _ => {
            skip(test, &format!("{MSSQL_URL_ENV} is not set"));
            None
        }
    }
}

/// The CA that signs the SQL Server test instance's `localhost` certificate
/// (`dev/compose.yml` installs the one of `dev/tls-certs.sh`).
pub fn mssql_ca(test: &str) -> Option<String> {
    match std::env::var(MSSQL_CA_ENV) {
        Ok(path) if !path.trim().is_empty() => Some(path),
        _ => {
            skip(test, &format!("{MSSQL_CA_ENV} is not set"));
            None
        }
    }
}

/// The CA that signs the test server's certificate (`dev/tls-certs.sh`).
pub fn pg_ca(test: &str) -> Option<String> {
    match std::env::var(PG_CA_ENV) {
        Ok(path) if !path.trim().is_empty() => Some(path),
        _ => {
            skip(test, &format!("{PG_CA_ENV} is not set"));
            None
        }
    }
}

pub fn blank(engine: Engine, name: &str) -> ConnectionDefinition {
    ConnectionDefinition {
        name: name.to_owned(),
        engine,
        host: String::new(),
        port: None,
        database: String::new(),
        username: String::new(),
        file_path: String::new(),
        auth: AuthMethod::None,
        tls_mode: TlsMode::Prefer,
        ca_cert_path: None,
        connect_timeout_secs: Some(5),
        options: Vec::new(),
        group_id: None,
        environment: Environment::default(),
        favorite: false,
        read_only: false,
        remember_password: true,
    }
}

/// A definition and its password from a connection URL, through yadbe's own parser.
pub fn from_url(url: &str) -> (ConnectionDefinition, Option<Secret>) {
    let parsed = connstring::parse(url, None).expect("valid test URL");
    let f = parsed.fields;
    let engine = f.engine.expect("engine");
    let mut def = blank(engine, "test");
    def.host = f.host.unwrap_or_default();
    def.port = f.port;
    def.database = f.database.unwrap_or_default();
    def.username = f.username.unwrap_or_default();
    def.file_path = f.file_path.unwrap_or_default();
    def.tls_mode = f.tls_mode.unwrap_or(TlsMode::Prefer);
    def.ca_cert_path = f.ca_cert_path;
    def.options = f.options;
    def.auth = if parsed.password.is_some() {
        AuthMethod::Password
    } else {
        AuthMethod::None
    };
    (def, parsed.password)
}

/// PostgreSQL definition with the session time zone pinned, so timestamps compare.
pub fn pg_definition(url: &str) -> (ConnectionDefinition, Option<Secret>) {
    let (mut def, password) = from_url(url);
    def.options.push(ConnectionOption {
        key: "options".into(),
        value: "-c TimeZone=UTC -c IntervalStyle=postgres".into(),
    });
    (def, password)
}

pub fn driver(engine: Engine) -> Arc<dyn Driver> {
    drivers::builtin()
        .into_iter()
        .find(|d| d.engine() == engine)
        .expect("driver")
}

pub async fn open(
    def: &ConnectionDefinition,
    password: Option<&Secret>,
) -> Result<Box<dyn Connection>, YadbeError> {
    let target = def.target();
    driver(def.engine)
        .connect(ConnectRequest {
            target: &target,
            password,
            recorder: Arc::new(NoRecorder),
        })
        .await
}

pub struct Harness {
    pub store: Arc<Store>,
    pub secrets: Arc<SecretStore>,
    pub log: Arc<StatementLog>,
    pub sink: Arc<RecordingSink>,
    pub manager: ConnectionManager,
}

pub fn harness() -> Harness {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(RecordingSink::default());
    let log = Arc::new(StatementLog::new(sink.clone()));
    let manager = ConnectionManager::new(
        Arc::clone(&store),
        Arc::clone(&secrets),
        Arc::clone(&log),
        sink.clone(),
    )
    .with_config(SessionConfig {
        reconnect_delays: vec![
            Duration::from_millis(50),
            Duration::from_millis(200),
            Duration::from_millis(500),
        ],
    });
    Harness {
        store,
        secrets,
        log,
        sink,
        manager,
    }
}

impl Harness {
    /// States emitted for `connection_id`, in order.
    pub fn states(&self, connection_id: &str) -> Vec<ConnectionState> {
        self.sink
            .events()
            .into_iter()
            .filter_map(|event| match event {
                BackendEvent::ConnectionStateChanged(e)
                    if e.session.connection_id == connection_id =>
                {
                    Some(e.session.state)
                }
                _ => None,
            })
            .collect()
    }

    /// Waits until the states emitted for `connection_id` are exactly `expected`.
    pub async fn wait_for_states(&self, connection_id: &str, expected: &[ConnectionState]) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while self.states(connection_id) != expected {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {expected:?}; states: {:?}",
                self.states(connection_id)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Waits until the last emitted state of `connection_id` is `state`.
    pub async fn wait_for_state(&self, connection_id: &str, state: ConnectionState) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while self.states(connection_id).last() != Some(&state) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {state:?}; states: {:?}",
                self.states(connection_id)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
