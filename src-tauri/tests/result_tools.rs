//! Result tools (M3-12) on every engine: aggregates of a selection (F-065). SQLite always
//! runs; PostgreSQL, SQL Server and MySQL run when `YADBE_TEST_PG_URL`,
//! `YADBE_TEST_MSSQL_URL`, `YADBE_TEST_MYSQL_URL` are set.

mod common;
mod query_common;

use common::{MysqlDatabase, blank, from_url, mssql_url, mysql_url, pg_definition, pg_url};
use query_common::{Bench, bench};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::session::query_model::{AggregateRange, ExecutionStatus, ResultSummary};

/// Three rows of `(a, b, c)`: a 64-bit maximum, decimals and a NULL in each of a and b, and
/// text. The same statement runs on every engine.
const ROWS: &str = "SELECT a, b, c FROM (\
    SELECT 1 AS a, 10.50 AS b, 'x' AS c \
    UNION ALL SELECT NULL, 0.25, 'y' \
    UNION ALL SELECT 9223372036854775807, -3.125, NULL \
    UNION ALL SELECT 2, NULL, 'z') AS t";

async fn result_of(b: &Bench) -> ResultSummary {
    let run = b.run("agg", ROWS).await;
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
    assert_eq!(run.results[0].row_count, 4);
    run.results[0].clone()
}

fn range(row_start: u32, row_end: u32, columns: &[u32]) -> AggregateRange {
    AggregateRange {
        row_start,
        row_end,
        columns: columns.to_vec(),
    }
}

/// What every engine agrees on. `decimals_exact` is false where `b` is a floating-point
/// column (SQLite has no decimal type).
fn check_aggregates(b: &Bench, result: &ResultSummary, decimals_exact: bool) {
    let id = result.result_id;
    // Column a, every row: 1 + 9223372036854775807 + 2 overflows 64 bits, and is exact.
    let a = b.runner.aggregate(id, &[range(0, 4, &[0])]).expect("a");
    assert_eq!((a.cells, a.non_null, a.numeric), (4, 3, 3));
    assert!(a.exact);
    assert_eq!(a.sum.as_deref(), Some("9223372036854775810"));
    assert_eq!(a.min.as_deref(), Some("1"));
    assert_eq!(a.max.as_deref(), Some("9223372036854775807"));
    assert_eq!(a.avg.as_deref(), Some("3074457345618258603.333333"));

    // Column b: decimals keep their digits; the NULL is skipped.
    let bb = b.runner.aggregate(id, &[range(0, 4, &[1])]).expect("b");
    assert_eq!((bb.cells, bb.non_null, bb.numeric), (4, 3, 3));
    assert_eq!(bb.exact, decimals_exact);
    assert_eq!(bb.sum.as_deref(), Some("7.625"));
    assert_eq!(bb.min.as_deref(), Some("-3.125"));
    assert_eq!(bb.max.as_deref(), Some("10.5"));

    // Both numbers, with an overlapping range counted once, and the text column alone.
    let both = b
        .runner
        .aggregate(id, &[range(0, 3, &[0, 1]), range(2, 4, &[1])])
        .expect("both");
    assert_eq!(both.cells, 3 * 2 + 1);
    assert_eq!(both.non_null, 2 + 3);
    let text = b.runner.aggregate(id, &[range(0, 4, &[2])]).expect("c");
    assert_eq!((text.cells, text.non_null, text.numeric), (4, 3, 0));
    assert_eq!(text.sum, None);
    // A text cell among numbers: no figures, the counts stay.
    let mixed = b
        .runner
        .aggregate(id, &[range(0, 4, &[0, 2])])
        .expect("mixed");
    assert_eq!((mixed.cells, mixed.non_null, mixed.numeric), (8, 6, 3));
    assert_eq!(mixed.sum, None);
}

async fn sqlite() -> (tempfile::TempDir, Bench) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("tools.sqlite");
    rusqlite::Connection::open(&path).expect("create");
    let mut def = blank(Engine::Sqlite, "tools.sqlite");
    def.file_path = path.display().to_string();
    (dir, bench(def, None).await)
}

#[tokio::test]
async fn sqlite_aggregates_a_selection() {
    let (_dir, b) = sqlite().await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, false);
}

#[tokio::test]
async fn postgres_aggregates_a_selection() {
    let Some(url) = pg_url("postgres_aggregates_a_selection") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let b = bench(def, password).await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, true);
}

#[tokio::test]
async fn mssql_aggregates_a_selection() {
    let Some(url) = mssql_url("mssql_aggregates_a_selection") else {
        return;
    };
    let (def, password) = from_url(&url);
    let b = bench(def, password).await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, true);
}

#[tokio::test]
async fn mysql_aggregates_a_selection() {
    let Some(url) = mysql_url("mysql_aggregates_a_selection") else {
        return;
    };
    let database = MysqlDatabase::create(&url, "rt").await;
    let (def, password) = database.definition();
    let b = bench(def, password).await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, true);
}
