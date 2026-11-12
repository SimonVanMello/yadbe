//! Redis and Valkey through `redis` (redis-rs): one multiplexed RESP3 connection (RESP2 on a
//! server without `HELLO`) over a TCP or TLS stream yadbe opens itself, so that the SSH tunnel
//! and the TLS settings (CA, client certificate, verification mode) work as for the other
//! engines. The driver sends what it is given and converts the replies; read-only, dangerous
//! commands, timeouts and the statement log are the command gate's (`session::keyvalue`).
//!
//! TLS modes: `disable` and `prefer` are plain TCP (Redis has no in-protocol upgrade to TLS,
//! so `prefer` has nothing to try); `require` and `verifyFull` are TLS from the first byte
//! (`rediss://`), verified as for the other engines.

use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, ProtocolVersion, RedisConnectionInfo};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use crate::db::config::{ConnectTarget, TlsMode};
use crate::db::driver::{
    Backend, BoxFuture, CancelHandle, ConnectRequest, Driver, KeyValueConnection, Link, LinkSignal,
    LinkWatch, StatementRecorder, recorded,
};
use crate::db::engine::Engine;
use crate::db::errors::{YadbeError, from_redis_connect_error};
use crate::db::keyvalue::KvReply;

mod reply;

pub struct RedisDriver;

impl Driver for RedisDriver {
    fn engine(&self) -> Engine {
        Engine::Redis
    }

    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Backend, YadbeError>> {
        Box::pin(async move {
            let target = request.target;
            let secs = u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX);
            match tokio::time::timeout(target.connect_timeout, connect(request)).await {
                Ok(result) => result,
                Err(_) => Err(YadbeError::connection_timeout(&target.host, secs)),
            }
        })
    }
}

/// The database index of a target: its `database` field, `0` when empty.
pub fn database_index(target: &ConnectTarget) -> Result<u32, YadbeError> {
    let text = target.database.trim();
    if text.is_empty() {
        return Ok(0);
    }
    text.parse::<u32>().map_err(|_| {
        YadbeError::invalid_argument(
            "The database of a Redis connection is a number (0, 1, 2…).",
            "La base d'une connexion Redis est un numéro (0, 1, 2…).",
        )
    })
}

async fn tcp(target: &ConnectTarget) -> Result<TcpStream, YadbeError> {
    let refused = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::ConnectionRefused => {
            YadbeError::connection_refused(&target.host, target.port).with_detail(e.to_string())
        }
        _ => YadbeError::connection_lost().with_detail(e.to_string()),
    };
    let stream = if let Some(dial) = target.dial {
        // An SSH tunnel's local end: TCP goes there, the host name stays for TLS.
        TcpStream::connect(dial).await.map_err(refused)?
    } else {
        let host = target.host.trim_start_matches('[').trim_end_matches(']');
        let addrs: Vec<std::net::SocketAddr> = match host.parse::<IpAddr>() {
            Ok(ip) => vec![(ip, target.port).into()],
            Err(_) => tokio::net::lookup_host((host, target.port))
                .await
                .map_err(|e| YadbeError::host_not_found(&target.host).with_detail(e.to_string()))?
                .collect(),
        };
        if addrs.is_empty() {
            return Err(YadbeError::host_not_found(&target.host));
        }
        let mut last = None;
        let mut connected = None;
        for addr in addrs {
            match TcpStream::connect(addr).await {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(e) => last = Some(e),
            }
        }
        match connected {
            Some(stream) => stream,
            None => {
                return Err(last.map_or_else(|| YadbeError::host_not_found(&target.host), refused));
            }
        }
    };
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn uses_tls(mode: TlsMode) -> bool {
    matches!(mode, TlsMode::Require | TlsMode::VerifyFull)
}

/// Why a connection attempt failed, from what redis-rs reported.
fn classify(err: &redis::RedisError, target: &ConnectTarget, password_given: bool) -> YadbeError {
    if let Some(code) = err.code() {
        let detail = err.detail().unwrap_or_default();
        if let Some(known) = from_redis_connect_error(
            code,
            detail,
            &target.username,
            &target.database,
            password_given,
        ) {
            return known;
        }
        return YadbeError::query_failed(format!("{code} {detail}"));
    }
    let message = err.to_string();
    let lower = message.to_ascii_lowercase();
    if lower.contains("tls") || lower.contains("certificate") || lower.contains("handshake") {
        return YadbeError::tls_failed().with_detail(message);
    }
    if err.is_timeout() {
        let secs = u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX);
        return YadbeError::connection_timeout(&target.host, secs).with_detail(message);
    }
    YadbeError::connection_lost().with_detail(message)
}

