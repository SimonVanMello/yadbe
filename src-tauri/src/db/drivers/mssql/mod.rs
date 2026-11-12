//! SQL Server driver (2017+, Azure SQL): `tiberius` over rustls (ring), SQL logins.
//!
//! The crate is vendored with a small patch (`vendor/tiberius/PATCHES.md`): user
//! batches go through `Client::batch`, which reports every token in order (result sets,
//! row counts, `PRINT` / `RAISERROR` messages, errors) and cancels with an in-band TDS
//! Attention. yadbe's own statements without parameters are plain batches too (a
//! `BEGIN TRANSACTION` must not run inside `sp_executesql`); metadata queries bind their
//! names as RPC parameters.

mod activity;
mod bound;
mod decode;
mod execute;
mod introspect;
mod objects;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::TryStreamExt;
use tiberius::error::Error as TdsError;
use tiberius::{AttentionSignal, AuthMethod, BatchItem, Client, Config, EncryptionLevel};
use tokio::net::{TcpSocket, TcpStream};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::db::config::{ConnectTarget, TlsMode};
use crate::db::dialect::Engine;
use crate::db::driver::{
    BoundFailure, BoundStatement, BoxFuture, CancelHandle, ConnectRequest, Connection, Driver,
    ExecError, ExecSender, ExecSummary, Explained, LinkSignal, LinkWatch, StatementRecorder,
    recorded, recorded_bound,
};
use crate::db::errors::{YadbeError, from_mssql_login_error, from_mssql_query_error};
use crate::db::params::ParamStatement;
use crate::db::value::{QueryResult, Value};

type Tds = Client<Compat<TcpStream>>;

const APPLICATION_NAME: &str = "yadbe";
const VERSION_SQL: &str = "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), \
CAST(SERVERPROPERTY('EngineEdition') AS int)";
const PING_SQL: &str = "SELECT 1";
/// SQL Server's own default; a named instance is found through the SQL Browser on it.
const DEFAULT_PORT: u16 = 1433;

pub struct MssqlDriver;

impl Driver for MssqlDriver {
    fn engine(&self) -> Engine {
        Engine::Mssql
    }

    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Box<dyn Connection>, YadbeError>> {
        Box::pin(async move {
            let target = request.target;
            let secs = u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX);
            // Bounds DNS, the SQL Browser, TCP, TLS and the login together.
            match tokio::time::timeout(target.connect_timeout, connect(request)).await {
                Ok(result) => result,
                Err(_) => Err(YadbeError::connection_timeout(&target.host, secs)),
            }
        })
    }
}

/// `host\instance` → (`host`, `instance`).
fn split_instance(host: &str) -> (&str, Option<&str>) {
    match host.split_once('\\') {
        Some((host, instance)) if !instance.is_empty() => (host, Some(instance)),
        Some((host, _)) => (host, None),
        None => (host, None),
    }
}

/// The user's option `key` (ADO.NET / JDBC spellings), if set.
fn option<'a>(target: &'a ConnectTarget, keys: &[&str]) -> Option<&'a str> {
    target.options.iter().find_map(|o| {
        let key: String = o
            .key
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '_')
            .flat_map(char::to_lowercase)
            .collect();
        keys.contains(&key.as_str()).then_some(o.value.as_str())
    })
}

fn config(target: &ConnectTarget, password: &str, host: &str, port: u16) -> Config {
    let mut config = Config::new();
    config.host(host);
    config.port(port);
    if !target.database.is_empty() {
        config.database(&target.database);
    }
    config
        .application_name(option(target, &["applicationname", "app"]).unwrap_or(APPLICATION_NAME));
    config.authentication(AuthMethod::sql_server(&target.username, password));
    // A routing hint for availability groups; the session is not made read-only by it.
    config.readonly(target.read_only);
    // User statements run as long as they need: cancelling is the user's call.
    config.command_timeout(None);
    config.handshake_timeout(Some(target.connect_timeout));
    // `disable` still encrypts the login, like every Microsoft client with `Encrypt=False`
    // (the password would otherwise cross the network merely obfuscated); the rest goes in
    // clear unless the server forces encryption. `prefer` encrypts everything the server
    // agrees to, which SQL Server always does. `require` verifies the chain only with a
    // custom CA (then with the host name too: tiberius cannot check one without the
    // other), `verifyFull` always.
    let (level, verify) = match target.tls_mode {
        TlsMode::Disable => (EncryptionLevel::Off, false),
        TlsMode::Prefer => (EncryptionLevel::On, false),
        TlsMode::Require => (EncryptionLevel::Required, target.ca_cert_path.is_some()),
        TlsMode::VerifyFull => (EncryptionLevel::Required, true),
    };
    config.encryption(level);
    match (&target.ca_cert_path, verify) {
        (_, false) => config.trust_cert(),
        (Some(ca), true) => config.trust_cert_ca(ca.display()),
        (None, true) => {} // OS trust store
    }
    config
}

