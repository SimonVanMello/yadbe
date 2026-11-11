//! SSH tunnels (F-010) against real OpenSSH servers (`dev/ssh-test.sh`, then
//! `YADBE_TEST_SSH_DIR` / `YADBE_TEST_SSH_PORT`) in front of PostgreSQL (`YADBE_TEST_PG_URL`)
//! and SQL Server (`YADBE_TEST_MSSQL_URL`). Missing servers: the tests print SKIPPED.
//!
//! The database host and port are the test URL's, as seen from the SSH server (the same
//! machine here). Tests never read the user's `~/.ssh`: host keys are trusted in the test
//! store, the agent is the one the script started.

mod common;
mod query_common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{mssql_url, pg_ca, pg_definition, pg_url, skip};
use query_common::{Bench, History, TimedSink};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use yadbe_lib::db::config::{ConnectionDefinition, TlsMode};
use yadbe_lib::db::errors::{ErrorCode, YadbeError};
use yadbe_lib::events::BackendEvent;
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretKind, SecretStore};
use yadbe_lib::session::manager::TunnelSecrets;
use yadbe_lib::session::query_model::{ExecuteScope, ExecutionStatus, ResultLimits, ResumeMode};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::{ConnectionManager, ConnectionState, QueryRunner, SessionConfig};
use yadbe_lib::store::Store;
use yadbe_lib::tunnel::{AgentLocation, SshAuthMethod, SshHop, SshTunnel, TunnelHop, TunnelPhase};

const USER: &str = "yadbe-ssh";
const PASSWORD: &str = "yadbe-ssh-pw1";
const PASSPHRASE: &str = "yadbe-key-pw1";

struct Ssh {
    dir: PathBuf,
    /// Tunnel server; +1 jump host; +2 no TCP forwarding.
    port: u16,
}

fn ssh(test: &str) -> Option<Ssh> {
    let dir = match std::env::var("YADBE_TEST_SSH_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => {
            skip(test, "YADBE_TEST_SSH_DIR is not set (dev/ssh-test.sh)");
            return None;
        }
    };
    let port = std::env::var("YADBE_TEST_SSH_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(2222);
    Some(Ssh { dir, port })
}

impl Ssh {
    fn key(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }

    fn hop(&self, port: u16, auth: SshAuthMethod, key: Option<&str>) -> SshHop {
        SshHop {
            host: "127.0.0.1".into(),
            port: Some(port),
            username: USER.into(),
            auth,
            key_path: key.map(|k| self.key(k)),
            remember_secret: false,
        }
    }

    fn password_hop(&self) -> SshHop {
        self.hop(self.port, SshAuthMethod::Password, None)
    }
}

fn host_key(path: &Path) -> (String, String) {
    let key = russh::keys::load_public_key(path).expect("host public key");
    (
        key.algorithm().as_str().to_owned(),
        key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
    )
}

fn tunnel(server: SshHop) -> SshTunnel {
    SshTunnel {
        server,
        jump: None,
        keepalive_secs: Some(5),
    }
}

fn secrets(pairs: &[(SecretKind, &str)]) -> TunnelSecrets {
    pairs
        .iter()
        .map(|(kind, value)| (*kind, Secret::new(*value)))
        .collect()
}

/// A manager over an in-memory store, with the script's agent.
struct Env {
    store: Arc<Store>,
    secrets: Arc<SecretStore>,
    log: Arc<StatementLog>,
    sink: Arc<TimedSink>,
    manager: Arc<ConnectionManager>,
}

fn env(ssh: &Ssh) -> Env {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(TimedSink::default());
    let log = Arc::new(StatementLog::new(sink.clone()));
    let manager = Arc::new(
        ConnectionManager::new(
            Arc::clone(&store),
            Arc::clone(&secrets),
            Arc::clone(&log),
            sink.clone(),
        )
        .with_agent(AgentLocation(Some(ssh.dir.join("agent.sock"))))
        .with_config(SessionConfig {
            reconnect_delays: vec![
                Duration::from_millis(100),
                Duration::from_millis(500),
                Duration::from_secs(1),
                Duration::from_secs(2),
            ],
        }),
    );
    Env {
        store,
        secrets,
        log,
        sink,
        manager,
    }
}

