//! Exports (M2-7) through the real `QueryRunner` on SQLite (always), PostgreSQL
//! (`YADBE_TEST_PG_URL`) and MySQL (`YADBE_TEST_MYSQL_URL`): results streamed to disk past their in-memory limit, with the
//! stored result left untouched, cancellation, and the stream of a result that still runs.

mod common;
mod query_common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{blank, pg_definition, pg_url};
use query_common::{Bench, bench};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::events::{BackendEvent, EventSink};
use yadbe_lib::export::ExportManager;
use yadbe_lib::export::model::{
    CsvOptions, ExportFinished, ExportFormat, ExportRequest, ExportScope, ExportSourceSpec,
    ExportStatus, JsonLayout, JsonOptions,
};
use yadbe_lib::session::query_model::{ExecutionStatus, ResultLimits, ResultStatus};
use yadbe_lib::session::table_data::TableDataService;

const MILLION_SQLITE: &str = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1000000) SELECT n, 'row ' || n AS label FROM c";
const MILLION_PG: &str = "SELECT g AS n, 'row ' || g AS label FROM generate_series(1, 1000000) g";
const SMALL_SQLITE: &str =
    "SELECT 1 AS id, 'a,b' AS name UNION ALL SELECT 2, NULL UNION ALL SELECT 3, ''";

async fn sqlite_bench() -> (tempfile::TempDir, Bench) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("app.sqlite");
    rusqlite::Connection::open(&path).expect("create");
    let mut def = blank(Engine::Sqlite, "app.sqlite");
    def.file_path = path.display().to_string();
    (dir, bench(def, None).await)
}

fn manager(b: &Bench) -> Arc<ExportManager> {
    let sink = Arc::clone(&b.sink) as Arc<dyn EventSink>;
    let tables = Arc::new(TableDataService::new(
        Arc::clone(&b.manager),
        b.runner.shared_store(),
        Arc::clone(&sink),
    ));
    Arc::new(ExportManager::new(Arc::clone(&b.runner), tables, sink))
}

fn csv() -> ExportFormat {
    ExportFormat::Csv {
        options: CsvOptions::default(),
    }
}

fn request(result_id: u32, scope: ExportScope, format: ExportFormat, path: &Path) -> ExportRequest {
    ExportRequest {
        source: ExportSourceSpec::Result { result_id, scope },
        format,
        path: path.display().to_string(),
    }
}

