//! Query execution on MySQL / MariaDB (M3-1, `YADBE_TEST_MYSQL_URL`): scripts with
//! `DELIMITER` and stored procedures, `CALL` with several result sets, lossless types,
//! warnings and server info as notices, error lines mapped to the editor, `KILL QUERY`
//! cancellation (running and paused), backpressure, tab sessions and transactions tracked
//! from the server (DDL commits implicitly), read-only enforcement on both layers, and the
//! typed connection errors.

mod common;
mod query_common;

use std::time::{Duration, Instant};

use common::{MysqlDatabase, from_url, mysql_ca, mysql_url};
use query_common::{Bench, bench};
use yadbe_lib::db::config::TlsMode;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::ValueKind;
use yadbe_lib::session::query_model::{
    ExecuteScope, ExecutionStatus, PauseReason, ResultLimits, ResultStatus, ResumeMode,
    TextPosition, TransactionMode, TransactionStatus,
};

/// A bench on a database of its own (dropped with the guard).
async fn mysql(test: &str, read_only: bool) -> Option<(MysqlDatabase, Bench)> {
    let url = mysql_url(test)?;
    let database = MysqlDatabase::create(&url, "q31").await;
    let (mut def, password) = database.definition();
    def.read_only = read_only;
    let b = bench(def, password).await;
    Some((database, b))
}

fn mariadb(b: &Bench) -> bool {
    b.manager
        .session(&b.connection_id)
        .and_then(|s| s.connection())
        .is_ok_and(|c| c.server_version().starts_with("MariaDB"))
}

