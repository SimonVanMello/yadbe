//! MySQL (8.0+) and MariaDB (10.6+) driver: `mysql_async` over rustls (ring).
//!
//! - User statements and yadbe's own statements without parameters go through the text
//!   protocol (`COM_QUERY`): any statement runs as written, and values arrive as the
//!   server's exact text. Statements with bound values are server-side prepared
//!   statements (binary protocol).
//! - Cancellation is `KILL QUERY <id>` sent from a second, short-lived connection.
//! - The transaction state comes from the server status flags of every reply, so a DDL
//!   statement's implicit commit is seen as it happens.
//! - `CLIENT_FOUND_ROWS`: an `UPDATE` reports the rows it matched, not only those it
//!   changed, so an edit that writes a value equal to the current one still counts as the
//!   one row it targets.

mod activity;
mod bound;
mod decode;
mod execute;
mod introspect;
mod objects;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use mysql_async::consts::StatusFlags;
use mysql_async::prelude::{Protocol, Queryable};
use mysql_async::{
    ClientIdentity, Conn, DriverError, Error as MyError, IoError, Opts, OptsBuilder,
    QueryResult as MyResult, SslOpts,
};

use self::decode::Decoder;
use crate::db::config::{ConnectTarget, TlsMode};
use crate::db::dialect::Engine;
use crate::db::driver::{
    BoundFailure, BoundStatement, BoxFuture, CancelHandle, ConnectRequest, Connection, Driver,
    ExecError, ExecSender, ExecSummary, Explained, LinkSignal, LinkWatch, StatementRecorder,
    recorded, recorded_bound,
};
use crate::db::errors::{
    ErrorCode, YadbeError, from_connect_sqlstate, from_mysql_connect_error, from_mysql_query_error,
};
use crate::db::params::ParamStatement;
use crate::db::tls_identity::TlsIdentity;
use crate::db::value::{ColumnMeta, QueryResult, Value};

const APPLICATION_NAME: &str = "yadbe";
const VERSION_SQL: &str = "SELECT VERSION()";
const READ_ONLY_SQL: &str = "SET SESSION TRANSACTION READ ONLY";
const READ_WRITE_SQL: &str = "SET SESSION TRANSACTION READ WRITE";
const PING_SQL: &str = "SELECT 1";
/// The largest packet the client accepts (the server's own maximum, 1 GiB): the server's
/// `max_allowed_packet` is the real bound. Setting it avoids a settings query at connect.
const MAX_PACKET: usize = 1 << 30;

/// Server errors that end the session (shutdown, killed connection, idle timeout).
const SESSION_ENDED: [u16; 5] = [1053, 1927, 3169, 4031, 2013];
/// `Query execution was interrupted`: `KILL QUERY` stopped the statement.
const INTERRUPTED: u16 = 1317;

pub struct MysqlDriver;

impl Driver for MysqlDriver {
    fn engine(&self) -> Engine {
        Engine::Mysql
    }

    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Box<dyn Connection>, YadbeError>> {
        Box::pin(async move {
            let target = request.target;
            // Bounds DNS, TCP, TLS, the login and the session setup together.
            match tokio::time::timeout(target.connect_timeout, connect(request)).await {
                Ok(result) => result,
                Err(_) => Err(YadbeError::connection_timeout(
                    &target.host,
                    timeout_secs(target),
                )),
            }
        })
    }
}

fn timeout_secs(target: &ConnectTarget) -> u32 {
    u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX)
}

fn os_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_owned())
}

/// The OS trust store as DER blobs, loaded once (it reads hundreds of files on Linux).
fn native_roots() -> &'static [Vec<u8>] {
    static ROOTS: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let result = rustls_native_certs::load_native_certs();
        for err in &result.errors {
            tracing::warn!(error = %err, "could not load some OS root certificates");
        }
        result.certs.into_iter().map(|c| c.to_vec()).collect()
    })
}

