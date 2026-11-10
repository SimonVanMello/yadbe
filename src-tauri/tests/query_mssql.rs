//! Query execution on SQL Server (M1-7, `YADBE_TEST_MSSQL_URL`): `GO` batches with several
//! result sets, `PRINT` / `RAISERROR` messages in order, lossless types, error lines mapped
//! to the editor, TDS Attention cancellation (running and paused), backpressure, tab
//! sessions and transactions tracked from the server, read-only enforcement and its limit,
//! and the typed connection errors.

mod common;
mod query_common;

use std::time::{Duration, Instant};

use common::{from_url, mssql_ca, mssql_url};
use query_common::{Bench, bench};
use yadbe_lib::db::config::TlsMode;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::{Value, ValueKind};
use yadbe_lib::session::query_model::{
    ExecuteScope, ExecutionStatus, PauseReason, ResultLimits, ResultStatus, ResumeMode,
    TextPosition, TransactionMode, TransactionStatus,
};

async fn mssql(test: &str, read_only: bool) -> Option<Bench> {
    let url = mssql_url(test)?;
    let (mut def, password) = from_url(&url);
    def.read_only = read_only;
    Some(bench(def, password).await)
}

#[tokio::test]
async fn runs_batches_with_types_messages_and_row_counts() {
    let Some(b) = mssql("runs_batches_with_types_messages_and_row_counts", false).await else {
        return;
    };
    let text = "PRINT 'hello';
CREATE TABLE #t (
  id bigint, n decimal(38,10), m money, sm smallmoney, f float, r real, b bit, ti tinyint,
  si smallint, d date, dt datetime, dt2 datetime2(7), sdt smalldatetime, tm time(3),
  dto datetimeoffset(7), u uniqueidentifier, vb varbinary(max), nv nvarchar(max), x xml,
  v sql_variant, h hierarchyid, c char(3));
INSERT INTO #t VALUES
  (9223372036854775807, 1234567890123456789012345678.1234567890, 922337203685477.5807,
   -214748.3648, 0.1, 0.1, 1, 255, -32768, '0001-01-01', '2025-02-28 12:34:56.789',
   '9999-12-31 23:59:59.9999999', '2025-02-28 12:35', '12:34:56.789',
   '2025-02-28 12:34:56.1234567 +05:30', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 0x00FF,
   N'héllo ✓', '<a b=\"1\"/>', CAST(42 AS int), '/1/2/', 'ab'),
  (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, 0x, N'', NULL, NULL, NULL, NULL);
SELECT * FROM #t ORDER BY id DESC;
RAISERROR('careful %d', 10, 1, 42);
SELECT 1 AS a; SELECT 'x' AS b WHERE 1 = 0;
GO
UPDATE #t SET n = 1;
UPDATE #t SET m = 2 WHERE id IS NULL
GO
SELECT 2 AS two";
    let run = b.run("tab", text).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.statements.len(), 3, "GO batches");
    assert_eq!(run.notices(), ["hello", "careful 42"]);
    assert_eq!(
        run.affected(),
        [None, Some(3.0), None],
        "{:?}",
        run.messages
    );
    assert_eq!(run.results.len(), 4);
    assert!(
        run.results
            .iter()
            .all(|r| r.status == ResultStatus::Complete),
        "every result set of a batch completes: {:?}",
        run.results
    );
    assert_eq!(
        run.results
            .iter()
            .map(|r| r.statement_index)
            .collect::<Vec<_>>(),
        [0, 0, 0, 2]
    );
    let empty = &run.results[2];
    assert_eq!((empty.row_count, empty.columns.len()), (0, 1));

    let rows = &run.results[0];
    let types: Vec<_> = rows.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(
        types,
        [
            "bigint",
            "decimal(38,10)",
            "money",
            "smallmoney",
            "float",
            "real",
            "bit",
            "tinyint",
            "smallint",
            "date",
            "datetime",
            "datetime2(7)",
            "smalldatetime",
            "time(3)",
            "datetimeoffset(7)",
            "uniqueidentifier",
            "varbinary(max)",
            "nvarchar(max)",
            "xml",
            "sql_variant",
            "hierarchyid",
            "char(3)"
        ]
    );
    assert_eq!(rows.columns[19].kind, ValueKind::Other);
    assert_eq!(rows.columns[20].kind, ValueKind::Other);
    let window = b.window(rows.result_id, 0, 500);
    let cell = |c: usize, r: usize| window.columns[c].values[r].clone();
    let expected = [
        "9223372036854775807",
        "1234567890123456789012345678.1234567890",
        "922337203685477.5807",
        "-214748.3648",
        "0.1",
        "0.1",
        "true",
        "255",
        "-32768",
        "0001-01-01",
        "2025-02-28 12:34:56.790",
        "9999-12-31 23:59:59.9999999",
        "2025-02-28 12:35:00",
        "12:34:56.789",
        "2025-02-28 12:34:56.1234567+05:30",
        "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
        "00ff",
        "héllo ✓",
        "<a b=\"1\"/>",
        "42",
        "0x5B40",
        "ab ",
    ];
    for (c, value) in expected.iter().enumerate() {
        assert_eq!(cell(c, 0).as_deref(), Some(*value), "column {c}");
    }
    assert_eq!(cell(0, 1), None);
    assert_eq!(cell(16, 1).as_deref(), Some(""), "empty binary");
    assert_eq!(cell(17, 1).as_deref(), Some(""), "empty string");
    assert_eq!(
        b.runner.cell(rows.result_id, 0, 2).expect("cell"),
        Value::Decimal("922337203685477.5807".into())
    );
    let history = b.history.entries();
    assert_eq!(history.len(), 3);
    assert_eq!(history[1].rows, Some(3));
}