impl Env {
    fn trust(&self, port: u16, host_key_file: &Path) {
        let (key_type, fingerprint) = host_key(host_key_file);
        self.manager
            .host_keys()
            .trust("127.0.0.1", port, &key_type, &fingerprint)
            .expect("trust");
    }

    fn trust_all(&self, ssh: &Ssh) {
        self.trust(ssh.port, &ssh.dir.join("host_ed25519.pub"));
        self.trust(ssh.port + 1, &ssh.dir.join("host_jump_ed25519.pub"));
        self.trust(ssh.port + 2, &ssh.dir.join("host_nofwd_ed25519.pub"));
    }

    async fn test(
        &self,
        def: &ConnectionDefinition,
        password: Option<&Secret>,
        tunnel_secrets: TunnelSecrets,
    ) -> Result<String, YadbeError> {
        self.manager
            .test_with_tunnel(
                uuid(),
                def.clone().normalized()?,
                password.cloned(),
                None,
                tunnel_secrets,
            )
            .await
            .map(|r| r.server_version)
    }

    fn logged(&self) -> Vec<String> {
        self.log.entries().into_iter().map(|e| e.sql).collect()
    }

    fn tunnel_phases(&self, connection_id: &str) -> Vec<(ConnectionState, Option<TunnelPhase>)> {
        self.sink
            .events()
            .into_iter()
            .filter_map(|e| match e {
                BackendEvent::ConnectionStateChanged(e)
                    if e.session.connection_id == connection_id =>
                {
                    Some((e.session.state, e.session.tunnel.map(|t| t.phase)))
                }
                _ => None,
            })
            .collect()
    }

    /// Saves and connects `def`; a runner on top, as `query_common::Bench`.
    async fn bench(
        self,
        def: ConnectionDefinition,
        password: Option<Secret>,
        tunnel_secrets: TunnelSecrets,
    ) -> (Bench, Arc<SecretStore>) {
        let saved = self.store.create_connection(&def).expect("save");
        self.manager
            .connect_with_tunnel(&saved.id, password, tunnel_secrets)
            .await
            .expect("connect through the tunnel");
        let history = Arc::new(History::default());
        let runner = Arc::new(QueryRunner::new(
            Arc::clone(&self.manager),
            self.sink.clone(),
            history.clone(),
        ));
        (
            Bench {
                runner,
                manager: self.manager,
                sink: self.sink,
                log: self.log,
                history,
                store: self.store,
                connection_id: saved.id,
            },
            self.secrets,
        )
    }
}

fn uuid() -> String {
    format!("{:?}", Instant::now())
}

fn tunnel_hop(err: &YadbeError) -> Option<TunnelHop> {
    err.tunnel.as_ref().map(|t| t.hop)
}

fn pg(test: &str) -> Option<(Ssh, ConnectionDefinition, Option<Secret>)> {
    let ssh = ssh(test)?;
    let url = pg_url(test)?;
    let (def, password) = pg_definition(&url);
    Some((ssh, def, password))
}

/// A TCP relay in front of an SSH server, to cut the SSH connections it carries.
struct Relay {
    port: u16,
    accepted: Arc<AtomicUsize>,
    links: Arc<Mutex<Vec<JoinHandle<()>>>>,
    task: JoinHandle<()>,
}

impl Relay {
    async fn start(to: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let links: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let (count, held) = (Arc::clone(&accepted), Arc::clone(&links));
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut inbound, _)) = listener.accept().await else {
                    return;
                };
                count.fetch_add(1, Ordering::SeqCst);
                held.lock().expect("links").push(tokio::spawn(async move {
                    if let Ok(mut outbound) = TcpStream::connect(("127.0.0.1", to)).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                }));
            }
        });
        Self {
            port,
            accepted,
            links,
            task,
        }
    }

    /// Drops every relayed connection (a dead network link, as far as both ends know).
    fn cut(&self) {
        for link in self.links.lock().expect("links").drain(..) {
            link.abort();
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.cut();
        self.task.abort();
    }
}

