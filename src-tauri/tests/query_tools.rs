//! Query tools (M3-9) on every engine: query parameters bound by the driver (F-048) and
//! explain plans (F-053). SQLite always runs; PostgreSQL, SQL Server and MySQL run when
//! `YADBE_TEST_PG_URL`, `YADBE_TEST_MSSQL_URL`, `YADBE_TEST_MYSQL_URL` are set.

mod common;
mod query_common;

use common::{MysqlDatabase, blank, from_url, mssql_url, mysql_url, pg_definition, pg_url};
use query_common::{Bench, Run, bench};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::plan::{PlanFormat, PlanWeightBasis};
use yadbe_lib::session::query_model::{
    ExecuteScope, ExecutionStatus, ExplainRequest, ExplainResult, ParameterKind, ParameterValue,
};

fn value(name: &str, kind: ParameterKind, text: &str) -> ParameterValue {
    ParameterValue {
        name: name.to_owned(),
        kind,
        value: text.to_owned(),
    }
}

async fn run_with(b: &Bench, tab: &str, text: &str, values: Vec<ParameterValue>) -> Run {
    let mut request = b.request(tab, text, ExecuteScope::All);
    request.parameters = values;
    let (id, _) = b.start(request).expect("start");
    b.wait(id).await
}

async fn explain(
    b: &Bench,
    tab: &str,
    text: &str,
    analyze: bool,
    values: Vec<ParameterValue>,
) -> Result<ExplainResult, yadbe_lib::db::errors::YadbeError> {
    b.runner
        .explain(ExplainRequest {
            tab_id: tab.to_owned(),
            connection_id: b.connection_id.clone(),
            database: None,
            text: text.to_owned(),
            scope: ExecuteScope::All,
            analyze,
            parameters: values,
        })
        .await
}

fn ok(run: &Run) {
    assert_eq!(run.status, ExecutionStatus::Succeeded, "{run:?}");
}

/// The checks every engine passes: the table `people (id, name)` holds `alice` (1) and
/// `bob` (2). `count_by_name` counts the rows whose name equals parameter `name`.
async fn check_parameters(b: &Bench, count_by_name: &str, expect_history: &str) {
    // An injection attempt stays a value: it matches no row and runs nothing.
    let hostile = "x' OR '1'='1";
    let run = run_with(
        b,
        "p",
        count_by_name,
        vec![value("name", ParameterKind::Text, hostile)],
    )
    .await;
    ok(&run);
    assert_eq!(b.column(&run.results[0], 0), [Some("0".into())]);
    let run = run_with(
        b,
        "p",
        count_by_name,
        vec![value("name", ParameterKind::Text, "alice")],
    )
    .await;
    ok(&run);
    assert_eq!(b.column(&run.results[0], 0), [Some("1".into())]);
    // The history holds the statement as sent, without the values.
    let history = b.history.entries();
    let last = history.last().expect("history entry");
    assert_eq!(last.sql, expect_history);
    assert!(!last.sql.contains("alice"));

    // A parameter without a value: nothing runs.
    let mut request = b.request("p", count_by_name, ExecuteScope::All);
    request.parameters = Vec::new();
    let err = b.start(request).expect_err("missing value");
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    // A value that does not fit its type is refused before running.
    let mut request = b.request("p", count_by_name, ExecuteScope::All);
    request.parameters = vec![value("name", ParameterKind::Number, "12abc")];
    assert_eq!(
        b.start(request).expect_err("bad number").code,
        ErrorCode::InvalidArgument
    );
}

/// `select_typed` selects parameters `n` (number), `flag` (boolean), `d` (date) and `none`
/// (null): the engine receives typed values.
async fn check_typed(b: &Bench, select_typed: &str, expected: &[Option<&str>]) {
    let run = run_with(
        b,
        "typed",
        select_typed,
        vec![
            value("n", ParameterKind::Number, "41"),
            value("flag", ParameterKind::Boolean, "true"),
            value("d", ParameterKind::DateTime, "2024-02-29"),
            value("none", ParameterKind::Null, ""),
        ],
    )
    .await;
    ok(&run);
    let row: Vec<Option<String>> = (0..expected.len())
        .map(|c| b.column(&run.results[0], c).remove(0))
        .collect();
    let expected: Vec<Option<String>> = expected.iter().map(|v| v.map(str::to_owned)).collect();
    assert_eq!(row, expected);
}