#[tokio::test]
async fn repeats_go_n_batches() {
    let Some(b) = mssql("repeats_go_n_batches", false).await else {
        return;
    };
    let run = b
        .run(
            "tab",
            "CREATE TABLE #g (a int)\nGO\nINSERT INTO #g VALUES (1)\nGO 3\nSELECT COUNT(*) FROM #g",
        )
        .await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.statements.len(), 3);
    assert_eq!(
        run.affected(),
        [None, Some(1.0), Some(1.0), Some(1.0), None]
    );
    assert_eq!(b.column(&run.results[0], 0), [Some("3".into())]);
    assert_eq!(b.history.entries().len(), 5);
}

#[tokio::test]
async fn maps_error_lines_and_keeps_later_messages() {
    let Some(b) = mssql("maps_error_lines_and_keeps_later_messages", false).await else {
        return;
    };
    let run = b
        .run(
            "tab",
            "SELECT 1\nGO\nSELECT 1;\n  SELECT é FROM nowhere_m17;\nSELECT 2",
        )
        .await;
    assert_eq!(run.status, ExecutionStatus::Failed, "{run:?}");
    let error = run.errors()[0];
    let server = error.server.as_ref().expect("server");
    assert_eq!(server.code.as_deref(), Some("208"));
    assert_eq!(server.severity, "ERROR");
    assert!(server.message.contains("nowhere_m17"), "{server:?}");
    assert_eq!(
        error.position,
        Some(TextPosition {
            offset: 22,
            line: 4,
            column: 1
        }),
        "start of the line the server reports, in the second batch"
    );
    assert!(
        error
            .error
            .detail
            .as_deref()
            .is_some_and(|d| d.starts_with("Msg 208, Level 16, State 1, Line 2")),
        "{:?}",
        error.error
    );

    // The batch goes on after a statement error: later messages arrive as notices.
    let run = b
        .run(
            "tab",
            "RAISERROR('first', 16, 1);\nPRINT 'after';\nRAISERROR('second', 16, 2);\nSELECT 3 AS three",
        )
        .await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    assert_eq!(run.notices(), ["after", "second"]);
    assert_eq!(run.results.len(), 1, "results after the error are kept");
    assert_eq!(run.errors()[0].position.map(|p| p.line), Some(1));

    // Inside a procedure, the line is the procedure's: no editor position.
    let setup = b
        .run(
            "tab",
            "CREATE OR ALTER PROCEDURE #m17_fail AS\nBEGIN\n  RAISERROR('in proc', 16, 1);\nEND",
        )
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded, "{setup:?}");
    let run = b.run("tab", "EXEC #m17_fail").await;
    let error = run.errors()[0];
    assert_eq!(error.position, None);
    assert_eq!(
        error.server.as_ref().and_then(|s| s.detail.as_deref()),
        Some("Procedure #m17_fail, line 3")
    );
}