#[tokio::test]
async fn runs_scripts_with_types_notices_and_row_counts() {
    let Some((_db, b)) = mysql("runs_scripts_with_types_notices_and_row_counts", false).await
    else {
        return;
    };
    let maria = mariadb(&b);
    let text = "SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';
CREATE TABLE t (
  id BIGINT, ub BIGINT UNSIGNED, n DECIMAL(65,30), f FLOAT, d DOUBLE, b TINYINT(1),
  ti TINYINT, bt BIT(1), b12 BIT(12), dt DATE, tm TIME(3), dtt DATETIME(6), ts TIMESTAMP(2) NULL,
  y YEAR, j JSON, e ENUM('a','b'), s SET('x','y'), vb VARBINARY(10), bl BLOB, vc VARCHAR(20),
  tx TEXT, ch CHAR(3), g GEOMETRY);
INSERT INTO t VALUES
  (9223372036854775807, 18446744073709551615,
   12345678901234567890123456789012345.123456789012345678901234567890, 0.1, 0.1, 1, -128,
   b'1', b'101010101010', '2025-02-28', '-838:59:59.000', '2025-02-28 12:34:56.123456',
   '2025-02-28 12:34:56.79', 2025, '{\"a\": [1, 2]}', 'b', 'y,x', 0x00FF, 0xDEADBEEF,
   'héllo ✓', 'long\\ntext', 'ab', ST_GeomFromText('POINT(1 2)')),
  (NULL, 0, 0, NULL, NULL, 0, NULL, b'0', NULL, '0000-00-00', '00:00:00', '0000-00-00 00:00:00',
   NULL, 0, NULL, NULL, '', X'', '', '', '', '', NULL);
SELECT * FROM t ORDER BY id DESC;
UPDATE t SET ti = 1;
SELECT CAST('abc' AS SIGNED) AS warned;
DELIMITER //
CREATE PROCEDURE two_sets()
BEGIN
  SELECT 1 AS a;
  SELECT 'x' AS b WHERE 1 = 0;
END//
DELIMITER ;
CALL two_sets();
# a comment
SELECT 2 AS two";
    let run = b.run("tab", text).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(
        run.statements.len(),
        9,
        "DELIMITER lines are not statements"
    );
    assert!(
        run.notices()
            .iter()
            .any(|n| n.contains("Rows matched: 2") && n.contains("Changed: 2")),
        "server info: {:?}",
        run.notices()
    );
    assert!(
        run.notices()
            .iter()
            .any(|n| n.contains("Truncated incorrect")),
        "warnings as notices: {:?}",
        run.notices()
    );
    let affected = run.affected();
    assert_eq!(affected[2], Some(2.0), "{affected:?}");
    assert_eq!(affected[4], Some(2.0), "{affected:?}");
    assert_eq!(run.results.len(), 5, "{:?}", run.results);
    assert_eq!(
        run.results
            .iter()
            .map(|r| r.statement_index)
            .collect::<Vec<_>>(),
        [3, 5, 7, 7, 8]
    );
    assert!(
        run.results
            .iter()
            .all(|r| r.status == ResultStatus::Complete),
        "{:?}",
        run.results
    );
    assert_eq!(
        (run.results[3].row_count, run.results[3].columns.len()),
        (0, 1)
    );

    let rows = &run.results[0];
    let types: Vec<_> = rows.columns.iter().map(|c| c.type_name.as_str()).collect();
    let mut expected = vec![
        "bigint",
        "bigint unsigned",
        "decimal(65,30)",
        "float",
        "double",
        "tinyint(1)",
        "tinyint",
        "bit(1)",
        "bit(12)",
        "date",
        "time(3)",
        "datetime(6)",
        "timestamp(2)",
        "year",
        "json",
        "enum",
        "set",
        "varbinary",
        "blob",
        "varchar",
        "text",
        "char",
        "geometry",
    ];
    if maria {
        // MariaDB's JSON is a LONGTEXT with a check.
        expected[14] = "text";
    }
    assert_eq!(types, expected);
    let kinds: Vec<_> = rows.columns.iter().map(|c| c.kind).collect();
    assert_eq!(kinds[5], ValueKind::Bool);
    assert_eq!(kinds[7], ValueKind::Bool);
    assert_eq!(kinds[8], ValueKind::Int);
    assert_eq!(kinds[17], ValueKind::Bytes);
    assert_eq!(kinds[22], ValueKind::Other);
    let window = b.window(rows.result_id, 0, 500);
    let cell = |c: usize, r: usize| window.columns[c].values[r].clone();
    let first = [
        "9223372036854775807",
        "18446744073709551615",
        "12345678901234567890123456789012345.123456789012345678901234567890",
        "0.1",
        "0.1",
        "true",
        "-128",
        "true",
        "2730",
        "2025-02-28",
        "-838:59:59.000",
        "2025-02-28 12:34:56.123456",
        "2025-02-28 12:34:56.79",
        "2025",
    ];
    for (c, value) in first.iter().enumerate() {
        assert_eq!(cell(c, 0).as_deref(), Some(*value), "column {}", types[c]);
    }
    assert!(
        cell(14, 0).is_some_and(|j| j.contains("[1, 2]")),
        "{:?}",
        cell(14, 0)
    );
    assert_eq!(cell(15, 0).as_deref(), Some("b"));
    assert_eq!(cell(16, 0).as_deref(), Some("x,y"));
    assert_eq!(cell(17, 0).as_deref(), Some("00ff"));
    assert_eq!(cell(18, 0).as_deref(), Some("deadbeef"));
    assert_eq!(cell(19, 0).as_deref(), Some("héllo ✓"));
    assert_eq!(cell(20, 0).as_deref(), Some("long\ntext"));
    assert_eq!(cell(21, 0).as_deref(), Some("ab"));
    assert!(
        cell(22, 0).is_some_and(|g| g.ends_with("000000000000f03f0000000000000040")),
        "SRID + WKB of POINT(1 2) as hexadecimal: {:?}",
        cell(22, 0)
    );
    // Zero dates and the zero year read back as stored; NULL stays NULL.
    assert_eq!(cell(0, 1), None);
    assert_eq!(cell(5, 1).as_deref(), Some("false"));
    assert_eq!(cell(9, 1).as_deref(), Some("0000-00-00"));
    assert_eq!(cell(11, 1).as_deref(), Some("0000-00-00 00:00:00.000000"));
    assert_eq!(cell(13, 1).as_deref(), Some("0"));
    assert_eq!(cell(17, 1).as_deref(), Some(""));
    let two = &run.results[4];
    assert_eq!(b.column(two, 0), [Some("2".into())]);
}

