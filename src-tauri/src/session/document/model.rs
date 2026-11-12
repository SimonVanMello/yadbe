//! IPC types of the document family's collection tab and console (`mongo_*` commands).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::meta::CollectionKind;
use crate::db::document::ops::DocTopology;
use crate::db::errors::YadbeError;
use crate::session::document::gate::DangerReport;
use crate::session::query_model::{ResultSummary, TextPosition, TextRange};

/// Documents shown two ways: `result`, the grid (top-level fields as columns, the union over
/// the documents, a field a document lacks as `missing`), read with `fetch_result_window`;
/// and the whole documents, in canonical Extended JSON, read with `mongo_fetch_documents`
/// from `documentsId`. Both live in the backend until the tab reads again or closes.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResult {
    pub result: ResultSummary,
    pub documents_id: u32,
    /// Documents in the result.
    pub count: u32,
}

/// What a collection tab asks for. The texts are relaxed or canonical Extended JSON; empty
/// means none.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionQuery {
    pub filter: String,
    pub projection: String,
    pub sort: String,
    /// Documents per page, 1 to 1000.
    pub page_size: u32,
}

/// One page of a collection tab.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPage {
    pub documents: DocumentResult,
    /// 0-based.
    pub page: u32,
    /// Documents exist after this page.
    pub has_more: bool,
    /// Pages follow `_id` (stable while documents are added); otherwise they skip.
    pub keyset: bool,
    /// The operation as it was sent, shell style.
    pub command: String,
    pub duration_ms: f64,
    /// The `_id` of each document of the page, canonical Extended JSON; `null` for a document
    /// read without one (a projection that leaves it out). What edits identify documents by.
    pub ids: Vec<Option<String>>,
}

/// A collection as its tab opens it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub database: String,
    pub collection: String,
    pub kind: Option<CollectionKind>,
    /// From the collection's metadata, at once (`estimatedDocumentCount`); `null` for a view.
    pub estimated_count: Option<f64>,
    pub topology: DocTopology,
    /// A capped collection: its documents cannot be deleted (M4-4).
    pub capped: bool,
}

/// How a console command ended.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CommandOutcome {
    /// It ran: a cursor's documents, or the reply document.
    #[serde(rename_all = "camelCase")]
    Done {
        documents: DocumentResult,
        /// The reply was a cursor (otherwise one reply document).
        cursor: bool,
        /// The cursor had more documents than the console keeps.
        truncated: bool,
        duration_ms: f64,
    },
    /// Nothing ran: the command is dangerous; send it again with `confirmed` to run it.
    Confirm { danger: DangerReport },
}

/// A mongosh script to run in a document query tab (M4-3).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    /// The database `db` starts on (`use` changes it during the run).
    pub database: String,
    /// The whole editor text: positions of errors refer to it.
    pub text: String,
    /// The part that runs (the selection), in UTF-16 code units of `text`; `null`: all of it.
    pub range: Option<TextRange>,
}

/// What a script's last expression gave.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScriptResult {
    /// Documents: a cursor drained by the backend, an array of documents or one document.
    #[serde(rename_all = "camelCase")]
    Documents {
        documents: DocumentResult,
        /// From a cursor (otherwise the value itself).
        cursor: bool,
        /// One document (a reply, a write result), not a list.
        single: bool,
        /// The cursor had more documents than a result keeps.
        truncated: bool,
    },
    /// Any other value, as mongosh prints it.
    #[serde(rename_all = "camelCase")]
    Text { text: String, truncated: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ScriptMessageKind {
    /// `print`, `printjson`, `console.log`.
    Print,
    /// `console.warn`.
    Warn,
    /// `console.error`.
    Error,
    /// What a shell command answered (`use`, `show`).
    Shell,
}

/// A line of the messages pane.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptMessage {
    pub kind: ScriptMessageKind,
    pub text: String,
    /// Milliseconds since the run started.
    pub at_ms: f64,
}

/// Why a script stopped, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFailure {
    /// `scriptError` (a JavaScript exception), `readOnlyViolation`, `queryFailed`,
    /// `cancelled`, `statementTimeout`, `notSupported`…
    pub error: YadbeError,
    /// Where in the editor text it failed.
    pub position: Option<TextPosition>,
}

/// How a script run ended. A failed script keeps the messages printed before it failed.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutcome {
    pub result: Option<ScriptResult>,
    pub messages: Vec<ScriptMessage>,
    /// Messages past the pane's limit were dropped.
    pub messages_truncated: bool,
    pub failure: Option<ScriptFailure>,
    /// The database `db` is on at the end (after `use`).
    pub database: String,
    pub duration_ms: f64,
}

/// A script reached a dangerous operation and waits for the user's word
/// (`mongo_script_confirm`), with its effect as the server counts it. Nothing was sent.
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct MongoScriptConfirm {
    pub tab_id: String,
    pub request_id: u32,
    pub danger: DangerReport,
}