#[tokio::test]
async fn pauses_with_server_backpressure_then_resumes() {
    let Some(b) = mssql("pauses_with_server_backpressure_then_resumes", false).await else {
        return;
    };
    // Wide rows: the TCP buffers on the way (docker-proxy included) hold megabytes.
    let sql = "SELECT TOP (1000000) /* m17-backpressure */ ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n,
  REPLICATE('x', 400) AS pad
FROM sys.all_columns a CROSS JOIN sys.all_columns b";
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
    // The request is still on the server, waiting for the client to read.
    let session = b.manager.session(&b.connection_id).expect("session");
    let activity = session
        .query(
            "SELECT r.status, r.wait_type FROM sys.dm_exec_requests r \
             CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t \
             WHERE t.text LIKE '%m17-backpressure%' AND r.session_id <> @@SPID",
            5,
        )
        .await
        .expect("activity");
    assert_eq!(
        activity.rows.first().and_then(|r| r.get(1)),
        Some(&Value::Text("ASYNC_NETWORK_IO".into())),
        "the request waits for the client: {activity:?}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        b.fold(id).0.results[0].row_count,
        100_000,
        "nothing read while paused"
    );

    b.runner
        .resume(result.result_id, ResumeMode::More)
        .expect("more");
    let run = b
        .wait_for(id, |r| {
            r.status == ExecutionStatus::Paused && r.results[0].row_count == 200_000
        })
        .await;
    assert_eq!(run.results[0].status, ResultStatus::Paused);
    let tail = b.window(result.result_id, 199_999, 1);
    assert_eq!(tail.columns[0].values[0].as_deref(), Some("200000"));
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert_eq!(run.results[0].row_count, 200_000);
    let again = b.run("tab", "SELECT 4 AS four").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded, "{again:?}");
}

#[tokio::test]
async fn cancels_running_and_paused_batches_with_an_attention() {
    let Some(b) = mssql(
        "cancels_running_and_paused_batches_with_an_attention",
        false,
    )
    .await
    else {
        return;
    };
    let (id, _) = b
        .start(b.request(
            "tab",
            "PRINT 'before'; WAITFOR DELAY '00:00:30'; PRINT 'never'",
            ExecuteScope::All,
        ))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = Instant::now();
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.status, ExecutionStatus::Cancelled, "{run:?}");
    assert_eq!(run.error_code(), Some(ErrorCode::Cancelled));
    assert!(!run.notices().contains(&"never".to_owned()));
    let history = b.history.entries();
    assert_eq!(
        history[0].outcome.as_ref().map_err(|e| e.code).err(),
        Some(ErrorCode::Cancelled)
    );
    // Same tab connection, usable again: the attention was acknowledged.
    let again = b.run("tab", "SELECT 2 AS two").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded, "{again:?}");
    assert_eq!(b.column(&again.results[0], 0), [Some("2".into())]);

    let id = b
        .run_limited(
            "tab",
            "SELECT TOP (5000000) a.object_id FROM sys.all_columns a CROSS JOIN sys.all_columns b",
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
    let again = b.run("tab", "SELECT 3 AS three").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded, "{again:?}");
    assert_eq!(b.column(&again.results[0], 0), [Some("3".into())]);
}

/// The server blocks on a lock in the middle of a row that spans several packets: the
/// client is waiting inside a token, and the Attention must still go out at once.
#[tokio::test]
async fn cancels_a_batch_stalled_in_the_middle_of_a_row() {
    let test = "cancels_a_batch_stalled_in_the_middle_of_a_row";
    let Some(url) = mssql_url(test) else {
        return;
    };
    let Some(b) = mssql(test, false).await else {
        return;
    };
    let (def, password) = from_url(&url);
    let blocker = common::open(&def, password.as_ref())
        .await
        .expect("blocker");
    blocker
        .query(
            "IF OBJECT_ID('dbo.m17_stall') IS NOT NULL DROP TABLE dbo.m17_stall;
CREATE TABLE dbo.m17_stall (id int PRIMARY KEY, big nvarchar(max));
INSERT INTO dbo.m17_stall VALUES (1, REPLICATE(CAST(N'x' AS nvarchar(max)), 20001)), (2, N'y');
BEGIN TRANSACTION;
UPDATE dbo.m17_stall SET big = N'z' WHERE id = 2;",
            0,
        )
        .await
        .expect("lock row 2");
    let (id, _) = b
        .start(b.request(
            "tab",
            "SELECT id, big, id AS again FROM dbo.m17_stall ORDER BY id",
            ExecuteScope::All,
        ))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let started = Instant::now();
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    let elapsed = started.elapsed();
    blocker
        .query("ROLLBACK; DROP TABLE dbo.m17_stall", 0)
        .await
        .expect("cleanup");
    blocker.close().await;
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    assert_eq!(run.status, ExecutionStatus::Cancelled, "{run:?}");
    let again = b.run("tab", "SELECT 5 AS five").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded, "{again:?}");
    assert_eq!(b.column(&again.results[0], 0), [Some("5".into())]);
}