async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, YadbeError> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
        .await
        .map_err(|e| YadbeError::host_not_found(host).with_detail(e.to_string()))?
        .collect();
    if addrs.is_empty() {
        return Err(YadbeError::host_not_found(host));
    }
    Ok(addrs)
}

/// A TCP connection with keepalive to the first address that answers (the local end of the
/// SSH tunnel when there is one).
async fn tcp(target: &ConnectTarget, host: &str, port: u16) -> Result<TcpStream, YadbeError> {
    let mut last: Option<std::io::Error> = None;
    let addrs = match target.dial {
        Some(dial) => vec![dial],
        None => resolve(host, port).await?,
    };
    for addr in addrs {
        let socket = if addr.is_ipv4() {
            TcpSocket::new_v4()
        } else {
            TcpSocket::new_v6()
        };
        let attempt = async {
            let socket = socket?;
            socket.set_keepalive(true)?;
            let stream = socket.connect(addr).await?;
            stream.set_nodelay(true)?;
            Ok::<_, std::io::Error>(stream)
        };
        match attempt.await {
            Ok(stream) => return Ok(stream),
            Err(err) => last = Some(err),
        }
    }
    let err = last.unwrap_or_else(|| std::io::Error::other("no address"));
    Err(match err.kind() {
        std::io::ErrorKind::ConnectionRefused => YadbeError::connection_refused(host, port),
        std::io::ErrorKind::TimedOut => YadbeError::connection_timeout(
            &target.host,
            u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX),
        ),
        _ => YadbeError::connection_refused(host, port),
    }
    .with_detail(err.to_string()))
}

async fn connect(request: ConnectRequest<'_>) -> Result<Box<dyn Connection>, YadbeError> {
    let target = request.target;
    if target.username.is_empty() {
        return Err(YadbeError::invalid_argument(
            "SQL Server needs a user name (SQL login).",
            "SQL Server a besoin d'un nom d'utilisateur (connexion SQL).",
        ));
    }
    let password = request.password.map(|p| p.expose()).unwrap_or_default();
    let (host, instance) = split_instance(&target.host);
    // `host\instance` on the default port asks the SQL Browser for the instance's port;
    // an explicit port is used as is.
    let mut client = match instance {
        Some(_) if target.port == DEFAULT_PORT && target.dial.is_some() => {
            return Err(YadbeError::ssh_tunnel_unsupported(
                "A named instance is found through the SQL Browser (UDP), which an SSH tunnel cannot carry: give the instance's port.",
                "Une instance nommée se trouve par le SQL Browser (UDP), qu'un tunnel SSH ne peut pas transporter : indiquez le port de l'instance.",
            ));
        }
        Some(instance) if target.port == DEFAULT_PORT => {
            let mut config = config(target, password, host, DEFAULT_PORT);
            config.instance_name(instance);
            // Without a port, tiberius asks the SQL Browser (UDP 1434).
            let mut browse = config.clone();
            browse.port(1434);
            let stream = <TcpStream as tiberius::SqlBrowser>::connect_named(&browse)
                .await
                .map_err(|e| classify_connect(&e, target))?;
            let _ = stream.set_nodelay(true);
            login(config, stream, target).await?
        }
        _ => {
            let config = config(target, password, host, target.port);
            let stream = tcp(target, host, target.port).await?;
            login(config, stream, target).await?
        }
    };

    let recorder = request.recorder;
    let version = recorded(&*recorder, VERSION_SQL, |_| Some(1), async {
        let rows = client
            .simple_query(VERSION_SQL)
            .await
            .map_err(|e| classify_query(&e))?
            .into_first_result()
            .await
            .map_err(|e| classify_query(&e))?;
        let row = rows
            .first()
            .ok_or_else(|| YadbeError::internal("the version query returned no row"))?;
        let version: Option<&str> = row.get(0);
        let edition: Option<i32> = row.get(1);
        Ok((version.unwrap_or_default().to_owned(), edition))
    })
    .await?;
    let product = match version.1 {
        Some(5) => "Azure SQL Database",
        Some(8) => "Azure SQL Managed Instance",
        _ => "SQL Server",
    };
    let (signal, link) = LinkWatch::new();
    let in_transaction = client.in_transaction();
    Ok(Box::new(MssqlConnection {
        client: tokio::sync::Mutex::new(Some(client)),
        server_version: format!("{product} {}", version.0),
        recorder,
        link,
        signal,
        attention: Mutex::new(AttentionSignal::new()),
        in_transaction: AtomicBool::new(in_transaction),
    }))
}

