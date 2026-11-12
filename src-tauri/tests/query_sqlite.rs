//! Query execution (M1-3) on SQLite: streaming into the result store, windows, limits and
//! load more, scripts, error positions, cancellation, transactions, read-only. Always runs.

mod common;
mod query_common;

use std::sync::Arc;
use std::time::Duration;

use common::blank;
use query_common::{Bench, bench};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::driver::{ConnectRequest, NoRecorder};
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::{Value, ValueKind};
use yadbe_lib::session::query_model::{
    ExecuteScope, ExecutionStatus, PauseReason, ResultLimits, ResultStatus, ResumeMode,
    TextPosition, TransactionMode, TransactionStatus,
};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("app.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create fixture");
    conn.execute_batch(include_str!("fixtures/sqlite_basic.sql"))
        .expect("fixture script");
    (dir, path)
}

fn definition(path: &std::path::Path, read_only: bool) -> ConnectionDefinition {
    let mut def = blank(Engine::Sqlite, "app.sqlite");
    def.file_path = path.display().to_string();
    def.read_only = read_only;
    def
}

async fn sqlite(read_only: bool) -> (tempfile::TempDir, std::path::PathBuf, Bench) {
    let (dir, path) = fixture();
    let bench = bench(definition(&path, read_only), None).await;
    (dir, path, bench)
}

const COUNT_ITEMS: &str = "SELECT count(*) FROM items";

#[tokio::test]
async fn runs_a_script_with_several_results_and_messages() {
    let (_dir, _path, b) = sqlite(false).await;
    let text = "-- setup\nCREATE TABLE t (a INTEGER, b TEXT);\nINSERT INTO t VALUES (1, 'x'), (2, NULL);\nSELECT * FROM t ORDER BY a;\nSELECT name FROM items ORDER BY id;\nUPDATE t SET b = 'y';";
    let run = b.run("tab", text).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.statements.len(), 5);
    assert_eq!(
        &text[run.statements[0].from as usize..run.statements[0].to as usize],
        "CREATE TABLE t (a INTEGER, b TEXT)"
    );
    assert_eq!(run.results.len(), 2);
    assert!(
        run.results
            .iter()
            .all(|r| r.status == ResultStatus::Complete)
    );
    assert_eq!(run.results[0].statement_index, 2);
    assert_eq!(
        run.results[0]
            .columns
            .iter()
            .map(|c| c.kind)
            .collect::<Vec<_>>(),
        [ValueKind::Int, ValueKind::Text]
    );
    assert_eq!(b.column(&run.results[0], 1), [Some("x".into()), None]);
    assert_eq!(
        b.column(&run.results[1], 0),
        [
            Some("first".into()),
            Some("second".into()),
            Some("max".into())
        ]
    );
    assert_eq!(run.affected(), [None, Some(2.0), None, None, Some(2.0)]);

    let history = b.history.entries();
    assert_eq!(history.len(), 5);
    assert_eq!(history[1].sql, "INSERT INTO t VALUES (1, 'x'), (2, NULL)");
    assert_eq!(history[1].rows, Some(2));
    assert_eq!(history[3].rows, Some(3), "rows returned");
    assert!(history.iter().all(|h| h.outcome.is_ok()));
    assert!(
        !b.logged().iter().any(|sql| sql.contains("INSERT")),
        "user statements go to the history, not the statement log"
    );
}

#[tokio::test]
async fn round_trips_types_through_windows() {
    let (_dir, _path, b) = sqlite(false).await;
    let run = b
        .run(
            "tab",
            "SELECT id, name, price, ratio, data, active, created_at, 1 + 1 AS expr FROM items ORDER BY id",
        )
        .await;
    let result = &run.results[0];
    let window = b.window(result.result_id, 0, 500);
    let cells = |c: usize| window.columns[c].values.clone();
    assert_eq!(
        cells(0),
        [
            Some("1".into()),
            Some("2".into()),
            Some("9223372036854775807".into())
        ]
    );
    assert_eq!(cells(4), [Some("00ff".into()), None, Some(String::new())]);
    assert_eq!(cells(3)[2].as_deref(), Some("1e300"));
    // SQLite typing: `price` is NUMERIC but stores REAL and INTEGER values.
    assert_eq!(
        window.columns[2].kinds,
        Some(vec![ValueKind::Float, ValueKind::Decimal, ValueKind::Int])
    );
    assert_eq!(window.columns[7].kinds, Some(vec![ValueKind::Int; 3]));
    assert_eq!(
        b.runner.cell(result.result_id, 0, 4).expect("cell"),
        Value::Bytes("00ff".into())
    );
    assert_eq!(
        b.runner.cell(result.result_id, 2, 0).expect("cell"),
        Value::int(i64::MAX)
    );
    assert_eq!(
        b.runner
            .cell(result.result_id, 9, 0)
            .map_err(|e| e.code)
            .err(),
        Some(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        b.runner
            .window(result.result_id, 0, 5000)
            .map_err(|e| e.code)
            .err(),
        Some(ErrorCode::InvalidArgument)
    );
}

const SERIES: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 250000) SELECT x, 'row ' || x AS label FROM c";

