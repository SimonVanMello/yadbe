//! One open connection: its driver connection, its state, and the monitor that reconnects
//! when the link drops (F-013). A statement is never replayed: a statement that fails with
//! the link fails for its caller, and the session only re-establishes the connection.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::db::config::ConnectTarget;
use crate::db::dialect::Dialect;
use crate::db::driver::{Backend, ConnectRequest, Driver, Link, SqlConnection, StatementRecorder};
use crate::db::errors::YadbeError;
use crate::db::value::QueryResult;
use crate::events::{BackendEvent, ConnectionStateChanged, EventSink};
use crate::secrets::Secret;
use crate::session::tunnel::{self, TunnelSlot};
use crate::session::{ConnectionState, SessionInfo};
use crate::tunnel::{Tunnel, TunnelPhase};

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
    /// Read-only as it applies now (F-008): the saved flag can change under an open session,
    /// `target.read_only` is the one it was opened with.
    read_only: AtomicBool,
    /// The statement timeout of query tabs as saved now (F-014); it applies to the next
    /// execution.
    statement_timeout: Mutex<Option<Duration>>,
    /// A save changed settings the session only picks up when it connects again.
    outdated: AtomicBool,
    password: Option<Secret>,
    recorder: Arc<dyn StatementRecorder>,
    sink: Arc<dyn EventSink>,
    config: SessionConfig,
    state: Mutex<SessionInfo>,
    conn: RwLock<Option<Backend>>,
    shutdown: watch::Sender<bool>,
    monitor: Mutex<Option<JoinHandle<()>>>,
    /// The keep-alive task (F-014), when the connection crosses a network.
    keeper: Mutex<Option<JoinHandle<()>>>,
    /// The SSH tunnel every connection of the session goes through, if any.
    tunnel: Option<TunnelSlot>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl ConnectionSession {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        id: String,
        driver: Arc<dyn Driver>,
        target: ConnectTarget,
        password: Option<Secret>,
        recorder: Arc<dyn StatementRecorder>,
        sink: Arc<dyn EventSink>,
        config: SessionConfig,
        tunnel: Option<TunnelSlot>,
    ) -> Arc<Self> {
        let state = SessionInfo {
            connection_id: id.clone(),
            state: ConnectionState::Connecting,
            server_version: None,
            error: None,
            reconnect_attempt: None,
            tunnel: tunnel.as_ref().map(|t| t.status(TunnelPhase::Down)),
        };
        Arc::new(Self {
            id,
            driver,
            read_only: AtomicBool::new(target.read_only),
            statement_timeout: Mutex::new(target.statement_timeout),
            outdated: AtomicBool::new(false),
            target,
            password,
            recorder,
            sink,
            config,
            state: Mutex::new(state),
            conn: RwLock::new(None),
            shutdown: watch::channel(false).0,
            monitor: Mutex::new(None),
            keeper: Mutex::new(None),
            tunnel,
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

    fn current(&self) -> Option<Backend> {
        self.conn
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn install(&self, conn: Option<Backend>) -> Option<Backend> {
        std::mem::replace(
            &mut *self
                .conn
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            conn,
        )
    }

    /// Opens the tunnel first when the session has one (state events say so).
    async fn route(&self) -> Result<Option<Arc<Tunnel>>, YadbeError> {
        let Some(slot) = &self.tunnel else {
            return Ok(None);
        };
        let tunnel = slot
            .ensure(&*self.recorder, || {
                self.set_state(|s| s.tunnel = Some(slot.status(TunnelPhase::Opening)));
            })
            .await
            .inspect_err(|_| self.set_state(|s| s.tunnel = Some(slot.status(TunnelPhase::Down))))?;
        Ok(Some(tunnel))
    }

    /// A driver connection with the session's settings, through the tunnel if any.
    async fn dial(&self, database: Option<&str>) -> Result<Backend, YadbeError> {
        let started = Instant::now();
        let tunnel = self.route().await?;
        let mut target = self.target.clone();
        target.read_only = self.read_only();
        if let Some(database) = database {
            database.clone_into(&mut target.database);
        }
        target.dial = tunnel.as_ref().map(|t| t.local_addr());
        let request = ConnectRequest {
            target: &target,
            password: self.password.as_ref(),
            recorder: Arc::clone(&self.recorder),
        };
        self.driver
            .connect(request)
            .await
            .map_err(|err| tunnel::explain(err, tunnel.as_deref(), started))
    }

    async fn open_link(&self) -> Result<Backend, YadbeError> {
        let mut shutdown = self.shutdown.subscribe();
        tokio::select! {
            result = self.dial(None) => result,
            _ = shutdown.wait_for(|closed| *closed) => Err(YadbeError::cancelled()),
        }
    }

    fn tunnel_open(&self, s: &mut SessionInfo) {
        if let Some(slot) = &self.tunnel {
            s.tunnel = Some(slot.status(TunnelPhase::Open));
        }
    }

    /// First connection; on success the monitor starts watching the link.
    pub(crate) async fn open(self: &Arc<Self>) -> Result<SessionInfo, YadbeError> {
        let conn = self.open_link().await?;
        if self.is_closed() {
            conn.as_link().close().await;
            return Err(YadbeError::cancelled());
        }
        let version = conn.as_link().server_version().to_owned();
        self.install(Some(conn));
        self.set_state(|s| {
            s.state = ConnectionState::Connected;
            s.server_version = Some(version);
            s.error = None;
            s.reconnect_attempt = None;
            self.tunnel_open(s);
        });
        let session = Arc::clone(self);
        *lock(&self.monitor) = Some(tokio::spawn(async move { session.watch().await }));
        if let Some(every) = self.target.keep_alive {
            let session = Arc::clone(self);
            *lock(&self.keeper) =
                Some(tokio::spawn(async move { session.keep_alive(every).await }));
        }
        Ok(self.info())
    }

    /// Pings the open connection every `every` while the session lives (F-014), so a firewall
    /// or NAT that forgets idle connections does not drop it. Not recorded; a failed ping is
    /// left to the link watch, which reconnects.
    async fn keep_alive(self: Arc<Self>, every: Duration) {
        let mut shutdown = self.shutdown.subscribe();
        loop {
            tokio::select! {
                () = tokio::time::sleep(every) => {}
                _ = shutdown.wait_for(|closed| *closed) => return,
            }
            let Ok(conn) = self.backend() else {
                continue;
            };
            if let Err(err) = conn.as_link().keep_alive().await {
                tracing::debug!(connection = %self.id, error = %err, "keep-alive ping failed");
            }
        }
    }

    /// Waits for the link to drop, then reconnects; ends on close or when the attempts are
    /// exhausted.
    async fn watch(self: Arc<Self>) {
        let mut shutdown = self.shutdown.subscribe();
        loop {
            let Some(conn) = self.current() else { return };
            let mut link = conn.as_link().link();
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
            let tunnel_down = self.tunnel.as_ref().filter(|slot| slot.is_down());
            self.set_state(|s| {
                s.state = ConnectionState::Lost;
                s.error = Some(YadbeError::connection_lost());
                s.reconnect_attempt = None;
                if let Some(slot) = tunnel_down {
                    s.tunnel = Some(slot.status(TunnelPhase::Down));
                }
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
                        conn.as_link().close().await;
                        return false;
                    }
                    let version = conn.as_link().server_version().to_owned();
                    self.install(Some(conn));
                    self.set_state(|s| {
                        s.state = ConnectionState::Connected;
                        s.server_version = Some(version);
                        s.error = None;
                        s.reconnect_attempt = None;
                        self.tunnel_open(s);
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
    pub fn backend(&self) -> Result<Backend, YadbeError> {
        match self.current() {
            Some(conn) if !conn.as_link().link().is_lost() => Ok(conn),
            _ => Err(YadbeError::not_connected()),
        }
    }

    /// The open connection of a SQL engine: `notConnected` as [`Self::backend`], `sqlOnly` for
    /// an engine of another family.
    pub fn sql(&self) -> Result<Arc<dyn SqlConnection>, YadbeError> {
        self.dialect()?;
        self.backend()?.into_sql()
    }

    /// The SQL dialect of the session's engine, or `sqlOnly` for an engine of another family:
    /// what every SQL service asks first.
    pub fn dialect(&self) -> Result<&'static dyn Dialect, YadbeError> {
        self.target
            .engine
            .sql_dialect()
            .ok_or_else(YadbeError::sql_only)
    }

    /// Runs one statement yadbe authors (recorded in the statement log). Fails, never
    /// retries, when the link drops.
    pub async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryResult, YadbeError> {
        self.sql()?.query(sql, max_rows).await
    }

    pub async fn ping(&self) -> Result<(), YadbeError> {
        self.backend()?.as_link().ping().await
    }

    /// The settings the session was opened with; read-only is [`Self::read_only`].
    pub fn target(&self) -> &ConnectTarget {
        &self.target
    }

    /// Whether the session refuses writes, as the connection is saved now (F-008).
    pub fn read_only(&self) -> bool {
        self.read_only.load(Ordering::SeqCst)
    }

    /// Notes that the saved settings changed in a way only a new connection picks up; returns
    /// whether the session runs with outdated settings (this change or an earlier one).
    pub fn mark_outdated(&self, outdated: bool) -> bool {
        if outdated {
            self.outdated.store(true, Ordering::SeqCst);
        }
        self.outdated.load(Ordering::SeqCst)
    }

    /// The limit of a query tab's statement, as saved now (F-014).
    pub fn statement_timeout(&self) -> Option<Duration> {
        *lock(&self.statement_timeout)
    }

    /// Changes the limit for the next executions; a running one keeps its own.
    pub fn set_statement_timeout(&self, limit: Option<Duration>) {
        *lock(&self.statement_timeout) = limit;
    }

    /// Turns read-only on or off under the open session. The yadbe checks read the flag at
    /// each statement; the engine's own guard follows on the main connection now and on the
    /// other connections of the session before their next statement outside a transaction
    /// ([`Self::align`]).
    pub async fn set_read_only(&self, on: bool) -> Result<(), YadbeError> {
        if self.read_only.swap(on, Ordering::SeqCst) == on {
            return Ok(());
        }
        tracing::info!(connection = %self.id, read_only = on, "read-only changed");
        match self.current() {
            Some(conn) if !conn.as_link().link().is_lost() => self.align(conn.as_link()).await,
            _ => Ok(()),
        }
    }

    /// Brings the engine's read-only guard of `conn` (a connection of this session) to the
    /// session's flag. Only outside a transaction: see [`Link::set_read_only`].
    pub async fn align(&self, conn: &dyn Link) -> Result<(), YadbeError> {
        let wanted = self.read_only();
        match conn.read_only_mode() {
            Some(mode) if mode != wanted => conn.set_read_only(wanted).await,
            _ => Ok(()),
        }
    }

    /// Records statements yadbe runs on this connection in the statement log.
    pub fn recorder(&self) -> Arc<dyn StatementRecorder> {
        Arc::clone(&self.recorder)
    }

    /// Flips to `true` when the session closes.
    pub fn closed(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    /// Opens another server connection with the session's settings and password (an editor
    /// tab's own connection), on `database` when given. Aborted when the session closes.
    pub async fn open_dedicated(&self, database: Option<&str>) -> Result<Backend, YadbeError> {
        self.backend()?;
        let mut shutdown = self.shutdown.subscribe();
        tokio::select! {
            result = self.dial(database) => result,
            _ = shutdown.wait_for(|closed| *closed) => Err(YadbeError::not_connected()),
        }
    }

    /// [`Self::open_dedicated`] for a SQL service: `sqlOnly` for another family, before
    /// anything is opened.
    pub async fn open_dedicated_sql(
        &self,
        database: Option<&str>,
    ) -> Result<Arc<dyn SqlConnection>, YadbeError> {
        self.dialect()?;
        self.open_dedicated(database).await?.into_sql()
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
        let keeper = lock(&self.keeper).take();
        if let Some(conn) = self.install(None) {
            conn.as_link().close().await;
        }
        if let Some(monitor) = monitor {
            monitor.abort();
        }
        if let Some(keeper) = keeper {
            keeper.abort();
        }
        if let Some(slot) = &self.tunnel {
            slot.close(&*self.recorder).await;
        }
    }
}
