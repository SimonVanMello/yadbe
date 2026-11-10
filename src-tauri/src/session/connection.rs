//! One open connection: its driver connection, its state, and the monitor that reconnects
//! when the link drops (F-013). A statement is never replayed: a statement that fails with
//! the link fails for its caller, and the session only re-establishes the connection.

use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::db::config::ConnectTarget;
use crate::db::driver::{ConnectRequest, Connection, Driver, StatementRecorder};
use crate::db::errors::YadbeError;
use crate::db::value::QueryResult;
use crate::events::{BackendEvent, ConnectionStateChanged, EventSink};
use crate::secrets::Secret;
use crate::session::{ConnectionState, SessionInfo};

/// Reconnection policy.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Wait before each automatic reconnection attempt; their count is the number of
    /// attempts.
    pub reconnect_delays: Vec<Duration>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            reconnect_delays: [0, 1, 2, 4, 8]
                .into_iter()
                .map(Duration::from_secs)
                .collect(),
        }
    }
}

pub struct ConnectionSession {
    id: String,
    driver: Arc<dyn Driver>,
    target: ConnectTarget,
    password: Option<Secret>,
    recorder: Arc<dyn StatementRecorder>,
    sink: Arc<dyn EventSink>,
    config: SessionConfig,
    state: Mutex<SessionInfo>,
    conn: RwLock<Option<Arc<dyn Connection>>>,
    shutdown: watch::Sender<bool>,
    monitor: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl ConnectionSession {
    pub(crate) fn new(
        id: String,
        driver: Arc<dyn Driver>,
        target: ConnectTarget,
        password: Option<Secret>,
        recorder: Arc<dyn StatementRecorder>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
    ) -> Arc<Self> {
        let state = SessionInfo {
            connection_id: id.clone(),
            state: ConnectionState::Connecting,
            server_version: None,
            error: None,
            reconnect_attempt: None,
        };
        Arc::new(Self {
            id,
            driver,
            target,
            password,
            recorder,
            sink,
            config,
            state: Mutex::new(state),
            conn: RwLock::new(None),
            shutdown: watch::channel(false).0,
            monitor: Mutex::new(None),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn info(&self) -> SessionInfo {
        lock(&self.state).clone()
    }

    pub fn is_closed(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// Whether the monitor still watches the link (and may reconnect).
    pub fn is_monitored(&self) -> bool {
        lock(&self.monitor)
            .as_ref()
            .is_some_and(|monitor| !monitor.is_finished())
    }

    /// Updates the state and emits it, unless the session is already closed.
    fn set_state(&self, update: impl FnOnce(&mut SessionInfo)) {
        let info = {
            let mut state = lock(&self.state);
            if state.state == ConnectionState::Closed {
                return;
            }
            update(&mut state);
            state.clone()
        };
        tracing::info!(connection = %self.id, state = ?info.state, "connection state");
        self.sink.emit(BackendEvent::ConnectionStateChanged(
            ConnectionStateChanged { session: info },
        ));
    }

    /// Emits the initial `connecting` state.
    pub(crate) fn announce(&self) {
        let info = self.info();
        self.sink.emit(BackendEvent::ConnectionStateChanged(
            ConnectionStateChanged { session: info },
        ));
    }

    fn current(&self) -> Option<Arc<dyn Connection>> {
        self.conn
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn install(&self, conn: Option<Arc<dyn Connection>>) -> Option<Arc<dyn Connection>> {
        std::mem::replace(
            &mut *self
                .conn
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            conn,
        )
    }

    async fn open_link(&self) -> Result<Arc<dyn Connection>, YadbeError> {
        let request = ConnectRequest {
            target: &self.target,
            password: self.password.as_ref(),
            recorder: Arc::clone(&self.recorder),
        };
        let mut shutdown = self.shutdown.subscribe();
        tokio::select! {
            result = self.driver.connect(request) => result.map(Arc::from),
            _ = shutdown.wait_for(|closed| *closed) => Err(YadbeError::cancelled()),
        }
    }

    /// First connection; on success the monitor starts watching the link.
    pub(crate) async fn open(self: &Arc<Self>) -> Result<SessionInfo, YadbeError> {
        let conn = self.open_link().await?;
        if self.is_closed() {
            conn.close().await;
            return Err(YadbeError::cancelled());
        }
        let version = conn.server_version().to_owned();
        self.install(Some(conn));
        self.set_state(|s| {
            s.state = ConnectionState::Connected;
            s.server_version = Some(version);
            s.error = None;
            s.reconnect_attempt = None;
        });
        let session = Arc::clone(self);
        *lock(&self.monitor) = Some(tokio::spawn(async move { session.watch().await }));
        Ok(self.info())
    }

    /// Waits for the link to drop, then reconnects; ends on close or when the attempts are
    /// exhausted.
    async fn watch(self: Arc<Self>) {
        let mut shutdown = self.shutdown.subscribe();
        loop {
            let Some(conn) = self.current() else { return };
            let mut link = conn.link();
            drop(conn);
            tokio::select! {
                () = link.lost() => {}
                _ = shutdown.wait_for(|closed| *closed) => return,
            }
            if self.is_closed() {
                return;
            }
            self.install(None);
            tracing::warn!(connection = %self.id, "connection lost");
            self.set_state(|s| {
                s.state = ConnectionState::Lost;
                s.error = Some(YadbeError::connection_lost());
                s.reconnect_attempt = None;
            });
            if !self.reconnect().await {
                return;
            }
        }
    }

    /// Returns whether the connection is back.
    async fn reconnect(&self) -> bool {
        let mut shutdown = self.shutdown.subscribe();
        let mut last_error = YadbeError::connection_lost();
        for (index, delay) in self.config.reconnect_delays.iter().enumerate() {
            let attempt = u32::try_from(index + 1).unwrap_or(u32::MAX);
            tokio::select! {
                () = tokio::time::sleep(*delay) => {}
                _ = shutdown.wait_for(|closed| *closed) => return false,
            }
            self.set_state(|s| {
                s.state = ConnectionState::Reconnecting;
                s.reconnect_attempt = Some(attempt);
                s.error = None;
            });
            match self.open_link().await {
                Ok(conn) => {
                    if self.is_closed() {
                        conn.close().await;
                        return false;
                    }
                    let version = conn.server_version().to_owned();
                    self.install(Some(conn));
                    self.set_state(|s| {
                        s.state = ConnectionState::Connected;
                        s.server_version = Some(version);
                        s.error = None;
                        s.reconnect_attempt = None;
                    });
                    return true;
                }
                Err(err) => {
                    tracing::warn!(connection = %self.id, attempt, error = %err, "reconnection failed");
                    let transient = err.is_transient();
                    last_error = err;
                    if !transient {
                        break;
                    }
                }
            }
        }
        self.set_state(|s| {
            s.state = ConnectionState::Lost;
            s.error = Some(last_error);
        });
        false
    }

    /// The open connection, or `notConnected` while connecting, lost or reconnecting.
    pub fn connection(&self) -> Result<Arc<dyn Connection>, YadbeError> {
        match self.current() {
            Some(conn) if !conn.link().is_lost() => Ok(conn),
            _ => Err(YadbeError::not_connected()),
        }
    }

    /// Runs one statement yadbe authors (recorded in the statement log). Fails, never
    /// retries, when the link drops.
    pub async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryResult, YadbeError> {
        self.connection()?.query(sql, max_rows).await
    }

    pub async fn ping(&self) -> Result<(), YadbeError> {
        self.connection()?.ping().await
    }

    /// Closes the connection and stops reconnecting. `error`: why, when it was not the
    /// user's choice.
    pub async fn close(&self, error: Option<YadbeError>) {
        self.set_state(|s| {
            s.state = ConnectionState::Closed;
            s.error = error;
            s.reconnect_attempt = None;
        });
        self.shutdown.send_replace(true);
        let monitor = lock(&self.monitor).take();
        if let Some(conn) = self.install(None) {
            conn.close().await;
        }
        if let Some(monitor) = monitor {
            monitor.abort();
        }
    }
}
