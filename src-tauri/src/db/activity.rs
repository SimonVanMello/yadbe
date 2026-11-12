//! The activity monitor's model and what a driver implements for it (F-140): who is connected,
//! what they run, who waits for whom, and how to stop a statement or a session.
//!
//! Every query a driver runs for this is a statement yadbe authors and goes through the
//! connection's recorder (statement log). Session ids cross as strings (64-bit on some
//! engines). Statement texts are cut at [`STATEMENT_CHARS`]: the monitor is a list, not an
//! editor.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::driver::BoxFuture;
use crate::db::errors::YadbeError;
use crate::db::value::Value;

pub type ActivityFuture<'a, T> = BoxFuture<'a, Result<T, YadbeError>>;

/// Longest statement text kept per session, in characters.
pub const STATEMENT_CHARS: usize = 4000;

/// At most this many locks are listed; `locks_truncated` says when there were more.
pub const MAX_LOCKS: usize = 1000;

/// What a session is doing right now, normalized across engines. The engine's own word stays
/// in `state_text`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// Running a statement (or waiting for a lock or a resource inside it).
    Active,
    /// Connected and waiting for the client.
    Idle,
    /// Idle with a transaction left open: its locks are still held.
    IdleInTransaction,
    /// Anything else (background work, unknown).
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySession {
    /// Process id (PostgreSQL), session id (SQL Server), thread id (MySQL).
    pub id: String,
    /// Identifies this very session, not only its id (ids are reused): what the kill checks
    /// again before it fires. Opaque for the frontend.
    pub fingerprint: String,
    pub user: Option<String>,
    pub database: Option<String>,
    /// Where the client connects from (`host`, `host:port`).
    pub client: Option<String>,
    pub application: Option<String>,
    pub state: SessionState,
    /// The engine's own word for the state (`idle in transaction`, `suspended`, `Sleep`…).
    pub state_text: Option<String>,
    /// What the session waits for (`Lock: transactionid`, `LCK_M_X`…), when it waits.
    pub wait: Option<String>,
    /// The statement it runs, or ran last when idle; cut at [`STATEMENT_CHARS`].
    pub statement: Option<String>,
    pub statement_truncated: bool,
    /// Seconds the current statement has been running, or the session in its current state.
    pub running_secs: Option<f64>,
    /// Seconds the open transaction has lasted, when the engine tells.
    pub transaction_secs: Option<f64>,
    /// Ids of the sessions that hold what this one waits for.
    pub blocked_by: Vec<String>,
    /// The session yadbe reads the monitor with: it cannot be killed from here.
    pub is_self: bool,
    /// A background or system session (workers, checkpointer…), hidden by default.
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLock {
    pub session_id: String,
    /// `relation`, `transactionid`, `KEY`, `RECORD`, `TABLE`…, as the engine names it.
    pub lock_type: String,
    pub mode: String,
    /// `false`: the session waits for this lock.
    pub granted: bool,
    /// The locked object (`public.orders`), when the engine names it.
    pub object: Option<String>,
}

/// What the monitor could not show in full, and why. The list is still the truth about what
/// was visible: these notes say what was left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ActivityNote {
    /// The user sees the other sessions but not their statements or states (PostgreSQL
    /// without `pg_read_all_stats`).
    StatementsHidden,
    /// The engine cannot list locks here (MySQL without the data lock tables, MariaDB).
    LocksUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub sessions: Vec<ActivitySession>,
    pub locks: Vec<ActivityLock>,
    pub locks_truncated: bool,
    pub notes: Vec<ActivityNote>,
}

/// How far a kill goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KillMode {
    /// Stops the running statement; the session stays (`pg_cancel_backend`, `KILL QUERY`).
    CancelQuery,
    /// Ends the session, rolling back its open transaction (`pg_terminate_backend`, `KILL`).
    TerminateSession,
}

/// The session to act on, as the list showed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KillRequest {
    pub session_id: String,
    pub fingerprint: String,
    pub mode: KillMode,
}