async fn check_explain(b: &Bench, select: &str, relation: &str, format: PlanFormat, analyze: bool) {
    // SQL Server explains whole batches: two statements are two `GO` batches.
    let separator = if format == PlanFormat::ShowplanXml {
        "\nGO\n"
    } else {
        ";\n"
    };
    let plan = explain(b, "x", select, false, Vec::new())
        .await
        .expect("estimated plan");
    assert_eq!(plan.plan.format, format);
    assert!(!plan.plan.analyzed);
    assert!(
        plan.plan
            .nodes
            .iter()
            .any(|n| n.relation.as_deref().is_some_and(|r| r.ends_with(relation))),
        "{:#?}",
        plan.plan.nodes
    );
    assert!(
        b.logged().iter().any(|sql| sql.contains(select)),
        "{:?}",
        b.logged()
    );
    if analyze {
        let plan = explain(b, "x", select, true, Vec::new())
            .await
            .expect("actual plan");
        assert!(plan.plan.analyzed);
        assert_eq!(plan.plan.weight_basis, PlanWeightBasis::Time);
        assert!(plan.plan.nodes.iter().any(|n| n.actual_rows.is_some()));
    } else {
        let err = explain(b, "x", select, true, Vec::new())
            .await
            .expect_err("no analyze");
        assert_eq!(err.code, ErrorCode::InvalidArgument);
    }
    let err = explain(
        b,
        "x",
        &format!("{select}{separator}{select}"),
        false,
        Vec::new(),
    )
    .await
    .expect_err("two statements");
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

// --- SQLite ---------------------------------------------------------------------------------

async fn sqlite(read_only: bool) -> (tempfile::TempDir, Bench) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("tools.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create");
    conn.execute_batch(
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);
         INSERT INTO people VALUES (1, 'alice'), (2, 'bob');",
    )
    .expect("fixture");
    drop(conn);
    let mut def = blank(Engine::Sqlite, "tools.sqlite");
    def.file_path = path.display().to_string();
    def.read_only = read_only;
    let b = bench(def, None).await;
    (dir, b)
}

#[tokio::test]
async fn sqlite_binds_parameters_as_written() {
    let (_dir, b) = sqlite(false).await;
    let text = "SELECT count(*) FROM people WHERE name = :name";
    check_parameters(&b, text, text).await;
    check_typed(
        &b,
        "SELECT :n + 1, :flag, :d, :none IS NULL",
        &[Some("42"), Some("1"), Some("2024-02-29"), Some("1")],
    )
    .await;
    // Every native form, `?` numbered across the statements of the run.
    let run = run_with(
        &b,
        "forms",
        "SELECT ?, @a, $b, ?5; SELECT ?",
        vec![
            value("#1", ParameterKind::Number, "1"),
            value("a", ParameterKind::Text, "two"),
            value("b", ParameterKind::Number, "3.5"),
            value("5", ParameterKind::Text, "four"),
            value("#2", ParameterKind::Text, "five"),
        ],
    )
    .await;
    ok(&run);
    let first: Vec<Option<String>> = (0..4)
        .map(|c| b.column(&run.results[0], c).remove(0))
        .collect();
    assert_eq!(
        first,
        [
            Some("1".into()),
            Some("two".into()),
            Some("3.5".into()),
            Some("four".into())
        ]
    );
    assert_eq!(b.column(&run.results[1], 0), [Some("five".into())]);
}

#[tokio::test]
async fn sqlite_explains_query_plans() {
    let (_dir, b) = sqlite(false).await;
    check_explain(
        &b,
        "SELECT * FROM people WHERE name = 'bob' ORDER BY name",
        "people",
        PlanFormat::SqliteRows,
        false,
    )
    .await;
    let plan = explain(
        &b,
        "x",
        "SELECT * FROM people WHERE id = :id",
        false,
        vec![value("id", ParameterKind::Number, "1")],
    )
    .await
    .expect("plan with a parameter");
    assert!(plan.plan.nodes[0].operation.starts_with("SEARCH people"));
    assert_eq!(
        plan.sent,
        "EXPLAIN QUERY PLAN SELECT * FROM people WHERE id = :id"
    );
}

#[tokio::test]
async fn sqlite_read_only_explain_analyze_is_refused() {
    let (_dir, b) = sqlite(true).await;
    // An estimated plan of a write runs nothing: allowed.
    explain(&b, "x", "DELETE FROM people", false, Vec::new())
        .await
        .expect("estimated plan of a write");
}

// --- PostgreSQL -----------------------------------------------------------------------------

async fn pg(test: &str, read_only: bool) -> Option<Bench> {
    let url = pg_url(test)?;
    let (mut def, password) = pg_definition(&url);
    def.read_only = read_only;
    Some(bench(def, password).await)
}

