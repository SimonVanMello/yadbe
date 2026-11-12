//! `ConnectionManager`: one `ConnectionSession` per open connection, connection tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::Notify;

use crate::db::config::{AuthMethod, ConnectionDefinition, DEFAULT_CONNECT_TIMEOUT_SECS, TlsMode};
use crate::db::driver::{ConnectRequest, Driver};
use crate::db::drivers;
use crate::db::engine::{Engine, EngineInfo};
use crate::db::errors::YadbeError;
use crate::db::tls_identity::TlsIdentity;
use crate::events::EventSink;
use crate::secrets::{Secret, SecretKind, SecretStore};
use crate::session::connection::{ConnectionSession, SessionConfig};
use crate::session::statement_log::StatementLog;
use crate::session::tunnel::{self, TunnelSlot};
use crate::session::{ConnectionState, SessionInfo, TestConnectionResult};
use crate::store::Store;
use crate::tunnel::{AgentLocation, HostKeys, TunnelConfig, TunnelPhase};

/// SSH passwords and key passphrases typed for one attempt (prompt, or a test from the form).
pub type TunnelSecrets = HashMap<SecretKind, Secret>;

pub struct ConnectionManager {
    store: Arc<Store>,
    secrets: Arc<SecretStore>,
    log: Arc<StatementLog>,
    sink: Arc<dyn EventSink>,
    drivers: HashMap<Engine, Arc<dyn Driver>>,
    config: SessionConfig,
    sessions: Mutex<HashMap<String, Arc<ConnectionSession>>>,
    tests: Mutex<HashMap<String, Arc<Notify>>>,
    host_keys: Arc<HostKeys>,
    agent: AgentLocation,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, YadbeError> + Send + 'static,
) -> Result<T, YadbeError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| YadbeError::internal(format!("background task failed: {e}")))?
}