/// The custom CA file's certificates, read here so a bad file is a typed error.
fn ca_roots(path: &std::path::Path) -> Result<Vec<Vec<u8>>, YadbeError> {
    use rustls::pki_types::CertificateDer;
    use rustls::pki_types::pem::PemObject;
    let unreadable = |detail: String| {
        YadbeError::tls_failed().with_detail(format!(
            "cannot read the CA file {}: {detail}",
            path.display()
        ))
    };
    let mut roots = Vec::new();
    for cert in CertificateDer::pem_file_iter(path).map_err(|e| unreadable(e.to_string()))? {
        let cert = cert.map_err(|e| unreadable(e.to_string()))?;
        roots.push(cert.to_vec());
    }
    if roots.is_empty() {
        return Err(unreadable("no certificate in the file".to_owned()));
    }
    Ok(roots)
}

/// The TLS options of a mode. `prefer` and `require` without CA encrypt without
/// authenticating the server; `verifyFull` verifies the chain and the host name, against
/// the CA or the OS trust store.
///
/// `require` with a CA verifies the host name too, unlike the other engines (chain only):
/// mysql_async 0.37 cannot skip the name check with rustls 0.23 (its option matches an
/// error text rustls no longer produces). Stricter, never weaker.
fn ssl_opts(
    mode: TlsMode,
    ca: Option<&std::path::Path>,
    identity: Option<&TlsIdentity>,
) -> Result<Option<SslOpts>, YadbeError> {
    let opts = ssl_opts_without_identity(mode, ca)?;
    // The decrypted key stays in the options for the life of the connection: mysql_async
    // reads the identity again at every (re)connect.
    Ok(opts.map(|opts| match identity {
        Some(identity) => opts.with_client_identity(Some(ClientIdentity::new(
            identity.cert_pem().to_vec().into(),
            identity.key_pem().to_vec().into(),
        ))),
        None => opts,
    }))
}

fn ssl_opts_without_identity(
    mode: TlsMode,
    ca: Option<&std::path::Path>,
) -> Result<Option<SslOpts>, YadbeError> {
    Ok(match (mode, ca) {
        (TlsMode::Disable, _) => None,
        (TlsMode::Prefer, _) | (TlsMode::Require, None) => {
            Some(SslOpts::default().with_danger_accept_invalid_certs(true))
        }
        (TlsMode::Require | TlsMode::VerifyFull, Some(ca)) => Some(
            SslOpts::default()
                .with_root_certs(ca_roots(ca)?.into_iter().map(Into::into).collect())
                .with_disable_built_in_roots(true),
        ),
        (TlsMode::VerifyFull, None) => {
            let native = native_roots();
            let opts = SslOpts::default();
            Some(if native.is_empty() {
                // No OS store (minimal containers): the Mozilla roots built into the crate.
                opts
            } else {
                opts.with_root_certs(native.iter().map(|der| der.clone().into()).collect())
                    .with_disable_built_in_roots(true)
            })
        }
    })
}

fn builder(target: &ConnectTarget, password: Option<&str>) -> OptsBuilder {
    let user = if target.username.is_empty() {
        os_user()
    } else {
        target.username.clone()
    };
    let mut builder = OptsBuilder::default()
        .user(Some(user))
        .pass(password.map(str::to_owned))
        .db_name((!target.database.is_empty()).then(|| target.database.clone()))
        // Never switches to the Unix socket behind a TCP address (a settings query).
        .prefer_socket(false)
        .tcp_nodelay(true)
        .tcp_keepalive(Some(Duration::from_secs(60)))
        .max_allowed_packet(Some(MAX_PACKET))
        // Only pools read it; given, the connection does not query it.
        .wait_timeout(Some(28_800))
        .client_found_rows(true)
        .connect_attribute("program_name", APPLICATION_NAME);
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    if let Some(dial) = target.dial {
        // An SSH tunnel's local end: TCP goes there, the host name stays for TLS.
        builder = builder
            .ip_or_hostname(host)
            .tcp_port(dial.port())
            .resolved_ips(Some(vec![dial.ip()]));
    } else if cfg!(unix) && target.host.starts_with('/') {
        builder = builder
            .ip_or_hostname("localhost")
            .socket(Some(target.host.clone()));
    } else {
        builder = builder.ip_or_hostname(host).tcp_port(target.port);
    }
    builder
}

