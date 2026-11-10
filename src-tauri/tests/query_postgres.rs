//! Query execution (M1-3) on PostgreSQL (`YADBE_TEST_PG_URL`): streaming with server-side
//! backpressure, scripts with notices, error positions, native cancellation, tab sessions,
//! transaction modes, read-only enforcement at both layers, and the P-03 measurement
//! (`cargo test --release --test query_postgres p03 -- --ignored --nocapture`).

mod common;
mod query_common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{pg_definition, pg_url};
use query_common::{Bench, bench};
use yadbe_lib::db::driver::{ConnectRequest, ExecEvent, NoRecorder};
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::Value;
use yadbe_lib::events::BackendEvent;
use yadbe_lib::session::query_model::{
    ExecuteScope, ExecutionStatus, PauseReason, ResultLimits, ResultStatus, ResumeMode,
    TextPosition, TransactionMode, TransactionStatus,
};

async fn pg(test: &str, read_only: bool) -> Option<Bench> {
    let url = pg_url(test)?;
    let (mut def, password) = pg_definition(&url);
    def.read_only = read_only;
    Some(bench(def, password).await)
}

#[tokio::test]
async fn runs_scripts_with_types_notices_and_row_counts() {
    let Some(b) = pg("runs_scripts_with_types_notices_and_row_counts", false).await else {
        return;
    };
    let text = r#"DO $$ BEGIN RAISE NOTICE 'hello %; still', 42; RAISE WARNING 'careful'; END $$;
CREATE TEMP TABLE t (id int8, n numeric, ts timestamptz, j jsonb, a int[], b bytea, u uuid, d date);
INSERT INTO t VALUES
  (9223372036854775807, 12345678901234567890.123456789, '2025-02-28 12:34:56.789+00', '{"x": 1.10}', '{1,NULL,3}', '\x00ff', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '0001-12-31 BC'),
  (NULL, 'NaN', 'infinity', 'null', '{}', '\x', NULL, 'infinity');
SELECT * FROM t ORDER BY id NULLS LAST;
UPDATE t SET n = 1;
SELECT 1 WHERE false"#;
    let run = b.run("tab", text).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.statements.len(), 6);
    assert_eq!(run.notices(), ["hello 42; still", "careful"]);
    assert_eq!(
        run.affected(),
        [None, None, Some(2.0), None, Some(2.0), None]
    );
    assert_eq!(run.results.len(), 2);
    let empty = &run.results[1];
    assert_eq!(
        (empty.row_count, empty.columns.len()),
        (0, 1),
        "columns of no row"
    );

    let rows = &run.results[0];
    let window = b.window(rows.result_id, 0, 500);
    let cell = |c: usize, r: usize| window.columns[c].values[r].clone();
    assert_eq!(cell(0, 0).as_deref(), Some("9223372036854775807"));
    assert_eq!(cell(0, 1), None);
    assert_eq!(
        cell(1, 0).as_deref(),
        Some("12345678901234567890.123456789")
    );
    assert_eq!(cell(1, 1).as_deref(), Some("NaN"));
    assert!(
        cell(2, 0)
            .is_some_and(|ts| ts.starts_with("2025-02-28 12:34:56.789") && ts.ends_with("+00")),
        "{:?}",
        cell(2, 0)
    );
    assert_eq!(cell(2, 1).as_deref(), Some("infinity"));
    assert_eq!(cell(3, 0).as_deref(), Some(r#"{"x": 1.10}"#));
    assert_eq!(
        cell(4, 0).as_deref(),
        Some(r#"[{"kind":"int","value":"1"},{"kind":"null"},{"kind":"int","value":"3"}]"#)
    );
    assert_eq!(cell(4, 1).as_deref(), Some("[]"));
    assert_eq!(cell(5, 0).as_deref(), Some("00ff"));
    assert_eq!(cell(5, 1).as_deref(), Some(""));
    assert_eq!(
        cell(6, 0).as_deref(),
        Some("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")
    );
    assert_eq!(cell(7, 0).as_deref(), Some("0001-12-31 BC"));
    assert!(
        window.columns.iter().all(|c| c.kinds.is_none()),
        "typed columns"
    );
    assert_eq!(
        b.runner.cell(rows.result_id, 0, 4).expect("cell"),
        Value::Array(vec![Value::int(1), Value::Null, Value::int(3)])
    );
    let history = b.history.entries();
    assert_eq!(history.len(), 6);
    assert_eq!(history[2].rows, Some(2));
}

#[tokio::test]
async fn maps_error_positions_and_tracks_failed_transactions() {
    let Some(b) = pg("maps_error_positions_and_tracks_failed_transactions", false).await else {
        return;
    };
    let run = b
        .run("tab", "SELECT 1;\nSELECT é, x FROM nowhere_m13;\nSELECT 2")
        .await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    let error = run.errors()[0];
    let server = error.server.as_ref().expect("server");
    assert_eq!(server.code.as_deref(), Some("42P01"));
    assert_eq!(server.severity, "ERROR");
    assert_eq!(
        error.position,
        Some(TextPosition {
            offset: 27,
            line: 2,
            column: 18
        })
    );
    assert_eq!(run.results.len(), 1);

    b.run("tab", "BEGIN; SELECT 1 / 0").await;
    assert_eq!(b.transaction("tab").status, TransactionStatus::Failed);
    let ignored = b.run("tab", "SELECT 1").await;
    assert_eq!(
        ignored.errors()[0]
            .server
            .as_ref()
            .and_then(|s| s.code.as_deref()),
        Some("25P02")
    );
    assert_eq!(b.transaction("tab").status, TransactionStatus::Failed);
    let state = b.runner.end_transaction("tab", true).await.expect("commit");
    assert_eq!(
        state.status,
        TransactionStatus::Idle,
        "COMMIT of a failed transaction rolls back"
    );
    assert_eq!(
        b.run("tab", "SELECT 1").await.status,
        ExecutionStatus::Succeeded
    );
}

#[tokio::test]
async fn pauses_with_server_backpressure_then_resumes() {
    let Some(b) = pg("pauses_with_server_backpressure_then_resumes", false).await else {
        return;
    };
    let sql = "SELECT /* m13-backpressure */ g, md5(g::text) FROM generate_series(1, 300000) g";
    let id = b
        .run_limited(
            "tab",
            sql,
            ResultLimits {
                max_rows: 100_000,
                max_bytes: 1 << 30,
            },
        )
        .await;
    let run = b
        .wait_for(id, |r| r.status == ExecutionStatus::Paused)
        .await;
    let result = run.results[0].clone();
    assert_eq!(result.row_count, 100_000);
    assert_eq!(result.paused_by, Some(PauseReason::RowLimit));
    // The statement is still running on the server: it waits for the client to read. The
    // activity view is sampled, so poll for the state rather than read it once.
    let session = b.manager.session(&b.connection_id).expect("session");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let activity = session
            .query(
                "SELECT state FROM pg_stat_activity WHERE query LIKE '%m13-backpressure%' AND pid <> pg_backend_pid()",
                5,
            )
            .await
            .expect("activity");
        if activity.scalar_text().as_deref() == Some("active") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the statement is still active: {activity:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        b.fold(id).0.results[0].row_count,
        100_000,
        "nothing read while paused"
    );

    b.runner
        .resume(result.result_id, ResumeMode::All)
        .expect("all");
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded);
    assert_eq!(run.results[0].row_count, 300_000);
    assert_eq!(run.results[0].status, ResultStatus::Complete);
    let tail = b.window(result.result_id, 299_999, 500);
    assert_eq!(tail.columns[0].values[0].as_deref(), Some("300000"));
}

#[tokio::test]
async fn cancels_running_and_paused_statements() {
    let Some(b) = pg("cancels_running_and_paused_statements", false).await else {
        return;
    };
    let (id, _) = b
        .start(b.request("tab", "SELECT pg_sleep(30)", ExecuteScope::All))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert_eq!(run.error_code(), Some(ErrorCode::Cancelled));
    assert_eq!(
        run.errors()[0]
            .server
            .as_ref()
            .and_then(|s| s.code.as_deref()),
        Some("57014")
    );
    let history = b.history.entries();
    assert_eq!(
        history[0].outcome.as_ref().map_err(|e| e.code).err(),
        Some(ErrorCode::Cancelled)
    );

    let id = b
        .run_limited(
            "tab",
            "SELECT g FROM generate_series(1, 5000000) g",
            ResultLimits {
                max_rows: 1000,
                max_bytes: 1 << 30,
            },
        )
        .await;
    b.wait_for(id, |r| r.status == ExecutionStatus::Paused)
        .await;
    let started = Instant::now();
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert_eq!(run.results[0].status, ResultStatus::Cancelled);
    assert_eq!(run.results[0].row_count, 1000);
    // Same tab connection, usable again.
    let again = b.run("tab", "SELECT 2").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded);
}

