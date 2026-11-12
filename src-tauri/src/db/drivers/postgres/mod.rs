//! PostgreSQL driver: `tokio-postgres` over rustls.

mod bound;
mod decode;
mod execute;
mod introspect;
mod objects;
mod tls;

use std::error::Error as _;
use std::io;
use std::net::IpAddr;
use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use tokio::task::JoinHandle;
use tokio_postgres::AsyncMessage;
use tokio_postgres::config::SslMode;
use tokio_postgres::types::ToSql;
use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use self::decode::{Raw, column_meta, decode};
use self::tls::RustlsConnect;
use crate::db::config::{ConnectTarget, TlsMode};
use crate::db::dialect::Engine;
use crate::db::driver::Explained;
use crate::db::driver::{
    BoundFailure, BoundStatement, BoxFuture, CancelHandle, ConnectRequest, Connection, Driver,
    ExecError, ExecSender, ExecSummary, LinkWatch, StatementRecorder, recorded, recorded_bound,
};
use crate::db::errors::{YadbeError, from_connect_sqlstate, from_query_sqlstate};
use crate::db::params::ParamStatement;
use crate::db::plan::RawPlan;
use crate::db::value::{QueryResult, Value};

const APPLICATION_NAME: &str = "yadbe";
const VERSION_SQL: &str = "SHOW server_version";
const PING_SQL: &str = "SELECT 1";

pub struct PostgresDriver;

impl Driver for PostgresDriver {
    fn engine(&self) -> Engine {
        Engine::Postgres
    }

    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Box<dyn Connection>, YadbeError>> {
        Box::pin(async move {
            let target = request.target;
            let secs = u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX);
            // tokio-postgres bounds each TCP attempt; this bounds DNS + TLS + auth too.
            match tokio::time::timeout(target.connect_timeout, connect(request)).await {
                Ok(result) => result,
                Err(_) => Err(YadbeError::connection_timeout(&target.host, secs)),
            }
        })
    }
}

fn os_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "postgres".to_owned())
}

async fn resolve(target: &ConnectTarget) -> Result<Vec<IpAddr>, YadbeError> {
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    let addrs = tokio::net::lookup_host((host, target.port))
        .await
        .map_err(|e| YadbeError::host_not_found(&target.host).with_detail(e.to_string()))?;
    let mut ips: Vec<IpAddr> = Vec::new();
    for addr in addrs {
        if !ips.contains(&addr.ip()) {
            ips.push(addr.ip());
        }
    }
    if ips.is_empty() {
        return Err(YadbeError::host_not_found(&target.host));
    }
    Ok(ips)
}

