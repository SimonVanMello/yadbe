//! IPC model of data imports (M3-10, F-091): the file's format options, the column mapping,
//! the type check of what will be written, and the payloads of the `import-progress` and
//! `import-finished` events.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::db::value::ValueKind;
use crate::export::model::BinaryEncoding;
use crate::session::table_model::ColumnReadOnlyReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportFormat {
    Csv,
    /// A JSON array of objects (`[{…}, {…}]`).
    Json,
    /// One JSON object after the other (JSON Lines / NDJSON).
    JsonLines,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportEncoding {
    Utf8,
    Utf16le,
    Utf16be,
    /// Windows-1252 (ISO 8859-1 with the printable characters of 0x80 to 0x9F).
    Latin1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportDelimiter {
    Comma,
    Semicolon,
    Tab,
    Pipe,
}

impl ImportDelimiter {
    pub fn char(self) -> char {
        match self {
            ImportDelimiter::Comma => ',',
            ImportDelimiter::Semicolon => ';',
            ImportDelimiter::Tab => '\t',
            ImportDelimiter::Pipe => '|',
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportQuote {
    Double,
    Single,
    /// No quoting: every delimiter separates fields.
    None,
}

impl ImportQuote {
    pub fn char(self) -> Option<char> {
        match self {
            ImportQuote::Double => Some('"'),
            ImportQuote::Single => Some('\''),
            ImportQuote::None => None,
        }
    }
}

/// How the file is read. `preview_import_file` detects them when none are given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportParseOptions {
    pub format: ImportFormat,
    pub encoding: ImportEncoding,
    /// CSV only.
    pub delimiter: ImportDelimiter,
    /// CSV only.
    pub quote: ImportQuote,
    /// CSV: the first row (after the skipped ones) holds the column names.
    pub header: bool,
    /// Text read as `NULL` when it is not quoted (`NULL`, `\N`…). CSV only.
    pub null_token: Option<String>,
    /// An unquoted empty CSV field is `NULL` (a quoted `""` stays an empty string).
    pub empty_as_null: bool,
    /// Spaces around unquoted CSV fields are dropped.
    pub trim: bool,
    /// Lines skipped before the header, CSV only.
    pub skip_rows: u32,
}

impl Default for ImportParseOptions {
    fn default() -> Self {
        Self {
            format: ImportFormat::Csv,
            encoding: ImportEncoding::Utf8,
            delimiter: ImportDelimiter::Comma,
            quote: ImportQuote::Double,
            header: true,
            null_token: None,
            empty_as_null: true,
            trim: false,
            skip_rows: 0,
        }
    }
}

/// The first rows of a file as the options read them. A cell is `null` for `NULL`.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// The options that were used: the detected ones when the call gave none.
    pub options: ImportParseOptions,
    /// The file starts with a byte order mark (dropped).
    pub bom: bool,
    pub file_size: f64,
    /// The header, or `Column 1`… without one; for JSON the keys of the first objects.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows among those read whose field count differs from the header's (CSV).
    pub ragged_rows: u32,
    /// Byte sequences that are not valid in the encoding, replaced by `U+FFFD` (a sign of
    /// a wrong encoding).
    pub invalid_bytes: u32,
}

/// What a column of the file is written as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportValueSource {
    /// The file's column at this position of `ImportPreview.columns`.
    File {
        index: u32,
    },
    Null,
    /// The same text for every row, converted like a file value.
    Constant {
        value: String,
    },
}

/// One written column. A table column without a mapping is left out of the `INSERT`: the
/// server applies its default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportMapping {
    pub column: String,
    pub source: ImportValueSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportDecimalSeparator {
    Dot,
    Comma,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportConvertOptions {
    /// `1,5` is a decimal number (and `1.5` is not) when this is a comma.
    pub decimal_separator: ImportDecimalSeparator,
    /// How binary columns are written in the file.
    pub binary: BinaryEncoding,
}

impl Default for ImportConvertOptions {
    fn default() -> Self {
        Self {
            decimal_separator: ImportDecimalSeparator::Dot,
            binary: BinaryEncoding::Hex,
        }
    }
}

/// What happens to a row that does not convert or that the server refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportOnError {
    /// The import ends at the first rejected row.
    Stop,
    /// The row is left out, counted and reported; the others go on.
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportCommit {
    /// One transaction: everything or nothing. Locks and the transaction log grow until the
    /// end.
    Single,
    /// Every batch is committed on its own: a failure or a cancel keeps the earlier batches.
    PerBatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub connection_id: String,
    pub table: ObjectRef,
    /// From the native open dialog: absolute, with a known extension.
    pub path: String,
    pub parse: ImportParseOptions,
    pub mapping: Vec<ImportMapping>,
    pub convert: ImportConvertOptions,
    pub on_error: ImportOnError,
    pub commit: ImportCommit,
    /// Runs everything in a transaction that is rolled back at the end.
    pub dry_run: bool,
    /// Rejected rows are written here as CSV (with their line and the reason).
    pub rejects_path: Option<String>,
}

/// A column of the target table, as the import sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportTargetColumn {
    pub name: String,
    pub type_name: String,
    pub kind: ValueKind,
    pub nullable: bool,
    /// A default, an identity or a computed value fills the column when it is left out.
    pub filled_by_server: bool,
    pub primary_key: bool,
    /// `null`: the column can be written.
    pub read_only_reason: Option<ColumnReadOnlyReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportTarget {
    pub table: ObjectRef,
    pub columns: Vec<ImportTargetColumn>,
    /// The connection is read-only: nothing can be imported.
    pub read_only: bool,
    /// Rows per multi-row `INSERT` at most (from the engine's parameter limit).
    pub max_batch_rows: u32,
}

/// Why a value is not written as is. Also the reason of a rejected row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportIssueKind {
    /// Not a number, date, boolean… of the column's type.
    InvalidFormat,
    OutOfRange,
    TooLong,
    /// More decimals than the column keeps: the server would round.
    TooManyDecimals,
    /// An empty or `NULL` value for a `NOT NULL` column.
    NullNotAllowed,
    /// A time zone offset for a column without zone.
    UnexpectedTimeZone,
    /// The row has more or fewer fields than the header.
    FieldCount,
    /// A unique, foreign key, check or not null constraint.
    Constraint,
    /// The server refused the row for another reason (`detail`).
    ServerError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportBadValue {
    /// 1-based line of the row in the file.
    pub line: u32,
    /// The text as read, cut at 80 characters.
    pub value: String,
    pub reason: ImportIssueKind,
}

/// How well the values of one mapped column convert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumnCheck {
    pub column: String,
    pub type_name: String,
    pub kind: ValueKind,
    pub nullable: bool,
    /// Rows examined.
    pub examined: u32,
    pub nulls: u32,
    /// Values that will not convert (a `NULL` for a `NOT NULL` column counts).
    pub invalid: u32,
    /// The first bad values.
    pub samples: Vec<ImportBadValue>,
}

/// The type check of a mapping over the first rows of the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportAnalysis {
    pub rows_examined: u32,
    /// The file has more rows than were examined: the dry run reads them all.
    pub sampled: bool,
    pub ragged_rows: u32,
    pub columns: Vec<ImportColumnCheck>,
    /// `NOT NULL` columns without a default that the mapping leaves out: the insert fails
    /// whatever the data.
    pub missing_required: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportStarted {
    pub import_id: u32,
}

/// Progress of an import, throttled (about ten per second).
#[derive(Debug, Clone, PartialEq, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub import_id: u32,
    pub rows_read: u32,
    /// Rows written (a dry run: that would be written).
    pub inserted: u32,
    pub rejected: u32,
    pub bytes_read: f64,
    pub total_bytes: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportStatus {
    Done,
    Failed,
    Cancelled,
}

/// A row that was not written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportReject {
    pub line: u32,
    pub column: Option<String>,
    /// The offending text (cut at 80 characters), when one value is at fault.
    pub value: Option<String>,
    pub reason: ImportIssueKind,
    /// What the server said.
    pub detail: Option<String>,
}

/// The import ended; always the last event of an import.
#[derive(Debug, Clone, PartialEq, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ImportFinished {
    pub import_id: u32,
    pub status: ImportStatus,
    pub dry_run: bool,
    pub commit: ImportCommit,
    pub rows_read: u32,
    /// Rows written (dry run: that would have been written).
    pub inserted: u32,
    /// Rows still in the table after the end: `inserted` once committed, `0` after a
    /// rollback, the committed batches for a per-batch import that failed or was cancelled.
    pub kept: u32,
    pub rejected: u32,
    pub batches: u32,
    pub duration_ms: f64,
    /// The first rejected rows (at most 50).
    pub reject_samples: Vec<ImportReject>,
    pub rejects_path: Option<String>,
    /// Invalid byte sequences replaced while decoding.
    pub invalid_bytes: u32,
    /// JSON: keys met after the first objects that are not columns of the file's schema.
    pub dropped_keys: u32,
    pub error: Option<YadbeError>,
}