async fn resolve(target: &ConnectTarget) -> Result<(), YadbeError> {
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    // Through a tunnel, the SSH server resolves the host.
    if target.dial.is_some()
        || target.host.starts_with('/')
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return Ok(());
    }
    let found = tokio::net::lookup_host((host, target.port))
        .await
        .map_err(|e| YadbeError::host_not_found(&target.host).with_detail(e.to_string()))?
        .next()
        .is_some();
    if found {
        Ok(())
    } else {
        Err(YadbeError::host_not_found(&target.host))
    }
}

/// rustls needs one process-wide crypto provider; yadbe ships `ring` only.
fn install_crypto_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// The connection and the options it was opened with (the `KILL QUERY` connection reuses
/// them, plain text included when `prefer` fell back to it).
async fn open(opts: Opts, target: &ConnectTarget) -> Result<(Conn, Opts), YadbeError> {
    match Conn::new(opts.clone()).await {
        Ok(conn) => Ok((conn, opts)),
        // `prefer` falls back to plain text when the server offers no TLS.
        Err(MyError::Driver(DriverError::NoClientSslFlagFromServer))
            if target.tls_mode == TlsMode::Prefer =>
        {
            let plain = Opts::from(OptsBuilder::from_opts(opts).ssl_opts(None::<SslOpts>));
            let conn = Conn::new(plain.clone())
                .await
                .map_err(|e| classify_connect(&e, target))?;
            Ok((conn, plain))
        }
        Err(err) => Err(classify_connect(&err, target)),
    }
}

/// MySQL or MariaDB, and the version, from `VERSION()` (`8.4.2`, `10.11.6-MariaDB-…`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Flavor {
    pub mariadb: bool,
    pub version: (u16, u16, u16),
}

impl Flavor {
    fn parse(version: &str) -> Flavor {
        let number = version.split('-').next().unwrap_or_default();
        let mut parts = number
            .split('.')
            .map(|p| p.parse::<u16>().unwrap_or_default());
        Flavor {
            mariadb: version.to_ascii_lowercase().contains("mariadb"),
            version: (
                parts.next().unwrap_or_default(),
                parts.next().unwrap_or_default(),
                parts.next().unwrap_or_default(),
            ),
        }
    }

    pub(super) fn at_least(&self, major: u16, minor: u16, patch: u16) -> bool {
        self.version >= (major, minor, patch)
    }
}

async fn connect(request: ConnectRequest<'_>) -> Result<Box<dyn Connection>, YadbeError> {
    install_crypto_provider();
    let target = request.target;
    resolve(target).await?;
    let password = request.password.map(|p| p.expose());
    let builder = builder(target, password).ssl_opts(ssl_opts(
        target.tls_mode,
        target.ca_cert_path.as_deref(),
        target.tls_identity.as_deref(),
    )?);
    let opts = Opts::from(builder);
    let (mut conn, opts) = open(opts, target).await?;

    let recorder = request.recorder;
    let version = recorded(&*recorder, VERSION_SQL, |_| Some(1), async {
        let result = buffered_text(&mut conn, VERSION_SQL, 1)
            .await
            .map_err(|e| classify_query(&e))?;
        result
            .scalar_text()
            .ok_or_else(|| YadbeError::internal("SELECT VERSION() returned no row"))
    })
    .await?;
    if target.read_only {
        // The default of every transaction of the session, autocommit ones included.
        recorded(&*recorder, READ_ONLY_SQL, |_| None, async {
            conn.query_drop(READ_ONLY_SQL)
                .await
                .map_err(|e| classify_query(&e))
        })
        .await?;
    }
    let flavor = Flavor::parse(&version);
    let number = version.split('-').next().unwrap_or_default();
    let product = if flavor.mariadb { "MariaDB" } else { "MySQL" };
    let (signal, link) = LinkWatch::new();
    let kill = Arc::new(Killer {
        opts,
        connection_id: conn.id(),
        recorder: Arc::clone(&recorder),
        latest: AtomicU64::new(0),
        running: AtomicBool::new(false),
        killed: AtomicBool::new(false),
    });
    Ok(Box::new(MysqlConnection {
        inner: Arc::new(Inner {
            conn: tokio::sync::Mutex::new(Some(conn)),
            flavor,
            recorder,
            signal,
            kill,
            in_transaction: AtomicBool::new(false),
            read_only: AtomicBool::new(target.read_only),
        }),
        server_version: format!("{product} {number}"),
        link,
    }))
}