#[tokio::test]
async fn maps_error_lines_and_keeps_the_server_message() {
    let Some((_db, b)) = mysql("maps_error_lines_and_keeps_the_server_message", false).await else {
        return;
    };
    let run = b
        .run("tab", "SELECT 1;\nSELECT 1,\n  2 FROMM nowhere;\nSELECT 2")
        .await;
    assert_eq!(run.status, ExecutionStatus::Failed, "{run:?}");
    let error = run.errors()[0];
    let server = error.server.as_ref().expect("server");
    assert_eq!(server.code.as_deref(), Some("1064"));
    assert_eq!(server.detail.as_deref(), Some("SQLSTATE 42000"));
    assert_eq!(
        error.position,
        Some(TextPosition {
            offset: 20,
            line: 3,
            column: 1
        }),
        "start of the line the server reports, in the second statement"
    );
    assert!(
        error
            .error
            .detail
            .as_deref()
            .is_some_and(|d| d.starts_with("ERROR 1064 (42000)")),
        "{:?}",
        error.error
    );
    let run = b.run("tab", "SELECT * FROM nowhere_m31").await;
    let error = run.errors()[0];
    assert_eq!(error.position, None);
    assert_eq!(
        error.server.as_ref().and_then(|s| s.code.as_deref()),
        Some("1146")
    );
    assert_eq!(error.error.code, ErrorCode::QueryFailed);
}

/// Digits 0-9 crossed with themselves: `10^n` rows without any table.
fn numbers(powers: usize, tag: &str) -> String {
    let digits = "(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 \
UNION ALL SELECT 9)";
    let terms: Vec<String> = (0..powers)
        .map(|p| format!("d{p}.n * {}", 10u64.pow(u32::try_from(p).unwrap_or(0))))
        .collect();
    let from: Vec<String> = (0..powers).map(|p| format!("{digits} d{p}")).collect();
    format!(
        "SELECT /* {tag} */ {} + 1 AS n, REPEAT('x', 400) AS pad FROM {}",
        terms.join(" + "),
        from.join(" CROSS JOIN ")
    )
}

#[tokio::test]
async fn pauses_with_server_backpressure_then_resumes() {
    let Some((_db, b)) = mysql("pauses_with_server_backpressure_then_resumes", false).await else {
        return;
    };
    let sql = numbers(6, "m31-backpressure");
    let id = b
        .run_limited(
            "tab",
            &sql,
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
    // The statement is still on the server, waiting for the client to read.
    let session = b.manager.session(&b.connection_id).expect("session");
    let activity = session
        .query(
            "SELECT COMMAND FROM information_schema.PROCESSLIST \
             WHERE INFO LIKE '%m31-backpressure%' AND ID <> CONNECTION_ID()",
            5,
        )
        .await
        .expect("activity");
    assert_eq!(activity.rows.len(), 1, "{activity:?}");
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
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Cancelled);
    assert_eq!(run.results[0].row_count, 200_000);
    let again = b.run("tab", "SELECT 4 AS four").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded, "{again:?}");
    assert_eq!(b.column(&again.results[0], 0), [Some("4".into())]);
}

