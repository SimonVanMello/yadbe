//! IPC model of editable query results (M3-7, F-087): whether a result set of a query tab can
//! be edited like a table tab, which table column each result column shows, and the row
//! identity it carries.
//!
//! The decision is the engine's: it says where each result column comes from (PostgreSQL
//! table OIDs, SQL Server `sp_describe_first_result_set`, MySQL `org_table` / `org_name`,
//! SQLite column origins). yadbe only adds a narrowing check of the statement's shape (one
//! `SELECT` reading one table, no join, union or subquery in `FROM`), so that a self-join or a
//! view hiding one can never pass for a single table.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::meta::ObjectRef;
use crate::session::table_model::{RowKey, TableColumn};

/// Why a result set cannot be edited. Several can apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ResultReadOnlyReason {
    /// The statement is not a plain `SELECT … FROM <one table>`: a join, a union, a subquery,
    /// a function or a CTE in `FROM`, several statements in one batch, no `FROM` at all…
    NotSingleTable,
    /// The engine did not say where the columns come from (or could not describe the
    /// statement), or none of them comes from a table.
    OriginUnknown,
    /// The columns come from another object than the one the statement names (a view, a
    /// synonym), or from several tables.
    OtherSource,
    /// The rows come from a view or a materialized view.
    View,
    /// The table is not in the connection's metadata (a temporary table…).
    TableUnknown,
    /// The table has neither a primary key nor a unique key on non-null columns.
    NoRowIdentity,
    /// The result does not hold every column of the table's row identity.
    KeyNotSelected,
    /// The connection is read-only.
    ReadOnlyConnection,
    /// The query tab's transaction is open: edits run in a transaction of their own, on
    /// another server connection, so the tab's must end first (commit or roll back). Not in
    /// `readOnlyReasons` (it changes with the tab): Apply refuses it.
    OpenTransaction,
}

/// A column of a result set, as an edit sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultEditColumn {
    /// The table column whose values this result column shows, exactly as a table read
    /// would; `null`: computed by the query (an expression, a repeat of a column already
    /// shown, a value the engine reads differently in a query), never written and left out of
    /// the row checks.
    pub source: Option<String>,
    /// The column as a table tab describes it (type, nullability, editor, why it cannot be
    /// written). A computed column is read-only with reason `computed`; its `name` is the
    /// result's.
    pub column: TableColumn,
}

/// Whether a result set can be edited, and how (F-087).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultEditInfo {
    pub result_id: u32,
    /// The table the rows come from, when the engine said.
    pub table: Option<ObjectRef>,
    /// Empty: the result can be edited (updates and deletes; no inserts).
    pub read_only_reasons: Vec<ResultReadOnlyReason>,
    /// One per result column, in result order.
    pub columns: Vec<ResultEditColumn>,
    /// The table columns identifying a row (`RowKey`s list their values in this order).
    pub row_identity: Vec<String>,
    /// For each row identity column, the result column holding it (the first one showing
    /// it). Empty when the result cannot be edited.
    pub identity_columns: Vec<u32>,
}

/// A row of a result set to read again, with its identity as last known.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultRowRef {
    /// Its row in the result (columns the query computed keep the value read there).
    pub row: u32,
    pub key: RowKey,
}