#[tokio::test]
async fn pauses_at_the_row_limit_then_loads_more_and_all() {
    let (_dir, _path, b) = sqlite(false).await;
    let limits = ResultLimits {
        max_rows: 100_000,
        max_bytes: 1 << 30,
    };
    let id = b.run_limited("tab", SERIES, limits).await;
    let run = b
        .wait_for(id, |r| r.status == ExecutionStatus::Paused)
        .await;
    let result = run.results[0].clone();
    assert_eq!(result.status, ResultStatus::Paused);
    assert_eq!(result.paused_by, Some(PauseReason::RowLimit));
    assert_eq!(result.row_count, 100_000);
    // Paused means paused: nothing more arrives.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(b.fold(id).0.results[0].row_count, 100_000);
    let last = b.window(result.result_id, 99_999, 500);
    assert_eq!(last.row_count, 1);
    assert_eq!(last.columns[0].values[0].as_deref(), Some("100000"));

    b.runner
        .resume(result.result_id, ResumeMode::More)
        .expect("more");
    let run = b
        .wait_for(id, |r| {
            r.status == ExecutionStatus::Paused && r.results[0].row_count == 200_000
        })
        .await;
    assert_eq!(run.results[0].status, ResultStatus::Paused);
    b.runner
        .resume(result.result_id, ResumeMode::All)
        .expect("all");
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded);
    assert_eq!(run.results[0].row_count, 250_000);
    assert_eq!(run.results[0].status, ResultStatus::Complete);
    let window = b.window(result.result_id, 249_500, 500);
    assert_eq!(window.columns[1].values[499].as_deref(), Some("row 250000"));
    assert!(
        run.progress_events < 200,
        "throttled: {}",
        run.progress_events
    );
}

#[tokio::test]
async fn the_run_time_leaves_out_the_pause() {
    let (_dir, _path, b) = sqlite(false).await;
    let limits = ResultLimits {
        max_rows: 100_000,
        max_bytes: 1 << 30,
    };
    let id = b.run_limited("tab", SERIES, limits).await;
    let run = b
        .wait_for(id, |r| r.status == ExecutionStatus::Paused)
        .await;
    let at_pause = run.elapsed_ms;
    tokio::time::sleep(Duration::from_millis(600)).await;
    b.runner
        .resume(run.results[0].result_id, ResumeMode::All)
        .expect("all");
    let done = b.wait(id).await;
    assert_eq!(done.status, ExecutionStatus::Succeeded);
    assert!(done.paused_ms >= 600, "{}", done.paused_ms);
    assert!(
        done.elapsed_ms < at_pause + done.paused_ms,
        "run time {} must not include the {} ms pause",
        done.elapsed_ms,
        done.paused_ms
    );
    let completed = done
        .messages
        .iter()
        .find_map(|m| match &m.body {
            yadbe_lib::session::query_model::MessageBody::StatementCompleted(c) => Some(c),
            _ => None,
        })
        .expect("completed message");
    assert!(completed.paused_ms >= 600);
    assert!(
        completed.duration_ms < f64::from(at_pause) + 500.0,
        "{completed:?}"
    );
}

#[tokio::test]
async fn a_memory_limit_pauses_too_and_rerun_frees_results() {
    let (_dir, _path, b) = sqlite(false).await;
    let limits = ResultLimits {
        max_rows: 1_000_000,
        max_bytes: 1024 * 1024,
    };
    let id = b.run_limited("tab", SERIES, limits).await;
    let run = b
        .wait_for(id, |r| r.status == ExecutionStatus::Paused)
        .await;
    let result = run.results[0].clone();
    assert_eq!(result.paused_by, Some(PauseReason::MemoryLimit));
    assert!(result.row_count < 250_000);
    assert!(result.bytes >= 1024 * 1024);

    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert_eq!(run.results[0].status, ResultStatus::Cancelled);
    // The rows read stay readable until the tab runs again.
    assert_eq!(b.window(result.result_id, 0, 1).row_count, 1);
    b.run("tab", "SELECT 1").await;
    assert_eq!(
        b.runner
            .window(result.result_id, 0, 1)
            .map_err(|e| e.code)
            .err(),
        Some(ErrorCode::ResultNotFound)
    );
    b.runner.close_tab("tab").await;
    assert!(b.runner.store().is_empty());
}