#[tokio::test]
async fn password_auth_asks_for_the_secret_then_the_host_key() {
    let Some((ssh, mut def, password)) = pg("password_auth_asks_for_the_secret_then_the_host_key")
    else {
        return;
    };
    let env = env(&ssh);
    def.ssh = Some(tunnel(ssh.password_hop()));

    let err = env
        .test(&def, password.as_ref(), TunnelSecrets::new())
        .await
        .expect_err("no SSH password");
    assert_eq!(err.code, ErrorCode::SshSecretRequired, "{err:?}");
    assert_eq!(
        err.tunnel.as_ref().and_then(|t| t.secret),
        Some(SecretKind::SshPassword)
    );

    let typed = secrets(&[(SecretKind::SshPassword, PASSWORD)]);
    let err = env
        .test(&def, password.as_ref(), typed.clone())
        .await
        .expect_err("unknown host key");
    assert_eq!(err.code, ErrorCode::SshHostKeyUnknown, "{err:?}");
    let failure = err.tunnel.clone().expect("tunnel failure");
    assert_eq!(failure.hop, TunnelHop::Server);
    let (key_type, fingerprint) = host_key(&ssh.dir.join("host_ed25519.pub"));
    assert_eq!(failure.key_type.as_deref(), Some(key_type.as_str()));
    assert_eq!(failure.fingerprint.as_deref(), Some(fingerprint.as_str()));
    assert!(err.message.en.contains(&fingerprint));

    // The user accepts the fingerprint they were shown.
    env.manager
        .host_keys()
        .trust(&failure.host, failure.port, &key_type, &fingerprint)
        .expect("trust");
    let version = env
        .test(&def, password.as_ref(), typed.clone())
        .await
        .expect("test through the tunnel");
    assert!(version.starts_with("PostgreSQL"), "{version}");
    let logged = env.logged();
    assert!(
        logged
            .iter()
            .any(|l| l.starts_with("-- SSH tunnel open: ssh yadbe-ssh@127.0.0.1")),
        "{logged:?}"
    );
    assert!(logged.iter().any(|l| l.starts_with("-- SSH tunnel closed")));

    let wrong = secrets(&[(SecretKind::SshPassword, "nope")]);
    let err = env
        .test(&def, password.as_ref(), wrong)
        .await
        .expect_err("wrong password");
    assert_eq!(err.code, ErrorCode::SshAuthFailed, "{err:?}");
    assert_eq!(
        err.tunnel.as_ref().and_then(|t| t.secret),
        Some(SecretKind::SshPassword)
    );

    // A saved connection: the typed password is kept for the session once it worked, and the
    // states say the tunnel opened before the database connection.
    let saved = env.store.create_connection(&def).expect("save");
    let info = env
        .manager
        .connect_with_tunnel(&saved.id, password.clone(), typed)
        .await
        .expect("connect");
    assert_eq!(info.state, ConnectionState::Connected);
    assert_eq!(info.tunnel.map(|t| t.phase), Some(TunnelPhase::Open));
    assert_eq!(
        env.secrets
            .get(&saved.id, SecretKind::SshPassword)
            .expect("get")
            .map(|s| s.expose().to_owned())
            .as_deref(),
        Some(PASSWORD)
    );
    let phases = env.tunnel_phases(&saved.id);
    assert_eq!(
        phases,
        vec![
            (ConnectionState::Connecting, Some(TunnelPhase::Down)),
            (ConnectionState::Connecting, Some(TunnelPhase::Opening)),
            (ConnectionState::Connected, Some(TunnelPhase::Open)),
        ]
    );
    let session = env.manager.session(&saved.id).expect("session");
    let one = session.query("SELECT 1", 1).await.expect("query");
    assert_eq!(one.scalar_text().as_deref(), Some("1"));
    env.manager.disconnect(&saved.id).await;
    assert!(
        env.logged()
            .iter()
            .any(|l| l.starts_with("-- SSH tunnel closed")),
        "closing the session closes the tunnel"
    );
}

