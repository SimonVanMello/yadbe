//! IPC model of table edits (M2-2, F-082 to F-086): the change set the grid buffers, its SQL
//! preview, and the outcome of applying it in one transaction.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::{ConstraintViolation, YadbeError};
use crate::db::value::Value;
use crate::session::query_model::{ResultWindow, ServerMessage};
use crate::session::table_model::RowKey;

/// A column and the value to write in it (`{ kind: "null" }` for `NULL`). The value's kind
/// may differ from the column's: the engine converts it (text typed for a `uuid` column).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValue {
    pub column: String,
    pub value: Value,
}

/// A new value for one cell of an existing row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CellUpdate {
    /// The row, by its identity as last read.
    pub key: RowKey,
    pub column: String,
    pub value: Value,
}

/// A new row. Columns left out take their default (or identity, or computed value).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    pub values: Vec<ColumnValue>,
}

/// Everything the grid buffered for one table (F-084). Cell updates of the same row are
/// merged into one `UPDATE` (the last value of a cell wins); updates of a deleted row are
/// dropped. Statements run deletes first, then updates, then inserts, so a deleted key or
/// unique value can be reused.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub updates: Vec<CellUpdate>,
    pub inserts: Vec<RowInsert>,
    pub deletes: Vec<RowKey>,
}

/// What a planned statement does, pointing back into the change set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlannedChange {
    Update {
        key: RowKey,
        /// Indices into `ChangeSet.updates` merged into this statement.
        updates: Vec<u32>,
    },
    Insert {
        /// Index into `ChangeSet.inserts`.
        insert: u32,
    },
    Delete {
        key: RowKey,
        /// Index into `ChangeSet.deletes`.
        delete: u32,
    },
}

/// One statement of a plan, as readable SQL: values are written as literals for reading only
/// (the statement that runs binds them as parameters). The statement log shows the same
/// text.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStatement {
    pub change: PlannedChange,
    pub sql: String,
}

/// The SQL Apply would run (F-085).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditPreview {
    /// In the order they run.
    pub statements: Vec<PlannedStatement>,
    /// The whole transaction as one script: the engine's `BEGIN`, the statements, `COMMIT`.
    pub script: String,
}

/// A statement that ran.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppliedStatement {
    pub change: PlannedChange,
    /// Rows changed (always 1 for an update or a delete).
    pub rows_affected: Option<f64>,
    pub duration_ms: f64,
}

/// The rows the inserts created, as stored (defaults, identities and computed values
/// filled in), columns as in a page.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InsertedRows {
    /// Kept in the backend until the tab reads another page or closes.
    pub window: ResultWindow,
    /// For each `ChangeSet.inserts` entry, its row in `window`; `null` when the engine
    /// could not return it (SQL Server table with triggers and no key value to read it
    /// back): refresh the page.
    pub positions: Vec<Option<u32>>,
}

/// Why a statement failed; the whole change set was rolled back.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementFailure {
    /// Index into the preview's statements; `null` when the `COMMIT` failed (a deferred
    /// constraint).
    pub statement_index: Option<u32>,
    pub change: Option<PlannedChange>,
    /// The statement, as in the preview (or `COMMIT`).
    pub sql: String,
    /// `rowNotFound` (0 rows: changed or deleted by someone else), `rowNotUnique` (several
    /// rows), `constraintViolation`, `invalidValue`, `queryFailed`, `cancelled`,
    /// `connectionLost`…
    pub error: YadbeError,
    /// The server's own message, when the server raised the error.
    pub server: Option<ServerMessage>,
    /// The constraint broken, for `constraintViolation`.
    pub violation: Option<ConstraintViolation>,
    /// Rows the statement matched, for `rowNotFound` / `rowNotUnique`.
    pub rows_affected: Option<f64>,
}

/// How an apply ended.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ApplyOutcome {
    /// Every statement ran and the transaction was committed.
    Applied {
        statements: Vec<AppliedStatement>,
        inserted: InsertedRows,
        #[serde(rename = "durationMs")]
        duration_ms: f64,
    },
    /// A statement failed: the transaction was rolled back, nothing changed.
    RolledBack { failure: Box<StatementFailure> },
}
