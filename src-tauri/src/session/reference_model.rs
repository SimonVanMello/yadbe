//! IPC model of foreign key navigation (M3-2, F-088): the referenced row of a foreign key
//! cell, the rows referencing a row, and the lookup of a referenced table that the foreign
//! key cell editor offers.
//!
//! Every lookup runs on a server connection of the table tab it comes from (see
//! `references.rs`), is given a request id the frontend can cancel, and is recorded in the
//! statement log. Rows come back as result windows, kept in the backend like pages.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::meta::ObjectRef;
use crate::db::value::{ColumnMeta, Value};
use crate::session::query_model::ResultWindow;
use crate::session::table_model::TableColumn;

/// Rows of a lookup page at most.
pub const MAX_LOOKUP_ROWS: u32 = 500;
/// Largest bound of a referencing-rows count.
pub const MAX_COUNT_LIMIT: u32 = 100_000;

/// A column and the value it must equal: one per column of a (possibly composite) key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub column: String,
    pub value: Value,
}

/// The row a foreign key value references (the peek).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReferencedRow {
    /// The referenced table's columns, in table order (as a table tab describes them).
    pub columns: Vec<TableColumn>,
    /// The matching row (none when the value references nothing, e.g. a constraint not
    /// enforced or a row deleted meanwhile; at most one more when the key is not unique).
    pub window: ResultWindow,
    /// Rows that matched, up to 2.
    pub matches: u32,
    pub duration_ms: f64,
}

/// How many rows hold a value, counted up to a bound.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoundedCount {
    /// Exact when `more` is false, else the bound.
    pub count: u32,
    /// More rows than the bound match ("1 000+").
    pub more: bool,
    pub duration_ms: f64,
}

/// A page of a referenced table, for the foreign key cell editor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LookupRequest {
    /// The referenced table (same database as the tab's table).
    pub table: ObjectRef,
    /// The referenced key columns: the page is ordered by them and they come first.
    pub key_columns: Vec<String>,
    /// A few columns that tell rows apart for a person (name, title…), after the key.
    pub display_columns: Vec<String>,
    /// Rows whose key or display columns contain this text, case-insensitively (compared as
    /// text, `LIKE` wildcards escaped, bound). Blank: every row.
    pub search: Option<String>,
    pub offset: u32,
    /// 1 to 500.
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LookupPage {
    /// `keyColumns` then `displayColumns`.
    pub columns: Vec<ColumnMeta>,
    pub window: ResultWindow,
    pub offset: u32,
    pub has_more: bool,
    pub duration_ms: f64,
}