/// Logs in, following one gateway redirection (Azure SQL).
async fn login(
    config: Config,
    stream: TcpStream,
    target: &ConnectTarget,
) -> Result<Tds, YadbeError> {
    match Client::connect(config.clone(), stream.compat_write()).await {
        Ok(client) => Ok(client),
        Err(TdsError::Routing { .. }) if target.dial.is_some() => {
            Err(YadbeError::ssh_tunnel_unsupported(
                "The server redirects the connection to another host (Azure SQL redirect policy), which this SSH tunnel does not lead to. Use the proxy connection policy.",
                "Le serveur redirige la connexion vers un autre hôte (stratégie de redirection d'Azure SQL), où ce tunnel SSH ne mène pas. Utilisez la stratégie de connexion proxy.",
            ))
        }
        Err(TdsError::Routing { host, port }) => {
            let mut config = config;
            config.host(&host);
            config.port(port);
            let stream = tcp(target, &host, port).await?;
            Client::connect(config, stream.compat_write())
                .await
                .map_err(|e| classify_connect(&e, target))
        }
        Err(err) => Err(classify_connect(&err, target)),
    }
}

pub(super) struct MssqlConnection {
    /// `None` once closed.
    client: tokio::sync::Mutex<Option<Tds>>,
    server_version: String,
    recorder: Arc<dyn StatementRecorder>,
    link: LinkWatch,
    signal: LinkSignal,
    /// The cancel signal of the current execution (one per `cancel_handle`).
    attention: Mutex<Arc<AttentionSignal>>,
    in_transaction: AtomicBool,
}

impl MssqlConnection {
    /// A failure that leaves the connection unusable ends its link.
    fn failed(&self, err: &TdsError) -> YadbeError {
        let error = classify_query(err);
        if error.code == crate::db::errors::ErrorCode::ConnectionLost {
            self.signal.lost();
        }
        error
    }

    fn closed(&self) -> YadbeError {
        self.signal.lost();
        YadbeError::connection_lost()
    }