#[tokio::test]
async fn every_key_format_and_the_agent() {
    let Some((ssh, mut def, password)) = pg("every_key_format_and_the_agent") else {
        return;
    };
    let env = env(&ssh);
    env.trust_all(&ssh);
    let none = TunnelSecrets::new();
    let with_passphrase = secrets(&[(SecretKind::SshPassphrase, PASSPHRASE)]);
    for (key, typed) in [
        ("id_ed25519", &none),
        ("id_rsa_pkcs8", &none),
        ("id_ecdsa_enc", &with_passphrase),
        ("id_rsa_pem_enc", &with_passphrase),
    ] {
        def.ssh = Some(tunnel(ssh.hop(ssh.port, SshAuthMethod::Key, Some(key))));
        env.test(&def, password.as_ref(), typed.clone())
            .await
            .unwrap_or_else(|e| panic!("{key}: {e:?}"));
    }

    def.ssh = Some(tunnel(ssh.hop(
        ssh.port,
        SshAuthMethod::Key,
        Some("id_ecdsa_enc"),
    )));
    let err = env
        .test(&def, password.as_ref(), none.clone())
        .await
        .expect_err("encrypted without passphrase");
    assert_eq!(err.code, ErrorCode::SshSecretRequired, "{err:?}");
    assert_eq!(
        err.tunnel.as_ref().and_then(|t| t.secret),
        Some(SecretKind::SshPassphrase)
    );
    let err = env
        .test(
            &def,
            password.as_ref(),
            secrets(&[(SecretKind::SshPassphrase, "wrong")]),
        )
        .await
        .expect_err("wrong passphrase");
    assert_eq!(err.code, ErrorCode::SshKeyPassphraseWrong, "{err:?}");

    def.ssh = Some(tunnel(ssh.hop(
        ssh.port,
        SshAuthMethod::Key,
        Some("missing_key"),
    )));
    let err = env
        .test(&def, password.as_ref(), none.clone())
        .await
        .expect_err("missing key file");
    assert_eq!(err.code, ErrorCode::SshKeyUnreadable, "{err:?}");

    def.ssh = Some(tunnel(ssh.hop(ssh.port, SshAuthMethod::Agent, None)));
    env.test(&def, password.as_ref(), none.clone())
        .await
        .expect("agent");

    let other = Env {
        manager: Arc::new(
            ConnectionManager::new(
                Arc::clone(&env.store),
                Arc::clone(&env.secrets),
                Arc::clone(&env.log),
                env.sink.clone(),
            )
            .with_agent(AgentLocation(Some(ssh.dir.join("no-agent.sock")))),
        ),
        store: Arc::clone(&env.store),
        secrets: Arc::clone(&env.secrets),
        log: Arc::clone(&env.log),
        sink: env.sink.clone(),
    };
    let err = other
        .test(&def, password.as_ref(), none)
        .await
        .expect_err("no agent");
    assert_eq!(err.code, ErrorCode::SshAgentUnavailable, "{err:?}");
}