impl ConnectionManager {
    pub fn new(
        store: Arc<Store>,
        secrets: Arc<SecretStore>,
        log: Arc<StatementLog>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            secrets,
            log,
            sink,
            drivers: drivers::builtin()
                .into_iter()
                .map(|d| (d.engine(), d))
                .collect(),
            config: SessionConfig::default(),
            sessions: Mutex::new(HashMap::new()),
            tests: Mutex::new(HashMap::new()),
            // Tests never read the user's `~/.ssh`: the app sets it (`with_user_known_hosts`).
            host_keys: Arc::new(HostKeys::new(Arc::clone(&store), None)),
            agent: AgentLocation::default(),
            store,
        }
    }

    /// Also trusts the host keys of an OpenSSH `known_hosts` file (read only).
    pub fn with_user_known_hosts(mut self, path: Option<std::path::PathBuf>) -> Self {
        self.host_keys = Arc::new(HostKeys::new(Arc::clone(&self.store), path));
        self
    }

    /// Uses this SSH agent socket instead of `SSH_AUTH_SOCK` (tests).
    pub fn with_agent(mut self, location: AgentLocation) -> Self {
        self.agent = location;
        self
    }

    pub fn host_keys(&self) -> Arc<HostKeys> {
        Arc::clone(&self.host_keys)
    }

    /// Replaces the driver of its engine (tests).
    pub fn with_driver(mut self, driver: Arc<dyn Driver>) -> Self {
        self.drivers.insert(driver.engine(), driver);
        self
    }

    /// Replaces the reconnection policy (tests).
    pub fn with_config(mut self, config: SessionConfig) -> Self {
        self.config = config;
        self
    }

    pub fn engines(&self) -> Vec<EngineInfo> {
        Engine::ALL
            .into_iter()
            .map(|engine| EngineInfo::of(engine, self.drivers.contains_key(&engine)))
            .collect()
    }

    fn driver(&self, engine: Engine) -> Result<Arc<dyn Driver>, YadbeError> {
        self.drivers
            .get(&engine)
            .cloned()
            .ok_or_else(|| YadbeError::engine_not_supported(engine.label()))
    }

    /// The app-wide connect timeout (preferences) for definitions that set none.
    async fn default_connect_timeout(&self) -> u32 {
        let store = Arc::clone(&self.store);
        blocking(move || store.preferences())
            .await
            .map_or(DEFAULT_CONNECT_TIMEOUT_SECS, |p| p.connect_timeout_secs)
    }

    /// The password to use: the one given, else the stored one, else none when the
    /// connection needs none.
    async fn password(
        &self,
        definition: &ConnectionDefinition,
        connection_id: Option<&str>,
        provided: Option<Secret>,
    ) -> Result<Option<Secret>, YadbeError> {
        if provided.is_some() || definition.auth == AuthMethod::None {
            return Ok(provided);
        }
        let Some(id) = connection_id else {
            return Err(YadbeError::password_required());
        };
        let secrets = Arc::clone(&self.secrets);
        let id = id.to_owned();
        blocking(move || secrets.get(&id, SecretKind::Password))
            .await?
            .map(Some)
            .ok_or_else(YadbeError::password_required)
    }

    /// The TLS client certificate of a definition (F-009), read from its files; the key's
    /// passphrase comes from `provided`, else the stored one. `None` when the connection has
    /// no certificate or does not use TLS.
    async fn tls_identity(
        &self,
        definition: &ConnectionDefinition,
        connection_id: Option<&str>,
        provided: &TunnelSecrets,
    ) -> Result<Option<Arc<TlsIdentity>>, YadbeError> {
        let caps = definition.engine.capabilities();
        let Some(cert) = definition.tls_client_cert_path.clone() else {
            return Ok(None);
        };
        if !caps.client_certificate || definition.tls_mode == TlsMode::Disable {
            return Ok(None);
        }
        let key = definition.tls_client_key_path.clone();
        let passphrase = self
            .stored_secret(connection_id, provided, SecretKind::TlsKeyPassphrase)
            .await?;
        // Reading two files and hashing a passphrase: off the async threads.
        let identity = blocking(move || {
            TlsIdentity::load(
                std::path::Path::new(&cert),
                key.as_deref().map(std::path::Path::new),
                passphrase.as_ref(),
            )
        })
        .await?;
        Ok(Some(Arc::new(identity)))
    }

    /// The tunnel of a definition, its secrets taken from `provided`, else the stored ones.
    async fn tunnel_config(
        &self,
        definition: &ConnectionDefinition,
        connection_id: Option<&str>,
        provided: &TunnelSecrets,
        connect_timeout: std::time::Duration,
    ) -> Result<Option<TunnelConfig>, YadbeError> {
        let Some(ssh) = &definition.ssh else {
            return Ok(None);
        };
        let target = definition.target();
        let mut kinds = Vec::new();
        for (hop, which) in [
            (Some(&ssh.server), crate::tunnel::TunnelHop::Server),
            (ssh.jump.as_ref(), crate::tunnel::TunnelHop::Jump),
        ] {
            if let Some(hop) = hop {
                kinds.push((hop.clone(), which));
            }
        }
        let mut hops = Vec::new();
        for (hop, which) in kinds {
            let (password_kind, passphrase_kind) = which.secret_kinds();
            let reference = crate::tunnel::errors::HopRef {
                hop: which,
                host: hop.host.clone(),
                port: hop.port(),
            };
            let auth = match hop.auth {
                crate::tunnel::SshAuthMethod::Password => crate::tunnel::HopAuth::Password(
                    self.stored_secret(connection_id, provided, password_kind)
                        .await?
                        .ok_or_else(|| {
                            YadbeError::ssh_secret_required(&reference, password_kind)
                        })?,
                ),
                crate::tunnel::SshAuthMethod::Key => crate::tunnel::HopAuth::Key {
                    path: hop.key_path.clone().unwrap_or_default(),
                    passphrase: self
                        .stored_secret(connection_id, provided, passphrase_kind)
                        .await?,
                },
                crate::tunnel::SshAuthMethod::Agent => crate::tunnel::HopAuth::Agent,
            };
            hops.push(crate::tunnel::HopConfig {
                hop: which,
                host: hop.host.clone(),
                port: hop.port(),
                username: hop.username.clone(),
                auth,
            });
        }
        let server = hops.remove(0);
        let jump = hops.pop();
        let keepalive = ssh
            .keepalive_secs
            .unwrap_or(crate::tunnel::model::DEFAULT_KEEPALIVE_SECS);
        Ok(Some(TunnelConfig {
            server,
            jump,
            keepalive: (keepalive > 0)
                .then(|| std::time::Duration::from_secs(u64::from(keepalive))),
            connect_timeout,
            target_host: target.host,
            target_port: target.port,
            agent: self.agent.clone(),
        }))
    }

    async fn stored_secret(
        &self,
        connection_id: Option<&str>,
        provided: &TunnelSecrets,
        kind: SecretKind,
    ) -> Result<Option<Secret>, YadbeError> {
        if let Some(secret) = provided.get(&kind) {
            return Ok(Some(secret.clone()));
        }
        let Some(id) = connection_id else {
            return Ok(None);
        };
        let secrets = Arc::clone(&self.secrets);
        let id = id.to_owned();
        blocking(move || secrets.get(&id, kind)).await
    }

    /// Connects with an unsaved definition, reads the version, pings and closes.
    pub async fn test(
        &self,
        request_id: String,
        definition: ConnectionDefinition,
        password: Option<Secret>,
        connection_id: Option<String>,
    ) -> Result<TestConnectionResult, YadbeError> {
        self.test_with_tunnel(
            request_id,
            definition,
            password,
            connection_id,
            TunnelSecrets::new(),
        )
        .await
    }

    /// [`Self::test`] with SSH secrets typed in the form. Goes through the definition's SSH
    /// tunnel when it has one; a failure names the hop (`error.tunnel`).
    pub async fn test_with_tunnel(
        &self,
        request_id: String,
        definition: ConnectionDefinition,
        password: Option<Secret>,
        connection_id: Option<String>,
        tunnel_secrets: TunnelSecrets,
    ) -> Result<TestConnectionResult, YadbeError> {
        let driver = self.driver(definition.engine)?;
        let password = self
            .password(&definition, connection_id.as_deref(), password)
            .await?;
        let cancel = Arc::new(Notify::new());
        lock(&self.tests).insert(request_id.clone(), Arc::clone(&cancel));
        let mut target = definition.target_with_timeout(self.default_connect_timeout().await);
        target.tls_identity = self
            .tls_identity(&definition, connection_id.as_deref(), &tunnel_secrets)
            .await?;
        let tunnel_config = self
            .tunnel_config(
                &definition,
                connection_id.as_deref(),
                &tunnel_secrets,
                target.connect_timeout,
            )
            .await?;
        let recorder = self
            .log
            .recorder(connection_id.clone(), definition.name.clone());
        let started = Instant::now();
        let slot = tunnel_config.map(|config| {
            let template = definition
                .ssh
                .as_ref()
                .map(|ssh| ssh.status(TunnelPhase::Down));
            TunnelSlot::new(
                config,
                Arc::clone(&self.host_keys),
                template.unwrap_or(crate::tunnel::TunnelStatus {
                    phase: TunnelPhase::Down,
                    endpoint: String::new(),
                    jump: None,
                }),
            )
        });
        let attempt = async {
            let tunnel = match &slot {
                Some(slot) => {
                    let tunnel = slot.ensure(&*recorder, || {}).await?;
                    target.dial = Some(tunnel.local_addr());
                    Some(tunnel)
                }
                None => None,
            };
            let dialed = Instant::now();
            let result = async {
                let conn = driver
                    .connect(ConnectRequest {
                        target: &target,
                        password: password.as_ref(),
                        recorder: Arc::clone(&recorder),
                    })
                    .await
                    .map_err(|err| tunnel::explain(err, tunnel.as_deref(), dialed))?;
                let link = conn.as_link();
                let ping = link.ping().await;
                let version = link.server_version().to_owned();
                link.close().await;
                ping.map(|()| version)
            }
            .await;
            if let Some(slot) = &slot {
                slot.close(&*recorder).await;
            }
            result
        };
        let result = tokio::select! {
            result = attempt => result,
            () = cancel.notified() => Err(YadbeError::cancelled()),
        };
        lock(&self.tests).remove(&request_id);
        result.map(|server_version| TestConnectionResult {
            server_version,
            duration_ms: (started.elapsed().as_secs_f64() * 1000.0).round(),
        })
    }

    pub fn cancel_test(&self, request_id: &str) {
        if let Some(cancel) = lock(&self.tests).get(request_id) {
            // A stored permit also covers a test that has not reached its `select!` yet.
            cancel.notify_one();
        }
    }

    /// Opens a saved connection, or returns the session already open (or reconnecting).
    pub async fn connect(
        &self,
        connection_id: &str,
        password: Option<Secret>,
    ) -> Result<SessionInfo, YadbeError> {
        self.connect_with_tunnel(connection_id, password, TunnelSecrets::new())
            .await
    }

    /// [`Self::connect`] with SSH secrets typed at connect time (kept for the session once
    /// they worked).
    pub async fn connect_with_tunnel(
        &self,
        connection_id: &str,
        password: Option<Secret>,
        tunnel_secrets: TunnelSecrets,
    ) -> Result<SessionInfo, YadbeError> {
        let store = Arc::clone(&self.store);
        let id = connection_id.to_owned();
        let saved = blocking(move || store.connection(&id)).await?;
        if let Some(existing) = self.session_entry(connection_id) {
            let info = existing.info();
            let finished = info.state == ConnectionState::Lost && !existing.is_monitored();
            if !finished && !existing.is_closed() {
                return Ok(info);
            }
            existing.close(None).await;
            self.remove(&existing);
        }
        let driver = self.driver(saved.definition.engine)?;
        let typed = password.clone();
        let password = self
            .password(&saved.definition, Some(connection_id), password)
            .await?;
        let mut target = saved
            .definition
            .target_with_timeout(self.default_connect_timeout().await);
        target.tls_identity = self
            .tls_identity(&saved.definition, Some(connection_id), &tunnel_secrets)
            .await?;
        let tunnel = self
            .tunnel_config(
                &saved.definition,
                Some(connection_id),
                &tunnel_secrets,
                target.connect_timeout,
            )
            .await?
            .map(|config| {
                let template = saved
                    .definition
                    .ssh
                    .as_ref()
                    .map(|ssh| ssh.status(TunnelPhase::Down));
                TunnelSlot::new(
                    config,
                    Arc::clone(&self.host_keys),
                    template.unwrap_or(crate::tunnel::TunnelStatus {
                        phase: TunnelPhase::Down,
                        endpoint: String::new(),
                        jump: None,
                    }),
                )
            });
        let session = ConnectionSession::new(
            connection_id.to_owned(),
            driver,
            target,
            password,
            self.log.recorder(
                Some(connection_id.to_owned()),
                saved.definition.name.clone(),
            ),
            Arc::clone(&self.sink),
            self.config.clone(),
            tunnel,
        );
        lock(&self.sessions).insert(connection_id.to_owned(), Arc::clone(&session));
        session.announce();
        match session.open().await {
            Ok(info) => {
                if let Some(typed) = typed {
                    self.secrets
                        .set_session(connection_id, SecretKind::Password, typed);
                }
                // Like the database password: typed secrets are kept once they worked.
                for (kind, secret) in tunnel_secrets {
                    self.secrets.set_session(connection_id, kind, secret);
                }
                let store = Arc::clone(&self.store);
                let id = connection_id.to_owned();
                if let Err(err) = blocking(move || store.touch_connection(&id)).await {
                    tracing::warn!(error = %err, "could not record the connection time");
                }
                Ok(info)
            }
            Err(err) => {
                session.close(Some(err.clone())).await;
                self.remove(&session);
                Err(err)
            }
        }
    }

    fn session_entry(&self, connection_id: &str) -> Option<Arc<ConnectionSession>> {
        lock(&self.sessions).get(connection_id).cloned()
    }

    /// Removes `session` from the map if it is still the one registered.
    fn remove(&self, session: &Arc<ConnectionSession>) {
        let mut sessions = lock(&self.sessions);
        if sessions
            .get(session.id())
            .is_some_and(|s| Arc::ptr_eq(s, session))
        {
            sessions.remove(session.id());
        }
    }

    /// The open session of a connection (metadata, table browsing… from M1).
    pub fn session(&self, connection_id: &str) -> Result<Arc<ConnectionSession>, YadbeError> {
        self.session_entry(connection_id)
            .ok_or_else(YadbeError::not_connected)
    }

    /// Applies a saved change of a connection's definition to its open session, if any:
    /// read-only (F-008) and the statement timeout (F-014) at once. Returns whether the
    /// session still runs with settings that only a new connection picks up.
    pub async fn apply_saved(
        &self,
        connection_id: &str,
        before: &ConnectionDefinition,
        after: &ConnectionDefinition,
    ) -> bool {
        let Some(session) = self.session_entry(connection_id) else {
            return false;
        };
        if session.is_closed() {
            return false;
        }
        session.set_statement_timeout(
            after
                .statement_timeout_secs
                .map(|secs| std::time::Duration::from_secs(u64::from(secs))),
        );
        // The flag applies whatever happens here: the engine's guard of the main connection
        // is aligned again before its next write.
        if let Err(err) = session.set_read_only(after.read_only).await {
            tracing::warn!(connection = connection_id, error = %err, "could not switch the engine's read-only mode");
        }
        session.mark_outdated(before.needs_reconnect(after))
    }

    /// Closes a connection; also aborts a connection attempt or a reconnection.
    pub async fn disconnect(&self, connection_id: &str) {
        let session = lock(&self.sessions).remove(connection_id);
        if let Some(session) = session {
            session.close(None).await;
        }
    }

    /// Every session that is not closed.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<SessionInfo> = lock(&self.sessions)
            .values()
            .map(|s| s.info())
            .filter(|i| i.state != ConnectionState::Closed)
            .collect();
        infos.sort_by(|a, b| a.connection_id.cmp(&b.connection_id));
        infos
    }
}
