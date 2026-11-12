//! Elasticsearch and OpenSearch over their HTTP API: hyper-util's pooled HTTP/1.1 client with
//! yadbe's own connector, which dials the target (or its SSH tunnel's local end) like the
//! other drivers and wraps TLS with the same rustls config (CA, client certificate,
//! verification mode). One base URL, no node sniffing.
//!
//! The driver sends what it is given and returns what the server answered, a 4xx / 5xx answer
//! included; read-only, dangerous requests, timeouts, cancellation and the statement log are
//! the request gate's (`session::search`). TLS modes: `disable` and `prefer` are `http://`,
//! `require` and `verifyFull` are `https://`.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

use crate::db::config::{ConnectTarget, TlsMode};
use crate::db::document::json::Json;
use crate::db::driver::{
    Backend, BoxFuture, CancelHandle, ConnectRequest, Driver, Link, LinkSignal, LinkWatch,
    SearchConnection, StatementRecorder, recorded,
};
use crate::db::engine::Engine;
use crate::db::errors::{YadbeError, from_search_error};
use crate::db::search::request::{HttpMethod, SearchRequest, SearchResponse};
use crate::db::search::server::SearchServer;
use crate::db::search::settings::{SearchAuth, SearchSettings};
use crate::secrets::Secret;

/// A response larger than this is refused (the console keeps whole responses).
const MAX_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
/// Idle pooled connections are closed after this long.
const POOL_IDLE: Duration = Duration::from_secs(60);

pub struct ElasticsearchDriver;

impl Driver for ElasticsearchDriver {
    fn engine(&self) -> Engine {
        Engine::Elasticsearch
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

fn uses_tls(mode: TlsMode) -> bool {
    matches!(mode, TlsMode::Require | TlsMode::VerifyFull)
}

/// A plain or TLS stream to the server.
enum Stream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

/// The stream as hyper reads and writes it.
struct Io(TokioIo<Stream>);

impl hyper::rt::Read for Io {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for Io {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

impl Connection for Io {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Opens the pool's connections: to the target (or its tunnel), TLS when the mode says so.
#[derive(Clone)]
struct Connector {
    target: Arc<ConnectTarget>,
    tls: Option<Arc<rustls::ClientConfig>>,
}

impl tower_service::Service<http::Uri> for Connector {
    type Response = Io;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Io, BoxError>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _uri: http::Uri) -> Self::Future {
        let target = Arc::clone(&self.target);
        let tls = self.tls.clone();
        Box::pin(async move {
            let open = async {
                let stream = super::redis::tcp(&target).await?;
                let Some(config) = tls else {
                    return Ok(Io(TokioIo::new(Stream::Plain(stream))));
                };
                let host = target.host.trim_start_matches('[').trim_end_matches(']');
                let name = ServerName::try_from(host.to_owned())
                    .map_err(|e| YadbeError::tls_failed().with_detail(e.to_string()))?;
                let stream = tokio_rustls::TlsConnector::from(config)
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
                        error.with_detail(message)
                    })?;
                Ok::<Io, YadbeError>(Io(TokioIo::new(Stream::Tls(Box::new(stream)))))
            };
            let secs = u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX);
            match tokio::time::timeout(target.connect_timeout, open).await {
                Ok(result) => result.map_err(|e| Box::new(e) as BoxError),
                Err(_) => {
                    Err(Box::new(YadbeError::connection_timeout(&target.host, secs)) as BoxError)
                }
            }
        })
    }
}

/// The classified failure inside a client error (the connector's), else `connectionLost`.
fn transport_error(err: &hyper_util::client::legacy::Error) -> YadbeError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(current) = source {
        if let Some(known) = current.downcast_ref::<YadbeError>() {
            return known.clone();
        }
        source = current.source();
    }
    let mut detail = err.to_string();
    let mut cause = std::error::Error::source(err);
    while let Some(inner) = cause {
        detail.push_str(": ");
        detail.push_str(&inner.to_string());
        cause = inner.source();
    }
    YadbeError::connection_lost().with_detail(detail)
}

