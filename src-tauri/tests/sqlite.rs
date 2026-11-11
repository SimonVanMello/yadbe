//! SQLite driver and sessions on a fixture file. Always runs.

mod common;

use std::time::Duration;

use common::{blank, harness, open};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::{Value, ValueKind};
use yadbe_lib::session::ConnectionState;
use yadbe_lib::session::statement_log::StatementOutcome;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("app.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create fixture");
    conn.execute_batch(include_str!("fixtures/sqlite_basic.sql"))
        .expect("fixture script");
    (dir, path)
}

fn definition(path: &std::path::Path) -> yadbe_lib::db::config::ConnectionDefinition {
    let mut def = blank(Engine::Sqlite, "app.sqlite");
    def.file_path = path.display().to_string();
    def
}

#[tokio::test]
async fn connects_reads_the_version_and_decodes_rows() {
    let (_dir, path) = fixture();
    let conn = open(&definition(&path), None).await.expect("connect");
    assert!(
        conn.server_version().starts_with("SQLite 3."),
        "{}",
        conn.server_version()
    );
    conn.ping().await.expect("ping");

    let result = conn
        .query("SELECT * FROM items ORDER BY id", 10)
        .await
        .expect("query");
    let kinds: Vec<ValueKind> = result.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ValueKind::Int,
            ValueKind::Text,
            ValueKind::Decimal,
            ValueKind::Float,
            ValueKind::Bytes,
            ValueKind::Bool,
            ValueKind::Timestamp
        ]
    );
    assert_eq!(result.columns[2].type_name, "NUMERIC(10, 2)");
    assert_eq!(result.rows.len(), 3);
    assert_eq!(
        result.rows[0],
        vec![
            Value::Int("1".into()),
            Value::Text("first".into()),
            Value::Float("12.5".into()),
            Value::Float("0.25".into()),
            Value::Bytes("00ff".into()),
            Value::Int("1".into()),
            Value::Text("2025-01-02 03:04:05".into()),
        ]
    );
    assert_eq!(result.rows[1][2], Value::Null);
    assert_eq!(result.rows[2][0], Value::Int("9223372036854775807".into()));
    assert_eq!(result.rows[2][3], Value::Float("1e300".into()));
    assert!(!result.truncated);

    let limited = conn.query("SELECT id FROM items", 2).await.expect("query");
    assert_eq!(limited.rows.len(), 2);
    assert!(limited.truncated);

    let update = conn
        .query("UPDATE items SET active = 0", 0)
        .await
        .expect("update");
    assert_eq!(update.rows_affected, Some(3));

    let error = conn
        .query("SELECT nope FROM items", 1)
        .await
        .expect_err("bad column");
    assert_eq!(error.code, ErrorCode::QueryFailed);
    assert!(error.detail.unwrap_or_default().contains("no such column"));
}

#[tokio::test]
async fn missing_file_is_not_created() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("typo.sqlite");
    let error = open(&definition(&path), None).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::FileNotFound);
    assert!(!path.exists(), "a missing database must not be created");
}

#[tokio::test]
async fn a_file_that_is_not_a_database_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("notes.txt");
    std::fs::write(
        &path,
        "these are not the pages you are looking for".repeat(100),
    )
    .expect("write");
    let error = open(&definition(&path), None).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::NotADatabase);
}

#[tokio::test]
async fn cancel_interrupts_a_running_statement() {
    let (_dir, path) = fixture();
    let conn = open(&definition(&path), None).await.expect("connect");
    let cancel = conn.cancel_handle();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel().await
    });
    let endless = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) \
                   SELECT count(*) FROM n";
    let error = conn.query(endless, 1).await.expect_err("interrupted");
    assert_eq!(error.code, ErrorCode::Cancelled);
    canceller.await.expect("join").expect("cancel");
}

#[tokio::test]
async fn manager_opens_logs_and_closes_a_saved_connection() {
    let (_dir, path) = fixture();
    let h = harness();
    let saved = h
        .store
        .create_connection(&definition(&path).normalized().expect("valid"))
        .expect("save");

    let info = h.manager.connect(&saved.id, None).await.expect("connect");
    assert_eq!(info.state, ConnectionState::Connected);
    assert!(
        info.server_version
            .unwrap_or_default()
            .starts_with("SQLite")
    );
    assert_eq!(
        h.states(&saved.id),
        vec![ConnectionState::Connecting, ConnectionState::Connected]
    );
    // Connecting again returns the open session.
    let again = h.manager.connect(&saved.id, None).await.expect("connect");
    assert_eq!(again.state, ConnectionState::Connected);
    assert_eq!(h.manager.sessions().len(), 1);

    let session = h.manager.session(&saved.id).expect("session");
    let rows = session
        .query("SELECT count(*) FROM items", 1)
        .await
        .expect("query");
    assert_eq!(rows.rows[0][0], Value::Int("3".into()));

    let log = h.log.entries();
    let sqls: Vec<&str> = log.iter().map(|e| e.sql.as_str()).collect();
    assert_eq!(
        sqls,
        vec![
            "PRAGMA schema_version",
            "PRAGMA foreign_keys = ON",
            "SELECT sqlite_version()",
            "SELECT count(*) FROM items"
        ]
    );
    assert!(
        log.iter()
            .all(|e| e.connection_id.as_deref() == Some(saved.id.as_str()))
    );
    assert!(matches!(
        log[3].outcome,
        StatementOutcome::Ok { rows: Some(1.0) }
    ));
    assert!(
        h.store
            .connection(&saved.id)
            .expect("saved")
            .last_connected_at
            .is_some()
    );

    h.manager.disconnect(&saved.id).await;
    assert_eq!(h.states(&saved.id).last(), Some(&ConnectionState::Closed));
    assert!(h.manager.sessions().is_empty());
    assert_eq!(
        session.query("SELECT 1", 1).await.map_err(|e| e.code).err(),
        Some(ErrorCode::NotConnected)
    );
}

#[tokio::test]
async fn a_failed_first_connection_closes_with_the_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let h = harness();
    let saved = h
        .store
        .create_connection(
            &definition(&dir.path().join("gone.sqlite"))
                .normalized()
                .expect("valid"),
        )
        .expect("save");
    let error = h.manager.connect(&saved.id, None).await.expect_err("fails");
    assert_eq!(error.code, ErrorCode::FileNotFound);
    assert_eq!(
        h.states(&saved.id),
        vec![ConnectionState::Connecting, ConnectionState::Closed]
    );
    assert!(h.manager.sessions().is_empty());
}

#[tokio::test]
async fn testing_an_unsaved_definition_reports_the_version() {
    let (_dir, path) = fixture();
    let h = harness();
    let result = h
        .manager
        .test("req-1".into(), definition(&path), None, None)
        .await
        .expect("test");
    assert!(result.server_version.starts_with("SQLite"));
    let log = h.log.entries();
    assert!(log.iter().all(|e| e.connection_id.is_none()));
    assert_eq!(log.last().map(|e| e.sql.as_str()), Some("SELECT 1"));
}

#[tokio::test]
async fn every_engine_ships_a_driver() {
    let h = harness();
    let available: Vec<Engine> = h
        .manager
        .engines()
        .iter()
        .filter(|e| e.available)
        .map(|e| e.engine)
        .collect();
    assert_eq!(available, Engine::ALL.to_vec());
}