#[tokio::test]
async fn jump_host_and_hop_errors() {
    let Some((ssh, mut def, password)) = pg("jump_host_and_hop_errors") else {
        return;
    };
    let env = env(&ssh);
    let mut through_jump = tunnel(ssh.hop(ssh.port, SshAuthMethod::Key, Some("id_ed25519")));
    through_jump.jump = Some(ssh.hop(ssh.port + 1, SshAuthMethod::Password, None));
    def.ssh = Some(through_jump);
    let typed = secrets(&[(SecretKind::JumpPassword, PASSWORD)]);

    let err = env
        .test(&def, password.as_ref(), typed.clone())
        .await
        .expect_err("jump host key unknown");
    assert_eq!(err.code, ErrorCode::SshHostKeyUnknown, "{err:?}");
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Jump));
    env.trust(ssh.port + 1, &ssh.dir.join("host_jump_ed25519.pub"));
    let err = env
        .test(&def, password.as_ref(), typed.clone())
        .await
        .expect_err("server host key unknown");
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Server), "{err:?}");
    env.trust(ssh.port, &ssh.dir.join("host_ed25519.pub"));
    env.test(&def, password.as_ref(), typed.clone())
        .await
        .expect("through the jump host");

    let err = env
        .test(
            &def,
            password.as_ref(),
            secrets(&[(SecretKind::JumpPassword, "nope")]),
        )
        .await
        .expect_err("wrong jump password");
    assert_eq!(err.code, ErrorCode::SshAuthFailed);
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Jump));
    assert_eq!(
        err.tunnel.as_ref().and_then(|t| t.secret),
        Some(SecretKind::JumpPassword)
    );

    // Nothing listens there, as seen from the jump host.
    let mut wrong_server = def.ssh.clone().expect("ssh");
    wrong_server.server.port = Some(1);
    def.ssh = Some(wrong_server);
    let err = env
        .test(&def, password.as_ref(), typed)
        .await
        .expect_err("server unreachable from the jump host");
    assert_eq!(err.code, ErrorCode::SshHostUnreachable, "{err:?}");
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Server));
}

#[tokio::test]
async fn unreachable_refused_and_changed_keys() {
    let Some((ssh, mut def, password)) = pg("unreachable_refused_and_changed_keys") else {
        return;
    };
    let env = env(&ssh);
    env.trust_all(&ssh);
    let key = |port| tunnel(ssh.hop(port, SshAuthMethod::Key, Some("id_ed25519")));
    let none = TunnelSecrets::new;

    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .expect("free port")
        .port();
    def.ssh = Some(key(closed));
    let err = env
        .test(&def, password.as_ref(), none())
        .await
        .expect_err("no SSH server");
    assert_eq!(err.code, ErrorCode::SshHostUnreachable, "{err:?}");
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Server));

    def.ssh = Some(key(ssh.port + 2));
    let err = env
        .test(&def, password.as_ref(), none())
        .await
        .expect_err("forwarding disabled");
    assert_eq!(err.code, ErrorCode::SshChannelRefused, "{err:?}");
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Database));

    def.ssh = Some(key(ssh.port));
    let mut no_database = def.clone();
    no_database.port = Some(1);
    let err = env
        .test(&no_database, password.as_ref(), none())
        .await
        .expect_err("database unreachable from the SSH server");
    assert_eq!(err.code, ErrorCode::ConnectionRefused, "{err:?}");
    assert_eq!(tunnel_hop(&err), Some(TunnelHop::Database));

    // A key of the same type with another fingerprint is known for this host: refused, and
    // trusting the new one is refused until the old one is forgotten.
    let relay = Relay::start(ssh.port).await;
    env.store
        .add_known_host("127.0.0.1", relay.port, "ssh-ed25519", "SHA256:another-key")
        .expect("known");
    def.ssh = Some(key(relay.port));
    let err = env
        .test(&def, password.as_ref(), none())
        .await
        .expect_err("changed host key");
    assert_eq!(err.code, ErrorCode::SshHostKeyChanged, "{err:?}");
    let failure = err.tunnel.clone().expect("failure");
    assert!(
        env.manager
            .host_keys()
            .trust(
                "127.0.0.1",
                relay.port,
                failure.key_type.as_deref().unwrap_or_default(),
                failure.fingerprint.as_deref().unwrap_or_default(),
            )
            .is_err()
    );
    env.store
        .forget_known_host("127.0.0.1", relay.port, None)
        .expect("forget");
    let err = env
        .test(&def, password.as_ref(), none())
        .await
        .expect_err("now unknown");
    assert_eq!(err.code, ErrorCode::SshHostKeyUnknown, "{err:?}");
}