/// Sends `KILL QUERY` for the statement a connection runs, from a connection of its own.
pub(super) struct Killer {
    opts: Opts,
    connection_id: u32,
    recorder: Arc<dyn StatementRecorder>,
    /// The epoch of the newest cancel handle.
    latest: AtomicU64,
    /// A statement runs.
    running: AtomicBool,
    /// `KILL QUERY` was sent for the running statement. MariaDB lets a statement whose
    /// `SLEEP()` was interrupted finish normally: it still ends as cancelled.
    killed: AtomicBool,
}

impl Killer {
    /// Marks a statement as running until the guard drops.
    pub(super) fn start(&self) -> RunningGuard<'_> {
        self.killed.store(false, Ordering::SeqCst);
        self.running.store(true, Ordering::SeqCst);
        RunningGuard(self)
    }

    fn busy(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// `KILL QUERY` when a statement runs and no newer handle superseded `epoch`: a late
    /// cancel of a finished execution never stops the next one.
    async fn kill(&self, epoch: Option<u64>) -> Result<(), YadbeError> {
        if !self.busy() {
            return Ok(());
        }
        if let Some(epoch) = epoch
            && self.latest.load(Ordering::SeqCst) != epoch
        {
            return Ok(());
        }
        // A connection id is a server-assigned integer: KILL takes no parameter.
        let sql = format!("KILL QUERY {}", self.connection_id);
        recorded(&*self.recorder, &sql, |_| None, async {
            let mut killer = Conn::new(self.opts.clone())
                .await
                .map_err(|e| classify_query(&e))?;
            let outcome = killer.query_drop(sql.as_str()).await;
            if let Err(err) = killer.disconnect().await {
                tracing::debug!(error = %err, "closing the KILL connection");
            }
            match outcome {
                Ok(()) => {
                    self.killed.store(true, Ordering::SeqCst);
                    Ok(())
                }
                // The statement ended meanwhile.
                Err(MyError::Server(e)) if e.code == 1094 => Ok(()),
                Err(e) => Err(classify_query(&e)),
            }
        })
        .await
    }
}

pub(super) struct RunningGuard<'a>(&'a Killer);

impl RunningGuard<'_> {
    /// Whether `KILL QUERY` was sent while the statement ran.
    pub(super) fn killed(&self) -> bool {
        self.0.killed.load(Ordering::SeqCst)
    }
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

struct MysqlCancel {
    killer: Arc<Killer>,
    epoch: u64,
}

impl CancelHandle for MysqlCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(self.killer.kill(Some(self.epoch)))
    }
}

/// The connection's state, shared with the tasks its statements run in: a statement runs
/// to its end in its own task even when the caller stops waiting (a dropped call), so the
/// wire protocol never stops between a request and its reply, and a running statement
/// stays visible to `KILL QUERY`.
pub(super) struct Inner {
    /// `None` once closed.
    conn: tokio::sync::Mutex<Option<Conn>>,
    flavor: Flavor,
    pub(super) recorder: Arc<dyn StatementRecorder>,
    signal: LinkSignal,
    kill: Arc<Killer>,
    in_transaction: AtomicBool,
    /// The session's transaction access mode as yadbe last set it.
    read_only: AtomicBool,
}

pub(super) struct MysqlConnection {
    inner: Arc<Inner>,
    server_version: String,
    link: LinkWatch,
}

/// Runs `work` in a task of its own and waits for it.
pub(super) async fn detached<T, E>(
    work: impl std::future::Future<Output = Result<T, E>> + Send + 'static,
) -> Result<T, E>
where
    T: Send + 'static,
    E: From<YadbeError> + Send + 'static,
{
    match tokio::spawn(work).await {
        Ok(result) => result,
        Err(err) => Err(E::from(YadbeError::internal(format!(
            "MySQL statement task failed: {err}"
        )))),
    }
}

/// One result set read in full (up to a row limit).
struct Buffered {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
}

/// What a statement read in full produced.
#[derive(Default)]
struct Drained {
    pub sets: Vec<Buffered>,
    /// Sum of the row counts of the replies without result set.
    pub affected: Option<u64>,
}

