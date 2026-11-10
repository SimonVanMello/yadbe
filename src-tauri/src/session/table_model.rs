//! IPC model of table data (M2-1): browsing a table or a view page by page with a
//! parameterized filter and a sort, row counts, and what can be edited (F-080, F-081,
//! F-086).
//!
//! A table tab owns a dedicated server connection (see `table_data.rs`). Pages are stored in
//! the backend like query results: `fetch_result_window` and `fetch_result_cell` read them.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::meta::{ObjectKind, ObjectRef};
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::query_model::ResultWindow;

/// Largest page `fetch_table_page` returns.
pub const MAX_PAGE_ROWS: u32 = 50_000;
/// Rows of a page sent with it; the rest is read with `fetch_result_window`.
pub const PAGE_WINDOW_ROWS: u32 = 500;

/// Comparison of a column filter (F-081).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    /// `=`, one value.
    Eq,
    /// `<>`, one value. Rows where the column is `NULL` do not match (SQL semantics).
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    /// The column's text contains the value, case-insensitively (`LIKE` / `ILIKE` with the
    /// wildcards of the value escaped). Any column type: it is compared as text.
    Contains,
    StartsWith,
    EndsWith,
    /// One of the values (at least one).
    In,
    /// No value.
    IsNull,
    IsNotNull,
    /// Two values, both bounds included.
    Between,
}

/// One condition on one column. Values are bound as parameters, never written into the SQL;
/// the engine converts them to the column's type (a `text` value for a `uuid` column is
/// fine).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
    /// None for `isNull` / `isNotNull`, two for `between`, at least one for `in`, one
    /// otherwise.
    pub values: Vec<Value>,
}

/// What rows a page, a count or a refresh reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    /// Combined with `AND`.
    pub conditions: Vec<ColumnFilter>,
    /// A `WHERE` condition typed by the user, sent as written inside parentheses and
    /// `AND`-ed with the conditions; only the engine validates it. Blank: none. Refused
    /// (`invalidArgument`) when it holds more than one statement.
    pub raw_where: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    pub direction: SortDirection,
}

/// Why a table or a view cannot be edited. Several can apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TableReadOnlyReason {
    /// A view or a materialized view.
    View,
    /// Neither a primary key nor a unique key on non-null columns: a row cannot be told
    /// apart from another one.
    NoRowIdentity,
    /// The connection is read-only.
    ReadOnlyConnection,
}

/// Why a column cannot be written (updated, or given a value in an inserted row).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ColumnReadOnlyReason {
    /// The table is read-only (see the table's reasons).
    Table,
    /// Identity the server always generates (`GENERATED ALWAYS`, SQL Server `IDENTITY`).
    Identity,
    /// Computed column (`GENERATED ALWAYS AS (…)`, SQL Server computed column).
    Generated,
    /// Row version maintained by the server (SQL Server `rowversion` / `timestamp`).
    RowVersion,
    /// A type yadbe shows as text but cannot write back exactly (SQL Server `sql_variant`,
    /// CLR types such as `geography` or `hierarchyid`).
    UnsupportedType,
}

/// A column of a table tab, in the order of the table (and of the page windows).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub name: String,
    /// Type as the engine prints it (`character varying(100)`, `decimal(10,2)`).
    pub type_name: String,
    /// The value kind cells of this column have, and the kind an edited value should have.
    pub kind: ValueKind,
    pub nullable: bool,
    /// Default expression, as written in the catalog.
    pub default: Option<String>,
    /// An inserted row that leaves this column out gets a value from the server (default,
    /// identity, computed, `NULL` for a nullable column…): `false` means the user must give
    /// one.
    pub optional_on_insert: bool,
    pub primary_key: bool,
    /// `null`: the column can be updated and given a value on insert.
    pub read_only_reason: Option<ColumnReadOnlyReason>,
    /// Labels of an enum column, in their sort order (PostgreSQL); `null` otherwise.
    pub enum_values: Option<Vec<String>>,
}

/// A table or view opened in a table tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableDataInfo {
    pub table: ObjectRef,
    pub kind: ObjectKind,
    pub columns: Vec<TableColumn>,
    /// The columns whose values identify a row (primary key, else a unique key on non-null
    /// columns): `RowKey`s list their values in this order. `null`: rows cannot be told
    /// apart.
    pub row_identity: Option<Vec<String>>,
    /// Empty: the table can be edited.
    pub read_only_reasons: Vec<TableReadOnlyReason>,
    /// The order of a page requested without sort: the row identity, ascending. Empty when
    /// there is none (the engine's order, not guaranteed stable between pages).
    pub default_order: Vec<SortKey>,
    /// The planner's estimate from the cached metadata, when the engine has one.
    pub row_estimate: Option<f64>,
}

/// One page of rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TablePageRequest {
    pub filter: TableFilter,
    /// Empty: `defaultOrder`. A sort that does not cover the row identity gets it appended,
    /// so pages stay stable.
    pub sort: Vec<SortKey>,
    /// Rows to skip.
    pub offset: u32,
    /// Page size, 1 to 50 000.
    pub limit: u32,
}

/// The rows of a page, kept in the backend as a result: read beyond `window` with
/// `fetch_result_window` / `fetch_result_cell`. Valid until the tab reads another page or
/// closes.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub result_id: u32,
    /// Same order as `TableDataInfo.columns`.
    pub columns: Vec<ColumnMeta>,
    /// The request's offset.
    pub offset: u32,
    pub row_count: u32,
    /// Rows exist after this page.
    pub has_more: bool,
    /// The page's first rows (up to 500), in the result window format.
    pub window: ResultWindow,
    /// The order applied, tie-breakers included.
    pub order: Vec<SortKey>,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CountMode {
    /// From the engine's statistics (fast, approximate): PostgreSQL plans the filtered
    /// query, SQL Server reads its partition counts (without the filter), SQLite has none.
    Estimate,
    /// `COUNT(*)` with the filter: exact, can take a while, cancellable.
    Exact,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableRowCount {
    pub mode: CountMode,
    /// `null`: no estimate available (SQLite, statistics never gathered).
    pub count: Option<f64>,
    /// The count accounts for the filter (`false` for an estimate the engine cannot filter).
    pub filtered: bool,
    pub duration_ms: f64,
}

/// The values of a row's identity columns, in `rowIdentity` order, as last read.
pub type RowKey = Vec<Value>;

/// Rows read again by their identity (after an apply).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RefreshedRows {
    /// The rows found, columns as in a page; kept in the backend until the tab reads another
    /// page or closes (long cells: `fetch_result_cell` on `window.resultId`).
    pub window: ResultWindow,
    /// For each requested key, its row in `window`, `null` when it no longer exists.
    pub positions: Vec<Option<u32>>,
}
