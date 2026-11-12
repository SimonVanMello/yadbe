//! IPC model of query execution (M1-3): requests, execution state, result windows, messages
//! and the payloads of the `query-progress`, `query-finished` and
//! `transaction-state-changed` events.
//!
//! Text positions are UTF-16 code units of the editor text (JavaScript string indices, as
//! CodeMirror counts them). Counts cross as numbers; values as lossless strings.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, ValueKind};

/// Rows kept per result before fetching pauses, unless the request says otherwise.
pub const DEFAULT_MAX_ROWS: u32 = 100_000;
/// Memory kept per result before fetching pauses (256 MB).
pub const DEFAULT_MAX_BYTES: u32 = 256 * 1024 * 1024;
/// Largest window `fetch_result_window` returns.
pub const MAX_WINDOW_ROWS: u32 = 2_000;
/// Cells longer than this many characters are cut in windows; `fetch_result_cell` returns
/// the whole value.
pub const CELL_PREVIEW_CHARS: usize = 2_000;

/// A span of the editor text, `from` inclusive, `to` exclusive, in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TextRange {
    pub from: u32,
    pub to: u32,
}

/// A position in the editor text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TextPosition {
    /// UTF-16 code units from the start of the text.
    pub offset: u32,
    /// 1-based.
    pub line: u32,
    /// 1-based, in UTF-16 code units.
    pub column: u32,
}

/// Which statements of the text run (F-041).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecuteScope {
    /// Every statement of the text.
    All,
    /// The statements of a selection, split like a whole text; ranges stay relative to the
    /// whole text.
    Range { from: u32, to: u32 },
    /// The statement under the cursor (same rule as `statement_at`).
    StatementAt { offset: u32 },
}

/// When fetching pauses for one result (SPEC §2.2: memory-capped result store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultLimits {
    pub max_rows: u32,
    pub max_bytes: u32,
}

