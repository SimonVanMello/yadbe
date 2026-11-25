//! Exports of MongoDB documents against real MongoDB servers: the JSON Lines export of a
//! collection page (M4-9), whose documents are written whole and read back equal to what the
//! server returned; and the export of a whole collection under a tab's query (M4-11), read by
//! pages. A test whose server is not configured prints SKIPPED.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::mongo::{EVERY_TYPE, Mongo, json, servers};
use tokio_util::sync::CancellationToken;
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::errors::YadbeError;
use yadbe_lib::db::value::{ColumnMeta, Value};
use yadbe_lib::export::encode::encoder;
use yadbe_lib::export::model::{
    CsvOptions, DocumentLines, ExportFormat, ExtendedJsonMode, JsonLinesOptions,
};
use yadbe_lib::export::run::run_export;
use yadbe_lib::export::source::ExportSource;
use yadbe_lib::session::document::export::CollectionExport;
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

/// A whole collection exported to `format` (M4-11), through the service's export rows: the
/// lines of the file.
async fn export_collection(
    mongo: &Mongo,
    export: CollectionExport,
    format: &ExportFormat,
) -> Vec<String> {
    let mut source = mongo
        .service
        .export_rows(export)
        .await
        .expect("export rows");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("out.txt");
    let outcome = run_export(
        &mut source,
        encoder(format).expect("encoder"),
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
    let header = usize::from(matches!(format, ExportFormat::Csv { .. }));
    assert_eq!(outcome.rows as usize + header, lines.len());
    lines
}

fn csv() -> ExportFormat {
    ExportFormat::Csv {
        options: CsvOptions::default(),
    }
}

fn finds(mongo: &Mongo, collection: &str) -> usize {
    let needle = format!("\"{collection}\").find(");
    mongo
        .log
        .entries()
        .iter()
        .filter(|entry| entry.sql.contains(&needle))
        .count()
}

#[tokio::test]
async fn a_whole_collection_is_exported_by_pages() {
    for (label, url) in servers("a_whole_collection_is_exported_by_pages") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let docs: Vec<Json> = (0..2_345)
            .map(|i| {
                let late = if i == 2_000 { r#", "late": true"# } else { "" };
                json(&format!(
                    r#"{{"_id": {i}, "n": {i}, "tag": "t{}"{late}}}"#,
                    i % 3
                ))
            })
            .collect();
        mongo.insert("whole", docs).await;
        let base = CollectionExport {
            connection_id: mongo.id.clone(),
            ns: mongo.ns("whole"),
            filter: String::new(),
            projection: String::new(),
            sort: String::new(),
            documents: false,
        };

        // Pages after the last `_id`: every document once, in `_id` order.
        let before = finds(&mongo, "whole");
        let lines = export_collection(&mongo, base.clone(), &csv()).await;
        assert_eq!(
            lines[0], "_id,n,tag",
            "{label}: the columns of the first page"
        );
        assert_eq!(lines.len(), 2_346, "{label}");
        assert_eq!(lines[1], "0,0,t0", "{label}");
        assert_eq!(lines[2_345], "2344,2344,t1", "{label}");
        assert!(
            finds(&mongo, "whole") - before >= 3,
            "{label}: each page a find in the statement log"
        );

        // Another sort skips, `_id` breaking ties; the filter and projection apply.
        let lines = export_collection(
            &mongo,
            CollectionExport {
                filter: r#"{"tag": "t1"}"#.into(),
                projection: r#"{"n": 1, "_id": 0}"#.into(),
                sort: r#"{"n": -1}"#.into(),
                ..base.clone()
            },
            &csv(),
        )
        .await;
        assert_eq!(lines[0], "n", "{label}");
        let numbers: Vec<i64> = lines[1..]
            .iter()
            .map(|n| n.parse().expect("a number"))
            .collect();
        let expected: Vec<i64> = (0..2_345).rev().filter(|i| i % 3 == 1).collect();
        assert_eq!(
            numbers, expected,
            "{label}: descending, filtered, no repeat"
        );

        // Whole documents: every field, whatever the first page had.
        let lines = export_collection(
            &mongo,
            CollectionExport {
                documents: true,
                ..base.clone()
            },
            &ExportFormat::JsonLines {
                options: JsonLinesOptions {
                    documents: Some(DocumentLines::Mongo {
                        extended_json: ExtendedJsonMode::Relaxed,
                    }),
                    ..JsonLinesOptions::default()
                },
            },
        )
        .await;
        assert_eq!(lines.len(), 2_345, "{label}");
        assert_eq!(
            Json::parse(&lines[2_000]).expect("a line"),
            json(r#"{"_id": 2000, "n": 2000, "tag": "t2", "late": true}"#),
            "{label}"
        );

        // A preview reads what the file starts with.
        let (columns, rows) = mongo
            .service
            .export_preview(base.clone(), 3)
            .await
            .expect("preview");
        assert_eq!(columns.len(), 3, "{label}");
        assert_eq!(rows.len(), 3, "{label}");

        // Cancelled: no file, the error is a cancel.
        let mut source = mongo.service.export_rows(base.clone()).await.expect("rows");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cancelled.csv");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = run_export(
            &mut source,
            encoder(&csv()).expect("encoder"),
            &path,
            2,
            &cancel,
            Duration::from_secs(1),
            |_, _| {},
        )
        .await
        .expect_err("cancelled");
        assert_eq!(err.code, ErrorCode::Cancelled, "{label}");
        assert!(!path.exists(), "{label}: no file");

        // A bad filter fails the start, not the file.
        let err = mongo
            .service
            .export_rows(CollectionExport {
                filter: "{ nope".into(),
                ..base
            })
            .await
            .err()
            .expect("refused");
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{label}");
    }
}

#[tokio::test]
async fn a_read_only_connection_exports_a_collection() {
    for (label, url) in servers("a_read_only_connection_exports_a_collection") {
        // The helper's insert goes around the gate: the connection itself is read-only.
        let reader = Mongo::open(&url, |def| def.read_only = true).await;
        reader
            .insert(
                "ro",
                (0..10)
                    .map(|i| json(&format!(r#"{{"_id": {i}}}"#)))
                    .collect(),
            )
            .await;
        let lines = export_collection(
            &reader,
            CollectionExport {
                connection_id: reader.id.clone(),
                ns: reader.ns("ro"),
                filter: String::new(),
                projection: String::new(),
                sort: String::new(),
                documents: false,
            },
            &csv(),
        )
        .await;
        assert_eq!(
            lines.len(),
            11,
            "{label}: the reads of an export are allowed"
        );
    }
}
