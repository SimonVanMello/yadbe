//! IPC types of the search family's index tab and console (`search_*` commands).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::{LocalizedText, YadbeError};
use crate::db::search::classify::SearchDangerKind;
use crate::db::search::meta::SearchIndexDetails;
use crate::db::search::request::HttpMethod;
use crate::db::search::server::SearchServer;
pub use crate::session::document::model::DocumentResult;
use crate::session::query_model::ResultSummary;

/// How the query box of an index tab reads its text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexQueryMode {
    /// A Query DSL object (`{"match": {"title": "x"}}`, or `{"query": {…}}`).
    Dsl,
    /// A Lucene query string (`status:paid AND total:>100`), sent as `query_string`.
    QueryString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexSort {
    pub field: String,
    pub descending: bool,
}

/// What an index tab asks for. Empty texts mean none (all documents, whole `_source`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexQuery {
    pub mode: IndexQueryMode,
    pub text: String,
    /// `_source` filtering: field patterns separated by commas, `-` before one to leave it
    /// out (`customer.*, -customer.secret`).
    pub source: String,
    pub sort: Vec<IndexSort>,
    /// Documents per page, 1 to 1000.
    pub page_size: u32,
}

/// How many documents match: exact, or a lower bound (`track_total_hits` stops counting).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchTotal {
    pub value: f64,
    /// `false`: at least `value`.
    pub exact: bool,
}

/// How the pages of an index tab follow each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexPaging {
    /// `search_after` on a point in time: consistent pages, no depth limit.
    PointInTime,
    /// `from` / `size`: pages stop at the index's result window (10 000 by default).
    FromSize,
}

/// An index (data stream, alias, pattern) as its tab opens it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexTabInfo {
    pub target: String,
    pub details: SearchIndexDetails,
    pub server: SearchServer,
    pub paging: IndexPaging,
}

/// One page of an index tab.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexPage {
    /// Hits as a grid (`_index`, `_id`, `_score`, the `_source` fields flattened) and as
    /// whole hits.
    pub documents: DocumentResult,
    /// 0-based.
    pub page: u32,
    pub has_more: bool,
    /// From the first page of the query (`track_total_hits` up to 10 000).
    pub total: Option<SearchTotal>,
    pub paging: IndexPaging,
    /// With `from` / `size`: the last document a page can reach (the result window).
    pub window: Option<u32>,
    /// The search as it was sent, console style.
    pub request: String,
    pub took_ms: Option<f64>,
    pub duration_ms: f64,
}

/// Lines of the console text (0-based, inclusive): the cursor's line, or the selection's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub from: u32,
    pub to: u32,
}

/// A dangerous request of a console run, and what it would do, as the server counts it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchDanger {
    /// 0-based line of its request line.
    pub line: u32,
    pub request: String,
    pub kind: SearchDangerKind,
    pub effect: LocalizedText,
}

/// The `_shards` of a response.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShardsInfo {
    pub total: f64,
    pub successful: f64,
    pub skipped: f64,
    pub failed: f64,
}

/// Where a response's error points in the editor (1-based).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsolePosition {
    pub line: u32,
    pub column: u32,
}

/// What a response holds, ready to show.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConsoleBody {
    /// No body (`HEAD`, an empty answer).
    Empty,
    /// Text (`_cat` without `format=json`, an error page).
    #[serde(rename_all = "camelCase")]
    Text { text: String, truncated: bool },
    /// JSON: the raw text, the whole response as one document (`search_fetch_documents`),
    /// its hits as a result when it has `hits.hits`, its table when it is an ES|QL / SQL
    /// answer.
    #[serde(rename_all = "camelCase")]
    Json {
        raw: String,
        /// `raw` is the start of a longer text.
        truncated: bool,
        document_id: u32,
        hits: Option<DocumentResult>,
        total: Option<SearchTotal>,
        table: Option<ResultSummary>,
    },
}

/// The answer to one request of a console run.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleResponse {
    /// 0-based line of the request line in the editor.
    pub line: u32,
    pub method: HttpMethod,
    pub path: String,
    /// `null` when nothing was answered (refused, cancelled, link down).
    pub status: Option<u16>,
    pub duration_ms: f64,
    pub took_ms: Option<f64>,
    pub shards: Option<ShardsInfo>,
    pub timed_out: bool,
    /// Why it failed: refused by the gate, cancelled, timed out, or what the server said
    /// for a status of 400 and more.
    pub error: Option<YadbeError>,
    pub error_position: Option<ConsolePosition>,
    pub body: ConsoleBody,
}

/// What `search_console_run` did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchConsoleOutcome {
    /// Nothing ran: these requests are dangerous; run again with `confirmed` to run them.
    NeedsConfirmation { dangers: Vec<SearchDanger> },
    /// The requests ran in order. A request that could not be sent stops the run: the ones
    /// after it are `skipped`. A text that is not requests fails with `failure`.
    #[serde(rename_all = "camelCase")]
    Ran {
        responses: Vec<ConsoleResponse>,
        skipped: u32,
        failure: Option<ConsoleFailure>,
    },
}

/// A console text that cannot be read as requests.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleFailure {
    pub error: YadbeError,
    /// 0-based line at fault.
    pub line: u32,
}