async fn connect(request: ConnectRequest<'_>) -> Result<Box<dyn Connection>, YadbeError> {
    let target = request.target;
    let user = if target.username.is_empty() {
        os_user()
    } else {
        target.username.clone()
    };
    let mut config = tokio_postgres::Config::new();
    config
        .user(&user)
        // Through an SSH tunnel, the port of its local end.
        .port(target.dial.map_or(target.port, |dial| dial.port()))
        .connect_timeout(target.connect_timeout)
        .keepalives(true)
        .application_name(APPLICATION_NAME);
    if !target.database.is_empty() {
        config.dbname(&target.database);
    }
    if let Some(password) = request.password {
        config.password(password.expose());
    }
    for option in &target.options {
        match option.key.as_str() {
            "application_name" => {
                config.application_name(&option.value);
            }
            "options" => {
                config.options(&option.value);
            }
            other => tracing::warn!(key = other, "ignored PostgreSQL option"),
        }
    }
    if target.read_only {
        // A startup parameter, not a `SET`: `RESET` and `DISCARD ALL` come back to it.
        let options = config.get_options().unwrap_or_default();
        config.options(format!("{options} -c default_transaction_read_only=on").trim());
    }

    let unix_socket = cfg!(unix) && target.host.starts_with('/') && target.dial.is_none();
    if let Some(dial) = target.dial {
        // Through an SSH tunnel: TCP to its local end, `host` still names the server for
        // TLS (SNI, `verify-full`); cancel requests follow the same address.
        config.host(&target.host).hostaddr(dial.ip());
    } else if unix_socket {
        #[cfg(unix)]
        config.host_path(&target.host);
    } else {
        for ip in resolve(target).await? {
            config.host(&target.host).hostaddr(ip);
        }
    }
    // TLS never applies to Unix sockets.
    let mode = if unix_socket {
        TlsMode::Disable
    } else {
        target.tls_mode
    };
    config.ssl_mode(match mode {
        TlsMode::Disable => SslMode::Disable,
        TlsMode::Prefer => SslMode::Prefer,
        TlsMode::Require | TlsMode::VerifyFull => SslMode::Require,
    });
    let tls = RustlsConnect::new(tls::client_config(mode, target.ca_cert_path.as_deref())?);

    let (client, connection) = config
        .connect(tls.clone())
        .await
        .map_err(|err| classify_connect(&err, target, &user))?;
    let (signal, link) = LinkWatch::new();
    let notices = execute::SharedRoute::default();
    let route = Arc::clone(&notices);
    let task = tokio::spawn(async move {
        let mut connection = connection;
        let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notice(notice)) => route.deliver(&notice),
                Ok(_) => {}
                Err(err) => {
                    tracing::debug!(error = %err, "PostgreSQL connection ended");
                    break;
                }
            }
        }
        signal.lost();
    });

    let recorder = request.recorder;
    let version = recorded(&*recorder, VERSION_SQL, |_| Some(1), async {
        let messages = client
            .simple_query(VERSION_SQL)
            .await
            .map_err(|e| classify_query(&e))?;
        messages
            .iter()
            .find_map(|m| match m {
                SimpleQueryMessage::Row(row) => row.get(0).map(str::to_owned),
                _ => None,
            })
            .ok_or_else(|| YadbeError::internal("SHOW server_version returned no row"))
    })
    .await;
    let version = match version {
        Ok(version) => version,
        Err(err) => {
            task.abort();
            return Err(err);
        }
    };
    Ok(Box::new(PgConnection {
        cancel: client.cancel_token(),
        client,
        server_version: format!("PostgreSQL {version}"),
        recorder,
        link,
        tls,
        task,
        notices,
    }))
}

struct PgConnection {
    client: Client,
    server_version: String,
    recorder: Arc<dyn StatementRecorder>,
    link: LinkWatch,
    cancel: CancelToken,
    tls: RustlsConnect,
    task: JoinHandle<()>,
    notices: execute::SharedRoute,
}