#[tokio::test]
async fn one_tunnel_for_every_connection_and_reconnect_after_a_drop() {
    let Some((ssh, mut def, password)) =
        pg("one_tunnel_for_every_connection_and_reconnect_after_a_drop")
    else {
        return;
    };
    let env = env(&ssh);
    let relay = Relay::start(ssh.port).await;
    env.trust(relay.port, &ssh.dir.join("host_ed25519.pub"));
    def.ssh = Some(tunnel(ssh.hop(
        relay.port,
        SshAuthMethod::Key,
        Some("id_ed25519"),
    )));
    let (b, _) = env.bench(def, password, TunnelSecrets::new()).await;

    // Several tabs at once (each its own server connection), one SSH connection.
    let runs: Vec<_> = (0..4)
        .map(|i| {
            b.start(b.request(
                &format!("tab{i}"),
                &format!("SELECT {i}, pg_sleep(0.2)"),
                ExecuteScope::All,
            ))
            .expect("start")
            .0
        })
        .collect();
    for id in runs {
        assert_eq!(b.wait(id).await.status, ExecutionStatus::Succeeded);
    }
    assert_eq!(
        relay.accepted.load(Ordering::SeqCst),
        1,
        "one SSH connection"
    );

    // The SSH link dies: the database links die with it, the session reopens the tunnel then
    // its connection, and nothing is replayed.
    relay.cut();
    let session = b.manager.session(&b.connection_id).expect("session");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let info = session.info();
        let reopened = relay.accepted.load(Ordering::SeqCst) >= 2;
        if reopened && info.state == ConnectionState::Connected {
            break;
        }
        assert!(Instant::now() < deadline, "no reconnection: {info:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let states: Vec<_> = b
        .sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::ConnectionStateChanged(e) => {
                Some((e.session.state, e.session.tunnel.map(|t| t.phase)))
            }
            _ => None,
        })
        .collect();
    assert!(
        states.contains(&(ConnectionState::Lost, Some(TunnelPhase::Down))),
        "{states:?}"
    );
    assert!(
        states.contains(&(ConnectionState::Reconnecting, Some(TunnelPhase::Opening))),
        "{states:?}"
    );
    let one = session
        .query("SELECT 1", 1)
        .await
        .expect("query after reconnect");
    assert_eq!(one.scalar_text().as_deref(), Some("1"));
    let run = b.run("tab0", "SELECT 2").await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert!(
        b.logged()
            .iter()
            .any(|l| l.starts_with("-- SSH tunnel dropped")),
        "{:?}",
        b.logged()
    );
}