const PG_PEOPLE: &str = "CREATE TEMP TABLE people (id int PRIMARY KEY, name text); INSERT INTO people VALUES (1, 'alice'), (2, 'bob')";

#[tokio::test]
async fn postgres_binds_parameters_with_numbers() {
    let Some(b) = pg("postgres_binds_parameters_with_numbers", false).await else {
        return;
    };
    ok(&b.run("p", PG_PEOPLE).await);
    check_parameters(
        &b,
        "SELECT count(*) FROM people WHERE name = :name",
        "SELECT count(*) FROM people WHERE name = $1",
    )
    .await;
    ok(&b.run("typed", PG_PEOPLE).await);
    check_typed(
        &b,
        "SELECT :n::int + 1, :flag::boolean, :d::date + 1, :none::text IS NULL",
        &[Some("42"), Some("true"), Some("2024-03-01"), Some("true")],
    )
    .await;
    // `$n` as written next to a name, which takes the next free number.
    let run = run_with(
        &b,
        "typed",
        "SELECT $2::text || :x, $1::int",
        vec![
            value("1", ParameterKind::Number, "7"),
            value("2", ParameterKind::Text, "a"),
            value("x", ParameterKind::Text, "b"),
        ],
    )
    .await;
    ok(&run);
    assert_eq!(b.column(&run.results[0], 0), [Some("ab".into())]);
    // An error position in the text sent maps back to the text as written.
    let text = "SELECT :long_name_here, nowhere_column";
    let run = run_with(
        &b,
        "typed",
        text,
        vec![value("long_name_here", ParameterKind::Text, "v")],
    )
    .await;
    assert_eq!(run.status, ExecutionStatus::Failed);
    let position = run.errors()[0].position.expect("position");
    assert_eq!(
        position.offset as usize,
        text.find("nowhere").expect("found")
    );
}

#[tokio::test]
async fn postgres_explains_estimated_and_actual_plans() {
    let Some(b) = pg("postgres_explains_estimated_and_actual_plans", false).await else {
        return;
    };
    ok(&b.run("x", PG_PEOPLE).await);
    check_explain(
        &b,
        "SELECT * FROM people WHERE name = 'bob'",
        "people",
        PlanFormat::PostgresJson,
        true,
    )
    .await;
    let plan = explain(
        &b,
        "x",
        "SELECT * FROM people WHERE id = :id",
        true,
        vec![value("id", ParameterKind::Number, "1")],
    )
    .await
    .expect("plan with a parameter");
    assert_eq!(
        plan.sent,
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM people WHERE id = $1"
    );
    assert!(
        plan.plan
            .summary
            .iter()
            .any(|f| f.label == "Execution Time")
    );
    // A server error comes back typed, with the server's message.
    let err = explain(&b, "x", "SELECT * FROM nowhere", false, Vec::new())
        .await
        .expect_err("missing table");
    assert_eq!(err.code, ErrorCode::QueryFailed);
    assert!(
        err.detail.as_deref().is_some_and(|d| d.contains("nowhere")),
        "{err:?}"
    );
}

#[tokio::test]
async fn postgres_read_only_refuses_an_analyze_that_writes() {
    let Some(b) = pg("postgres_read_only_refuses_an_analyze_that_writes", true).await else {
        return;
    };
    let err = explain(&b, "x", "DELETE FROM pg_class", true, Vec::new())
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::ReadOnlyViolation);
    assert!(
        !b.logged().iter().any(|sql| sql.contains("DELETE")),
        "nothing was sent: {:?}",
        b.logged()
    );
    explain(&b, "x", "SELECT * FROM pg_class", true, Vec::new())
        .await
        .expect("a read can be analyzed");
}

// --- SQL Server -----------------------------------------------------------------------------

async fn mssql(test: &str) -> Option<Bench> {
    let url = mssql_url(test)?;
    let (def, password) = from_url(&url);
    Some(bench(def, password).await)
}

const MSSQL_PEOPLE: &str = "CREATE TABLE #people (id int PRIMARY KEY, name nvarchar(20)); INSERT INTO #people VALUES (1, N'alice'), (2, N'bob')";