impl Connection for PgConnection {
    fn server_version(&self) -> &str {
        &self.server_version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            recorded(&*self.recorder, PING_SQL, |_| Some(1), async {
                self.client
                    .simple_query(PING_SQL)
                    .await
                    .map(|_| ())
                    .map_err(|e| classify_query(&e))
            })
            .await
        })
    }

    fn keep_alive(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            self.client
                .simple_query(PING_SQL)
                .await
                .map(|_| ())
                .map_err(|e| classify_query(&e))
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
        Arc::new(PgCancel {
            token: self.cancel.clone(),
            tls: self.tls.clone(),
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        // Dropping the client sends Terminate; this ends the link for clones still alive.
        Box::pin(async move { self.task.abort() })
    }

    fn execute<'a>(
        &'a self,
        sql: &'a str,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        Box::pin(self.execute_streaming(sql, &[], events))
    }

    fn execute_params<'a>(
        &'a self,
        statement: &'a ParamStatement,
        events: ExecSender,
    ) -> BoxFuture<'a, Result<ExecSummary, ExecError>> {
        Box::pin(async move {
            let params: Vec<bound::TextParam> = statement
                .params
                .iter()
                .map(|p| bound::TextParam::of(&p.value))
                .collect();
            self.execute_streaming(&statement.sql, &params, events)
                .await
        })
    }

    fn explain<'a>(
        &'a self,
        statement: &'a ParamStatement,
        analyze: bool,
    ) -> BoxFuture<'a, Result<Explained, ExecError>> {
        Box::pin(async move {
            let options = if analyze {
                "ANALYZE, BUFFERS, FORMAT JSON"
            } else {
                "FORMAT JSON"
            };
            let sql = format!("EXPLAIN ({options}) {}", statement.sql);
            let params: Vec<bound::TextParam> = statement
                .params
                .iter()
                .map(|p| bound::TextParam::of(&p.value))
                .collect();
            let mut server = None;
            let rows_of = |r: &QueryResult| u64::try_from(r.rows.len()).ok();
            let read = recorded(&*self.recorder, &sql, rows_of, async {
                self.run_with(&sql, &params, usize::MAX)
                    .await
                    .map_err(|failure| match failure {
                        bound::PgFailure::Server(err) => {
                            server = Some(execute::exec_error(&err));
                            classify_query(&err)
                        }
                        bound::PgFailure::Decode(err) => err,
                    })
            })
            .await;
            let result = match read {
                Ok(result) => result,
                Err(error) => {
                    // The position is in the EXPLAIN text, not the user's: left out.
                    let mut failure = server.unwrap_or_else(|| error.into());
                    failure.location = None;
                    return Err(failure);
                }
            };
            let text: Vec<String> = result
                .rows
                .into_iter()
                .filter_map(|row| match row.into_iter().next() {
                    Some(Value::Json(text) | Value::Text(text)) => Some(text),
                    _ => None,
                })
                .collect();
            Ok(Explained {
                raw: RawPlan::PostgresJson(text.join("\n")),
                sent: sql,
            })
        })
    }

    fn introspector(&self) -> Option<&dyn crate::db::introspect::Introspector> {
        Some(self)
    }

    fn query_bound<'a>(
        &'a self,
        statement: &'a BoundStatement,
        max_rows: usize,
    ) -> BoxFuture<'a, Result<QueryResult, BoundFailure>> {
        Box::pin(async move {
            let params: Vec<bound::TextParam> =
                statement.params.iter().map(bound::TextParam::of).collect();
            recorded_bound(&*self.recorder, statement, async {
                self.run_with(&statement.sql, &params, max_rows)
                    .await
                    .map_err(|failure| match failure {
                        bound::PgFailure::Server(err) => bound::failure(&err),
                        bound::PgFailure::Decode(err) => err.into(),
                    })
            })
            .await
        })
    }
}

impl PgConnection {
    async fn run(&self, sql: &str, max_rows: usize) -> Result<QueryResult, YadbeError> {
        self.run_with(sql, &[], max_rows)
            .await
            .map_err(|failure| match failure {
                bound::PgFailure::Server(err) => classify_query(&err),
                bound::PgFailure::Decode(err) => err,
            })
    }

    /// Prepares `sql`, binds `params` and buffers at most `max_rows` rows.
    async fn run_with(
        &self,
        sql: &str,
        params: &[bound::TextParam],
        max_rows: usize,
    ) -> Result<QueryResult, bound::PgFailure> {
        let statement = self.client.prepare(sql).await?;
        let columns: Vec<_> = statement
            .columns()
            .iter()
            .map(|c| column_meta(c.name(), c.type_()))
            .collect();
        let stream = self
            .client
            .query_raw(&statement, params.iter().map(|p| p as &(dyn ToSql + Sync)))
            .await?;
        pin_mut!(stream);
        let mut rows = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row?;
            if rows.len() == max_rows {
                truncated = true;
                break;
            }
            let mut values = Vec::with_capacity(columns.len());
            for (index, column) in statement.columns().iter().enumerate() {
                let raw: Option<Raw<'_>> = row
                    .try_get(index)
                    .map_err(|e| bound::PgFailure::Decode(YadbeError::internal(e.to_string())))?;
                values.push(match raw {
                    None => Value::Null,
                    Some(Raw(bytes)) => decode(column.type_(), bytes).map_err(|e| {
                        bound::PgFailure::Decode(YadbeError::internal(format!(
                            "cannot decode a {} value: {e}",
                            column.type_().name()
                        )))
                    })?,
                });
            }
            rows.push(values);
        }
        let rows_affected = if columns.is_empty() {
            stream.rows_affected()
        } else {
            None
        };
        Ok(QueryResult {
            columns,
            rows,
            rows_affected,
            truncated,
        })
    }
}

