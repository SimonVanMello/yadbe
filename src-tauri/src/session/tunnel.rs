//! The SSH tunnel of a `ConnectionSession` (F-010): opened before its first database
//! connection, shared by all of them, reopened when it dropped, closed with the session.
//! Every opening, drop and close is a line of the statement log.

use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use crate::db::driver::{RecordedStatement, StatementRecorder};
use crate::db::errors::YadbeError;
use crate::tunnel::{HostKeys, Tunnel, TunnelConfig, TunnelPhase, TunnelStatus};

pub struct TunnelSlot {
    config: TunnelConfig,
    host_keys: Arc<HostKeys>,
    template: TunnelStatus,
    current: Mutex<Option<Arc<Tunnel>>>,
    /// Serializes openings: concurrent connections wait for the same tunnel.
    opening: tokio::sync::Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn record(
    recorder: &dyn StatementRecorder,
    sql: String,
    started: (SystemTime, Instant),
    outcome: Result<Option<u64>, YadbeError>,
) {
    recorder.record(RecordedStatement {
        sql,
        started_at: started.0,
        duration: started.1.elapsed(),
        outcome,
    });
}

impl TunnelSlot {
    pub fn new(config: TunnelConfig, host_keys: Arc<HostKeys>, template: TunnelStatus) -> Self {
        Self {
            config,
            host_keys,
            template,
            current: Mutex::new(None),
            opening: tokio::sync::Mutex::new(()),
        }
    }

    pub fn status(&self, phase: TunnelPhase) -> TunnelStatus {
        TunnelStatus {
            phase,
            ..self.template.clone()
        }
    }

    /// The live tunnel, if any.
    pub fn current(&self) -> Option<Arc<Tunnel>> {
        lock(&self.current)
            .as_ref()
            .filter(|t| t.is_alive())
            .cloned()
    }

    /// The live tunnel, opened (again) when there is none; `opening` runs just before an
    /// opening starts (state event).
    pub async fn ensure(
        &self,
        recorder: &dyn StatementRecorder,
        opening: impl FnOnce(),
    ) -> Result<Arc<Tunnel>, YadbeError> {
        if let Some(tunnel) = self.current() {
            return Ok(tunnel);
        }
        let _guard = self.opening.lock().await;
        if let Some(tunnel) = self.current() {
            return Ok(tunnel);
        }
        let dropped = lock(&self.current).take();
        if let Some(dropped) = dropped {
            record(
                recorder,
                format!("-- SSH tunnel dropped: {}", self.config.describe()),
                (SystemTime::now(), Instant::now()),
                Err(YadbeError::connection_lost()),
            );
            dropped.close().await;
        }
        opening();
        let started = (SystemTime::now(), Instant::now());
        match Tunnel::open(&self.config, Arc::clone(&self.host_keys)).await {
            Ok(tunnel) => {
                record(
                    recorder,
                    format!(
                        "-- SSH tunnel open: {} (local end {})",
                        self.config.describe(),
                        tunnel.local_addr()
                    ),
                    started,
                    Ok(None),
                );
                let tunnel = Arc::new(tunnel);
                *lock(&self.current) = Some(Arc::clone(&tunnel));
                Ok(tunnel)
            }
            Err(err) => {
                record(
                    recorder,
                    format!("-- SSH tunnel open: {}", self.config.describe()),
                    started,
                    Err(err.clone()),
                );
                Err(err)
            }
        }
    }

    /// Whether a tunnel was open and is gone.
    pub fn is_down(&self) -> bool {
        lock(&self.current).as_ref().is_none_or(|t| !t.is_alive())
    }

    pub async fn close(&self, recorder: &dyn StatementRecorder) {
        let tunnel = lock(&self.current).take();
        if let Some(tunnel) = tunnel {
            let started = (SystemTime::now(), Instant::now());
            tunnel.close().await;
            record(
                recorder,
                format!("-- SSH tunnel closed: {}", self.config.describe()),
                started,
                Ok(None),
            );
        }
    }
}

/// A driver that could not connect through the tunnel most likely met a channel the SSH
/// server refused: that error says what happened, the driver's ("connection closed") does not.
pub fn explain(err: YadbeError, tunnel: Option<&Tunnel>, since: Instant) -> YadbeError {
    tunnel
        .and_then(|t| t.forward_error_since(since))
        .unwrap_or(err)
}
