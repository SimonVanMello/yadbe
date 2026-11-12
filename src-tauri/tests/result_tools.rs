//! Result tools (M3-12) on every engine: aggregates of a selection, client-side sort and
//! filter of a result (F-065). SQLite always
//! runs; PostgreSQL, SQL Server and MySQL run when `YADBE_TEST_PG_URL`,
//! `YADBE_TEST_MSSQL_URL`, `YADBE_TEST_MYSQL_URL` are set.

mod common;
mod query_common;

use common::{MysqlDatabase, blank, from_url, mssql_url, mysql_url, pg_definition, pg_url};
use query_common::{Bench, bench};
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::value::Value;
use yadbe_lib::export::model::ExportScope;
use yadbe_lib::export::source::QueryResultSource;
use yadbe_lib::session::query_model::{AggregateRange, ExecutionStatus, ResultSummary};
use yadbe_lib::session::result_view::{ResultViewSpec, ViewFilter, ViewFilterOp, ViewSort};

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

fn spec(sort: &[(u32, bool)], filters: Vec<ViewFilter>) -> ResultViewSpec {
    ResultViewSpec {
        sort: sort
            .iter()
            .map(|&(column, descending)| ViewSort { column, descending })
            .collect(),
        filters,
        match_case: false,
    }
}

fn condition(column: Option<u32>, op: ViewFilterOp, value: &str) -> ViewFilter {
    ViewFilter {
        column,
        op,
        value: value.to_owned(),
    }
}

/// Sort and filter of the same rows on every engine: numbers by value (not as text), the
/// 64-bit maximum exact, NULLs last, and the windows, cells and a selection export follow.
async fn check_view(b: &Bench, result: &ResultSummary) {
    let id = result.result_id;
    let text = |window: yadbe_lib::session::query_model::ResultWindow, column: usize| {
        window.columns[column].values.clone()
    };

    // Column a ascending: 1, 2, the maximum, then the NULL (last whatever the direction).
    let info = b
        .runner
        .set_result_view(id, spec(&[(0, false)], vec![]))
        .expect("sort");
    assert_eq!((info.row_count, info.source_rows), (4, 4));
    assert_eq!(
        text(b.window(id, 0, 10), 0),
        [
            Some("1".into()),
            Some("2".into()),
            Some("9223372036854775807".into()),
            None
        ]
    );
    b.runner
        .set_result_view(id, spec(&[(0, true)], vec![]))
        .expect("sort");
    assert_eq!(
        text(b.window(id, 0, 10), 0),
        [
            Some("9223372036854775807".into()),
            Some("2".into()),
            Some("1".into()),
            None
        ]
    );
    // The cell and the aggregate of the first shown rows are the maximum row's and the next.
    let first = b.runner.cell(id, 0, 0).expect("cell");
    // SQL Server types the literal as `numeric(19,0)`: an integer or a decimal, same digits.
    assert!(
        matches!(&first, Value::Int(t) | Value::Decimal(t) if t == "9223372036854775807"),
        "{first:?}"
    );
    let sum = b
        .runner
        .aggregate(
            id,
            &[AggregateRange {
                row_start: 0,
                row_end: 2,
                columns: vec![0],
            }],
        )
        .expect("aggregate");
    assert_eq!(sum.sum.as_deref(), Some("9223372036854775809"));

    // A filter on b: greater than 0 keeps 10.5 and 0.25; "any column contains" finds 'y'.
    let info = b
        .runner
        .set_result_view(
            id,
            spec(&[], vec![condition(Some(1), ViewFilterOp::Greater, "0")]),
        )
        .expect("filter");
    assert_eq!((info.row_count, info.source_rows), (2, 4));
    assert_eq!(
        text(b.window(id, 0, 10), 2),
        [Some("x".into()), Some("y".into())]
    );
    let info = b
        .runner
        .set_result_view(
            id,
            spec(&[], vec![condition(None, ViewFilterOp::Contains, "Y")]),
        )
        .expect("quick filter");
    assert_eq!(info.row_count, 1);
    assert_eq!(text(b.window(id, 0, 10), 2), [Some("y".into())]);

    // The selection export reads the rows as shown; the whole result keeps its own order.
    let range = ExportScope::Range {
        row_from: 0,
        row_to: 0,
        columns: vec![2],
    };
    let (_, rows) =
        QueryResultSource::preview(&b.runner, id, range, 10).expect("selection preview");
    assert_eq!(rows, [[Value::Text("y".into())]]);
    let (_, all) =
        QueryResultSource::preview(&b.runner, id, ExportScope::All, 10).expect("preview");
    assert_eq!(all.len(), 4);

    // Back to the result as it came.
    let info = b
        .runner
        .set_result_view(id, ResultViewSpec::default())
        .expect("clear");
    assert_eq!(info.row_count, 4);
    assert_eq!(text(b.window(id, 0, 10), 0)[0].as_deref(), Some("1"));
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
async fn sqlite_sorts_filters_and_aggregates_a_selection() {
    let (_dir, b) = sqlite().await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, false);
    check_view(&b, &result).await;
}

#[tokio::test]
async fn postgres_sorts_filters_and_aggregates_a_selection() {
    let Some(url) = pg_url("postgres_sorts_filters_and_aggregates_a_selection") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let b = bench(def, password).await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, true);
    check_view(&b, &result).await;
}

#[tokio::test]
async fn mssql_sorts_filters_and_aggregates_a_selection() {
    let Some(url) = mssql_url("mssql_sorts_filters_and_aggregates_a_selection") else {
        return;
    };
    let (def, password) = from_url(&url);
    let b = bench(def, password).await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, true);
    check_view(&b, &result).await;
}

#[tokio::test]
async fn mysql_sorts_filters_and_aggregates_a_selection() {
    let Some(url) = mysql_url("mysql_sorts_filters_and_aggregates_a_selection") else {
        return;
    };
    let database = MysqlDatabase::create(&url, "rt").await;
    let (def, password) = database.definition();
    let b = bench(def, password).await;
    let result = result_of(&b).await;
    check_aggregates(&b, &result, true);
    check_view(&b, &result).await;
}
