//! SQL inserts, Markdown and Excel exports (M3-12) through the real `QueryRunner`: SQLite
//! always; PostgreSQL, SQL Server and MySQL when `YADBE_TEST_PG_URL`, `YADBE_TEST_MSSQL_URL`,
//! `YADBE_TEST_MYSQL_URL` are set. The SQL script of every engine is run back against a table
//! of that engine and the rows compared with the ones exported.

mod common;
mod query_common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{MysqlDatabase, blank, from_url, mssql_url, mysql_url, pg_definition, pg_url};
use query_common::{Bench, bench};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::events::{BackendEvent, EventSink};
use yadbe_lib::export::ExportManager;
use yadbe_lib::export::model::{
    ExcelOptions, ExportFinished, ExportFormat, ExportRequest, ExportScope, ExportSourceSpec,
    ExportStatus, LineEnding, MarkdownOptions, SqlOptions,
};
use yadbe_lib::session::query_model::ExecutionStatus;
use yadbe_lib::session::table_data::TableDataService;

fn manager(b: &Bench) -> Arc<ExportManager> {
    let sink = Arc::clone(&b.sink) as Arc<dyn EventSink>;
    let tables = Arc::new(TableDataService::new(
        Arc::clone(&b.manager),
        b.runner.shared_store(),
        Arc::clone(&sink),
    ));
    Arc::new(ExportManager::new(Arc::clone(&b.runner), tables, sink))
}

