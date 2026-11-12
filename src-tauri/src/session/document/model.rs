//! IPC types of the document family's collection tab and console (`mongo_*` commands).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::meta::CollectionKind;
use crate::db::document::ops::DocTopology;
use crate::session::document::gate::DangerReport;
use crate::session::query_model::ResultSummary;

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