/// The failure of a command on an open connection.
pub(super) fn command_error(err: &redis::RedisError) -> YadbeError {
    if let Some(code) = err.code() {
        let detail = err.detail().unwrap_or_default();
        let text = if detail.is_empty() {
            code.to_owned()
        } else {
            format!("{code} {detail}")
        };
        return YadbeError::query_failed(text);
    }
    YadbeError::connection_lost().with_detail(err.to_string())
}

/// A server that predates `HELLO` (RESP3) answers it as an unknown command.
fn no_resp3(err: &redis::RedisError) -> bool {
    let text = format!(
        "{} {}",
        err.code().unwrap_or_default(),
        err.detail().unwrap_or_default()
    )
    .to_ascii_lowercase();
    text.contains("unknown command") && text.contains("hello") || text.contains("noproto")
}

struct Opened {
    conn: MultiplexedConnection,
    driver: JoinHandle<()>,
    link: LinkWatch,
}

async fn handshake<C>(
    stream: C,
    info: &RedisConnectionInfo,
    signal: LinkSignal,
) -> Result<(MultiplexedConnection, JoinHandle<()>), (redis::RedisError, LinkSignal)>
where
    C: Unpin + AsyncRead + AsyncWrite + Send + 'static,
{
    // No response timeout: the gate applies the connection's statement timeout itself.
    let config = AsyncConnectionConfig::new().set_response_timeout(None);
    match MultiplexedConnection::new_with_config(info, stream, config).await {
        Ok((conn, driver)) => {
            let task = tokio::spawn(async move {
                driver.await;
                signal.lost();
            });
            Ok((conn, task))
        }
        Err(err) => Err((err, signal)),
    }
}

async fn open(
    target: &ConnectTarget,
    info: &RedisConnectionInfo,
    password_given: bool,
) -> Result<Opened, Result<YadbeError, redis::RedisError>> {
    let stream = tcp(target).await.map_err(Ok)?;
    let (signal, link) = LinkWatch::new();
    let result = if uses_tls(target.tls_mode) {
        let config = super::postgres::tls::client_config(
            target.tls_mode,
            target.ca_cert_path.as_deref(),
            target.tls_identity.as_deref(),
        )
        .map_err(Ok)?;
        let host = target.host.trim_start_matches('[').trim_end_matches(']');
        let name = ServerName::try_from(host.to_owned())
            .map_err(|e| Ok(YadbeError::tls_failed().with_detail(e.to_string())))?;
        let tls = tokio_rustls::TlsConnector::from(config)
            .connect(name, stream)
            .await
            .map_err(|e| {
                let message = e.to_string();
                let error = if message
                    .to_ascii_lowercase()
                    .contains("certificate required")
                {
                    YadbeError::tls_client_cert_required()
                } else {
                    YadbeError::tls_failed()
                };
                Ok(error.with_detail(message))
            })?;
        handshake(tls, info, signal).await
    } else {
        handshake(stream, info, signal).await
    };
    match result {
        Ok((conn, driver)) => Ok(Opened { conn, driver, link }),
        Err((err, _)) if no_resp3(&err) => Err(Err(err)),
        Err((err, _)) => Err(Ok(classify(&err, target, password_given))),
    }
}

async fn connect(request: ConnectRequest<'_>) -> Result<Backend, YadbeError> {
    let target = request.target;
    let database = database_index(target)?;
    let mut info = RedisConnectionInfo::default()
        .set_db(i64::from(database))
        .set_skip_set_lib_name();
    if !target.username.is_empty() {
        info = info.set_username(&target.username);
    }
    let password_given = request.password.is_some_and(|p| !p.is_empty());
    if let Some(password) = request.password.filter(|p| !p.is_empty()) {
        info = info.set_password(password.expose());
    }
    let opened = match open(
        target,
        &info.clone().set_protocol(ProtocolVersion::RESP3),
        password_given,
    )
    .await
    {
        Ok(opened) => opened,
        Err(Ok(error)) => return Err(error),
        // A server older than Redis 6: RESP2.
        Err(Err(_)) => open(
            target,
            &info.set_protocol(ProtocolVersion::RESP2),
            password_given,
        )
        .await
        .map_err(|failure| match failure {
            Ok(error) => error,
            Err(err) => classify(&err, target, password_given),
        })?,
    };
    let connection = RedisConnection {
        conn: opened.conn,
        driver: Mutex::new(Some(opened.driver)),
        link: opened.link,
        database,
        version: String::new(),
        recorder: Arc::clone(&request.recorder),
    };
    let version = connection.read_version().await?;
    Ok(Backend::KeyValue(Arc::new(RedisConnection {
        version,
        ..connection
    })))
}

