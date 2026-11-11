//! SSH tunnels (F-010).
//!
//! A [`Tunnel`] is one SSH session (through an optional jump host) and a TCP listener on
//! `127.0.0.1`, on a port the OS picks, that forwards every accepted connection to the
//! database host and port through a `direct-tcpip` channel. Drivers dial the listener instead
//! of the database (`ConnectTarget::dial`) and keep the real host name for TLS, so every
//! driver, its cancel requests included, works unchanged behind the `Driver` trait. The
//! listener only binds the loopback interface and lives as long as the SSH session.

mod agent;
mod client;
pub mod errors;
pub mod host_keys;
pub mod keys;
pub mod model;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::Handle;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::db::errors::YadbeError;
pub use agent::AgentLocation;
use client::{Handler, open_channel};
pub use client::{HopAuth, HopConfig};
use errors::HopRef;
pub use host_keys::HostKeys;
pub use model::{
    KnownHost, SshAuthMethod, SshHop, SshTunnel, TunnelFailure, TunnelHop, TunnelPhase,
    TunnelStatus,
};

/// Everything needed to open a tunnel, secrets resolved.
pub struct TunnelConfig {
    pub server: HopConfig,
    pub jump: Option<HopConfig>,
    /// `None`: no keep-alive.
    pub keepalive: Option<Duration>,
    /// Bounds the whole opening: TCP, handshakes, authentication.
    pub connect_timeout: Duration,
    /// The database, as the SSH server sees it.
    pub target_host: String,
    pub target_port: u16,
    pub agent: AgentLocation,
}

impl TunnelConfig {
    fn target(&self) -> HopRef {
        HopRef {
            hop: TunnelHop::Database,
            host: self.target_host.clone(),
            port: self.target_port,
        }
    }

    /// `ssh deploy@bastion:22 via ops@jump:22 → db:5432`, for logs.
    pub fn describe(&self) -> String {
        let server = format!(
            "{}@{}:{}",
            self.server.username, self.server.host, self.server.port
        );
        let via = self
            .jump
            .as_ref()
            .map(|j| format!(" via {}@{}:{}", j.username, j.host, j.port))
            .unwrap_or_default();
        format!(
            "ssh {server}{via} → {}:{}",
            self.target_host, self.target_port
        )
    }
}

/// Receive window of each forwarded connection: what the server may send that it has not
/// read yet.
const WINDOW_BYTES: u32 = 2 * 1024 * 1024;
/// A window of 2 KiB packets.
const CHANNEL_BUFFER_MESSAGES: usize = 1024;

type ForwardError = Arc<Mutex<Option<(Instant, YadbeError)>>>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// An open tunnel. Closes when dropped.
pub struct Tunnel {
    local: SocketAddr,
    server: Arc<Handle<Handler>>,
    jump: Option<Handle<Handler>>,
    closed: watch::Receiver<bool>,
    shutdown: watch::Sender<bool>,
    listener: JoinHandle<()>,
    forward_error: ForwardError,
}

impl Tunnel {
    /// Connects and authenticates every hop, then starts the local listener.
    pub async fn open(config: &TunnelConfig, host_keys: Arc<HostKeys>) -> Result<Self, YadbeError> {
        let current = Arc::new(Mutex::new(
            config.jump.as_ref().unwrap_or(&config.server).reference(),
        ));
        let secs = u32::try_from(config.connect_timeout.as_secs()).unwrap_or(u32::MAX);
        match tokio::time::timeout(
            config.connect_timeout,
            Self::open_hops(config, host_keys, Arc::clone(&current)),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(YadbeError::ssh_timeout(&lock(&current), secs)),
        }
    }

