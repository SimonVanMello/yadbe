//! What the key-value commands (`kv_*`) and events carry.

use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

use crate::db::errors::YadbeError;
use crate::db::keyvalue::KvBytes;
use crate::db::keyvalue::spec::KvDanger;
use crate::db::value::ColumnMeta;

/// A numbered database of the server, from `INFO keyspace`.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvDatabase {
    pub index: u32,
    pub keys: u32,
    /// Keys with a time to live.
    pub expires: u32,
    /// The database the connection is saved on.
    pub current: bool,
}

/// Where a key scan of a database stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KvScanState {
    /// Batches are being read.
    Running,
    /// The scan stopped at its target count: "load more" goes on.
    Paused,
    /// The user stopped it; "load more" goes on from where it stopped.
    Stopped,
    /// Every key was seen (`SCAN` returned cursor 0).
    Done,
    /// A batch failed (`error`); "load more" tries again.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvScanStatus {
    /// Changes whenever the scan starts again (refresh, new pattern).
    pub scan_id: u32,
    pub database: u32,
    /// The `MATCH` pattern; `null`: every key.
    pub pattern: Option<String>,
    /// Distinct keys found so far.
    pub loaded: u32,
    /// `DBSIZE` when the scan started: the "~M" of "N of ~M".
    pub estimate: Option<u32>,
    pub state: KvScanState,
    pub error: Option<YadbeError>,
    /// Bumps whenever keys are added: the levels read before are stale.
    pub version: u32,
}

/// A key scan progressed: keys were added or its state changed. Throttled (about five per
/// second per scan); read the open levels again when `status.version` moved.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct KvScanProgress {
    pub connection_id: String,
    pub status: KvScanStatus,
}

/// One child of a level of the key tree.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KvLevelEntry {
    /// Keys sharing `prefix` (which ends with the delimiter), shown as a folder.
    Namespace {
        /// The segment between the parent's prefix and the delimiter.
        name: KvBytes,
        prefix: KvBytes,
        /// Loaded keys under it, at any depth.
        keys: u32,
    },
    Key {
        /// What is left of the key after the parent's prefix.
        name: KvBytes,
        key: KvBytes,
    },
}

/// The children of a level, namespaces first, each part sorted by bytes; paged.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvLevel {
    pub entries: Vec<KvLevelEntry>,
    /// Namespaces and keys at this level in all.
    pub total: u32,
    /// The scan version the level was read at.
    pub version: u32,
}

/// The type of a key, as `TYPE` names it; module types (`ReJSON-RL`) keep their name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KvKeyKind {
    String,
    Hash,
    List,
    Set,
    Zset,
    Stream,
    /// A RedisJSON document (shown as JSON when the module answers).
    Json,
    /// A type yadbe has no viewer for (another module): shown read-only, untyped.
    Unknown,
    /// The key does not exist (any more).
    Missing,
}

impl KvKeyKind {
    pub fn of_type(type_name: &str) -> Self {
        match type_name {
            "string" => KvKeyKind::String,
            "hash" => KvKeyKind::Hash,
            "list" => KvKeyKind::List,
            "set" => KvKeyKind::Set,
            "zset" => KvKeyKind::Zset,
            "stream" => KvKeyKind::Stream,
            "ReJSON-RL" => KvKeyKind::Json,
            "none" | "" => KvKeyKind::Missing,
            _ => KvKeyKind::Unknown,
        }
    }
}

/// What a tree row shows of a key, read for the visible rows only.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvKeySummary {
    pub key: KvBytes,
    pub kind: KvKeyKind,
    /// The server's type name (`hash`, `ReJSON-RL`, `MBbloom--`…).
    pub type_name: String,
    /// Milliseconds left; `null`: no expiry (or the key is gone).
    pub ttl_ms: Option<f64>,
    /// `MEMORY USAGE` in bytes, when the server allows it.
    pub memory: Option<f64>,
}

/// The header of a key tab.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyInfo {
    pub key: KvBytes,
    pub database: u32,
    pub kind: KvKeyKind,
    pub type_name: String,
    pub ttl_ms: Option<f64>,
    /// `OBJECT ENCODING` (`listpack`, `hashtable`, `embstr`…).
    pub encoding: Option<String>,
    pub memory: Option<f64>,
    /// Bytes of a string, fields of a hash, elements of a list, set, sorted set or stream.
    pub length: Option<u32>,
    /// The RedisJSON module answers on this server.
    pub json_module: bool,
}

/// A window of a string value.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvStringChunk {
    /// Length of the whole value in bytes.
    pub total: u32,
    pub offset: u32,
    /// The bytes of `[offset, offset + length)`, base64.
    pub base64: String,
}

/// The rows of a collection read so far, kept in the result store (rule 8).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvCollection {
    /// The result to read windows of (`fetch_result_window`); also names the collection.
    pub result_id: u32,
    pub columns: Vec<ColumnMeta>,
    pub row_count: u32,
    /// Every element was read.
    pub done: bool,
    /// The collection's length when it was opened (`HLEN`…).
    pub total: Option<u32>,
}

/// A scalar reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KvScalarKind {
    Status,
    Bulk,
    Int,
    Double,
    Bool,
    BigNumber,
    Error,
}

/// How the console shows a reply: a value, a grid (rows in the result store), or a tree.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KvReplyView {
    Nil,
    Scalar {
        value: KvBytes,
        scalar: KvScalarKind,
    },
    /// An empty array, set or map.
    Empty,
    Grid {
        result_id: u32,
        columns: Vec<ColumnMeta>,
        row_count: u32,
    },
    /// Nested replies, as JSON text; cut past a few thousand elements (`truncated`).
    Tree {
        json: String,
        truncated: bool,
    },
}

/// One command of a console run.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvConsoleEntry {
    /// 0-based line of the console text.
    pub line: u32,
    /// The command as sent, secrets redacted.
    pub command: String,
    /// The database the command ran on.
    pub database: u32,
    pub duration_ms: f64,
    pub reply: Option<KvReplyView>,
    pub error: Option<YadbeError>,
}

/// What a console run did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KvConsoleOutcome {
    /// Nothing ran: these commands need a confirmation with their effect; run again with
    /// `confirmed`.
    NeedsConfirmation { dangers: Vec<KvDanger> },
    /// The commands ran in order, stopping at the first failure.
    Ran {
        entries: Vec<KvConsoleEntry>,
        /// The console's database after the run (`SELECT` moves it).
        database: u32,
        /// Lines left unrun because a command failed or the run was stopped.
        skipped: u32,
    },
}
