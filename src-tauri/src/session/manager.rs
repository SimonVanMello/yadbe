//! `ConnectionManager`: one `ConnectionSession` per open connection, connection tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::Notify;

use crate::db::config::{AuthMethod, ConnectionDefinition};
use crate::db::dialect::{Engine, EngineInfo};
use crate::db::driver::{ConnectRequest, Driver};
use crate::db::drivers;
use crate::db::errors::YadbeError;
use crate::events::EventSink;
use crate::secrets::{Secret, SecretKind, SecretStore};
use crate::session::connection::{ConnectionSession, SessionConfig};
use crate::session::statement_log::StatementLog;
use crate::session::{ConnectionState, SessionInfo, TestConnectionResult};
use crate::store::Store;

pub struct ConnectionManager {
    store: Arc<Store>,
    secrets: Arc<SecretStore>,
    log: Arc<StatementLog>,
    sink: Arc<dyn EventSink>,
    drivers: HashMap<Engine, Arc<dyn Driver>>,
    config: SessionConfig,
    sessions: Mutex<HashMap<String, Arc<ConnectionSession>>>,
    tests: Mutex<HashMap<String, Arc<Notify>>>,
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
            store,
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
        }
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
            .map(|engine| {
                let dialect = engine.dialect();
                EngineInfo {
                    engine,
                    label: dialect.label().to_owned(),
                    capabilities: dialect.capabilities(),
                    default_username: dialect.default_username().map(str::to_owned),
                    available: self.drivers.contains_key(&engine),
                }
            })
            .collect()
    }

    fn driver(&self, engine: Engine) -> Result<Arc<dyn Driver>, YadbeError> {
        self.drivers
            .get(&engine)
            .cloned()
            .ok_or_else(|| YadbeError::engine_not_supported(engine.dialect().label()))
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

    /// Connects with an unsaved definition, reads the version, pings and closes.
    pub async fn test(
        &self,
        request_id: String,
        definition: ConnectionDefinition,
        password: Option<Secret>,
        connection_id: Option<String>,
    ) -> Result<TestConnectionResult, YadbeError> {
        let driver = self.driver(definition.engine)?;
        let password = self
            .password(&definition, connection_id.as_deref(), password)
            .await?;
        let cancel = Arc::new(Notify::new());
        lock(&self.tests).insert(request_id.clone(), Arc::clone(&cancel));
        let target = definition.target();
        let recorder = self
            .log
            .recorder(connection_id.clone(), definition.name.clone());
        let started = Instant::now();
        let attempt = async {
            let conn = driver
                .connect(ConnectRequest {
                    target: &target,
                    password: password.as_ref(),
                    recorder,
                })
                .await?;
            let ping = conn.ping().await;
            let version = conn.server_version().to_owned();
            conn.close().await;
            ping.map(|()| version)
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
        let session = ConnectionSession::new(
            connection_id.to_owned(),
            driver,
            saved.definition.target(),
            password,
            self.log.recorder(
                Some(connection_id.to_owned()),
                saved.definition.name.clone(),
            ),
            Arc::clone(&self.sink),
            self.config.clone(),
        );
        lock(&self.sessions).insert(connection_id.to_owned(), Arc::clone(&session));
        session.announce();
        match session.open().await {
            Ok(info) => {
                if let Some(typed) = typed {
                    self.secrets
                        .set_session(connection_id, SecretKind::Password, typed);
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
