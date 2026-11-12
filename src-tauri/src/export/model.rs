//! IPC model of exports (M2-7): the request, its options and the payloads of the
//! `export-progress` and `export-finished` events.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::session::table_model::{SortKey, TableFilter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CsvDelimiter {
    Comma,
    Semicolon,
    Tab,
}

impl CsvDelimiter {
    pub fn byte(self) -> u8 {
        match self {
            CsvDelimiter::Comma => b',',
            CsvDelimiter::Semicolon => b';',
            CsvDelimiter::Tab => b'\t',
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CsvQuote {
    /// Only when the value contains the delimiter, a quote or a line break.
    Minimal,
    /// Every value that is not NULL.
    All,
    /// Every value that is not a number or a boolean.
    NonNumeric,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            LineEnding::Lf => b"\n",
            LineEnding::Crlf => b"\r\n",
        }
    }
}

/// How binary values are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BinaryEncoding {
    Hex,
    Base64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    pub delimiter: CsvDelimiter,
    pub quote: CsvQuote,
    pub header: bool,
    /// Written for SQL NULL. When empty, an empty string is quoted (`""`) to stay
    /// distinguishable from NULL.
    pub null_text: String,
    pub line_ending: LineEnding,
    /// A UTF-8 byte order mark first, which Excel needs to read accents.
    pub bom: bool,
    pub binary: BinaryEncoding,
}

impl Default for CsvOptions {
    fn default() -> Self {
        Self {
            delimiter: CsvDelimiter::Comma,
            quote: CsvQuote::Minimal,
            header: true,
            null_text: String::new(),
            line_ending: LineEnding::Lf,
            bom: false,
            binary: BinaryEncoding::Hex,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JsonLayout {
    /// One JSON array of objects, one object per line.
    Array,
    /// One object per line, no enclosing array.
    Ndjson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JsonNumbers {
    /// Integers, decimals and floats as JSON numbers when a reader reproduces them exactly
    /// (at most 15 significant digits, or integers within 2^53), else as strings.
    Auto,
    /// Every number as a string.
    Strings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonOptions {
    pub layout: JsonLayout,
    pub numbers: JsonNumbers,
    pub binary: BinaryEncoding,
}

impl Default for JsonOptions {
    fn default() -> Self {
        Self {
            layout: JsonLayout::Array,
            numbers: JsonNumbers::Auto,
            binary: BinaryEncoding::Hex,
        }
    }
}

/// `INSERT` statements (F-066): identifiers quoted and values written as literals the way the
/// chosen engine reads them, so the script runs on that engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SqlOptions {
    /// The engine whose quoting and literals the script uses (not necessarily the source's).
    pub engine: Engine,
    /// Schema of the target table; empty: none.
    pub schema: String,
    /// Target table, unquoted.
    pub table: String,
    /// Rows per `INSERT` (1 to 500): one multi-row statement holds this many.
    pub rows_per_statement: u32,
    pub line_ending: LineEnding,
}

impl SqlOptions {
    pub const MAX_ROWS_PER_STATEMENT: u32 = 500;
}

/// A Markdown (GitHub flavoured) table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownOptions {
    /// Written for SQL NULL.
    pub null_text: String,
    /// Numeric columns are right-aligned.
    pub align_numbers: bool,
    pub binary: BinaryEncoding,
    pub line_ending: LineEnding,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        Self {
            null_text: "NULL".to_owned(),
            align_numbers: true,
            binary: BinaryEncoding::Hex,
            line_ending: LineEnding::Lf,
        }
    }
}

/// An Excel workbook (`.xlsx`), streamed: one worksheet, a frozen bold header row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExcelOptions {
    /// Name of the worksheet (at most 31 characters, none of `[]:*?/\`).
    pub sheet_name: String,
    pub binary: BinaryEncoding,
}

impl Default for ExcelOptions {
    fn default() -> Self {
        Self {
            sheet_name: "Result".to_owned(),
            binary: BinaryEncoding::Hex,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "format", rename_all = "camelCase")]
pub enum ExportFormat {
    Csv { options: CsvOptions },
    Json { options: JsonOptions },
    Sql { options: SqlOptions },
    Markdown { options: MarkdownOptions },
    Excel { options: ExcelOptions },
}

/// Which part of a result is exported. Zero-based.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportScope {
    /// Every row the statement returns, including those past the in-memory limit.
    All,
    /// Loaded rows `row_from..=row_to` and the given columns, in this order (the grid's
    /// selection, whose columns may have been reordered).
    Range {
        row_from: u32,
        row_to: u32,
        columns: Vec<u32>,
    },
}

/// Where the rows come from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportSourceSpec {
    Result {
        result_id: u32,
        scope: ExportScope,
    },
    /// Every row of an open table tab's table under this filter and sort (the tab's own, not
    /// only its current page), read from the server in pages.
    Table {
        tab_id: String,
        filter: TableFilter,
        sort: Vec<SortKey>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub source: ExportSourceSpec,
    pub format: ExportFormat,
    /// From the native save dialog: absolute, with an extension that fits the format.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportStarted {
    pub export_id: u32,
}

/// Rows and bytes written so far. Throttled (at most about ten per second).
#[derive(Debug, Clone, PartialEq, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub export_id: u32,
    pub rows: u32,
    pub bytes: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExportStatus {
    Done,
    Failed,
    Cancelled,
}

/// The export ended; always the last event of an export. A failed or cancelled export left
/// no file.
#[derive(Debug, Clone, PartialEq, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ExportFinished {
    pub export_id: u32,
    pub status: ExportStatus,
    pub rows: u32,
    pub bytes: f64,
    pub path: String,
    /// The result was stopped at its limit before an export drained it: the file lacks the
    /// rows the limit left out.
    pub truncated: bool,
    /// The format's own limit stopped the export: the file lacks the rows past it (an Excel
    /// worksheet holds 1 048 575 rows below its header).
    pub limited: bool,
    pub error: Option<YadbeError>,
}