async fn export(
    exports: &Arc<ExportManager>,
    b: &Bench,
    result_id: u32,
    format: ExportFormat,
    path: &Path,
) -> ExportFinished {
    let started = exports
        .start(ExportRequest {
            source: ExportSourceSpec::Result {
                result_id,
                scope: ExportScope::All,
            },
            format,
            path: path.display().to_string(),
        })
        .await
        .expect("start");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        for event in b.sink.events() {
            if let BackendEvent::ExportFinished(done) = event
                && done.export_id == started.export_id
            {
                return done;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "export not finished"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// How an engine writes the source rows and the table the script is run into. A backslash
/// and a line break are in the data: the script must keep both.
struct Dialect {
    engine: Engine,
    source: &'static str,
    /// Table name as exported, and its `CREATE` statement.
    table: &'static str,
    create: &'static str,
}

const SQLITE: Dialect = Dialect {
    engine: Engine::Sqlite,
    source: "SELECT 1 AS id, 'O''Brien' AS name, 12.5 AS total, 'plain' AS note \
UNION ALL SELECT 2, 'back' || char(92) || 'slash', NULL, NULL \
UNION ALL SELECT 3, 'two\nlines', 1234.5678, ''",
    table: "rt_copy",
    create: "CREATE TEMP TABLE rt_copy (id integer, name text, total real, note text)",
};

const POSTGRES: Dialect = Dialect {
    engine: Engine::Postgres,
    source: "SELECT 1 AS id, 'O''Brien' AS name, 12.5 AS total, 'plain' AS note \
UNION ALL SELECT 2, 'back' || chr(92) || 'slash', NULL, NULL \
UNION ALL SELECT 3, 'two\nlines', 1234.5678, ''",
    table: "rt_copy",
    create: "CREATE TEMP TABLE rt_copy (id int8, name text, total numeric, note text)",
};

const MSSQL: Dialect = Dialect {
    engine: Engine::Mssql,
    source: "SELECT 1 AS id, N'O''Brien' AS name, 12.5 AS total, N'plain' AS note \
UNION ALL SELECT 2, CONCAT(N'back', NCHAR(92), N'slash'), NULL, NULL \
UNION ALL SELECT 3, N'two\nlines', 1234.5678, N''",
    table: "#rt_copy",
    create: "CREATE TABLE #rt_copy (id bigint, name nvarchar(100), total float, note nvarchar(100))",
};

const MYSQL: Dialect = Dialect {
    engine: Engine::Mysql,
    source: "SELECT 1 AS id, 'O''Brien' AS name, 12.5 AS total, 'plain' AS note \
UNION ALL SELECT 2, CONVERT(CONCAT('back', CHAR(92), 'slash') USING utf8mb4), NULL, NULL \
UNION ALL SELECT 3, 'two\nlines', 1234.5678, ''",
    table: "rt_copy",
    create: "CREATE TEMPORARY TABLE rt_copy (id bigint, name varchar(100), total double, note varchar(100))",
};

async fn check_sql_round_trip(exports: &Arc<ExportManager>, b: &Bench, dialect: &Dialect) {
    let source = b.run("src", dialect.source).await;
    assert_eq!(source.status, ExecutionStatus::Succeeded, "{source:?}");
    let result = &source.results[0];

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("rows.sql");
    let done = export(
        exports,
        b,
        result.result_id,
        ExportFormat::Sql {
            options: SqlOptions {
                engine: dialect.engine,
                schema: String::new(),
                table: dialect.table.into(),
                rows_per_statement: 2,
                line_ending: LineEnding::Lf,
            },
        },
        &path,
    )
    .await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    assert_eq!(done.rows, 3);
    let script = std::fs::read_to_string(&path).expect("script");
    assert_eq!(script.matches("INSERT INTO").count(), 2, "{script}");

    // The script runs on its engine and puts back the rows it was written from.
    let created = b.run("dst", dialect.create).await;
    assert_eq!(created.status, ExecutionStatus::Succeeded, "{created:?}");
    let ran = b.run("dst", &script).await;
    assert_eq!(ran.status, ExecutionStatus::Succeeded, "{ran:?}\n{script}");
    let table = dialect.table;
    let copy = b
        .run(
            "dst",
            &format!("SELECT id, name, total, note FROM {table} ORDER BY id"),
        )
        .await;
    assert_eq!(copy.status, ExecutionStatus::Succeeded, "{copy:?}");
    for column in [0, 1, 3] {
        assert_eq!(
            b.column(&copy.results[0], column),
            b.column(result, column),
            "column {column}\n{script}"
        );
    }
    // Decimals may differ in trailing zeros between the source and the copy's column type.
    let numbers = |run: &query_common::Run| -> Vec<Option<f64>> {
        b.column(&run.results[0], 2)
            .into_iter()
            .map(|cell| cell.map(|text| text.parse().expect("a number")))
            .collect()
    };
    assert_eq!(numbers(&copy), numbers(&source));
}

async fn check_text_formats(exports: &Arc<ExportManager>, b: &Bench) {
    let source = b.run("src", SQLITE.source).await;
    assert_eq!(source.status, ExecutionStatus::Succeeded, "{source:?}");
    let id = source.results[0].result_id;
    let dir = tempfile::tempdir().expect("tempdir");

    let md = dir.path().join("rows.md");
    let done = export(
        exports,
        b,
        id,
        ExportFormat::Markdown {
            options: MarkdownOptions::default(),
        },
        &md,
    )
    .await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    // SQLite types an expression's column by its values, not at all: nothing to right-align.
    assert_eq!(
        std::fs::read_to_string(&md).expect("markdown"),
        "| id | name | total | note |\n| --- | --- | --- | --- |\n\
| 1 | O'Brien | 12.5 | plain |\n\
| 2 | back\\\\slash | NULL | NULL |\n\
| 3 | two<br>lines | 1234.5678 |  |\n"
    );

    let xlsx = dir.path().join("rows.xlsx");
    let done = export(
        exports,
        b,
        id,
        ExportFormat::Excel {
            options: ExcelOptions {
                sheet_name: "Orders".into(),
                ..ExcelOptions::default()
            },
        },
        &xlsx,
    )
    .await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    assert_eq!(done.rows, 3);
    assert!(!done.limited);
    let bytes = std::fs::read(&xlsx).expect("workbook");
    assert_eq!(&bytes[..2], b"PK", "a ZIP file");
    // For a look with another reader (openpyxl, LibreOffice): YADBE_KEEP_XLSX=/path/out.xlsx.
    if let Ok(keep) = std::env::var("YADBE_KEEP_XLSX") {
        std::fs::copy(&xlsx, keep).expect("keep the workbook");
    }

    // The format decides the file types: a CSV name is not an Excel file.
    let wrong = dir.path().join("rows.csv");
    let refused = exports
        .start(ExportRequest {
            source: ExportSourceSpec::Result {
                result_id: id,
                scope: ExportScope::All,
            },
            format: ExportFormat::Excel {
                options: ExcelOptions::default(),
            },
            path: wrong.display().to_string(),
        })
        .await;
    assert!(refused.is_err());
}

async fn sqlite() -> (tempfile::TempDir, Bench) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("formats.sqlite");
    rusqlite::Connection::open(&path).expect("create");
    let mut def = blank(Engine::Sqlite, "formats.sqlite");
    def.file_path = path.display().to_string();
    (dir, bench(def, None).await)
}

#[tokio::test]
async fn sqlite_exports_sql_markdown_and_excel() {
    let (_dir, b) = sqlite().await;
    let exports = manager(&b);
    check_sql_round_trip(&exports, &b, &SQLITE).await;
    check_text_formats(&exports, &b).await;
}

#[tokio::test]
async fn postgres_sql_script_runs_back() {
    let Some(url) = pg_url("postgres_sql_script_runs_back") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let b = bench(def, password).await;
    let exports = manager(&b);
    check_sql_round_trip(&exports, &b, &POSTGRES).await;

    // Typed cells of an Excel workbook: dates, a timestamp, a boolean, a number Excel would
    // round, and a time zone it cannot hold.
    let typed = b
        .run(
            "typed",
            "SELECT DATE '2024-02-29' AS day, TIMESTAMP '2000-01-01 12:00:00.5' AS at, \
TIMESTAMPTZ '2000-01-01 12:00:00+00' AS at_tz, TRUE AS ok, \
123456789012345678.25::numeric AS big, 42::int8 AS n, 'x'::text AS t",
        )
        .await;
    assert_eq!(typed.status, ExecutionStatus::Succeeded, "{typed:?}");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("typed.xlsx");
    let done = export(
        &exports,
        &b,
        typed.results[0].result_id,
        ExportFormat::Excel {
            options: ExcelOptions::default(),
        },
        &path,
    )
    .await;
    assert_eq!(done.status, ExportStatus::Done, "{done:?}");
    if let Ok(keep) = std::env::var("YADBE_KEEP_XLSX_TYPED") {
        std::fs::copy(&path, keep).expect("keep the workbook");
    }
}

#[tokio::test]
async fn mssql_sql_script_runs_back() {
    let Some(url) = mssql_url("mssql_sql_script_runs_back") else {
        return;
    };
    let (def, password) = from_url(&url);
    let b = bench(def, password).await;
    check_sql_round_trip(&manager(&b), &b, &MSSQL).await;
}

#[tokio::test]
async fn mysql_sql_script_runs_back() {
    let Some(url) = mysql_url("mysql_sql_script_runs_back") else {
        return;
    };
    let database = MysqlDatabase::create(&url, "xf").await;
    let (def, password) = database.definition();
    let b = bench(def, password).await;
    check_sql_round_trip(&manager(&b), &b, &MYSQL).await;
}
