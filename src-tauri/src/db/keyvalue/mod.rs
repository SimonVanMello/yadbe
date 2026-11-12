//! The key-value family (Redis, Valkey): what yadbe knows of it without a driver crate.
//!
//! - [`reply`]: a server reply, binary-safe, whatever the protocol version (RESP2 / RESP3).
//! - [`bytes`]: keys and values as they cross the IPC (text when they are UTF-8, base64 else).
//! - [`tokenize`]: a console line split into arguments with `redis-cli`'s quoting rules.
//! - [`command`]: a command's display form for the history and the statement log, secrets
//!   redacted.
//! - [`spec`]: what the server says of a command (`COMMAND INFO`) and the gate's verdict
//!   (read-only refusal, unsupported command, dangerous command).

pub mod bytes;
pub mod command;
pub mod reply;
pub mod spec;
pub mod tokenize;

pub use bytes::KvBytes;
pub use command::KvCommand;
pub use reply::KvReply;

use crate::db::errors::{ErrorCode, YadbeError};

/// A key-value feature was asked of a connection of another family.
pub fn key_value_only() -> YadbeError {
    YadbeError::new(
        ErrorCode::NotSupported,
        "This works on key-value connections (Redis, Valkey) only.",
        "Cela ne fonctionne que sur les connexions clé-valeur (Redis, Valkey).",
    )
}