#[tokio::test]
async fn reports_errors_with_their_editor_position() {
    let (_dir, _path, b) = sqlite(false).await;
    let text = "SELECT 'ü';\n  SELECT é FROM items;\nSELECT 2";
    let run = b.run("tab", text).await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    assert_eq!(run.results.len(), 1, "the third statement did not run");
    let error = run.errors()[0];
    assert_eq!(error.error.code, ErrorCode::QueryFailed);
    let server = error.server.as_ref().expect("server message");
    assert_eq!(server.message, "no such column: é");
    // SQLite points at the token; offsets count UTF-16 units of the whole text (ü is 2
    // bytes, 1 unit).
    assert_eq!(
        error.position,
        Some(TextPosition {
            offset: 21,
            line: 2,
            column: 10
        })
    );
    let history = b.history.entries();
    assert_eq!(history.len(), 2);
    assert!(history[1].outcome.is_err());

    let syntax = b.run("tab2", "SELECT 1;\nSELEC 2").await;
    let position = syntax.errors()[0].position.expect("position");
    assert_eq!(
        position,
        TextPosition {
            offset: 10,
            line: 2,
            column: 1
        }
    );
}

#[tokio::test]
async fn runs_the_statement_under_the_cursor_or_a_selection() {
    let (_dir, _path, b) = sqlite(false).await;
    let text = "SELECT 1 AS a;\nSELECT 2 AS b;\n\n\n\nSELECT 3 AS c";
    let run = b
        .run_scoped("tab", text, ExecuteScope::StatementAt { offset: 17 })
        .await;
    assert_eq!(run.results.len(), 1);
    assert_eq!(run.results[0].columns[0].name, "b");
    assert_eq!(run.statements[0].from, 15);
    let run = b
        .run_scoped(
            "tab",
            text,
            ExecuteScope::Range {
                from: 15,
                to: text.len() as u32,
            },
        )
        .await;
    assert_eq!(
        run.results
            .iter()
            .map(|r| r.columns[0].name.as_str())
            .collect::<Vec<_>>(),
        ["b", "c"]
    );
    let nothing =
        b.runner
            .execute(b.request("tab", text, ExecuteScope::StatementAt { offset: 31 }));
    assert_eq!(
        nothing.map_err(|e| e.code).err(),
        Some(ErrorCode::InvalidArgument)
    );
}

#[tokio::test]
async fn cancels_a_long_statement_with_interrupt() {
    let (_dir, _path, b) = sqlite(false).await;
    let (id, _) = b
        .start(b.request(
            "tab",
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
            ExecuteScope::All,
        ))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let busy = b.start(b.request("tab", "SELECT 1", ExecuteScope::All));
    assert_eq!(
        busy.map_err(|e| e.code).err(),
        Some(ErrorCode::ExecutionRunning)
    );
    let started = std::time::Instant::now();
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert_eq!(run.error_code(), Some(ErrorCode::Cancelled));
    // The tab runs again afterwards, on the same connection.
    let again = b.run("tab", "SELECT 1").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded);
}

#[tokio::test]
async fn announces_schema_changes() {
    let (_dir, _path, b) = sqlite(false).await;
    b.check_ddl_refresh("tab").await;
}

#[tokio::test]
async fn keeps_the_tab_connection_and_its_transactions() {
    let (_dir, path, b) = sqlite(false).await;
    b.run("tab", "CREATE TEMP TABLE scratch (x)").await;
    let run = b.run("tab", "SELECT * FROM scratch").await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "same connection");
    let other = b.run("other", "SELECT * FROM scratch").await;
    assert_eq!(
        other.status,
        ExecutionStatus::Failed,
        "own connection per tab"
    );

    // Auto-commit with an explicit transaction: SQLite tells the status exactly.
    b.run("tab", "BEGIN; DELETE FROM items WHERE id = 1").await;
    assert_eq!(b.transaction("tab").status, TransactionStatus::Open);
    assert_eq!(
        b.runner
            .set_mode("tab", TransactionMode::Manual)
            .map_err(|e| e.code)
            .err(),
        Some(ErrorCode::TransactionOpen)
    );
    let state = b
        .runner
        .end_transaction("tab", false)
        .await
        .expect("rollback");
    assert_eq!(state.status, TransactionStatus::Idle);
    assert!(b.logged().iter().any(|sql| sql == "ROLLBACK"));

    // Manual mode: yadbe opens the transaction, the data changes only on commit.
    b.runner
        .set_mode("tab", TransactionMode::Manual)
        .expect("manual");
    b.run("tab", "DELETE FROM items WHERE id = 2").await;
    assert_eq!(
        b.transaction("tab"),
        yadbe_lib::session::query_model::TransactionState {
            mode: TransactionMode::Manual,
            status: TransactionStatus::Open
        }
    );
    assert!(b.logged().iter().any(|sql| sql == "BEGIN"));
    let outside = rusqlite::Connection::open(&path).expect("open");
    let count = |c: &rusqlite::Connection| -> i64 {
        c.query_row(COUNT_ITEMS, [], |r| r.get(0)).expect("count")
    };
    assert_eq!(count(&outside), 3, "not committed yet");
    b.runner.end_transaction("tab", true).await.expect("commit");
    assert_eq!(count(&outside), 2);
    assert_eq!(b.transaction("tab").status, TransactionStatus::Idle);

    // Closing the tab rolls back what is pending.
    b.run("tab", "DELETE FROM items").await;
    assert_eq!(b.transaction("tab").status, TransactionStatus::Open);
    b.runner.close_tab("tab").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(count(&outside), 2);
}