    fn current_attention(&self) -> Arc<AttentionSignal> {
        Arc::clone(
            &self
                .attention
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn track_transaction(&self, client: &Tds) {
        self.in_transaction
            .store(client.in_transaction(), Ordering::SeqCst);
    }

    /// A statement of yadbe's own, as a plain batch, buffered. The first server error
    /// fails it.
    async fn run(&self, sql: &str, max_rows: usize) -> Result<QueryResult, YadbeError> {
        let mut guard = self.client.lock().await;
        let client = guard.as_mut().ok_or_else(|| self.closed())?;
        let mut columns = Vec::new();
        let mut decoders = Vec::new();
        let mut rows: Vec<Vec<Value>> = Vec::new();
        let mut truncated = false;
        let mut affected: Option<u64> = None;
        let mut error: Option<tiberius::ServerMessage> = None;
        let mut open_result = false;
        {
            let mut stream = client.batch(sql, None).await.map_err(|e| self.failed(&e))?;
            while let Some(item) = stream.try_next().await.map_err(|e| self.failed(&e))? {
                match item {
                    BatchItem::Metadata(meta) if columns.is_empty() => {
                        open_result = true;
                        for column in meta.metadata.iter() {
                            let (meta, decoder) = decode::column_meta(column);
                            columns.push(meta);
                            decoders.push(decoder);
                        }
                    }
                    BatchItem::Metadata(_) => open_result = true,
                    BatchItem::Row(row) if row.result_index() == 0 => {
                        if rows.len() == max_rows {
                            truncated = true;
                            continue;
                        }
                        rows.push(
                            row.into_iter()
                                .zip(&decoders)
                                .map(|(data, &d)| decode::decode(data, d))
                                .collect(),
                        );
                    }
                    BatchItem::Row(_) => {}
                    BatchItem::Done(done) => {
                        if !open_result && let Some(n) = done.rows {
                            *affected.get_or_insert(0) += n;
                        }
                        open_result = false;
                    }
                    BatchItem::Message(message) if message.error => {
                        error.get_or_insert(message);
                    }
                    BatchItem::Message(message) => {
                        tracing::debug!(message = message.message, "SQL Server message");
                    }
                }
            }
        }
        self.track_transaction(client);
        if let Some(error) = error {
            return Err(YadbeError::query_failed(execute::detail(&error)));
        }
        Ok(QueryResult {
            rows_affected: if columns.is_empty() { affected } else { None },
            columns,
            rows,
            truncated,
        })
    }
}

impl Connection for MssqlConnection {
    fn server_version(&self) -> &str {
        &self.server_version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            recorded(&*self.recorder, PING_SQL, |_| Some(1), async {
                self.run(PING_SQL, 1).await.map(|_| ())
            })
            .await
        })
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, YadbeError>> {
        Box::pin(async move {
            let rows_of =
                |r: &QueryResult| r.rows_affected.or_else(|| u64::try_from(r.rows.len()).ok());
            recorded(&*self.recorder, sql, rows_of, self.run(sql, max_rows)).await
        })
    }

    fn link(&self) -> LinkWatch {
        self.link.clone()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        // A fresh signal per execution: a late cancel of a finished execution can never
        // stop the next one.
        let signal = AttentionSignal::new();
        *self
            .attention
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::clone(&signal);
        Arc::new(MssqlCancel(signal))
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            // A running statement keeps the client: cancel it first, then close.
            self.current_attention().request();
            if let Some(client) = self.client.lock().await.take()
                && let Err(err) = client.close().await
            {
                tracing::debug!(error = %err, "closing a SQL Server connection");
            }
            self.signal.lost();
        })
    }

    fn execute<'a>(
        &'a self,
        sql: &'a str,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        Box::pin(self.execute_streaming(sql, Vec::new(), events))
    }

    fn execute_params<'a>(
        &'a self,
        statement: &'a ParamStatement,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        let params = statement
            .params
            .iter()
            .map(|p| (p.name.clone(), bound::user_param(&p.value)))
            .collect();
        Box::pin(self.execute_streaming(&statement.sql, params, events))
    }

    fn explain<'a>(
        &'a self,
        statement: &'a ParamStatement,
        analyze: bool,
    ) -> BoxFuture<'a, Result<Explained, ExecError>> {
        Box::pin(self.explain(statement, analyze))
    }

    fn describe_origins<'a>(
        &'a self,
        statement: &'a ParamStatement,
    ) -> BoxFuture<'a, Result<Option<Vec<Option<crate::db::driver::ColumnOrigin>>>, YadbeError>>
    {
        Box::pin(async move { self.column_origins(statement).await.map(Some) })
    }

    fn in_transaction(&self) -> Option<bool> {
        Some(self.in_transaction.load(Ordering::SeqCst))
    }

    fn query_bound<'a>(
        &'a self,
        statement: &'a BoundStatement,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, BoundFailure>> {
        Box::pin(async move {
            recorded_bound(
                &*self.recorder,
                statement,
                self.run_bound(statement, max_rows),
            )
            .await
        })
    }

    fn introspector(&self) -> Option<&dyn crate::db::introspect::Introspector> {
        Some(self)
    }

    fn activity(&self) -> Option<&dyn crate::db::activity::ActivityMonitor> {
        Some(self)
    }
}

struct MssqlCancel(Arc<AttentionSignal>);