struct PgCancel {
    token: CancelToken,
    tls: RustlsConnect,
}

impl CancelHandle for PgCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            self.token
                .cancel_query(self.tls.clone())
                .await
                .map_err(|e| classify_query(&e))
        })
    }
}

/// Finds a cause of type `T` in the error chain (also inside `io::Error`s).
fn find_cause<'a, T: std::error::Error + 'static>(
    err: &'a (dyn std::error::Error + 'static),
) -> Option<&'a T> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = current {
        if let Some(found) = e.downcast_ref::<T>() {
            return Some(found);
        }
        if let Some(io) = e.downcast_ref::<io::Error>()
            && let Some(inner) = io.get_ref()
            && let Some(found) = inner.downcast_ref::<T>()
        {
            return Some(found);
        }
        current = e.source();
    }
    None
}

fn classify_connect(err: &tokio_postgres::Error, target: &ConnectTarget, user: &str) -> YadbeError {
    // tokio-postgres puts the reason in the error's source: match on the whole chain.
    let detail = full_chain(err);
    if let Some(db) = err.as_db_error() {
        let message = format!("{} ({})", db.message(), db.code().code());
        return from_connect_sqlstate(db.code().code(), user, &target.database, &message)
            .unwrap_or_else(|| YadbeError::query_failed(message));
    }
    if find_cause::<rustls::Error>(err).is_some() {
        return YadbeError::tls_failed().with_detail(detail);
    }
    if detail.contains("server does not support TLS") {
        return YadbeError::tls_not_supported().with_detail(detail);
    }
    if detail.contains("password missing") {
        return YadbeError::password_required();
    }
    if let Some(io) = find_cause::<io::Error>(err) {
        return match io.kind() {
            io::ErrorKind::ConnectionRefused => {
                YadbeError::connection_refused(&target.host, target.port)
            }
            io::ErrorKind::TimedOut => YadbeError::connection_timeout(
                &target.host,
                u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX),
            ),
            io::ErrorKind::NotFound if target.host.starts_with('/') => {
                YadbeError::connection_refused(&target.host, target.port)
            }
            _ => YadbeError::connection_lost(),
        }
        .with_detail(full_chain(err));
    }
    if err.is_closed() {
        return YadbeError::connection_lost().with_detail(detail);
    }
    YadbeError::internal(full_chain(err))
}

/// A statement failure: the server's message, or a lost connection.
fn classify_query(err: &tokio_postgres::Error) -> YadbeError {
    if let Some(db) = err.as_db_error() {
        let code = db.code().code();
        if matches!(code, "57P01" | "57P02" | "57P03") {
            return YadbeError::connection_lost().with_detail(db.message());
        }
        if let Some(error) = from_query_sqlstate(code, db.message()) {
            return error;
        }
        let mut detail = format!("{}: {}", db.severity(), db.message());
        if let Some(hint) = db.hint() {
            detail.push_str(&format!("\nHINT: {hint}"));
        }
        detail.push_str(&format!("\nSQLSTATE {code}"));
        return YadbeError::query_failed(detail);
    }
    if err.is_closed() || find_cause::<io::Error>(err).is_some() {
        return YadbeError::connection_lost().with_detail(full_chain(err));
    }
    YadbeError::internal(full_chain(err))
}

fn full_chain(err: &tokio_postgres::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(e) = source {
        let text = e.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = e.source();
    }
    out
}