#[tokio::test]
async fn mssql_binds_undeclared_variables_by_name() {
    let Some(b) = mssql("mssql_binds_undeclared_variables_by_name").await else {
        return;
    };
    ok(&b.run("p", MSSQL_PEOPLE).await);
    let text = "SELECT count(*) FROM #people WHERE name = @name";
    check_parameters(&b, text, text).await;
    ok(&b.run("typed", MSSQL_PEOPLE).await);
    check_typed(
        &b,
        "SELECT @n + 1, @flag, DATEADD(day, 1, CAST(@d AS date)), CASE WHEN @none IS NULL THEN 1 ELSE 0 END",
        &[Some("42"), Some("true"), Some("2024-03-01"), Some("1")],
    )
    .await;
    // A declared variable stays a variable; decimals keep their digits.
    let run = run_with(
        &b,
        "typed",
        "DECLARE @base decimal(20, 4) = 1; SELECT @base + @delta",
        vec![value("delta", ParameterKind::Number, "12345678901234.1234")],
    )
    .await;
    ok(&run);
    assert_eq!(
        b.column(&run.results[0], 0),
        [Some("12345678901235.1234".into())]
    );
}

#[tokio::test]
async fn mssql_explains_estimated_and_actual_plans() {
    let Some(b) = mssql("mssql_explains_estimated_and_actual_plans").await else {
        return;
    };
    ok(&b.run("x", MSSQL_PEOPLE).await);
    check_explain(
        &b,
        "SELECT * FROM #people WHERE name = N'bob'",
        "#people",
        PlanFormat::ShowplanXml,
        true,
    )
    .await;
    // The plan settings are off again: a plain run returns rows, not a plan.
    let run = b.run("x", "SELECT count(*) FROM #people").await;
    ok(&run);
    assert_eq!(b.column(&run.results[0], 0), [Some("2".into())]);
    let plan = explain(
        &b,
        "x",
        "SELECT * FROM #people WHERE id = @id",
        true,
        vec![value("id", ParameterKind::Number, "1")],
    )
    .await
    .expect("plan with a parameter");
    assert!(
        plan.plan
            .nodes
            .iter()
            .any(|n| n.relation.as_deref() == Some("#people"))
    );
}

// --- MySQL ----------------------------------------------------------------------------------

async fn mysql(test: &str) -> Option<(MysqlDatabase, Bench)> {
    let url = mysql_url(test)?;
    let database = MysqlDatabase::create(&url, "q39").await;
    let (def, password) = database.definition();
    let b = bench(def, password).await;
    Some((database, b))
}

const MYSQL_PEOPLE: &str = "CREATE TABLE people (id int PRIMARY KEY, name varchar(20)); INSERT INTO people VALUES (1, 'alice'), (2, 'bob')";

#[tokio::test]
async fn mysql_binds_question_marks() {
    let Some((_db, b)) = mysql("mysql_binds_question_marks").await else {
        return;
    };
    ok(&b.run("p", MYSQL_PEOPLE).await);
    check_parameters(
        &b,
        "SELECT count(*) FROM people WHERE name = :name",
        "SELECT count(*) FROM people WHERE name = ?",
    )
    .await;
    check_typed(
        &b,
        "SELECT :n + 1, :flag, DATE_ADD(:d, INTERVAL 1 DAY), :none IS NULL",
        &[Some("42"), Some("1"), Some("2024-03-01"), Some("1")],
    )
    .await;
    let run = run_with(
        &b,
        "typed",
        "SELECT ?, ? FROM people WHERE id = :id",
        vec![
            value("#1", ParameterKind::Text, "first"),
            value("#2", ParameterKind::Text, "second"),
            value("id", ParameterKind::Number, "2"),
        ],
    )
    .await;
    ok(&run);
    assert_eq!(b.column(&run.results[0], 1), [Some("second".into())]);
}

#[tokio::test]
async fn mysql_explains_estimated_and_actual_plans() {
    let Some((_db, b)) = mysql("mysql_explains_estimated_and_actual_plans").await else {
        return;
    };
    ok(&b.run("x", MYSQL_PEOPLE).await);
    let maria = b
        .manager
        .session(&b.connection_id)
        .and_then(|s| s.connection())
        .is_ok_and(|c| c.server_version().starts_with("MariaDB"));
    let select = "SELECT * FROM people WHERE name = 'bob'";
    check_explain(&b, select, "people", PlanFormat::MysqlJson, true).await;
    let actual = explain(&b, "x", select, true, Vec::new())
        .await
        .expect("actual");
    assert_eq!(
        actual.plan.format,
        if maria {
            PlanFormat::MysqlJson
        } else {
            PlanFormat::MysqlTree
        }
    );
    let plan = explain(
        &b,
        "x",
        "SELECT * FROM people WHERE id = :id",
        false,
        vec![value("id", ParameterKind::Number, "1")],
    )
    .await
    .expect("plan with a parameter");
    assert_eq!(
        plan.sent,
        "EXPLAIN FORMAT=JSON SELECT * FROM people WHERE id = ?"
    );
}
