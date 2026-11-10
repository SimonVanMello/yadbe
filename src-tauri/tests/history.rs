//! History (M1-6) through the real `QueryRunner`: recording of succeeded, failed, cancelled
//! and refused statements, per-connection opt-out, `history-changed`. SQLite always runs;
//! PostgreSQL when `YADBE_TEST_PG_URL` is set.

mod common;
mod query_common;

use std::sync::Arc;
use std::time::Duration;

use common::{blank, pg_definition, pg_url};
use query_common::{Bench, bench_with_history};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::events::BackendEvent;
use yadbe_lib::session::history_writer::StoreHistory;
use yadbe_lib::session::query_model::ExecuteScope;
use yadbe_lib::store::{HistoryOutcome, HistoryQuery, HistoryRetention, HistoryScope};

async fn with_history(
    definition: yadbe_lib::db::config::ConnectionDefinition,
    password: Option<yadbe_lib::secrets::Secret>,
) -> (Bench, Arc<StoreHistory>) {
    let slot = Arc::new(std::sync::Mutex::new(None));
    let out = Arc::clone(&slot);
    let bench = bench_with_history(definition, password, move |store, sink| {
        let history =
            StoreHistory::new(Arc::clone(store), sink.clone(), HistoryRetention::default());
        *out.lock().expect("slot") = Some(Arc::clone(&history));
        history
    })
    .await;
    let history = slot.lock().expect("slot").take().expect("history");
    (bench, history)
}

fn sqlite_definition(
    dir: &tempfile::TempDir,
    read_only: bool,
) -> yadbe_lib::db::config::ConnectionDefinition {
    let path = dir.path().join("app.sqlite");
    rusqlite::Connection::open(&path)
        .expect("create")
        .execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);")
        .expect("fixture");
    let mut def = blank(Engine::Sqlite, "app.sqlite");
    def.file_path = path.display().to_string();
    def.read_only = read_only;
    def
}

fn all(b: &Bench) -> Vec<yadbe_lib::store::HistoryRow> {
    b.store
        .search_history(&HistoryQuery::default())
        .expect("search")
        .rows
}

const LONG_SQLITE: &str =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";

#[tokio::test]
async fn records_success_failure_and_cancellation_on_sqlite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (b, history) = with_history(sqlite_definition(&dir, false), None).await;

    b.run(
        "tab",
        "INSERT INTO items (name) VALUES ('alpha'), ('beta');\nSELECT * FROM items ORDER BY id",
    )
    .await;
    b.run("tab", "SELECT nope FROM items").await;
    let (id, _) = b
        .start(b.request("tab2", LONG_SQLITE, ExecuteScope::All))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(300)).await;
    b.runner.cancel("tab2").await;
    b.wait(id).await;
    history.flush();

    let rows = all(&b);
    assert_eq!(rows.len(), 4, "{rows:#?}");
    // Newest first.
    let cancelled = &rows[0];
    assert_eq!(cancelled.outcome, HistoryOutcome::Cancelled);
    assert_eq!(cancelled.sql, LONG_SQLITE);
    let failed = &rows[1];
    assert_eq!(failed.outcome, HistoryOutcome::Error);
    assert_eq!(failed.sql, "SELECT nope FROM items");
    assert!(
        failed
            .error_message
            .as_deref()
            .is_some_and(|m| m.contains("nope")),
        "{:?}",
        failed.error_message
    );
    let select = &rows[2];
    assert_eq!(select.outcome, HistoryOutcome::Ok);
    assert_eq!(select.rows, Some(2.0));
    assert_eq!(select.connection_name, "app.sqlite");
    assert_eq!(select.engine, Engine::Sqlite);
    assert_eq!(select.database, None, "a SQLite file has no database name");
    let insert = &rows[3];
    assert_eq!(insert.rows, Some(2.0), "rows affected");

    let found = b
        .store
        .search_history(&HistoryQuery {
            text: Some("ite".into()),
            ..HistoryQuery::default()
        })
        .expect("search");
    assert_eq!(found.rows.len(), 3, "prefix match on `items`");
    let errors = b
        .store
        .search_history(&HistoryQuery {
            outcomes: vec![HistoryOutcome::Error, HistoryOutcome::Cancelled],
            ..HistoryQuery::default()
        })
        .expect("search");
    assert_eq!(errors.rows.len(), 2);
}