/// What a kill reports; the statement is what yadbe sent, for the toast and the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub statement: String,
}

/// What a driver offers for the monitor, on the connection that is not the one being killed.
pub trait ActivityMonitor: Send + Sync {
    /// Sessions, locks and who blocks whom. Fails with `insufficientPrivilege` when the user
    /// cannot see other sessions at all.
    fn activity(&self) -> ActivityFuture<'_, ActivitySnapshot>;

    /// Cancels the statement of a session, or ends the session. Checks first that the session
    /// is still the one the request names (`sessionChanged` otherwise) and is not the
    /// monitor's own. A server refusal for lack of privilege is `insufficientPrivilege`.
    fn kill<'a>(&'a self, request: &'a KillRequest) -> ActivityFuture<'a, KillOutcome>;
}

/// Cuts a statement text and says whether it was cut.
pub fn cut_statement(text: Option<String>) -> (Option<String>, bool) {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return (None, false);
    };
    match text.char_indices().nth(STATEMENT_CHARS) {
        Some((end, _)) => (Some(text[..end].to_owned()), true),
        None => (Some(text), false),
    }
}

/// A column of a driver row as text (`NULL` and anything that is not text read as `None`).
pub fn text_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::Text(text)
        | Value::Int(text)
        | Value::Decimal(text)
        | Value::Float(text)
        | Value::Date(text)
        | Value::Time(text)
        | Value::Timestamp(text)
        | Value::TimestampTz(text)
        | Value::Uuid(text)
        | Value::Other(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Interval(_) | Value::Json(_) | Value::Bytes(_) | Value::Array(_) => None,
    }
}

/// A non-empty text column.
pub fn nonempty_of(value: Option<&Value>) -> Option<String> {
    text_of(value).filter(|t| !t.is_empty())
}

pub fn bool_of(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Int(n) | Value::Text(n)) => n == "1" || n == "t" || n == "true",
        _ => false,
    }
}

pub fn float_of(value: Option<&Value>) -> Option<f64> {
    text_of(value)?
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
}

/// Ids joined by a comma (`12,34`), as the drivers' queries print them.
pub fn ids_of(value: Option<&Value>) -> Vec<String> {
    text_of(value)
        .map(|joined| {
            joined
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A session id the user interface sent back, parsed so that only digits can reach a
/// statement that cannot take a parameter (`KILL`).
pub fn parse_session_id(id: &str) -> Result<u64, YadbeError> {
    id.parse::<u64>().map_err(|_| {
        YadbeError::invalid_argument(
            "That is not a session id.",
            "Ce n'est pas un identifiant de session.",
        )
    })
}

/// The monitor's own session cannot be stopped from itself.
pub fn own_session() -> YadbeError {
    YadbeError::invalid_argument(
        "This is the session yadbe reads the monitor with: stopping it would blind the monitor.",
        "C'est la session que yadbe utilise pour lire le moniteur : l'arrêter l'aveuglerait.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_long_statements_on_a_character_boundary() {
        let long = "é".repeat(STATEMENT_CHARS + 10);
        let (cut, truncated) = cut_statement(Some(long));
        assert!(truncated);
        assert_eq!(cut.map(|t| t.chars().count()), Some(STATEMENT_CHARS));
        assert_eq!(cut_statement(Some("  ".into())), (None, false));
        assert_eq!(
            cut_statement(Some("select 1".into())),
            (Some("select 1".into()), false)
        );
    }

    #[test]
    fn reads_id_lists_and_rejects_non_numeric_ids() {
        assert_eq!(ids_of(Some(&Value::Text("12, 34,".into()))), ["12", "34"]);
        assert!(ids_of(Some(&Value::Null)).is_empty());
        assert_eq!(parse_session_id("42").ok(), Some(42));
        assert!(parse_session_id("42; DROP TABLE x").is_err());
        assert!(parse_session_id("-1").is_err());
    }
}
