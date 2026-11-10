use serde::Serialize;
use specta::Type;

use crate::db::errors::YadbeError;

/// Life cycle of an open connection (F-013).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    /// First connection attempt in progress.
    Connecting,
    Connected,
    /// The link dropped; nothing is running. Automatic reconnection follows unless the
    /// failure is not transient or the attempts are exhausted (then `error` says why).
    Lost,
    /// Automatic reconnection attempt `reconnectAttempt` in progress. Statements sent
    /// meanwhile fail with `notConnected`; none is ever replayed.
    Reconnecting,
    /// Closed by the user, or the first attempt failed (`error`).
    Closed,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub connection_id: String,
    pub state: ConnectionState,
    /// Known once connected (kept while lost / reconnecting).
    pub server_version: Option<String>,
    /// Why the connection is lost or closed, when it was not the user's choice.
    pub error: Option<YadbeError>,
    /// 1-based, while `reconnecting` (and on the `lost` state that ends the attempts).
    pub reconnect_attempt: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub server_version: String,
    /// Connect + version query + ping.
    pub duration_ms: f64,
}