#[tokio::test]
async fn tabs_keep_their_session_and_transactions() {
    let Some(b) = pg("tabs_keep_their_session_and_transactions", false).await else {
        return;
    };
    let setup = b
        .run(
            "a",
            "SET search_path TO pg_catalog, public; CREATE TEMP TABLE m13_tmp (a int)",
        )
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded);
    let a = b.run("a", "SHOW search_path").await;
    assert_eq!(
        b.column(&a.results[0], 0),
        [Some("pg_catalog, public".into())]
    );
    let other = b.run("b", "SHOW search_path").await;
    assert_ne!(
        b.column(&other.results[0], 0),
        [Some("pg_catalog, public".into())]
    );

    // Auto-commit with an explicit transaction.
    b.run("a", "BEGIN; INSERT INTO m13_tmp VALUES (1)").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    b.run("a", "COMMIT").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);

    // Manual mode.
    b.runner
        .set_mode("a", TransactionMode::Manual)
        .expect("manual");
    b.run("a", "INSERT INTO m13_tmp VALUES (2)").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    let mut switch = b.request("a", "SELECT current_database()", ExecuteScope::All);
    switch.database = Some("postgres".into());
    assert_eq!(
        b.runner.execute(switch.clone()).map_err(|e| e.code).err(),
        Some(ErrorCode::TransactionOpen)
    );
    b.runner
        .end_transaction("a", false)
        .await
        .expect("rollback");
    let count = b.run("a", "SELECT count(*) FROM m13_tmp").await;
    assert_eq!(b.column(&count.results[0], 0), [Some("1".into())]);
    b.runner.end_transaction("a", true).await.expect("commit");
    let logged = b.logged();
    assert!(logged.iter().any(|sql| sql == "BEGIN"));
    assert!(logged.iter().any(|sql| sql == "ROLLBACK"));

    // Another database: the tab connection is reopened there.
    let (id, _) = b.start(switch).expect("switch");
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(b.column(&run.results[0], 0), [Some("postgres".into())]);
    assert_eq!(b.runner.tab_info("a").database.as_deref(), Some("postgres"));
    b.runner.close_tab("a").await;
    b.runner.close_tab("b").await;
}