#[tokio::test]
async fn a_million_rows_with_backpressure_and_cancel() {
    let Some((ssh, mut def, password)) = pg("a_million_rows_with_backpressure_and_cancel") else {
        return;
    };
    let env = env(&ssh);
    env.trust_all(&ssh);
    def.ssh = Some(tunnel(ssh.hop(
        ssh.port,
        SshAuthMethod::Key,
        Some("id_ed25519"),
    )));
    let (b, _) = env.bench(def, password, TunnelSecrets::new()).await;

    let started = Instant::now();
    let id = b
        .run_limited(
            "big",
            "SELECT g, md5(g::text) FROM generate_series(1, 1000000) g",
            ResultLimits {
                max_rows: 2_000_000,
                max_bytes: 1 << 30,
            },
        )
        .await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.results[0].row_count, 1_000_000);
    let tail = b.window(run.results[0].result_id, 999_999, 1);
    assert_eq!(tail.columns[0].values[0].as_deref(), Some("1000000"));
    eprintln!("1M rows through the tunnel: {:?}", started.elapsed());

    // Paused at its cap, the result stops reading: the server waits, and the other
    // connections of the tunnel keep working meanwhile.
    let id = b
        .run_limited(
            "paused",
            "SELECT /* tunnel-paused */ g, md5(g::text) FROM generate_series(1, 1000000) g",
            ResultLimits {
                max_rows: 50_000,
                max_bytes: 1 << 30,
            },
        )
        .await;
    let paused = b
        .wait_for(id, |r| r.status == ExecutionStatus::Paused)
        .await;
    let session = b.manager.session(&b.connection_id).expect("session");
    for _ in 0..3 {
        let other = tokio::time::timeout(Duration::from_secs(10), session.query("SELECT 1", 1))
            .await
            .expect("the metadata connection is not blocked by the paused one")
            .expect("query");
        assert_eq!(other.scalar_text().as_deref(), Some("1"));
        let run = tokio::time::timeout(Duration::from_secs(10), b.run("other", "SELECT 3"))
            .await
            .expect("another tab is not blocked by the paused one");
        assert_eq!(run.status, ExecutionStatus::Succeeded);
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert_eq!(
        b.fold(id).0.results[0].row_count,
        50_000,
        "nothing read while paused"
    );
    // The backpressure reached the server: the statement waits there for the client to read
    // (memory stays bounded by the socket buffers and one SSH window).
    let activity = session
        .query(
            "SELECT state FROM pg_stat_activity WHERE query LIKE '%tunnel-paused%' AND pid <> pg_backend_pid()",
            5,
        )
        .await
        .expect("activity");
    assert_eq!(activity.scalar_text().as_deref(), Some("active"));
    b.runner
        .resume(paused.results[0].result_id, ResumeMode::All)
        .expect("resume");
    let run = b.wait(id).await;
    assert_eq!(run.results[0].row_count, 1_000_000);

    // A native cancel request travels through the tunnel too.
    let (id, _) = b
        .start(b.request("sleep", "SELECT pg_sleep(30)", ExecuteScope::All))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    b.runner.cancel("sleep").await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn tls_verify_full_checks_the_real_host_name() {
    let test = "tls_verify_full_checks_the_real_host_name";
    let Some((ssh, mut def, password)) = pg(test) else {
        return;
    };
    let Some(ca) = pg_ca(test) else {
        return;
    };
    let env = env(&ssh);
    env.trust_all(&ssh);
    def.ssh = Some(tunnel(ssh.hop(
        ssh.port,
        SshAuthMethod::Key,
        Some("id_ed25519"),
    )));
    // The certificate names `localhost` only: TCP goes to the tunnel's 127.0.0.1 end, the
    // name check uses the definition's host.
    def.host = "localhost".into();
    def.tls_mode = TlsMode::VerifyFull;
    def.ca_cert_path = Some(ca);
    env.test(&def, password.as_ref(), TunnelSecrets::new())
        .await
        .expect("verify-full through the tunnel");
    def.host = "127.0.0.1".into();
    let err = env
        .test(&def, password.as_ref(), TunnelSecrets::new())
        .await
        .expect_err("the certificate does not name 127.0.0.1");
    assert_eq!(err.code, ErrorCode::TlsFailed, "{err:?}");
}

#[tokio::test]
async fn sql_server_through_the_tunnel() {
    let test = "sql_server_through_the_tunnel";
    let Some(ssh) = ssh(test) else { return };
    let Some(url) = mssql_url(test) else { return };
    let (mut def, password) = common::from_url(&url);
    let env = env(&ssh);
    env.trust_all(&ssh);
    def.ssh = Some(tunnel(ssh.hop(ssh.port, SshAuthMethod::Agent, None)));
    let version = env
        .test(&def, password.as_ref(), TunnelSecrets::new())
        .await
        .expect("SQL Server through the tunnel");
    assert!(version.contains("SQL Server"), "{version}");
    let (b, _) = env.bench(def, password, TunnelSecrets::new()).await;
    let run = b.run("tab", "SELECT 41 + 1").await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    let (id, _) = b
        .start(b.request("sleep", "WAITFOR DELAY '00:00:30'", ExecuteScope::All))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    b.runner.cancel("sleep").await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
}
