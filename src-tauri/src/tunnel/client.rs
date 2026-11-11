//! One SSH hop: transport, host key check, authentication.

use std::sync::Arc;

use russh::client::{self, AuthResult, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelOpenFailure, ChannelStream};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::db::errors::YadbeError;
use crate::secrets::{Secret, SecretKind};
use crate::tunnel::agent::{self, AgentLocation};
use crate::tunnel::errors::HopRef;
use crate::tunnel::host_keys::{self, HostKeyVerdict, HostKeys};
use crate::tunnel::keys;
use crate::tunnel::model::TunnelHop;

/// How a hop authenticates, with its secrets resolved.
pub enum HopAuth {
    Password(Secret),
    Key {
        path: String,
        passphrase: Option<Secret>,
    },
    Agent,
}

/// One SSH server to cross.
pub struct HopConfig {
    pub hop: TunnelHop,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: HopAuth,
}

impl HopConfig {
    pub fn reference(&self) -> HopRef {
        HopRef {
            hop: self.hop,
            host: self.host.clone(),
            port: self.port,
        }
    }

    fn secret_kinds(&self) -> (SecretKind, SecretKind) {
        self.hop.secret_kinds()
    }
}

/// Why a handshake stopped.
#[derive(Debug)]
pub enum HandlerError {
    Ssh(russh::Error),
    /// Host key unknown or changed: the typed error to return.
    Refused(Box<YadbeError>),
}

impl From<russh::Error> for HandlerError {
    fn from(err: russh::Error) -> Self {
        Self::Ssh(err)
    }
}

/// Checks the host key; flips `closed` when the SSH session ends (the session task owns the
/// handler and drops it then).
pub struct Handler {
    hop: HopRef,
    host_keys: Arc<HostKeys>,
    closed: watch::Sender<bool>,
}

impl Drop for Handler {
    fn drop(&mut self) {
        self.closed.send_replace(true);
    }
}

impl client::Handler for Handler {
    type Error = HandlerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // A host certificate is checked as its plain key: yadbe trusts no SSH CA.
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let host_keys = Arc::clone(&self.host_keys);
        let (host, port) = (self.hop.host.clone(), self.hop.port);
        let checked = key.clone();
        let verdict = tokio::task::spawn_blocking(move || host_keys.verify(&host, port, &checked))
            .await
            .map_err(|e| {
                HandlerError::Refused(Box::new(YadbeError::internal(format!(
                    "host key check failed: {e}"
                ))))
            })?
            .map_err(|e| HandlerError::Refused(Box::new(e)))?;
        let key_type = host_keys::key_type(&key);
        let fingerprint = host_keys::fingerprint(&key);
        match verdict {
            HostKeyVerdict::Trusted => Ok(true),
            HostKeyVerdict::Unknown => Err(HandlerError::Refused(Box::new(
                YadbeError::ssh_host_key_unknown(&self.hop, &key_type, &fingerprint),
            ))),
            HostKeyVerdict::Changed => {
                tracing::error!(host = %self.hop.host, port = self.hop.port, %fingerprint, "SSH host key changed: refused");
                Err(HandlerError::Refused(Box::new(
                    YadbeError::ssh_host_key_changed(&self.hop, &key_type, &fingerprint),
                )))
            }
        }
    }
}

/// An authenticated SSH session and the signal of its end.
pub struct HopSession {
    pub handle: Handle<Handler>,
    pub closed: watch::Receiver<bool>,
}

fn handshake_error(hop: &HopRef, err: HandlerError) -> YadbeError {
    match err {
        HandlerError::Refused(err) => *err,
        HandlerError::Ssh(err) => {
            let detail = err.to_string();
            match err {
                russh::Error::IO(io) => io_error(hop, &io),
                _ => YadbeError::ssh_handshake_failed(hop),
            }
            .with_detail(detail)
        }
    }
}

fn io_error(hop: &HopRef, err: &std::io::Error) -> YadbeError {
    match err.kind() {
        std::io::ErrorKind::ConnectionRefused => YadbeError::ssh_unreachable(hop),
        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset => {
            YadbeError::ssh_handshake_failed(hop)
        }
        _ => YadbeError::ssh_unreachable(hop),
    }
    .with_detail(err.to_string())
}

/// A TCP connection to the first address of the hop that answers.
pub async fn tcp(hop: &HopRef) -> Result<TcpStream, YadbeError> {
    let bare = hop.host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<_> = tokio::net::lookup_host((bare, hop.port))
        .await
        .map_err(|e| YadbeError::ssh_host_not_found(hop).with_detail(e.to_string()))?
        .collect();
    let mut last = None;
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(err) => last = Some(err),
        }
    }
    Err(match last {
        Some(err) => io_error(hop, &err),
        None => YadbeError::ssh_host_not_found(hop),
    })
}