#[tokio::test]
async fn cancels_running_and_paused_statements_with_kill_query() {
    let Some((_db, b)) = mysql(
        "cancels_running_and_paused_statements_with_kill_query",
        false,
    )
    .await
    else {
        return;
    };
    let (id, _) = b
        .start(b.request(
            "tab",
            "SELECT SLEEP(30); SELECT 'never' AS never",
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
    assert_eq!(run.results.len(), 1, "the second statement never ran");
    assert!(b.logged().iter().any(|sql| sql.starts_with("KILL QUERY ")));
    let again = b.run("tab", "SELECT 2 AS two").await;
    assert_eq!(again.status, ExecutionStatus::Succeeded, "{again:?}");
    assert_eq!(b.column(&again.results[0], 0), [Some("2".into())]);

    // A statement interrupted while computing fails with `cancelled`.
    let (id, _) = b
        .start(b.request(
            "tab",
            "SELECT BENCHMARK(1000000000, SHA2('x', 256))",
            ExecuteScope::All,
        ))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(500)).await;
    b.runner.cancel("tab").await;
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Cancelled, "{run:?}");
    assert_eq!(
        b.history
            .entries()
            .last()
            .map(|e| e.outcome.as_ref().map_err(|e| e.code).err()),
        Some(Some(ErrorCode::Cancelled))
    );

    let id = b
        .run_limited(
            "tab",
            &numbers(7, "m31-paused"),
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
        started.elapsed() < Duration::from_secs(10),
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

#[tokio::test]
async fn tabs_keep_their_session_and_transactions() {
    let Some((db, b)) = mysql("tabs_keep_their_session_and_transactions", false).await else {
        return;
    };
    let setup = b
        .run(
            "a",
            "CREATE TABLE m31 (a int) ENGINE=InnoDB; SET @who = 'tab a'",
        )
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded, "{setup:?}");
    let a = b.run("a", "SELECT @who").await;
    assert_eq!(b.column(&a.results[0], 0), [Some("tab a".into())]);
    let other = b.run("b", "SELECT @who").await;
    assert_eq!(b.column(&other.results[0], 0), [None]);

    // Auto-commit with an explicit transaction, tracked from the server status flags.
    b.run("a", "START TRANSACTION; INSERT INTO m31 VALUES (1)")
        .await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    b.run("a", "COMMIT").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    // A statement error does not end the transaction…
    b.run(
        "a",
        "BEGIN; INSERT INTO m31 VALUES (2); SELECT * FROM nowhere_m31",
    )
    .await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    // …but DDL commits it implicitly, and yadbe sees it.
    let ddl = b.run("a", "CREATE TABLE m31_other (b int)").await;
    assert_eq!(ddl.status, ExecutionStatus::Succeeded, "{ddl:?}");
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    let count = b.run("b", "SELECT COUNT(*) FROM m31").await;
    assert_eq!(
        b.column(&count.results[0], 0),
        [Some("2".into())],
        "the DDL committed the insert"
    );

    // Manual mode.
    b.runner
        .set_mode("a", TransactionMode::Manual)
        .expect("manual");
    b.run("a", "INSERT INTO m31 VALUES (3)").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    let mut switch = b.request("a", "SELECT DATABASE()", ExecuteScope::All);
    switch.database = Some("information_schema".into());
    assert_eq!(
        b.runner.execute(switch.clone()).map_err(|e| e.code).err(),
        Some(ErrorCode::TransactionOpen)
    );
    b.runner
        .end_transaction("a", false)
        .await
        .expect("rollback");
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    let count = b.run("a", "SELECT COUNT(*) FROM m31").await;
    assert_eq!(b.column(&count.results[0], 0), [Some("2".into())]);
    b.runner.end_transaction("a", true).await.expect("commit");
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    // A DDL statement in manual mode ends the transaction it ran in.
    b.run("a", "INSERT INTO m31 VALUES (4)").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Open);
    b.run("a", "DROP TABLE m31_other").await;
    assert_eq!(b.transaction("a").status, TransactionStatus::Idle);
    let logged = b.logged();
    assert!(logged.iter().any(|sql| sql == "START TRANSACTION"));
    assert!(logged.iter().any(|sql| sql == "ROLLBACK"));

    // Another database: the tab connection is reopened there.
    let (id, _) = b.start(switch).expect("switch");
    let run = b.wait(id).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(
        b.column(&run.results[0], 0),
        [Some("information_schema".into())]
    );
    b.runner.close_tab("a").await;
    b.runner.close_tab("b").await;
    drop(db);
}