impl Default for ResultLimits {
    fn default() -> Self {
        Self {
            max_rows: DEFAULT_MAX_ROWS,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    /// The editor tab: it owns a dedicated server connection, opened on its first run.
    pub tab_id: String,
    pub connection_id: String,
    /// Database to run in; `null`: the connection's. Ignored by engines without several
    /// databases. Changing it (or the connection) reopens the tab's connection.
    pub database: Option<String>,
    /// The whole editor text: ranges and error positions refer to it.
    pub text: String,
    pub scope: ExecuteScope,
    /// `null`: 100 000 rows / 256 MB per result.
    pub limits: Option<ResultLimits>,
    /// Values of the statements' parameters (F-048), from `query_parameters`. A statement
    /// whose parameters lack a value fails the whole run before anything is sent.
    #[serde(default)]
    pub parameters: Vec<ParameterValue>,
}

/// Returned as soon as an execution is accepted; everything else arrives as events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionStarted {
    /// Unique for the app's lifetime.
    pub execution_id: u32,
    /// The statements that will run, in order (`statementIndex` indexes this list).
    pub statements: Vec<TextRange>,
}

/// Transaction handling of a tab (F-047).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TransactionMode {
    /// Every statement commits on its own (an explicit `BEGIN` still opens a transaction).
    #[default]
    AutoCommit,
    /// yadbe opens a transaction before the first statement; Commit / Rollback end it.
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TransactionStatus {
    /// No transaction open.
    #[default]
    Idle,
    /// A transaction is open: changes are not committed yet.
    Open,
    /// A statement failed inside the transaction; the engine refuses further statements
    /// until Rollback (PostgreSQL).
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransactionState {
    pub mode: TransactionMode,
    pub status: TransactionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionStatus {
    /// Opening the tab's connection.
    Connecting,
    Running,
    /// A result reached its limit: fetching waits for `resume_result` (or a cancel).
    Paused,
    Succeeded,
    /// A statement failed (or was refused); the next ones did not run.
    Failed,
    Cancelled,
}

impl ExecutionStatus {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            ExecutionStatus::Succeeded | ExecutionStatus::Failed | ExecutionStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ResultStatus {
    /// Rows are arriving.
    Streaming,
    /// Limit reached; more rows may follow (`resume_result`).
    Paused,
    /// Every row was read.
    Complete,
    /// Stopped by a cancel; the rows read so far stay readable.
    Cancelled,
    /// The statement failed while streaming; the rows read so far stay readable.
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    RowLimit,
    MemoryLimit,
}

/// How much more to read from a paused result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ResumeMode {
    /// One more batch of the limits (rows and memory).
    More,
    /// Everything, without limit.
    All,
}

/// One result set of an execution (one per statement that returns rows).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultSummary {
    /// Unique for the app's lifetime; valid until the tab runs again or closes.
    pub result_id: u32,
    pub statement_index: u32,
    pub columns: Vec<ColumnMeta>,
    /// Rows readable with `fetch_result_window`.
    pub row_count: u32,
    pub status: ResultStatus,
    /// Set while `paused`.
    pub paused_by: Option<PauseReason>,
    /// Memory the rows take in the backend, approximately, in bytes (saturates at 4 GiB).
    pub bytes: u32,
    /// Rows past the limits went to an export only (M2-7): the stored rows are not all the
    /// rows the statement returned, and the statement cannot be resumed.
    pub truncated: bool,
}

/// A message from the server, never translated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerMessage {
    /// As sent by the server: `ERROR`, `WARNING`, `NOTICE`, `INFO`…
    pub severity: String,
    /// SQLSTATE or the engine's error number.
    pub code: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementCompleted {
    /// Time the statement ran, without the time it waited paused at a result cap.
    pub duration_ms: f64,
    /// Time it waited paused at a result cap, for the user to resume.
    pub paused_ms: u32,
    /// Rows changed by a DML statement, when the engine says.
    pub rows_affected: Option<f64>,
    /// Rows read, for a statement that returned a result set.
    pub rows_returned: Option<u32>,
    pub result_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementError {
    /// Typed error: `queryFailed` (see `server`), `readOnlyViolation`, `connectionLost`,
    /// `cancelled`…
    pub error: YadbeError,
    /// The server's own message, for errors the server raised.
    pub server: Option<ServerMessage>,
    /// Where the server located the error, in the editor text (F-061).
    pub position: Option<TextPosition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MessageBody {
    StatementCompleted(StatementCompleted),
    /// Notice, warning or info sent by the server (`RAISE NOTICE`, `PRINT`…).
    Notice(ServerMessage),
    Error(StatementError),
}

/// A line of the Messages tab (F-061).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryMessage {
    /// 0, 1, 2… in the execution.
    pub seq: u32,
    /// The statement it belongs to, when there is one.
    pub statement_index: Option<u32>,
    /// Milliseconds since the execution started.
    pub at_ms: u32,
    pub body: MessageBody,
}

/// What changed in an execution since its previous event.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDelta {
    pub status: ExecutionStatus,
    /// Active milliseconds since the execution started (until it finished): pauses at a result
    /// cap, which wait for the user, are not counted.
    pub elapsed_ms: u32,
    /// Milliseconds spent paused so far.
    pub paused_ms: u32,
    /// The statement running (or paused), `null` once finished.
    pub current_statement: Option<u32>,
    /// Results created or changed since the previous event: replace them by `resultId`.
    pub results: Vec<ResultSummary>,
    /// Messages added since the previous event, in order.
    pub messages: Vec<QueryMessage>,
}

/// Everything known about an execution, for a view that (re)mounts.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSnapshot {
    pub execution_id: u32,
    pub connection_id: String,
    pub database: Option<String>,
    pub statements: Vec<TextRange>,
    /// Unix time in milliseconds.
    pub started_at: f64,
    pub status: ExecutionStatus,
    pub elapsed_ms: u32,
    pub paused_ms: u32,
    pub current_statement: Option<u32>,
    pub results: Vec<ResultSummary>,
    pub messages: Vec<QueryMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryTabInfo {
    pub tab_id: String,
    pub transaction: TransactionState,
    /// The connection and database the tab's own server connection is open on, `null`
    /// before its first run or once closed.
    pub connection_id: Option<String>,
    pub database: Option<String>,
    /// The running or last execution.
    pub execution: Option<ExecutionSnapshot>,
}

/// The cells of one column in a window. Each cell is its lossless text, `null` for SQL
/// `NULL`: `true` / `false` for booleans, digits for numbers (`NaN`, `Infinity` included),
/// lowercase hexadecimal for bytes, the JSON of the nested values (`Value[]`) for arrays,
/// and the forms documented on `Value` for the other kinds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowColumn {
    pub values: Vec<Option<String>>,
    /// The kind of each cell, only when a cell's kind differs from the column's (SQLite's
    /// dynamic typing, expressions); `null` otherwise. Entries of `NULL` cells are the
    /// column's kind.
    pub kinds: Option<Vec<ValueKind>>,
    /// Indices in the window of the cells cut at 2 000 characters; `fetch_result_cell`
    /// returns the whole value.
    pub truncated: Vec<u32>,
}

/// Rows `offset .. offset + rowCount` of a result, column by column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultWindow {
    pub result_id: u32,
    pub offset: u32,
    pub row_count: u32,
    /// One entry per column of the result, in order.
    pub columns: Vec<WindowColumn>,
}