#[tokio::test]
async fn read_only_refusals_are_recorded_as_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (b, history) = with_history(sqlite_definition(&dir, true), None).await;
    b.run("tab", "DELETE FROM items").await;
    history.flush();
    let rows = all(&b);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].outcome, HistoryOutcome::Refused);
    assert_eq!(rows[0].sql, "DELETE FROM items");
    assert!(rows[0].error_message.is_some());
}

#[tokio::test]
async fn a_connection_that_opted_out_leaves_no_history() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut def = sqlite_definition(&dir, false);
    def.history_enabled = false;
    let (b, history) = with_history(def.clone(), None).await;
    b.run("tab", "SELECT 1").await;
    history.flush();
    assert!(all(&b).is_empty(), "opted out");

    // Turning it back on takes effect for the next statements, no reconnect needed.
    def.history_enabled = true;
    b.store
        .update_connection(&b.connection_id, &def)
        .expect("update");
    b.run("tab", "SELECT 2").await;
    history.flush();
    let rows = all(&b);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].sql, "SELECT 2");
}

#[tokio::test]
async fn history_survives_the_deletion_of_its_connection_and_can_be_cleared() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (b, history) = with_history(sqlite_definition(&dir, false), None).await;
    b.run("tab", "SELECT 1").await;
    b.run("tab", "SELECT 2").await;
    history.flush();
    b.store.delete_connection(&b.connection_id).expect("delete");
    let rows = all(&b);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].connection_name, "app.sqlite", "name snapshot");

    let scope = HistoryScope {
        connection_id: Some(b.connection_id.clone()),
        ..HistoryScope::default()
    };
    assert_eq!(b.store.count_history(&scope).expect("count"), 2);
    assert_eq!(b.store.clear_history(&scope).expect("clear"), 2);
    assert!(all(&b).is_empty());
}

#[tokio::test]
async fn announces_changes_once_per_burst() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (b, history) = with_history(sqlite_definition(&dir, false), None).await;
    for i in 0..5 {
        b.run("tab", &format!("SELECT {i}")).await;
    }
    history.flush();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let events = b
        .sink
        .events()
        .into_iter()
        .filter(|e| matches!(e, BackendEvent::HistoryChanged(_)))
        .count();
    assert!(
        (1..=3).contains(&events),
        "debounced, but announced: {events}"
    );
}

#[tokio::test]
async fn records_on_postgres() {
    let Some(url) = pg_url("records_on_postgres") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let (b, history) = with_history(def, password).await;
    b.run("tab", "SELECT 1 AS one, 'x' AS two").await;
    b.run("tab", "SELECT * FROM table_that_does_not_exist")
        .await;
    let (id, _) = b
        .start(b.request("tab2", "SELECT pg_sleep(30)", ExecuteScope::All))
        .expect("start");
    tokio::time::sleep(Duration::from_millis(300)).await;
    b.runner.cancel("tab2").await;
    b.wait(id).await;
    history.flush();

    let rows = all(&b);
    assert_eq!(rows.len(), 3, "{rows:#?}");
    assert_eq!(rows[0].outcome, HistoryOutcome::Cancelled);
    assert_eq!(rows[1].outcome, HistoryOutcome::Error);
    assert!(
        rows[1]
            .error_message
            .as_deref()
            .is_some_and(|m| m.contains("table_that_does_not_exist"))
    );
    assert_eq!(rows[2].outcome, HistoryOutcome::Ok);
    assert_eq!(rows[2].rows, Some(1.0));
    assert_eq!(rows[2].engine, Engine::Postgres);
    assert!(
        rows[2].database.as_deref().is_some_and(|d| !d.is_empty()),
        "the connection's own database"
    );
}