struct ElasticConnection {
    client: Client<Connector, Full<Bytes>>,
    /// `http://host:9200/prefix`, without a trailing slash.
    base: String,
    auth: SearchAuth,
    username: String,
    secret: Option<Secret>,
    server: SearchServer,
    version: String,
    signal: LinkSignal,
    link: LinkWatch,
    recorder: Arc<dyn StatementRecorder>,
}

fn base_url(target: &ConnectTarget, settings: &SearchSettings) -> String {
    let scheme = if uses_tls(target.tls_mode) {
        "https"
    } else {
        "http"
    };
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    format!(
        "{scheme}://{host}:{}{}",
        target.port,
        settings.path_prefix.as_deref().unwrap_or_default()
    )
}

impl ElasticConnection {
    fn authorization(&self) -> Option<http::HeaderValue> {
        let secret = self.secret.as_ref()?;
        let text = match self.auth {
            SearchAuth::None => return None,
            SearchAuth::Basic => {
                let pair = format!("{}:{}", self.username, secret.expose());
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(pair)
                )
            }
            SearchAuth::ApiKey => format!("ApiKey {}", secret.expose().trim()),
            SearchAuth::Bearer => format!("Bearer {}", secret.expose().trim()),
        };
        let mut value = http::HeaderValue::from_str(&text).ok()?;
        value.set_sensitive(true);
        Some(value)
    }

    async fn raw(
        &self,
        request: &SearchRequest,
        opaque_id: Option<&str>,
    ) -> Result<SearchResponse, YadbeError> {
        let uri = format!("{}{}", self.base, request.path);
        let mut builder = http::Request::builder()
            .method(request.method.as_str())
            .uri(&uri)
            .header(http::header::USER_AGENT, "yadbe");
        if let Some(auth) = self.authorization() {
            builder = builder.header(http::header::AUTHORIZATION, auth);
        }
        if let Some(id) = opaque_id {
            builder = builder.header("x-opaque-id", id);
        }
        let body = match &request.body {
            Some(body) => {
                builder = builder.header(http::header::CONTENT_TYPE, body.content_type());
                Bytes::from(body.text.clone().into_bytes())
            }
            None => Bytes::new(),
        };
        let http_request = builder.body(Full::new(body)).map_err(|e| {
            YadbeError::invalid_argument(
                "This request cannot be sent: its path is not a valid URL path.",
                "Cette requête ne peut pas être envoyée : son chemin n'est pas un chemin d'URL valide.",
            )
            .with_detail(e.to_string())
        })?;
        let response = match self.client.request(http_request).await {
            Ok(response) => response,
            Err(err) => {
                let error = transport_error(&err);
                if err.is_connect() || error.code == crate::db::errors::ErrorCode::ConnectionLost {
                    self.signal.lost();
                }
                return Err(error);
            }
        };
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or(v).trim().to_ascii_lowercase());
        let body = Limited::new(response.into_body(), MAX_RESPONSE_BYTES)
            .collect()
            .await
            .map_err(|err| {
                if err.is::<http_body_util::LengthLimitError>() {
                    YadbeError::not_supported(
                        format!(
                            "The response is larger than {} MB: narrow the request (size, _source, filter_path).",
                            MAX_RESPONSE_BYTES / (1024 * 1024)
                        ),
                        format!(
                            "La réponse dépasse {} Mo : restreignez la requête (size, _source, filter_path).",
                            MAX_RESPONSE_BYTES / (1024 * 1024)
                        ),
                    )
                } else {
                    YadbeError::connection_lost().with_detail(err.to_string())
                }
            })?
            .to_bytes();
        Ok(SearchResponse {
            status,
            content_type,
            body: body.to_vec(),
        })
    }
}