    async fn open_hops(
        config: &TunnelConfig,
        host_keys: Arc<HostKeys>,
        current: Arc<Mutex<HopRef>>,
    ) -> Result<Self, YadbeError> {
        let ssh = Arc::new(russh::client::Config {
            // Unread data per channel is bounded by the window (consumer-driven, see
            // vendor/russh/PATCHES.md); the message buffer must hold a window of small packets
            // so that delivering to a slow reader never blocks the session.
            window_size: WINDOW_BYTES,
            channel_buffer_size: CHANNEL_BUFFER_MESSAGES,
            keepalive_interval: config.keepalive,
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        });
        let server_ref = config.server.reference();
        let (jump, server) = match &config.jump {
            Some(jump) => {
                let jump_ref = jump.reference();
                let stream = client::tcp(&jump_ref).await?;
                let jump_session = client::connect(
                    Arc::clone(&ssh),
                    stream,
                    jump,
                    Arc::clone(&host_keys),
                    &config.agent,
                )
                .await?;
                *lock(&current) = server_ref.clone();
                let stream = open_channel(&jump_session.handle, &jump_ref, &server_ref, 0).await?;
                let server =
                    client::connect(ssh, stream, &config.server, host_keys, &config.agent).await?;
                (Some(jump_session.handle), server)
            }
            None => {
                let stream = client::tcp(&server_ref).await?;
                let server =
                    client::connect(ssh, stream, &config.server, host_keys, &config.agent).await?;
                (None, server)
            }
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| YadbeError::internal(format!("cannot listen on the loopback: {e}")))?;
        let local = listener
            .local_addr()
            .map_err(|e| YadbeError::internal(format!("listener address: {e}")))?;
        let handle = Arc::new(server.handle);
        let (shutdown, _) = watch::channel(false);
        let forward_error = ForwardError::default();
        let listener = tokio::spawn(serve(
            listener,
            Arc::clone(&handle),
            server_ref,
            config.target(),
            shutdown.subscribe(),
            server.closed.clone(),
            Arc::clone(&forward_error),
        ));
        tracing::info!(tunnel = %config.describe(), %local, "SSH tunnel open");
        Ok(Self {
            local,
            server: handle,
            jump,
            closed: server.closed,
            shutdown,
            listener,
            forward_error,
        })
    }

    /// Where drivers connect: `127.0.0.1:<port>`.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    pub fn is_alive(&self) -> bool {
        !*self.closed.borrow() && !self.server.is_closed() && !*self.shutdown.borrow()
    }

    /// Resolves when the SSH session ends (dropped link, keep-alive timeout, closed).
    pub async fn lost(&self) {
        let mut closed = self.closed.clone();
        let _ = closed.wait_for(|closed| *closed).await;
    }

    /// The last failure to open a forwarding channel since `since`: what a driver saw as a
    /// connection closed at once.
    pub fn forward_error_since(&self, since: Instant) -> Option<YadbeError> {
        lock(&self.forward_error)
            .as_ref()
            .filter(|(at, _)| *at >= since)
            .map(|(_, err)| err.clone())
    }

    /// Stops accepting, drops every forwarded connection and ends the SSH session(s).
    pub async fn close(&self) {
        self.shutdown.send_replace(true);
        self.listener.abort();
        let _ = self
            .server
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        if let Some(jump) = &self.jump {
            let _ = jump
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.shutdown.send_replace(true);
        self.listener.abort();
    }
}

async fn serve(
    listener: TcpListener,
    server: Arc<Handle<Handler>>,
    server_ref: HopRef,
    target: HopRef,
    mut shutdown: watch::Receiver<bool>,
    mut closed: watch::Receiver<bool>,
    forward_error: ForwardError,
) {
    loop {
        let (socket, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(err) => {
                    tracing::warn!(error = %err, "tunnel listener failed");
                    continue;
                }
            },
            _ = shutdown.wait_for(|stop| *stop) => return,
            _ = closed.wait_for(|closed| *closed) => return,
        };
        // Bound to 127.0.0.1, so this is belt and braces.
        if !peer.ip().is_loopback() {
            continue;
        }
        tokio::spawn(forward(
            socket,
            peer,
            Arc::clone(&server),
            server_ref.clone(),
            target.clone(),
            shutdown.clone(),
            Arc::clone(&forward_error),
        ));
    }
}

/// Copies one accepted connection to a new channel and back. Both directions go through
/// fixed-size buffers: a reader that stops reading stops the copy, never grows memory.
async fn forward(
    mut socket: TcpStream,
    peer: SocketAddr,
    server: Arc<Handle<Handler>>,
    server_ref: HopRef,
    target: HopRef,
    mut shutdown: watch::Receiver<bool>,
    forward_error: ForwardError,
) {
    let _ = socket.set_nodelay(true);
    let mut channel = match open_channel(&server, &server_ref, &target, peer.port()).await {
        Ok(channel) => channel,
        Err(err) => {
            tracing::warn!(error = %err, "tunnel channel refused");
            *lock(&forward_error) = Some((Instant::now(), err));
            return;
        }
    };
    tokio::select! {
        result = tokio::io::copy_bidirectional(&mut socket, &mut channel) => {
            if let Err(err) = result {
                tracing::debug!(error = %err, "tunnelled connection ended");
            }
        }
        _ = shutdown.wait_for(|stop| *stop) => {}
    }
}