/// Opens a `direct-tcpip` channel from `from` to `to`.
pub async fn open_channel(
    session: &Handle<Handler>,
    from: &HopRef,
    to: &HopRef,
    originator_port: u16,
) -> Result<ChannelStream<client::Msg>, YadbeError> {
    match session
        .channel_open_direct_tcpip(
            to.host.clone(),
            u32::from(to.port),
            "127.0.0.1",
            u32::from(originator_port),
        )
        .await
    {
        Ok(channel) => Ok(channel.into_stream()),
        Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::ConnectFailed)) => {
            Err(if to.hop == TunnelHop::Database {
                YadbeError::ssh_target_unreachable(from, to)
            } else {
                YadbeError::ssh_unreachable(to)
            })
        }
        Err(russh::Error::ChannelOpenFailure(reason)) => {
            Err(YadbeError::ssh_channel_refused(from, to).with_detail(format!("{reason:?}")))
        }
        Err(err) => Err(YadbeError::ssh_handshake_failed(from).with_detail(err.to_string())),
    }
}

/// Handshake and authentication over `stream`.
pub async fn connect<S>(
    config: Arc<client::Config>,
    stream: S,
    hop: &HopConfig,
    host_keys: Arc<HostKeys>,
    agent_location: &AgentLocation,
) -> Result<HopSession, YadbeError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let reference = hop.reference();
    let (closed, closed_rx) = watch::channel(false);
    let handler = Handler {
        hop: reference.clone(),
        host_keys,
        closed,
    };
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| handshake_error(&reference, e))?;
    authenticate(&mut handle, hop, agent_location).await?;
    Ok(HopSession {
        handle,
        closed: closed_rx,
    })
}

async fn rsa_hash(handle: &Handle<Handler>) -> Option<HashAlg> {
    match handle.best_supported_rsa_hash().await {
        Ok(Some(hash)) => hash,
        // The server did not say (no `server-sig-algs`): SHA-256 is the safe modern guess.
        _ => Some(HashAlg::Sha256),
    }
}

async fn authenticate(
    handle: &mut Handle<Handler>,
    hop: &HopConfig,
    agent_location: &AgentLocation,
) -> Result<(), YadbeError> {
    let reference = hop.reference();
    let (password_kind, passphrase_kind) = hop.secret_kinds();
    let failed =
        |secret: Option<SecretKind>| YadbeError::ssh_auth_failed(&reference, &hop.username, secret);
    let lost = |err: russh::Error| {
        YadbeError::ssh_handshake_failed(&reference).with_detail(err.to_string())
    };
    match &hop.auth {
        HopAuth::Password(password) => {
            let result = handle
                .authenticate_password(hop.username.clone(), password.expose())
                .await
                .map_err(lost)?;
            if result.success() {
                Ok(())
            } else {
                Err(failed(Some(password_kind)))
            }
        }
        HopAuth::Key { path, passphrase } => {
            let (path, passphrase) = (path.clone(), passphrase.clone());
            let key_ref = reference.clone();
            let key = tokio::task::spawn_blocking(move || {
                keys::load_private_key(&key_ref, &path, passphrase.as_ref(), passphrase_kind)
            })
            .await
            .map_err(|e| YadbeError::internal(format!("key loading failed: {e}")))??;
            let hash = rsa_hash(handle).await;
            let result = handle
                .authenticate_publickey(
                    hop.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(lost)?;
            if result.success() {
                Ok(())
            } else {
                Err(failed(None))
            }
        }
        HopAuth::Agent => {
            let mut agent = agent::connect(agent_location).await.map_err(|detail| {
                YadbeError::ssh_agent_unavailable(&reference).with_detail(detail)
            })?;
            if let Some(binding) = handle.agent_session_binding()
                && let Err(err) = agent.bind_session(binding, false).await
            {
                // Agents older than OpenSSH 8.9 do not know the extension.
                tracing::debug!(error = %err, "agent session binding refused");
            }
            let identities = agent.request_identities().await.map_err(|e| {
                YadbeError::ssh_agent_unavailable(&reference).with_detail(e.to_string())
            })?;
            if identities.is_empty() {
                return Err(YadbeError::ssh_agent_unavailable(&reference)
                    .with_detail("the agent holds no identity"));
            }
            let hash = rsa_hash(handle).await;
            for identity in identities {
                let key = identity.public_key().into_owned();
                let hash = if key.algorithm().is_rsa() { hash } else { None };
                match handle
                    .authenticate_publickey_with(hop.username.clone(), key, hash, &mut agent)
                    .await
                {
                    Ok(AuthResult::Success) => return Ok(()),
                    Ok(AuthResult::Failure { .. }) => {}
                    // The agent declined to sign with this key: try the next one.
                    Err(err) => tracing::debug!(error = %err, "agent could not sign"),
                }
            }
            Err(failed(None))
        }
    }
}
