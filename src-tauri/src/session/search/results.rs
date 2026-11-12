//! Search answers into the result store (rule 8): hits as a grid result plus the whole hits
//! (plain JSON, one per row, read with `search_fetch_documents`), ES|QL / SQL tables as a grid
//! result, any other JSON answer as one document.

use std::collections::HashMap;

use crate::db::document::json::Json;
use crate::db::search::hits::{hit_rows, table_rows};
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::document::model::DocumentResult;
use crate::session::query_model::{ResultStatus, ResultSummary};
use crate::session::result_store::{ResultStore, StoredResult};

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn summary(result: &StoredResult, extra_bytes: usize) -> ResultSummary {
    ResultSummary {
        result_id: result.id(),
        statement_index: 0,
        columns: result.columns().to_vec(),
        row_count: to_u32(result.row_count()),
        status: ResultStatus::Complete,
        paused_by: None,
        bytes: to_u32(result.bytes().saturating_add(extra_bytes)),
        truncated: false,
    }
}

fn documents_result(store: &ResultStore, documents: &[Json]) -> std::sync::Arc<StoredResult> {
    let whole = store.create(vec![ColumnMeta {
        name: "document".to_owned(),
        type_name: "object".to_owned(),
        kind: ValueKind::Json,
    }]);
    for chunk in documents.chunks(500) {
        whole.append(
            chunk
                .iter()
                .map(|document| vec![Value::Json(document.to_text())])
                .collect(),
        );
    }
    whole
}

/// Stores `hits` as a grid result and a documents result; `types`: mapping types by path.
pub fn store_hits(
    store: &ResultStore,
    hits: &[Json],
    types: &HashMap<String, String>,
) -> DocumentResult {
    let (columns, rows) = hit_rows(hits, types);
    let grid = store.create(columns);
    let mut rows = rows.into_iter().peekable();
    while rows.peek().is_some() {
        grid.append(rows.by_ref().take(500).collect());
    }
    let whole = documents_result(store, hits);
    DocumentResult {
        result: summary(&grid, whole.bytes()),
        documents_id: whole.id(),
        count: to_u32(hits.len()),
    }
}

/// Stores one JSON answer as a one-document result; its id.
pub fn store_document(store: &ResultStore, document: &Json) -> u32 {
    documents_result(store, std::slice::from_ref(document)).id()
}

/// Stores the table of an ES|QL / SQL answer, when it is one.
pub fn store_table(store: &ResultStore, response: &Json) -> Option<ResultSummary> {
    let (columns, rows) = table_rows(response)?;
    let grid = store.create(columns);
    let mut rows = rows.into_iter().peekable();
    while rows.peek().is_some() {
        grid.append(rows.by_ref().take(500).collect());
    }
    Some(summary(&grid, 0))
}

/// The results a stored answer holds, to free them together.
pub fn ids_of(documents: &DocumentResult) -> [u32; 2] {
    [documents.result.result_id, documents.documents_id]
}
