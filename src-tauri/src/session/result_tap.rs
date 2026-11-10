//! Reading the rows of a result beyond what the `ResultStore` keeps (M2-7, export).
//!
//! An export of a result that is still streaming, or paused at its row / memory cap, must
//! not load the rest in memory. The export attaches a *tap* to the result: from then on the
//! runner hands every batch it reads from the driver to the tap (bounded channel, so a slow
//! disk slows the server read down) and keeps storing only what fits under the limits. The
//! result in the grid keeps the rows it had; it is then marked as stopped at its limit.

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::db::value::Value;
use crate::session::result_store::StoredResult;

/// How the stream of a result ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TapEnd {
    Complete,
    Failed,
    Cancelled,
}

#[derive(Debug)]
pub enum TapMsg {
    Rows(Vec<Vec<Value>>),
    /// Last message: the statement is over.
    End(TapEnd),
}

/// Batches buffered between the runner and an export.
pub const TAP_CAPACITY: usize = 4;

/// What an export reads: the rows already in the store, then the live tail.
pub struct ResultStream {
    pub stored: Arc<StoredResult>,
    /// Rows `0..stored_rows` come from the store, the rest from `tail`.
    pub stored_rows: usize,
    /// `None` when the statement is over: the store is all there is.
    pub tail: Option<mpsc::Receiver<TapMsg>>,
    /// The store lacks rows (an earlier export drained the result past its limit).
    pub truncated: bool,
}