#[tokio::test]
async fn read_only_is_enforced_by_the_classifier_and_the_session() {
    let Some(writer) = pg(
        "read_only_is_enforced_by_the_classifier_and_the_session",
        false,
    )
    .await
    else {
        return;
    };
    let setup = writer
        .run(
            "setup",
            "CREATE TABLE IF NOT EXISTS m13_ro (a int);
CREATE OR REPLACE FUNCTION m13_write() RETURNS int LANGUAGE sql AS $$ INSERT INTO m13_ro VALUES (1) RETURNING a $$",
        )
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded, "{setup:?}");
    let Some(b) = pg("read_only (reader)", true).await else {
        return;
    };

    for sql in [
        "DELETE FROM m13_ro",
        "SET default_transaction_read_only = off",
        "BEGIN READ WRITE",
        "SELECT set_config('default_transaction_read_only', 'off', false)",
        "WITH d AS (DELETE FROM m13_ro RETURNING *) SELECT * FROM d",
    ] {
        let run = b.run("tab", sql).await;
        assert_eq!(
            run.error_code(),
            Some(ErrorCode::ReadOnlyViolation),
            "{sql}"
        );
    }
    let show = b.run("tab", "SHOW default_transaction_read_only").await;
    assert_eq!(b.column(&show.results[0], 0), [Some("on".into())]);

    // A function with side effects passes the classifier; the session refuses the write,
    // even after RESET ALL (the setting is a startup parameter).
    let run = b.run("tab", "RESET ALL; SELECT m13_write()").await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    assert_eq!(
        run.errors()[0]
            .server
            .as_ref()
            .and_then(|s| s.code.as_deref()),
        Some("25006"),
        "{run:?}"
    );

    // Same without the runner's classifier: straight to a read-only driver connection.
    let url = pg_url("read_only (driver)").expect("url");
    let (mut def, password) = pg_definition(&url);
    def.read_only = true;
    let target = def.target();
    let conn = common::driver(def.engine)
        .connect(ConnectRequest {
            target: &target,
            password: password.as_ref(),
            recorder: Arc::new(NoRecorder),
        })
        .await
        .expect("connect");
    let (sender, mut events) = tokio::sync::mpsc::channel(8);
    let failed = conn
        .execute("INSERT INTO m13_ro VALUES (2)", sender)
        .await
        .expect_err("read-only transaction");
    assert_eq!(failed.server.and_then(|s| s.code).as_deref(), Some("25006"));
    assert!(events.try_recv().is_err());
    conn.close().await;

    let count = writer.run("setup", "SELECT count(*) FROM m13_ro").await;
    assert_eq!(writer.column(&count.results[0], 0), [Some("0".into())]);
    writer
        .run("setup", "DROP FUNCTION m13_write(); DROP TABLE m13_ro")
        .await;
}