#[tokio::test]
async fn read_only_sessions_and_the_classifier() {
    let Some((db, writer)) = mysql("read_only_sessions_and_the_classifier", false).await else {
        return;
    };
    assert!(Engine::Mysql.dialect().capabilities().read_only_session);
    let setup = writer
        .run(
            "setup",
            "CREATE TABLE m31_ro (a int);
DELIMITER //
CREATE FUNCTION m31_write() RETURNS int DETERMINISTIC MODIFIES SQL DATA
BEGIN
  INSERT INTO m31_ro VALUES (1);
  RETURN 1;
END//
DELIMITER ;",
        )
        .await;
    assert_eq!(setup.status, ExecutionStatus::Succeeded, "{setup:?}");
    let (mut def, password) = db.definition();
    def.read_only = true;
    let b = bench(def, password).await;
    // The classifier refuses what it can see.
    for sql in [
        "DELETE FROM m31_ro",
        "INSERT INTO m31_ro VALUES (1)",
        "REPLACE INTO m31_ro VALUES (1)",
        "CREATE TEMPORARY TABLE t (a int)",
        "SELECT * FROM m31_ro FOR UPDATE",
        "SELECT * FROM m31_ro LOCK IN SHARE MODE",
        "SELECT a INTO @x FROM m31_ro",
        "SELECT GET_LOCK('m31', 0)",
        "SET SESSION TRANSACTION READ WRITE",
        "SET SESSION transaction_read_only = 0",
        "SET @@session.transaction_read_only = OFF",
        "SET tx_read_only = 0",
        "START TRANSACTION READ WRITE",
        "/*!40000 DELETE FROM m31_ro */",
        "/*M!100000 DELETE FROM m31_ro */",
        "HANDLER m31_ro OPEN",
        "XA START 'x'",
        "CALL nothing()",
    ] {
        let run = b.run("tab", sql).await;
        assert_eq!(
            run.error_code(),
            Some(ErrorCode::ReadOnlyViolation),
            "{sql}"
        );
    }
    let read = b
        .run(
            "tab",
            "SELECT COUNT(*) FROM m31_ro; SHOW TABLES; SET @x = 1",
        )
        .await;
    assert_eq!(read.status, ExecutionStatus::Succeeded, "{read:?}");
    // What the classifier cannot see, the read-only session refuses.
    let run = b.run("tab", "SELECT m31_write()").await;
    assert_eq!(
        run.error_code(),
        Some(ErrorCode::ReadOnlyViolation),
        "{run:?}"
    );
    assert_eq!(
        run.errors()[0]
            .server
            .as_ref()
            .and_then(|s| s.code.as_deref()),
        Some("1792")
    );
    let count = writer.run("setup", "SELECT COUNT(*) FROM m31_ro").await;
    assert_eq!(writer.column(&count.results[0], 0), [Some("0".into())]);
    drop(b);
    drop(writer);
    drop(db);
}