async fn finished(b: &Bench, export_id: u32) -> ExportFinished {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        for event in b.sink.events() {
            if let BackendEvent::ExportFinished(done) = event
                && done.export_id == export_id
            {
                return done;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "export not finished"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// `n,row n` for 1..=1_000_000, in order, after the header.
fn assert_million(path: &Path) {
    let text = std::fs::read_to_string(path).expect("read export");
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("n,label"));
    let mut count = 0_u32;
    for line in lines {
        count += 1;
        assert_eq!(line, format!("{count},row {count}"));
    }
    assert_eq!(count, 1_000_000);
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .expect("read dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect()
}

async fn exports_a_small_result_as_csv_and_json(b: &Bench, sql: &str) {
    let out = tempfile::tempdir().expect("tempdir");
    let exports = manager(b);
    let run = b.run("small", sql).await;
    let id = run.results[0].result_id;
    let path = out.path().join("small.csv");
    let started = exports
        .start(request(id, ExportScope::All, csv(), &path))
        .await
        .expect("start");
    let done = finished(b, started.export_id).await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    assert_eq!(done.rows, 3);
    assert!(!done.truncated);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read"),
        "id,name\n1,\"a,b\"\n2,\n3,\"\"\n"
    );

    let path = out.path().join("small.ndjson");
    let format = ExportFormat::Json {
        options: JsonOptions {
            layout: JsonLayout::Ndjson,
            ..JsonOptions::default()
        },
    };
    let started = exports
        .start(request(id, ExportScope::All, format.clone(), &path))
        .await
        .expect("start");
    assert_eq!(
        finished(b, started.export_id).await.status,
        ExportStatus::Done
    );
    assert_eq!(
        std::fs::read_to_string(&path).expect("read"),
        "{\"id\":1,\"name\":\"a,b\"}\n{\"id\":2,\"name\":null}\n{\"id\":3,\"name\":\"\"}\n"
    );

    // A selection: rows 1..=2, the second column only.
    let path = out.path().join("selection.csv");
    let scope = ExportScope::Range {
        row_from: 1,
        row_to: 5,
        columns: vec![1],
    };
    let started = exports
        .start(request(id, scope, csv(), &path))
        .await
        .expect("start");
    assert_eq!(finished(b, started.export_id).await.rows, 2);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read"),
        "name\n\n\"\"\n"
    );
    let preview = exports
        .preview(
            &ExportSourceSpec::Result {
                result_id: id,
                scope: ExportScope::All,
            },
            &csv(),
            2,
        )
        .await
        .expect("preview");
    assert_eq!(preview, "id,name\n1,\"a,b\"\n2,\n");
    let outside = ExportScope::Range {
        row_from: 0,
        row_to: 0,
        columns: vec![9],
    };
    let error = exports
        .start(request(id, outside, csv(), &path))
        .await
        .expect_err("outside");
    assert_eq!(error.code, ErrorCode::InvalidArgument);
}

/// A result paused at 1 000 rows is exported to the end; the stored result does not grow.
async fn exports_a_paused_result_without_growing_it(b: &Bench, sql: &str) {
    let out = tempfile::tempdir().expect("tempdir");
    let exports = manager(b);
    let limits = ResultLimits {
        max_rows: 1_000,
        max_bytes: 256 * 1024 * 1024,
    };
    let execution = b.run_limited("paused", sql, limits).await;
    let run = b
        .wait_for(execution, |run| {
            run.results
                .first()
                .is_some_and(|r| r.status == ResultStatus::Paused)
        })
        .await;
    let id = run.results[0].result_id;
    let stored = b.runner.store().get(id).expect("stored");
    let (rows_before, bytes_before) = (stored.row_count(), stored.bytes());
    assert_eq!(rows_before, 1_000);

    let path = out.path().join("million.csv");
    let started = exports
        .start(request(id, ExportScope::All, csv(), &path))
        .await
        .expect("start");
    let done = finished(b, started.export_id).await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    assert_eq!(done.rows, 1_000_000);
    assert_million(&path);
    assert!(leftovers(out.path()).is_empty());

    assert_eq!(stored.row_count(), rows_before, "the store did not grow");
    assert_eq!(stored.bytes(), bytes_before);
    let run = b.wait(execution).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.results[0].status, ResultStatus::Complete);
    assert_eq!(run.results[0].row_count, 1_000);
    assert!(
        run.results[0].truncated,
        "the summary says rows went to the export only"
    );
    // The result is now marked as stopped at its limit, and says so to a later export.
    let again = out.path().join("again.csv");
    let started = exports
        .start(request(id, ExportScope::All, csv(), &again))
        .await
        .expect("start");
    let done = finished(b, started.export_id).await;
    assert_eq!(done.rows, 1_000);
    assert!(done.truncated);
}

/// An export started while the statement still streams gets every row, in order.
async fn exports_a_result_that_is_still_streaming(b: &Bench, sql: &str) {
    let out = tempfile::tempdir().expect("tempdir");
    let exports = manager(b);
    let limits = ResultLimits {
        max_rows: 50_000,
        max_bytes: 256 * 1024 * 1024,
    };
    let execution = b.run_limited("streaming", sql, limits).await;
    let run = b.wait_for(execution, |run| !run.results.is_empty()).await;
    let id = run.results[0].result_id;
    let path = out.path().join("million.csv");
    let started = exports
        .start(request(id, ExportScope::All, csv(), &path))
        .await
        .expect("start");
    let done = finished(b, started.export_id).await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    assert_million(&path);
    let stored = b.runner.store().get(id).expect("stored");
    assert!(stored.row_count() <= 50_000, "{}", stored.row_count());
    assert_eq!(b.wait(execution).await.status, ExecutionStatus::Succeeded);
}

/// Cancelling an export leaves no file (and keeps the one that was there), and stops the
/// statement it was draining.
async fn cancelling_removes_the_partial_file(b: &Bench, sql: &str) {
    let out = tempfile::tempdir().expect("tempdir");
    let exports = manager(b);
    let limits = ResultLimits {
        max_rows: 1_000,
        max_bytes: 256 * 1024 * 1024,
    };
    let execution = b.run_limited("cancel", sql, limits).await;
    let run = b
        .wait_for(execution, |run| {
            run.results
                .first()
                .is_some_and(|r| r.status == ResultStatus::Paused)
        })
        .await;
    let id = run.results[0].result_id;
    let path = out.path().join("million.csv");
    std::fs::write(&path, "old").expect("seed");
    let started = exports
        .start(request(id, ExportScope::All, csv(), &path))
        .await
        .expect("start");
    tokio::time::sleep(Duration::from_millis(50)).await;
    exports.cancel(started.export_id);
    let done = finished(b, started.export_id).await;
    assert!(
        matches!(done.status, ExportStatus::Cancelled | ExportStatus::Done),
        "{done:?}"
    );
    if done.status == ExportStatus::Cancelled {
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "old");
        assert!(leftovers(out.path()).is_empty());
        let run = b.wait(execution).await;
        assert_eq!(run.status, ExecutionStatus::Cancelled, "{run:?}");
    }
}