/// P-03: query sent → first window (500 rows) readable, for a 1M-row result.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement: cargo test --release --test query_postgres p03 -- --ignored --nocapture"]
async fn p03_first_window_of_a_million_rows() {
    let Some(b) = pg("p03_first_window_of_a_million_rows", false).await else {
        return;
    };
    // Materialized by the server before its first row (FROM-clause function), and streamed
    // from the first row (set-returning function in the select list).
    let queries = [
        "SELECT g FROM generate_series(1, 1000000) g",
        "SELECT generate_series(1, 1000000) AS g",
    ];
    let median = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    for (q, sql) in queries.into_iter().enumerate() {
        let url = pg_url("p03").expect("url");
        let (def, password) = pg_definition(&url);
        let target = def.target();
        let driver = common::driver(def.engine);
        let mut driver_ms = Vec::new();
        let mut event_ms = Vec::new();
        let mut readable_ms = Vec::new();
        let mut complete_ms = Vec::new();
        for round in 0..7 {
            // Server time to the first rows, through the driver alone (no store, no events).
            let conn = driver
                .connect(ConnectRequest {
                    target: &target,
                    password: password.as_ref(),
                    recorder: Arc::new(NoRecorder),
                })
                .await
                .expect("connect");
            let (sender, mut events) = tokio::sync::mpsc::channel(64);
            let started = Instant::now();
            let task = {
                let sql = sql.to_owned();
                let conn: Arc<dyn yadbe_lib::db::driver::Connection> = Arc::from(conn);
                let c = Arc::clone(&conn);
                tokio::spawn(async move { c.execute(&sql, sender).await })
            };
            let mut first_batch = None;
            while let Some(event) = events.recv().await {
                if matches!(event, ExecEvent::Rows(_)) && first_batch.is_none() {
                    first_batch = Some(started.elapsed());
                }
            }
            task.await.expect("join").expect("execute");

            // The runner: the first `query-progress` with 500 rows, then the window itself.
            let tab = format!("p03-{q}-{round}");
            // The tab's own connection is open (its first run pays the connect, TLS included).
            b.run(&tab, "SELECT 1").await;
            let sent = Instant::now();
            let (id, _) = b
                .start(b.request(&tab, sql, ExecuteScope::All))
                .expect("start");
            let (event_at, result_id) = loop {
                let found = b
                    .sink
                    .timed()
                    .into_iter()
                    .find_map(|(at, event)| match event {
                        BackendEvent::QueryProgress(e) if e.execution_id == id => e
                            .delta
                            .results
                            .iter()
                            .find(|r| r.row_count >= 500)
                            .map(|r| (at, r.result_id)),
                        _ => None,
                    });
                if let Some(found) = found {
                    break found;
                }
                tokio::task::yield_now().await;
            };
            let window = b.window(result_id, 0, 500);
            let readable = sent.elapsed();
            assert_eq!(window.row_count, 500);
            let run = b
                .wait_for(id, |r| r.status == ExecutionStatus::Paused)
                .await;
            assert_eq!(run.results[0].row_count, 100_000, "default limit");
            let complete = sent.elapsed();
            b.runner.cancel(&tab).await;
            b.runner.close_tab(&tab).await;
            if round > 0 {
                driver_ms.push(first_batch.expect("rows").as_secs_f64() * 1000.0);
                event_ms.push((event_at - sent).as_secs_f64() * 1000.0);
                readable_ms.push(readable.as_secs_f64() * 1000.0);
                complete_ms.push(complete.as_secs_f64() * 1000.0);
            }
        }
        println!(
            "P-03 `{sql}` (median of 6): driver first 500 rows {:.1} ms; runner first event with 500 rows {:.1} ms; first window readable {:.1} ms; overhead {:.1} ms; paused at 100k rows after {:.1} ms",
            median(&mut driver_ms),
            median(&mut event_ms),
            median(&mut readable_ms),
            median(&mut readable_ms) - median(&mut driver_ms),
            median(&mut complete_ms)
        );
    }
}
