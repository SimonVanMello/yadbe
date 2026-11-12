//! JSON Lines export of MongoDB results (M4-9), against real MongoDB servers: the documents a
//! collection page stored are written whole, and read back they equal what the server returned.
//! A test whose server is not configured prints SKIPPED.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::mongo::{EVERY_TYPE, Mongo, json, servers};
use tokio_util::sync::CancellationToken;
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::errors::YadbeError;
use yadbe_lib::db::value::{ColumnMeta, Value};
use yadbe_lib::export::encode::encoder;
use yadbe_lib::export::model::{DocumentLines, ExportFormat, ExtendedJsonMode, JsonLinesOptions};
use yadbe_lib::export::run::run_export;
use yadbe_lib::export::source::ExportSource;
use yadbe_lib::session::document::model::CollectionQuery;
use yadbe_lib::session::result_store::StoredResult;

/// What the export reads in the app: the rows of the documents result, in the store.
struct StoredRows {
    stored: Arc<StoredResult>,
    columns: Vec<ColumnMeta>,
    next: usize,
}

impl ExportSource for StoredRows {
    fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        let rows = self.stored.kept_rows(self.next, 500);
        if rows.is_empty() {
            return Ok(None);
        }
        self.next += rows.len();
        Ok(Some(rows))
    }
}

async fn export(mongo: &Mongo, documents_id: u32, mode: ExtendedJsonMode) -> Vec<String> {
    let stored = mongo.store.get(documents_id).expect("documents result");
    let mut source = StoredRows {
        columns: stored.columns().to_vec(),
        stored,
        next: 0,
    };
    let format = ExportFormat::JsonLines {
        options: JsonLinesOptions {
            documents: Some(DocumentLines::Mongo {
                extended_json: mode,
            }),
            ..JsonLinesOptions::default()
        },
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("out.jsonl");
    let outcome = run_export(
        &mut source,
        encoder(&format).expect("encoder"),
        &path,
        1,
        &CancellationToken::new(),
        Duration::from_secs(1),
        |_, _| {},
    )
    .await
    .expect("exports");
    let text = std::fs::read_to_string(&path).expect("file");
    let lines: Vec<String> = text.lines().map(str::to_owned).collect();
    assert_eq!(outcome.rows as usize, lines.len());
    lines
}

#[tokio::test]
async fn documents_round_trip_through_a_jsonl_file() {
    for (label, url) in servers("documents_round_trip_through_a_jsonl_file") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let mut docs = vec![json(EVERY_TYPE)];
        docs.extend((0..120).map(|i| {
            json(&format!(
                r#"{{"_id": {i}, "nested": {{"list": [{i}, "x\ny"], "when": {{"$date": {{"$numberLong": "1700000000123"}}}}}}, "text": "é☃ \"quoted\""}}"#
            ))
        }));
        mongo.insert("lines", docs).await;
        let page = mongo
            .service
            .page(
                "tab",
                &mongo.id,
                mongo.ns("lines"),
                CollectionQuery {
                    filter: String::new(),
                    projection: String::new(),
                    sort: String::new(),
                    page_size: 500,
                },
                0,
            )
            .await
            .expect("page");
        let id = page.documents.documents_id;
        let shown = mongo.service.documents(id, 0, 500).expect("documents");
        assert_eq!(shown.len(), 121, "{label}");

        let canonical = export(&mongo, id, ExtendedJsonMode::Canonical).await;
        assert_eq!(canonical.len(), shown.len(), "{label}");
        for (line, original) in canonical.iter().zip(&shown) {
            assert!(!line.contains('\n'), "{label}: one document per line");
            assert_eq!(
                Json::parse(line).expect("a JSON line"),
                Json::parse(original).expect("the document"),
                "{label}: canonical lines are the documents"
            );
        }

        let relaxed = export(&mongo, id, ExtendedJsonMode::Relaxed).await;
        assert_eq!(relaxed.len(), shown.len(), "{label}");
        for (line, original) in relaxed.iter().zip(&shown) {
            assert_eq!(
                Json::parse(line).expect("a JSON line"),
                Json::parse(original).expect("the document").to_relaxed(),
                "{label}: relaxed lines are the relaxed documents"
            );
        }
        assert!(
            relaxed.iter().all(|line| !line.contains("$numberInt")),
            "{label}: plain numbers"
        );
    }
}