/// Reads every result set of `result`, keeping at most `max_rows` rows of each.
async fn drain<P: Protocol>(
    result: &mut MyResult<'_, '_, P>,
    max_rows: usize,
) -> Result<Drained, MyError> {
    let mut drained = Drained::default();
    while let Some(columns) = result.columns() {
        if columns.is_empty() {
            *drained.affected.get_or_insert(0) += result.affected_rows();
            result.next().await?;
            continue;
        }
        let (metas, decoders): (Vec<ColumnMeta>, Vec<Decoder>) =
            columns.iter().map(decode::column).unzip();
        let mut set = Buffered {
            columns: metas,
            rows: Vec::new(),
            truncated: false,
        };
        while let Some(row) = result.next().await? {
            if set.rows.len() >= max_rows {
                set.truncated = true;
                continue;
            }
            set.rows.push(decode_row(row, &decoders));
        }
        drained.sets.push(set);
    }
    Ok(drained)
}

fn decode_row(row: mysql_async::Row, decoders: &[Decoder]) -> Vec<Value> {
    row.unwrap_raw()
        .into_iter()
        .zip(decoders)
        .map(|(value, &decoder)| value.map_or(Value::Null, |value| decode::decode(value, decoder)))
        .collect()
}

/// A statement without parameters, through the text protocol; the first result set.
async fn buffered_text(
    conn: &mut Conn,
    sql: &str,
    max_rows: usize,
) -> Result<QueryResult, MyError> {
    let mut result = conn.query_iter(sql).await?;
    let drained = drain(&mut result, max_rows).await?;
    Ok(first_set(drained))
}

fn first_set(drained: Drained) -> QueryResult {
    let affected = drained.affected;
    match drained.sets.into_iter().next() {
        Some(set) => QueryResult {
            columns: set.columns,
            rows: set.rows,
            rows_affected: None,
            truncated: set.truncated,
        },
        None => QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: affected,
            truncated: false,
        },
    }
}

impl Inner {
    /// A failure that leaves the connection unusable ends its link.
    pub(super) fn failed(&self, err: &MyError) -> YadbeError {
        let error = classify_query(err);
        if error.code == ErrorCode::ConnectionLost {
            self.signal.lost();
        }
        error
    }

    pub(super) fn closed(&self) -> YadbeError {
        self.signal.lost();
        YadbeError::connection_lost()
    }

    pub(super) fn flavor(&self) -> Flavor {
        self.flavor
    }

    /// The connection, locked, with the statement marked as running for `KILL QUERY`.
    pub(super) async fn lock(
        &self,
    ) -> Result<(tokio::sync::MutexGuard<'_, Option<Conn>>, RunningGuard<'_>), YadbeError> {
        let guard = self.conn.lock().await;
        if guard.is_none() {
            return Err(self.closed());
        }
        Ok((guard, self.kill.start()))
    }

    /// The transaction state of the last reply. An error reply carries none: a `COM_PING`
    /// (no statement) asks for it.
    pub(super) async fn track_transaction(&self, conn: &mut Conn) {
        if conn.last_ok_packet().is_none()
            && let Err(err) = conn.ping().await
        {
            self.failed(&err);
            self.in_transaction.store(false, Ordering::SeqCst);
            return;
        }
        if let Some(ok) = conn.last_ok_packet() {
            self.in_transaction.store(
                ok.status_flags()
                    .contains(StatusFlags::SERVER_STATUS_IN_TRANS),
                Ordering::SeqCst,
            );
        }
    }

    /// A statement of yadbe's own, buffered.
    async fn run(&self, sql: &str, max_rows: usize) -> Result<QueryResult, YadbeError> {
        let (mut guard, running) = self.lock().await?;
        let conn = guard.as_mut().ok_or_else(|| self.closed())?;
        let result = buffered_text(conn, sql, max_rows).await;
        let killed = running.killed();
        drop(running);
        self.track_transaction(conn).await;
        match result {
            Ok(_) if killed => Err(YadbeError::cancelled()),
            other => other.map_err(|e| self.failed(&e)),
        }
    }
}