impl CancelHandle for MssqlCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        // The connection running the batch sends the TDS Attention as soon as it polls,
        // even in the middle of a row; the batch then reads up to the acknowledgement.
        self.0.request();
        Box::pin(async { Ok(()) })
    }
}

fn timeout_secs(target: &ConnectTarget) -> u32 {
    u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX)
}

fn classify_connect(err: &TdsError, target: &ConnectTarget) -> YadbeError {
    let (host, _) = split_instance(&target.host);
    match err {
        TdsError::Server(token) => from_mssql_login_error(
            token.code(),
            &target.username,
            &target.database,
            &format!("{} (error {})", token.message(), token.code()),
        )
        .unwrap_or_else(|| YadbeError::query_failed(token.to_string())),
        TdsError::Tls(message) => YadbeError::tls_failed().with_detail(message),
        TdsError::Io { kind, message } => {
            // The handshake bound's message names TLS and the handshake: a timeout first.
            if *kind == std::io::ErrorKind::TimedOut {
                return YadbeError::connection_timeout(&target.host, timeout_secs(target))
                    .with_detail(message);
            }
            let lower = message.to_ascii_lowercase();
            if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake")
            {
                return YadbeError::tls_failed().with_detail(message);
            }
            match kind {
                std::io::ErrorKind::ConnectionRefused => {
                    YadbeError::connection_refused(host, target.port)
                }
                std::io::ErrorKind::TimedOut => {
                    YadbeError::connection_timeout(&target.host, timeout_secs(target))
                }
                std::io::ErrorKind::NotFound => YadbeError::host_not_found(&target.host),
                _ => YadbeError::connection_lost(),
            }
            .with_detail(message)
        }
        TdsError::Protocol(message) => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("encrypt") {
                // The server and the TLS mode disagree on encryption.
                if matches!(target.tls_mode, TlsMode::Require | TlsMode::VerifyFull) {
                    YadbeError::tls_not_supported()
                } else {
                    YadbeError::tls_failed()
                }
                .with_detail(message.as_ref())
            } else {
                YadbeError::connection_lost().with_detail(message.as_ref())
            }
        }
        other => YadbeError::internal(other.to_string()),
    }
}

/// A failure of a statement: the server's error, or a lost connection.
fn classify_query(err: &TdsError) -> YadbeError {
    match err {
        TdsError::Server(token) => {
            let detail = format!(
                "{} (error {}, severity {})",
                token.message(),
                token.code(),
                token.class()
            );
            from_mssql_query_error(token.code(), &detail)
                .unwrap_or_else(|| YadbeError::query_failed(detail))
        }
        TdsError::Io { message, .. } => YadbeError::connection_lost().with_detail(message),
        TdsError::Protocol(message) => YadbeError::connection_lost().with_detail(message.as_ref()),
        other => YadbeError::internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_named_instances() {
        assert_eq!(split_instance("sql\\PROD"), ("sql", Some("PROD")));
        assert_eq!(split_instance("sql"), ("sql", None));
        assert_eq!(split_instance("sql\\"), ("sql", None));
    }

    #[test]
    fn a_stalled_handshake_is_a_timeout_not_a_tls_failure() {
        use crate::db::config::{AuthMethod, ConnectionDefinition, Environment, TlsMode};
        use crate::db::errors::ErrorCode;
        let target = ConnectionDefinition {
            name: "silent".into(),
            engine: Engine::Mssql,
            host: "127.0.0.1".into(),
            port: Some(55999),
            database: String::new(),
            username: "sa".into(),
            file_path: String::new(),
            auth: AuthMethod::Password,
            tls_mode: TlsMode::Prefer,
            ca_cert_path: None,
            connect_timeout_secs: Some(3),
            options: Vec::new(),
            group_id: None,
            environment: Environment::default(),
            favorite: false,
            read_only: false,
            remember_password: false,
            history_enabled: true,
            ssh: None,
        }
        .target();
        // tiberius' handshake bound names "TLS negotiation" and "handshake" in its message.
        let err = TdsError::Io {
            kind: std::io::ErrorKind::TimedOut,
            message: "the connection handshake (prelogin, TLS negotiation and login) did not \
                      complete within 3s"
                .into(),
        };
        assert_eq!(
            classify_connect(&err, &target).code,
            ErrorCode::ConnectionTimeout
        );
    }
}