async fn connect(request: ConnectRequest<'_>) -> Result<Backend, YadbeError> {
    let target = request.target;
    let settings = target.search.clone().unwrap_or_default();
    let tls = if uses_tls(target.tls_mode) {
        Some(super::postgres::tls::client_config(
            target.tls_mode,
            target.ca_cert_path.as_deref(),
            target.tls_identity.as_deref(),
        )?)
    } else {
        None
    };
    let connector = Connector {
        target: Arc::new(target.clone()),
        tls,
    };
    let client = Client::builder(TokioExecutor::new())
        .pool_idle_timeout(POOL_IDLE)
        .pool_max_idle_per_host(8)
        .build(connector);
    let (signal, link) = LinkWatch::new();
    let secret = request.password.filter(|p| !p.is_empty()).cloned();
    let password_given = secret.is_some();
    let mut connection = ElasticConnection {
        client,
        base: base_url(target, &settings),
        auth: settings.auth,
        username: target.username.clone(),
        secret,
        server: SearchServer {
            product: crate::db::search::server::SearchProduct::Elasticsearch,
            version: String::new(),
            cluster_name: None,
            features: crate::db::search::server::SearchFeatures {
                point_in_time: None,
                shard_doc_sort: false,
                data_streams: false,
                index_templates: false,
                esql: false,
            },
        },
        version: String::new(),
        signal,
        link,
        recorder: Arc::clone(&request.recorder),
    };
    if settings.auth.has_secret() && !password_given {
        return Err(YadbeError::password_required());
    }
    let root = SearchRequest::new(HttpMethod::Get, "/");
    let response = recorded(&*connection.recorder, "GET /", |_| None, async {
        let response = connection.raw(&root, None).await?;
        match response.server_error() {
            None => Ok(response),
            Some(error) => Err(from_search_error(
                response.status,
                &error.kind,
                &error.reason,
                &target.username,
                password_given,
            )
            .unwrap_or_else(|| error.into_error(response.status))),
        }
    })
    .await?;
    let json = response
        .json()
        .ok_or_else(|| SearchServer::detect(&Json::Null).unwrap_err())?;
    connection.server = SearchServer::detect(&json)?;
    connection.version = connection.server.label();
    Ok(Backend::Search(Arc::new(connection)))
}

impl Link for ElasticConnection {
    fn server_version(&self) -> &str {
        &self.version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            let root = SearchRequest::new(HttpMethod::Get, "/");
            recorded(&*self.recorder, "GET /", |_| None, async {
                self.raw(&root, None).await?.into_result().map(|_| ())
            })
            .await
        })
    }

    fn keep_alive(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            let root = SearchRequest::new(HttpMethod::Get, "/");
            self.raw(&root, None).await?.into_result().map(|_| ())
        })
    }

    fn link(&self) -> LinkWatch {
        self.link.clone()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        // Requests are cancelled by the gate (task API and dropping the request).
        Arc::new(NoCancel)
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        // The pool's connections close with the connection.
        Box::pin(async {})
    }
}

impl SearchConnection for ElasticConnection {
    fn server(&self) -> &SearchServer {
        &self.server
    }

    fn send<'a>(
        &'a self,
        request: &'a SearchRequest,
        opaque_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<SearchResponse, YadbeError>> {
        Box::pin(self.raw(request, opaque_id))
    }
}

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
    fn base_urls_follow_the_tls_mode_and_prefix() {
        let mut def = crate::db::config::sample_definition(Engine::Elasticsearch);
        def.host = "::1".into();
        def.tls_mode = TlsMode::VerifyFull;
        let settings = SearchSettings {
            auth: SearchAuth::None,
            path_prefix: Some("/es".into()),
        };
        assert_eq!(base_url(&def.target(), &settings), "https://[::1]:9200/es");
        def.host = "localhost".into();
        def.tls_mode = TlsMode::Prefer;
        assert_eq!(
            base_url(&def.target(), &SearchSettings::default()),
            "http://localhost:9200"
        );
    }
}