#[tokio::test]
async fn connection_failures_are_typed() {
    let Some(url) = mysql_url("connection_failures_are_typed") else {
        return;
    };
    let (def, password) = from_url(&url);
    let probe = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    let have_ssl = probe
        .query("SHOW VARIABLES LIKE 'have_ssl'", 1)
        .await
        .expect("have_ssl")
        .rows
        .first()
        .and_then(|r| r.get(1).cloned());
    probe.close().await;
    // MySQL 8.4 dropped the variable: it always offers TLS.
    let tls = have_ssl.is_none_or(|v| v == yadbe_lib::db::value::Value::Text("YES".into()));
    // Encryption as each mode asks; prefer falls back to plain text on a server without
    // TLS. The test server's certificate is not trusted by the OS.
    for (mode, encrypted) in [
        (TlsMode::Disable, false),
        (TlsMode::Prefer, tls),
        (TlsMode::Require, true),
    ] {
        let mut ok = def.clone();
        ok.tls_mode = mode;
        if mode == TlsMode::Require && !tls {
            let error = common::open(&ok, password.as_ref())
                .await
                .err()
                .expect("no TLS on the server");
            assert_eq!(error.code, ErrorCode::TlsNotSupported, "{error:?}");
            continue;
        }
        let conn = common::open(&ok, password.as_ref())
            .await
            .unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
        assert!(
            conn.server_version().starts_with("MySQL ")
                || conn.server_version().starts_with("MariaDB "),
            "{}",
            conn.server_version()
        );
        let cipher = conn
            .query("SHOW SESSION STATUS LIKE 'Ssl_cipher'", 1)
            .await
            .expect("cipher");
        let value = cipher.rows[0][1].clone();
        assert_eq!(
            value != yadbe_lib::db::value::Value::Text(String::new()),
            encrypted,
            "{mode:?}: {value:?}"
        );
        conn.close().await;
    }
    let mut strict = def.clone();
    strict.tls_mode = TlsMode::VerifyFull;
    strict.ca_cert_path = None;
    let error = common::open(&strict, password.as_ref())
        .await
        .err()
        .expect("certificate unknown to the OS");
    let expected = if tls {
        ErrorCode::TlsFailed
    } else {
        ErrorCode::TlsNotSupported
    };
    assert_eq!(error.code, expected, "{error:?}");

    let wrong = yadbe_lib::secrets::Secret::new("not-the-password".to_owned());
    let error = common::open(&def, Some(&wrong)).await.err().expect("auth");
    assert_eq!(error.code, ErrorCode::AuthFailed, "{error:?}");
    assert!(
        !format!("{error:?}").contains("not-the-password"),
        "no secret in errors"
    );

    let mut unknown = def.clone();
    unknown.database = "yadbe_no_such_db_m31".into();
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

    let mut nowhere = def.clone();
    nowhere.host = "no-such-host-m31.invalid".into();
    let error = common::open(&nowhere, password.as_ref())
        .await
        .err()
        .expect("dns");
    assert_eq!(error.code, ErrorCode::HostNotFound, "{error:?}");
}

#[tokio::test]
async fn verifies_the_server_certificate_with_a_custom_ca() {
    let test = "verifies_the_server_certificate_with_a_custom_ca";
    let (Some(url), Some(ca)) = (mysql_url(test), mysql_ca(test)) else {
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
    // The certificate names `localhost` only. With a CA, MySQL's `require` checks the name
    // too (mysql_async cannot skip it): stricter than the other engines, never weaker.
    let mut by_ip = def.clone();
    by_ip.host = "127.0.0.1".into();
    for mode in [TlsMode::Require, TlsMode::VerifyFull] {
        by_ip.tls_mode = mode;
        let error = common::open(&by_ip, password.as_ref())
            .await
            .err()
            .expect("host name mismatch");
        assert_eq!(error.code, ErrorCode::TlsFailed, "{mode:?}: {error:?}");
    }
    // Without a CA, `require` encrypts without verifying.
    by_ip.tls_mode = TlsMode::Require;
    by_ip.ca_cert_path = None;
    let conn = common::open(&by_ip, password.as_ref())
        .await
        .expect("encrypted, unverified");
    conn.close().await;
    let mut missing = def.clone();
    missing.ca_cert_path = Some("/nonexistent/ca.crt".into());
    let error = common::open(&missing, password.as_ref())
        .await
        .err()
        .expect("unreadable CA");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");
}

#[tokio::test]
async fn a_killed_session_ends_the_link() {
    let Some(url) = mysql_url("a_killed_session_ends_the_link") else {
        return;
    };
    let (def, password) = from_url(&url);
    let victim = common::open(&def, password.as_ref()).await.expect("victim");
    let id = victim
        .query("SELECT CONNECTION_ID()", 1)
        .await
        .expect("id")
        .scalar_text()
        .expect("a connection id");
    let killer = common::open(&def, password.as_ref()).await.expect("killer");
    killer.query(&format!("KILL {id}"), 0).await.expect("kill");
    killer.close().await;
    let error = victim.ping().await.expect_err("killed");
    assert_eq!(error.code, ErrorCode::ConnectionLost, "{error:?}");
    assert!(victim.link().is_lost());
}