#[tokio::test]
async fn read_only_connections_refuse_writes_before_sending() {
    let (_dir, path, b) = sqlite(true).await;
    let run = b
        .run("tab", "SELECT count(*) FROM items;\nDELETE FROM items")
        .await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    assert!(run.results.is_empty(), "nothing ran, not even the SELECT");
    let error = run.errors()[0];
    assert_eq!(error.error.code, ErrorCode::ReadOnlyViolation);
    assert!(error.error.message.en.contains("DELETE"));
    assert_eq!(error.position.map(|p| p.line), Some(2));
    assert_eq!(b.history.entries().len(), 1);

    for sql in ["PRAGMA query_only = 0", "ATTACH 'other.db' AS o", "VACUUM"] {
        let run = b.run("tab", sql).await;
        assert_eq!(
            run.error_code(),
            Some(ErrorCode::ReadOnlyViolation),
            "{sql}"
        );
    }
    let reads = b
        .run(
            "tab",
            "SELECT count(*) FROM items; PRAGMA table_info(items)",
        )
        .await;
    assert_eq!(reads.status, ExecutionStatus::Succeeded);
    assert!(b.logged().iter().any(|sql| sql == "PRAGMA query_only = ON"));

    // The engine guard holds without the classifier.
    let target = definition(&path, true).target();
    let conn = common::driver(Engine::Sqlite)
        .connect(ConnectRequest {
            target: &target,
            password: None,
            recorder: Arc::new(NoRecorder),
        })
        .await
        .expect("connect")
        .into_sql()
        .expect("a SQL connection");
    let error = conn
        .query("DELETE FROM items", 0)
        .await
        .expect_err("read-only database");
    assert!(
        error
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("readonly"),
        "{error:?}"
    );
    let (sender, _events) = tokio::sync::mpsc::channel(4);
    let error = conn
        .execute("INSERT INTO items (id, name) VALUES (5, 'x')", sender)
        .await
        .expect_err("refused");
    assert_eq!(error.error.code, ErrorCode::ReadOnlyViolation);
    let outside = rusqlite::Connection::open(&path).expect("open");
    let count: i64 = outside
        .query_row(COUNT_ITEMS, [], |r| r.get(0))
        .expect("count");
    assert_eq!(count, 3);
}

#[tokio::test]
async fn closing_the_session_closes_the_tab_connections() {
    let (_dir, _path, b) = sqlite(false).await;
    b.run("tab", "BEGIN").await;
    assert_eq!(b.transaction("tab").status, TransactionStatus::Open);
    assert!(b.runner.tab_info("tab").connection_id.is_some());
    b.manager.disconnect(&b.connection_id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let info = b.runner.tab_info("tab");
    assert_eq!(info.transaction.status, TransactionStatus::Idle);
    assert_eq!(info.connection_id, None);
    let refused = b.start(b.request("tab", "SELECT 1", ExecuteScope::All));
    assert_eq!(
        refused.map_err(|e| e.code).err(),
        Some(ErrorCode::NotConnected)
    );
}

#[tokio::test]
async fn read_only_switched_under_an_open_session() {
    for start in [false, true] {
        let (_dir, _path, b) = sqlite(start).await;
        b.check_read_only_switch("INSERT INTO items (name) VALUES ('m316')", COUNT_ITEMS)
            .await;
        assert!(
            b.logged()
                .iter()
                .any(|sql| sql == "PRAGMA query_only = OFF")
        );
    }
}