#[tokio::test]
async fn sqlite_exports_small_results_and_selections() {
    let (_dir, b) = sqlite_bench().await;
    exports_a_small_result_as_csv_and_json(&b, SMALL_SQLITE).await;
}

#[tokio::test]
async fn sqlite_exports_a_paused_million_rows_without_growing_the_result() {
    let (_dir, b) = sqlite_bench().await;
    exports_a_paused_result_without_growing_it(&b, MILLION_SQLITE).await;
}

#[tokio::test]
async fn sqlite_exports_a_streaming_result() {
    let (_dir, b) = sqlite_bench().await;
    exports_a_result_that_is_still_streaming(&b, MILLION_SQLITE).await;
}

#[tokio::test]
async fn sqlite_cancelling_an_export_removes_the_partial_file() {
    let (_dir, b) = sqlite_bench().await;
    cancelling_removes_the_partial_file(&b, MILLION_SQLITE).await;
}

#[tokio::test]
async fn a_freed_result_cannot_be_exported() {
    let (_dir, b) = sqlite_bench().await;
    let exports = manager(&b);
    let out = tempfile::tempdir().expect("tempdir");
    let error = exports
        .start(request(
            999,
            ExportScope::All,
            csv(),
            &out.path().join("x.csv"),
        ))
        .await
        .expect_err("unknown result");
    assert_eq!(error.code, ErrorCode::ResultNotFound);
}

async fn pg(test: &str) -> Option<Bench> {
    let url = pg_url(test)?;
    let (def, password) = pg_definition(&url);
    Some(bench(def, password).await)
}

#[tokio::test]
async fn postgres_exports_small_results_and_selections() {
    let Some(b) = pg("export_small").await else {
        return;
    };
    exports_a_small_result_as_csv_and_json(
        &b,
        "SELECT 1 AS id, 'a,b' AS name UNION ALL SELECT 2, NULL UNION ALL SELECT 3, ''",
    )
    .await;
}

#[tokio::test]
async fn postgres_exports_a_paused_million_rows_without_growing_the_result() {
    let Some(b) = pg("export_paused").await else {
        return;
    };
    exports_a_paused_result_without_growing_it(&b, MILLION_PG).await;
}

#[tokio::test]
async fn postgres_exports_a_streaming_result() {
    let Some(b) = pg("export_streaming").await else {
        return;
    };
    exports_a_result_that_is_still_streaming(&b, MILLION_PG).await;
}

#[tokio::test]
async fn postgres_cancelling_an_export_removes_the_partial_file() {
    let Some(b) = pg("export_cancel").await else {
        return;
    };
    cancelling_removes_the_partial_file(&b, MILLION_PG).await;
}

/// 1 to 1 000 000 in order, without a table or a recursion limit (MySQL and MariaDB).
fn million_mysql() -> String {
    let digits = "(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 \
UNION ALL SELECT 9)";
    let from: Vec<String> = (0..6).map(|p| format!("{digits} p{p}")).collect();
    let n = "p0.d + 10 * p1.d + 100 * p2.d + 1000 * p3.d + 10000 * p4.d + 100000 * p5.d + 1";
    format!(
        "SELECT {n} AS n, CONCAT('row ', {n}) AS label FROM {} ORDER BY n",
        from.join(" CROSS JOIN ")
    )
}

async fn mysql(test: &str) -> Option<Bench> {
    let url = common::mysql_url(test)?;
    let (def, password) = common::from_url(&url);
    Some(bench(def, password).await)
}

#[tokio::test]
async fn mysql_exports_small_results_and_selections() {
    let Some(b) = mysql("export_small").await else {
        return;
    };
    exports_a_small_result_as_csv_and_json(
        &b,
        "SELECT 1 AS id, 'a,b' AS name UNION ALL SELECT 2, NULL UNION ALL SELECT 3, ''",
    )
    .await;
}

#[tokio::test]
async fn mysql_exports_a_paused_million_rows_without_growing_the_result() {
    let Some(b) = mysql("export_paused").await else {
        return;
    };
    exports_a_paused_result_without_growing_it(&b, &million_mysql()).await;
}

#[tokio::test]
async fn mysql_exports_a_streaming_result() {
    let Some(b) = mysql("export_streaming").await else {
        return;
    };
    exports_a_result_that_is_still_streaming(&b, &million_mysql()).await;
}

#[tokio::test]
async fn mysql_cancelling_an_export_removes_the_partial_file() {
    let Some(b) = mysql("export_cancel").await else {
        return;
    };
    cancelling_removes_the_partial_file(&b, &million_mysql()).await;
}