struct RedisConnection {
    conn: MultiplexedConnection,
    /// The task that reads the socket; aborted on close.
    driver: Mutex<Option<JoinHandle<()>>>,
    link: LinkWatch,
    database: u32,
    version: String,
    recorder: Arc<dyn StatementRecorder>,
}

fn command(args: &[Vec<u8>]) -> redis::Cmd {
    let mut cmd = redis::Cmd::new();
    for arg in args {
        cmd.arg(arg.as_slice());
    }
    cmd
}

/// `Redis 8.2.1`, `Valkey 8.1.0`, from `INFO server`.
fn version_of(info: &str) -> String {
    let field = |name: &str| {
        info.lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .map(|v| v.trim().to_owned())
    };
    if let Some(valkey) = field("valkey_version") {
        return format!("Valkey {valkey}");
    }
    match field("redis_version") {
        Some(version) => format!("Redis {version}"),
        None => "Redis".to_owned(),
    }
}

impl RedisConnection {
    async fn raw(&self, args: &[Vec<u8>]) -> Result<KvReply, YadbeError> {
        let mut conn = self.conn.clone();
        match conn.send_packed_command(&command(args)).await {
            // A server error reply is the command's failure.
            Ok(value) => match reply::convert(value) {
                KvReply::Error(message) => Err(YadbeError::query_failed(message)),
                other => Ok(other),
            },
            Err(err) => Err(command_error(&err)),
        }
    }

    async fn read_version(&self) -> Result<String, YadbeError> {
        let args = vec![b"INFO".to_vec(), b"server".to_vec()];
        let info = recorded(&*self.recorder, "INFO server", |_| None, self.raw(&args)).await?;
        Ok(version_of(&info.text().unwrap_or_default()))
    }
}

impl Link for RedisConnection {
    fn server_version(&self) -> &str {
        &self.version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            let args = vec![b"PING".to_vec()];
            recorded(&*self.recorder, "PING", |_| None, self.raw(&args))
                .await
                .map(|_| ())
        })
    }

    fn keep_alive(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            let args = vec![b"PING".to_vec()];
            self.raw(&args).await.map(|_| ())
        })
    }

    fn link(&self) -> LinkWatch {
        self.link.clone()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        Arc::new(NoCancel)
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let driver = self
                .driver
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(driver) = driver {
                driver.abort();
            }
        })
    }
}

impl KeyValueConnection for RedisConnection {
    fn database(&self) -> u32 {
        self.database
    }

    fn send<'a>(&'a self, args: &'a [Vec<u8>]) -> BoxFuture<'a, Result<KvReply, YadbeError>> {
        Box::pin(self.raw(args))
    }

    fn send_all<'a>(
        &'a self,
        commands: &'a [Vec<Vec<u8>>],
    ) -> BoxFuture<'a, Vec<Result<KvReply, YadbeError>>> {
        Box::pin(async move {
            if commands.is_empty() {
                return Vec::new();
            }
            // One pipeline: written in order, one round trip, a reply (or error) per command.
            let mut pipe = redis::Pipeline::with_capacity(commands.len());
            pipe.ignore_errors();
            for args in commands {
                pipe.add_command(command(args));
            }
            let mut conn = self.conn.clone();
            match conn.send_packed_commands(&pipe, 0, commands.len()).await {
                Ok(values) => values
                    .into_iter()
                    .map(|value| match reply::convert(value) {
                        KvReply::Error(message) => Err(YadbeError::query_failed(message)),
                        other => Ok(other),
                    })
                    .collect(),
                Err(err) => {
                    let error = command_error(&err);
                    commands.iter().map(|_| Err(error.clone())).collect()
                }
            }
        })
    }
}

/// A running Redis command cannot be stopped (`native_cancel = false`).
struct NoCancel;

impl CancelHandle for NoCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_product_and_version() {
        assert_eq!(
            version_of("# Server\r\nredis_version:8.2.1\r\n"),
            "Redis 8.2.1"
        );
        assert_eq!(
            version_of("redis_version:7.2.4\r\nvalkey_version:8.1.0\r\n"),
            "Valkey 8.1.0"
        );
    }

    #[test]
    fn the_database_is_a_number() {
        let mut target = crate::db::config::sample_definition(Engine::Redis).target();
        target.database = String::new();
        assert_eq!(database_index(&target).expect("default"), 0);
        target.database = "3".into();
        assert_eq!(database_index(&target).expect("three"), 3);
        target.database = "app".into();
        assert!(database_index(&target).is_err());
    }
}