/// The type a query parameter's value is given as (F-048).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ParameterKind {
    Text,
    /// Digits, optionally a sign, a decimal part and an exponent.
    Number,
    /// `true` / `false`.
    Boolean,
    /// SQL `NULL`; the value is ignored.
    Null,
    /// `YYYY-MM-DD`, `HH:MM[:SS[.ffffff]]` or both, with an optional offset.
    DateTime,
}

/// The value given for one query parameter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParameterValue {
    /// `QueryParameter::name`.
    pub name: String,
    pub kind: ParameterKind,
    pub value: String,
}

/// A parameter of the statements a run would send (F-048).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryParameter {
    /// What the value is given for: the name without its sigil (`id`), the number of a
    /// numbered one (`2`), `#` and the order of a `?` in the run (`#1`, `#2`…).
    pub name: String,
    /// As written the first time (`:id`, `@id`, `$2`, `?`).
    pub label: String,
    pub style: crate::db::params::ParameterStyle,
    /// Where it appears in the editor text.
    pub occurrences: Vec<TextRange>,
}

/// Explain the statement of a scope (F-053).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRequest {
    /// Runs on the tab's own connection (its transaction, temporary tables, settings).
    pub tab_id: String,
    pub connection_id: String,
    pub database: Option<String>,
    pub text: String,
    /// Must hold exactly one statement.
    pub scope: ExecuteScope,
    /// Run the statement and report actual rows and times (`EXPLAIN ANALYZE`, actual
    /// execution plan). A statement that writes does write.
    pub analyze: bool,
    #[serde(default)]
    pub parameters: Vec<ParameterValue>,
}

/// A plan and what was run to get it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    pub statement: TextRange,
    pub plan: crate::db::plan::QueryPlan,
    /// What yadbe sent (also in the statement log), e.g. `EXPLAIN (FORMAT JSON) …`.
    pub sent: String,
    pub duration_ms: f64,
}

/// A block of a selection of cells: rows `rowStart .. rowEnd` (exclusive, in the order the grid
/// shows them) of these columns (indices in the result's data order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AggregateRange {
    pub row_start: u32,
    pub row_end: u32,
    pub columns: Vec<u32>,
}

/// What a selection of cells adds up to (F-065). A cell in two ranges counts once.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionAggregate {
    /// Cells selected, `NULL`s included (saturates at 4 billion).
    pub cells: u32,
    /// Cells that are not `NULL`.
    pub non_null: u32,
    /// Cells holding a number (integers, decimals, floats).
    pub numeric: u32,
    /// `sum`, `avg`, `min` and `max` are only given when every non-`NULL` cell is a number
    /// (at least one). Plain decimals, exact unless `exact` is false.
    pub sum: Option<String>,
    pub avg: Option<String>,
    pub min: Option<String>,
    pub max: Option<String>,
    /// False when a floating-point cell took part: the figures are then floating point.
    pub exact: bool,
}