impl MysqlConnection {
    async fn run(&self, sql: &str, max_rows: usize) -> Result<QueryResult, YadbeError> {
        let inner = Arc::clone(&self.inner);
        let sql = sql.to_owned();
        detached(async move { inner.run(&sql, max_rows).await }).await
    }
}

impl Connection for MysqlConnection {
    fn server_version(&self) -> &str {
        &self.server_version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            recorded(&*self.inner.recorder, PING_SQL, |_| Some(1), async {
                self.run(PING_SQL, 1).await.map(|_| ())
            })
            .await
        })
    }

    fn keep_alive(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move { self.run(PING_SQL, 1).await.map(|_| ()) })
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, YadbeError>> {
        Box::pin(async move {
            let rows_of =
                |r: &QueryResult| r.rows_affected.or_else(|| u64::try_from(r.rows.len()).ok());
            recorded(&*self.inner.recorder, sql, rows_of, self.run(sql, max_rows)).await
        })
    }

    fn read_only_mode(&self) -> Option<bool> {
        Some(self.inner.read_only.load(Ordering::SeqCst))
    }

    fn set_read_only(&self, on: bool) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            let sql = if on { READ_ONLY_SQL } else { READ_WRITE_SQL };
            recorded(&*self.inner.recorder, sql, |_| None, self.run(sql, 0)).await?;
            self.inner.read_only.store(on, Ordering::SeqCst);
            Ok(())
        })
    }

    fn link(&self) -> LinkWatch {
        self.link.clone()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        let killer = Arc::clone(&self.inner.kill);
        let epoch = killer.latest.fetch_add(1, Ordering::SeqCst) + 1;
        Arc::new(MysqlCancel { killer, epoch })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let inner = &self.inner;
            // A running statement holds the connection: stop it first, then close.
            if inner.kill.busy()
                && let Err(err) = inner.kill.kill(None).await
            {
                tracing::debug!(error = %err, "stopping the statement of a closing connection");
            }
            if let Some(conn) = inner.conn.lock().await.take()
                && let Err(err) = conn.disconnect().await
            {
                tracing::debug!(error = %err, "closing a MySQL connection");
            }
            inner.signal.lost();
        })
    }

    fn execute<'a>(
        &'a self,
        sql: &'a str,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        let inner = Arc::clone(&self.inner);
        let sql = sql.to_owned();
        Box::pin(detached(async move {
            inner.execute_streaming(&sql, Vec::new(), events).await
        }))
    }

    fn execute_params<'a>(
        &'a self,
        statement: &'a ParamStatement,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        let inner = Arc::clone(&self.inner);
        let sql = statement.sql.clone();
        let params = statement
            .params
            .iter()
            .map(|p| bound::param(&p.value))
            .collect();
        Box::pin(detached(async move {
            inner.execute_streaming(&sql, params, events).await
        }))
    }

    fn explain<'a>(
        &'a self,
        statement: &'a ParamStatement,
        analyze: bool,
    ) -> BoxFuture<'a, Result<Explained, ExecError>> {
        let inner = Arc::clone(&self.inner);
        let statement = statement.clone();
        Box::pin(detached(
            async move { inner.explain(&statement, analyze).await },
        ))
    }

    fn query_bound<'a>(
        &'a self,
        statement: &'a BoundStatement,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, BoundFailure>> {
        Box::pin(async move {
            let inner = Arc::clone(&self.inner);
            let owned = statement.clone();
            recorded_bound(
                &*self.inner.recorder,
                statement,
                detached(async move { inner.run_bound(&owned, max_rows).await }),
            )
            .await
        })
    }

    fn in_transaction(&self) -> Option<bool> {
        Some(self.inner.in_transaction.load(Ordering::SeqCst))
    }

    fn introspector(&self) -> Option<&dyn crate::db::introspect::Introspector> {
        Some(self)
    }

    fn activity(&self) -> Option<&dyn crate::db::activity::ActivityMonitor> {
        Some(self)
    }
}

/// `ERROR 1146 (42S02): Table 'shop.nowhere' doesn't exist`, as the MySQL client prints it.
pub(super) fn server_detail(err: &mysql_async::ServerError) -> String {
    format!("ERROR {} ({}): {}", err.code, err.state, err.message)
}