#[tokio::test]
async fn tabs_keep_their_session_and_transactions() {
    let Some(b) = mssql("tabs_keep_their_session_and_transactions", false).await else {
        return;
    };
    let setup = b
        .run("a", "CREATE TABLE #m17 (a int); SET LANGUAGE French")
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded, "{setup:?}");
    let a = b.run("a", "SELECT @@LANGUAGE").await;
    assert_eq!(b.column(&a.results[0], 0), [Some("Français".into())]);
    let other = b.run("b", "SELECT @@LANGUAGE").await;
    assert_ne!(b.column(&other.results[0], 0), [Some("Français".into())]);
    b.run("a", "SET LANGUAGE us_english").await;

    // Auto-commit with an explicit transaction, tracked from the server's reports.
    b.run("a", "BEGIN TRAN; INSERT INTO #m17 VALUES (1)").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    b.run("a", "COMMIT").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    // A statement error does not end the transaction (unlike PostgreSQL)…
    b.run("a", "BEGIN TRAN; SELECT 1 / 0").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    b.run("a", "ROLLBACK").await;
    // …but XACT_ABORT rolls it back on the server, and yadbe sees it.
    let run = b
        .run(
            "a",
            "SET XACT_ABORT ON; BEGIN TRAN; INSERT INTO #m17 VALUES (2); SELECT 1 / 0",
        )
        .await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    b.run("a", "SET XACT_ABORT OFF").await;

    // Manual mode.
    b.runner
        .set_mode("a", TransactionMode::Manual)
        .expect("manual");
    b.run("a", "INSERT INTO #m17 VALUES (3)").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    let mut switch = b.request("a", "SELECT DB_NAME()", ExecuteScope::All);
    switch.database = Some("tempdb".into());
    assert_eq!(
        b.runner.execute(switch.clone()).map_err(|e| e.code).err(),
        Some(ErrorCode::TransactionOpen)
    );
    b.runner
        .end_transaction("a", false)
        .await
        .expect("rollback");
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    let count = b.run("a", "SELECT COUNT(*) FROM #m17").await;
    assert_eq!(b.column(&count.results[0], 0), [Some("1".into())]);
    b.runner.end_transaction("a", true).await.expect("commit");
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    let logged = b.logged();
    assert!(logged.iter().any(|sql| sql == "BEGIN TRANSACTION"));
    assert!(logged.iter().any(|sql| sql == "ROLLBACK"));

    // Another database: the tab connection is reopened there.
    let (id, _) = b.start(switch).expect("switch");
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(b.column(&run.results[0], 0), [Some("tempdb".into())]);
    b.runner.close_tab("a").await;
    b.runner.close_tab("b").await;
}

#[tokio::test]
async fn read_only_relies_on_the_classifier_alone() {
    let Some(writer) = mssql("read_only_relies_on_the_classifier_alone", false).await else {
        return;
    };
    assert!(!Engine::Mssql.dialect().capabilities().read_only_session);
    let setup = writer
        .run(
            "setup",
            "IF OBJECT_ID('dbo.m17_ro') IS NULL CREATE TABLE dbo.m17_ro (a int);
IF OBJECT_ID('dbo.m17_seq') IS NULL CREATE SEQUENCE dbo.m17_seq START WITH 1",
        )
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded, "{setup:?}");
    let Some(b) = mssql("read_only (reader)", true).await else {
        return;
    };
    for sql in [
        "DELETE FROM dbo.m17_ro",
        "SELECT * INTO #copy FROM dbo.m17_ro",
        "EXEC sp_rename 'dbo.m17_ro', 'm17_gone'",
        "SELECT 1\nINSERT INTO dbo.m17_ro VALUES (1)",
        "MERGE dbo.m17_ro AS t USING (SELECT 1 AS a) s ON t.a = s.a WHEN NOT MATCHED THEN INSERT VALUES (1);",
    ] {
        let run = b.run("tab", sql).await;
        assert_eq!(
            run.error_code(),
            Some(ErrorCode::ReadOnlyViolation),
            "{sql}"
        );
    }
    let read = b.run("tab", "SELECT COUNT(*) FROM dbo.m17_ro").await;
    assert_eq!(read.status, ExecutionStatus::Succeeded);
    // The documented limit: no read-only session, so a read with a side effect passes.
    let run = b.run("tab", "SELECT NEXT VALUE FOR dbo.m17_seq").await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");

    let count = writer.run("setup", "SELECT COUNT(*) FROM dbo.m17_ro").await;
    assert_eq!(writer.column(&count.results[0], 0), [Some("0".into())]);
    writer
        .run("setup", "DROP TABLE dbo.m17_ro; DROP SEQUENCE dbo.m17_seq")
        .await;
}

