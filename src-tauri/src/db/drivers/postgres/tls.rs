//! rustls glue for tokio-postgres, with the verification each TLS mode asks for.

use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_postgres::tls::{ChannelBinding, MakeTlsConnect, TlsConnect, TlsStream};

use crate::db::config::TlsMode;
use crate::db::errors::YadbeError;

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    Arc::clone(PROVIDER.get_or_init(|| Arc::new(rustls::crypto::ring::default_provider())))
}

/// The OS trust store, loaded once (it reads hundreds of files on Linux).
fn native_roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    Arc::clone(ROOTS.get_or_init(|| {
        let result = rustls_native_certs::load_native_certs();
        for err in &result.errors {
            tracing::warn!(error = %err, "could not load some OS root certificates");
        }
        let mut roots = RootCertStore::empty();
        let (added, ignored) = roots.add_parsable_certificates(result.certs);
        tracing::debug!(added, ignored, "OS root certificates loaded");
        Arc::new(roots)
    }))
}

fn roots_from_pem(path: &Path) -> Result<Arc<RootCertStore>, YadbeError> {
    let unreadable = |detail: String| {
        YadbeError::tls_failed().with_detail(format!(
            "cannot read the CA file {}: {detail}",
            path.display()
        ))
    };
    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_file_iter(path).map_err(|e| unreadable(e.to_string()))? {
        let cert = cert.map_err(|e| unreadable(e.to_string()))?;
        roots.add(cert).map_err(|e| unreadable(e.to_string()))?;
    }
    if roots.is_empty() {
        return Err(unreadable("no certificate in the file".to_owned()));
    }
    Ok(Arc::new(roots))
}

/// The rustls configuration of a TLS mode. `prefer` and `require` (without CA) encrypt
/// without authenticating the server, like libpq.
pub fn client_config(mode: TlsMode, ca: Option<&Path>) -> Result<Arc<ClientConfig>, YadbeError> {
    let provider = provider();
    let algorithms = provider.signature_verification_algorithms;
    let webpki = |roots: Arc<RootCertStore>| {
        WebPkiServerVerifier::builder_with_provider(roots, Arc::clone(&provider))
            .build()
            .map_err(|e| YadbeError::tls_failed().with_detail(e.to_string()))
    };
    let verifier: Arc<dyn ServerCertVerifier> = match (mode, ca) {
        (TlsMode::VerifyFull, Some(ca)) => webpki(roots_from_pem(ca)?)?,
        (TlsMode::VerifyFull, None) => webpki(native_roots())?,
        (TlsMode::Require, Some(ca)) => Arc::new(ChainOnly(webpki(roots_from_pem(ca)?)?)),
        _ => Arc::new(EncryptOnly(algorithms)),
    };
    let config = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| YadbeError::tls_failed().with_detail(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// Accepts any certificate (the handshake signatures are still checked): encryption
/// without authentication, what `prefer` and `require` mean.
#[derive(Debug)]
struct EncryptOnly(WebPkiSupportedAlgorithms);

impl ServerCertVerifier for EncryptOnly {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_schemes()
    }
}

/// Verifies the chain against the custom CA but not the host name (libpq's `verify-ca`).
#[derive(Debug)]
struct ChainOnly(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for ChainOnly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
        {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

/// `MakeTlsConnect` for tokio-postgres over rustls.
#[derive(Clone)]
pub struct RustlsConnect {
    config: Arc<ClientConfig>,
}

impl RustlsConnect {
    pub fn new(config: Arc<ClientConfig>) -> Self {
        Self { config }
    }
}

impl<S> MakeTlsConnect<S> for RustlsConnect
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = RustlsStream<S>;
    type TlsConnect = RustlsConnectOnce;
    type Error = io::Error;

    fn make_tls_connect(&mut self, domain: &str) -> Result<RustlsConnectOnce, io::Error> {
        let name = ServerName::try_from(domain.to_owned())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        Ok(RustlsConnectOnce {
            name,
            connector: tokio_rustls::TlsConnector::from(Arc::clone(&self.config)),
        })
    }
}

pub struct RustlsConnectOnce {
    name: ServerName<'static>,
    connector: tokio_rustls::TlsConnector,
}

impl<S> TlsConnect<S> for RustlsConnectOnce
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = RustlsStream<S>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = io::Result<RustlsStream<S>>> + Send>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            self.connector
                .connect(self.name, stream)
                .await
                .map(RustlsStream)
        })
    }
}

pub struct RustlsStream<S>(tokio_rustls::client::TlsStream<S>);

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for RustlsStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for RustlsStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> TlsStream for RustlsStream<S> {
    fn channel_binding(&self) -> ChannelBinding {
        // SCRAM channel binding (tls-server-end-point) is a follow-up; plain SCRAM is used.
        ChannelBinding::none()
    }
}