fn io_failure(err: &IoError, target: &ConnectTarget) -> YadbeError {
    let message = err.to_string();
    let lower = message.to_ascii_lowercase();
    match err {
        IoError::Tls(_) => YadbeError::tls_failed(),
        _ if lower.contains("certificate")
            || lower.contains("tls")
            || lower.contains("handshake") =>
        {
            YadbeError::tls_failed()
        }
        IoError::Io(io) => match io.kind() {
            std::io::ErrorKind::ConnectionRefused => {
                YadbeError::connection_refused(&target.host, target.port)
            }
            std::io::ErrorKind::TimedOut => {
                YadbeError::connection_timeout(&target.host, timeout_secs(target))
            }
            std::io::ErrorKind::NotFound if target.host.starts_with('/') => {
                YadbeError::connection_refused(&target.host, target.port)
            }
            _ => YadbeError::connection_lost(),
        },
    }
    .with_detail(message)
}

fn classify_connect(err: &MyError, target: &ConnectTarget) -> YadbeError {
    match err {
        MyError::Server(server) => {
            let detail = server_detail(server);
            from_mysql_connect_error(server.code, &target.username, &target.database, &detail)
                .or_else(|| {
                    from_connect_sqlstate(
                        &server.state,
                        &target.username,
                        &target.database,
                        &detail,
                    )
                })
                .unwrap_or_else(|| YadbeError::query_failed(detail))
        }
        MyError::Io(io) => io_failure(io, target),
        MyError::Driver(DriverError::NoClientSslFlagFromServer) => {
            YadbeError::tls_not_supported().with_detail(err.to_string())
        }
        // An authentication method this build does not speak (`ed25519`, `gssapi`…).
        MyError::Driver(DriverError::UnknownAuthPlugin { .. }) => {
            YadbeError::auth_failed(&target.username).with_detail(err.to_string())
        }
        MyError::Driver(_) => YadbeError::connection_lost().with_detail(err.to_string()),
        MyError::Other(_) | MyError::Url(_) => YadbeError::internal(err.to_string()),
    }
}

/// A failure of a statement: the server's error, or a lost connection.
pub(super) fn classify_query(err: &MyError) -> YadbeError {
    match err {
        MyError::Server(server) => {
            let detail = server_detail(server);
            if SESSION_ENDED.contains(&server.code) {
                YadbeError::connection_lost().with_detail(detail)
            } else if server.code == INTERRUPTED {
                YadbeError::cancelled()
            } else {
                from_mysql_query_error(server.code, &detail)
                    .unwrap_or_else(|| YadbeError::query_failed(detail))
            }
        }
        MyError::Io(_)
        | MyError::Driver(
            DriverError::ConnectionClosed
            | DriverError::PacketOutOfOrder
            | DriverError::UnexpectedPacket { .. }
            | DriverError::PacketTooLarge,
        ) => YadbeError::connection_lost().with_detail(err.to_string()),
        MyError::Driver(_) | MyError::Other(_) | MyError::Url(_) => {
            YadbeError::internal(err.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_flavors() {
        let mysql = Flavor::parse("8.4.2");
        assert!(!mysql.mariadb && mysql.at_least(8, 0, 16));
        let maria = Flavor::parse("10.11.6-MariaDB-1:10.11.6+maria~ubu2204");
        assert!(maria.mariadb);
        assert_eq!(maria.version, (10, 11, 6));
        assert!(!Flavor::parse("5.7.44-log").at_least(8, 0, 0));
    }

    #[test]
    fn classifies_server_errors() {
        let server = |code: u16, state: &str| {
            MyError::Server(mysql_async::ServerError {
                code,
                message: "m".into(),
                state: state.into(),
            })
        };
        assert_eq!(
            classify_query(&server(1317, "70100")).code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            classify_query(&server(1792, "25006")).code,
            ErrorCode::ReadOnlyViolation
        );
        assert_eq!(
            classify_query(&server(1053, "08S01")).code,
            ErrorCode::ConnectionLost
        );
        assert_eq!(
            classify_query(&server(1146, "42S02")).code,
            ErrorCode::QueryFailed
        );
    }
}
