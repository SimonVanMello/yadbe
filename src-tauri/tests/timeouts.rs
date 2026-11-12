//! Statement timeout and keep-alive per connection (M3-12, F-014) on every engine: SQLite
//! always; PostgreSQL, SQL Server and MySQL when `YADBE_TEST_PG_URL`, `YADBE_TEST_MSSQL_URL`,
//! `YADBE_TEST_MYSQL_URL` are set. A statement that outlasts its connection's limit is
//! cancelled with the engine's own mechanism, reported as `statementTimeout`, and the tab's
//! connection stays usable.

mod common;
mod query_common;

use std::time::{Duration, Instant};

use common::{MysqlDatabase, blank, from_url, mssql_url, mysql_url, pg_definition, pg_url};
use query_common::{Bench, bench};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::session::query_model::{ExecuteScope, ExecutionStatus};

/// A statement that runs for far longer than the 1 s limit, and one that returns at once.
struct Sleeper {
    long: &'static str,
    quick: &'static str,
}

const SQLITE: Sleeper = Sleeper {
    long: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2000000000) SELECT count(*) FROM c",
    quick: "SELECT 41 + 1",
};
const POSTGRES: Sleeper = Sleeper {
    long: "SELECT pg_sleep(60)",
    quick: "SELECT 41 + 1",
};
const MSSQL: Sleeper = Sleeper {
    long: "WAITFOR DELAY '00:01:00'",
    quick: "SELECT 41 + 1",
};
const MYSQL: Sleeper = Sleeper {
    long: "SELECT SLEEP(60)",
    quick: "SELECT 41 + 1",
};

async fn check_timeout(b: &Bench, sleeper: &Sleeper) {
    // Within the limit: nothing happens.
    let quick = b.run("t", sleeper.quick).await;
    assert_eq!(quick.status, ExecutionStatus::Succeeded, "{quick:?}");

    // Past it: cancelled by the engine, reported as a timeout, quickly.
    let started = Instant::now();
    let run = b.run("t", sleeper.long).await;
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.status, ExecutionStatus::Failed, "{run:?}");
    assert_eq!(
        run.error_code(),
        Some(ErrorCode::StatementTimeout),
        "{run:?}"
    );
    let error = &run.errors()[0].error;
    assert!(error.message.en.contains("1 s limit"), "{error:?}");
    assert!(
        error.action.is_some(),
        "it suggests changing the connection"
    );

    // The connection survived the cancel: the same tab runs the next statement.
    let after = b.run("t", sleeper.quick).await;
    assert_eq!(after.status, ExecutionStatus::Succeeded, "{after:?}");
    assert_eq!(b.column(&after.results[0], 0), [Some("42".into())]);

    // The history records the failure with its code, like any other error.
    let recorded = b.history.entries();
    let last_long = recorded
        .iter()
        .rev()
        .find(|entry| entry.sql == sleeper.long)
        .expect("recorded");
    assert_eq!(
        last_long.outcome.as_ref().err().map(|e| e.code),
        Some(ErrorCode::StatementTimeout)
    );

    // In a script the statement past its limit stops the script: what follows does not run.
    // (SQL Server sends a script as one batch, which the timeout cuts as a whole.)
    let script = format!("{}; {}; {}", sleeper.quick, sleeper.long, sleeper.quick);
    let run = b.run_scoped("script", &script, ExecuteScope::All).await;
    assert_eq!(run.status, ExecutionStatus::Failed, "{run:?}");
    assert_eq!(
        run.error_code(),
        Some(ErrorCode::StatementTimeout),
        "{run:?}"
    );
    assert!(run.results.len() <= 2, "{run:?}");
}

/// The keep-alive ping is a real round trip on a network engine, and is not written to the
/// statement log (it would fill it); a file engine has nothing to keep open.
async fn check_keep_alive(b: &Bench) {
    let conn = b
        .manager
        .session(&b.connection_id)
        .and_then(|session| session.sql())
        .expect("connection");
    let before = b.log.entries().len();
    conn.keep_alive().await.expect("keep-alive ping");
    assert_eq!(b.log.entries().len(), before, "not recorded");
    // The connection is still good afterwards.
    conn.ping().await.expect("ping");
}

fn limited(mut def: ConnectionDefinition) -> ConnectionDefinition {
    def.statement_timeout_secs = Some(1);
    def
}

#[tokio::test]
async fn sqlite_cancels_a_statement_past_its_timeout() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("timeouts.sqlite");
    rusqlite::Connection::open(&path).expect("create");
    let mut def = blank(Engine::Sqlite, "timeouts.sqlite");
    def.file_path = path.display().to_string();
    let b = bench(limited(def), None).await;
    check_timeout(&b, &SQLITE).await;
    check_keep_alive(&b).await;
}

#[tokio::test]
async fn postgres_cancels_a_statement_past_its_timeout() {
    let Some(url) = pg_url("postgres_cancels_a_statement_past_its_timeout") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let b = bench(limited(def), password).await;
    check_timeout(&b, &POSTGRES).await;
    check_keep_alive(&b).await;
}

#[tokio::test]
async fn mssql_cancels_a_statement_past_its_timeout() {
    let Some(url) = mssql_url("mssql_cancels_a_statement_past_its_timeout") else {
        return;
    };
    let (def, password) = from_url(&url);
    let b = bench(limited(def), password).await;
    check_timeout(&b, &MSSQL).await;
    check_keep_alive(&b).await;
}

#[tokio::test]
async fn mysql_cancels_a_statement_past_its_timeout() {
    let Some(url) = mysql_url("mysql_cancels_a_statement_past_its_timeout") else {
        return;
    };
    let database = MysqlDatabase::create(&url, "to").await;
    let (def, password) = database.definition();
    let b = bench(limited(def), password).await;
    check_timeout(&b, &MYSQL).await;
    check_keep_alive(&b).await;
}

/// A connection without a timeout is left alone: the same wait is not cut short.
#[tokio::test]
async fn a_connection_without_a_timeout_is_not_cut_short() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("free.sqlite");
    rusqlite::Connection::open(&path).expect("create");
    let mut def = blank(Engine::Sqlite, "free.sqlite");
    def.file_path = path.display().to_string();
    let b = bench(def, None).await;
    // About 2 s of work: longer than the 1 s the other connections allow.
    let started = Instant::now();
    let run = b
        .run(
            "t",
            "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 12000000) SELECT count(*) FROM c",
        )
        .await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert!(
        started.elapsed() > Duration::from_millis(1_000),
        "{:?}",
        started.elapsed()
    );
}