#[tokio::test]
async fn connection_failures_are_typed() {
    let Some(url) = mssql_url("connection_failures_are_typed") else {
        return;
    };
    let (def, password) = from_url(&url);
    // Every encryption mode SQL Server's self-signed certificate allows.
    for (mode, encrypted) in [
        (TlsMode::Disable, "FALSE"),
        (TlsMode::Prefer, "TRUE"),
        (TlsMode::Require, "TRUE"),
    ] {
        let mut ok = def.clone();
        ok.tls_mode = mode;
        let conn = common::open(&ok, password.as_ref())
            .await
            .unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
        assert!(
            conn.server_version().starts_with("SQL Server "),
            "{}",
            conn.server_version()
        );
        let option = conn
            .query(
                "SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID",
                1,
            )
            .await
            .expect("encryption")
            .scalar_text();
        assert_eq!(option.as_deref(), Some(encrypted), "{mode:?}");
        conn.close().await;
    }
    let mut strict = def.clone();
    strict.tls_mode = TlsMode::VerifyFull;
    let error = common::open(&strict, password.as_ref())
        .await
        .err()
        .expect("self-signed certificate");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");

    let wrong = yadbe_lib::secrets::Secret::new("not-the-password".to_owned());
    let error = common::open(&def, Some(&wrong)).await.err().expect("auth");
    assert_eq!(error.code, ErrorCode::AuthFailed, "{error:?}");
    assert!(
        !format!("{error:?}").contains("not-the-password"),
        "no secret in errors"
    );

    let mut unknown = def.clone();
    unknown.database = "no_such_db_m17".into();
    let error = common::open(&unknown, password.as_ref())
        .await
        .err()
        .expect("database");
    assert_eq!(error.code, ErrorCode::UnknownDatabase, "{error:?}");

    let mut refused = def.clone();
    refused.host = "127.0.0.1".into();
    refused.port = Some(1);
    let error = common::open(&refused, password.as_ref())
        .await
        .err()
        .expect("refused");
    assert_eq!(error.code, ErrorCode::ConnectionRefused, "{error:?}");
}

#[tokio::test]
async fn verifies_the_server_certificate_with_a_custom_ca() {
    let test = "verifies_the_server_certificate_with_a_custom_ca";
    let (Some(url), Some(ca)) = (mssql_url(test), mssql_ca(test)) else {
        return;
    };
    let (mut def, password) = from_url(&url);
    def.ca_cert_path = Some(ca);
    for mode in [TlsMode::Require, TlsMode::VerifyFull] {
        def.tls_mode = mode;
        let conn = common::open(&def, password.as_ref())
            .await
            .unwrap_or_else(|e| panic!("{mode:?} with the CA: {e:?}"));
        conn.close().await;
    }
    // The certificate names `localhost` only.
    let mut by_ip = def.clone();
    by_ip.host = "127.0.0.1".into();
    let error = common::open(&by_ip, password.as_ref())
        .await
        .err()
        .expect("host name mismatch");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");
    // Without the CA, the OS trust store does not know it.
    def.ca_cert_path = None;
    let error = common::open(&def, password.as_ref())
        .await
        .err()
        .expect("unknown CA");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");
}

#[tokio::test]
async fn a_killed_session_ends_the_link() {
    let Some(url) = mssql_url("a_killed_session_ends_the_link") else {
        return;
    };
    let (def, password) = from_url(&url);
    let victim = common::open(&def, password.as_ref()).await.expect("victim");
    let spid = victim
        .query("SELECT @@SPID", 1)
        .await
        .expect("spid")
        .scalar_text()
        .expect("a session id");
    let killer = common::open(&def, password.as_ref()).await.expect("killer");
    killer
        .query(&format!("KILL {spid}"), 0)
        .await
        .expect("kill");
    killer.close().await;
    let error = victim.ping().await.expect_err("killed");
    assert_eq!(error.code, ErrorCode::ConnectionLost, "{error:?}");
    assert!(victim.link().is_lost());
}
