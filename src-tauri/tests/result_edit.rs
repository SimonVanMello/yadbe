//! Editable query results (M3-7, F-087) against real engines, each case checked on the
//! resulting database state: what the engine reports makes a result editable (one table with
//! its key, aliases, expressions as read-only columns) or not (join, missing key, view,
//! table without key), each result set of a multi-statement run judged on its own; updates and
//! deletes applied through a result, a row changed elsewhere reported as a conflict, the
//! change set journaled and reverted (a deleted row comes back with the columns the result
//! did not show), an open transaction of the query tab and a read-only connection refused.
//! SQLite always runs; PostgreSQL, SQL Server and MySQL when their URLs are set.

mod common;
mod query_common;

use std::sync::Arc;

use common::{blank, mssql_url, pg_definition, pg_url};
use query_common::Bench as QueryBench;
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::edit_dialect::plain_text;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::Value;
use yadbe_lib::edit::model::{ApplyOutcome, CellUpdate, ChangeSet, ColumnValue, RowDelete};
use yadbe_lib::secrets::Secret;
use yadbe_lib::session::journal::ChangeJournal;
use yadbe_lib::session::meta_cache::MetaService;
use yadbe_lib::session::query_model::{ExecutionStatus, ResultLimits, ResultStatus, ResultSummary};
use yadbe_lib::session::result_edit::ResultEditService;
use yadbe_lib::session::result_edit_model::{ResultEditInfo, ResultReadOnlyReason, ResultRowRef};
use yadbe_lib::session::table_data::TableDataService;
use yadbe_lib::session::table_model::ColumnReadOnlyReason;
use yadbe_lib::store::JournalQuery;

const TAB: &str = "query";

struct Fixture {
    engine: Engine,
    def: ConnectionDefinition,
    password: Option<Secret>,
    /// What the statements put before a table name (`"schema".`, `re.`, nothing).
    prefix: String,
}

impl Fixture {
    fn password(&self) -> Option<Secret> {
        self.password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned()))
    }

    fn sql(&self, template: &str) -> String {
        template.replace("{t}", &self.prefix)
    }

    /// Statements of one run, in separate batches on SQL Server.
    fn script(&self, statements: &[&str]) -> String {
        let separator = if self.engine == Engine::Mssql {
            "\nGO\n"
        } else {
            ";\n"
        };
        statements
            .iter()
            .map(|s| self.sql(s))
            .collect::<Vec<_>>()
            .join(separator)
    }

    fn begin(&self) -> &'static str {
        match self.engine {
            Engine::Mssql => "BEGIN TRANSACTION",
            Engine::Mysql => "START TRANSACTION",
            _ => "BEGIN",
        }
    }
}

struct Bench {
    q: QueryBench,
    meta: MetaService,
    tables: Arc<TableDataService>,
    edits: ResultEditService,
}

async fn bench(fx: &Fixture) -> Bench {
    let q = query_common::bench(fx.def.clone(), fx.password()).await;
    let sink: Arc<dyn yadbe_lib::events::EventSink> = q.sink.clone();
    let journal = Arc::new(ChangeJournal::new(Arc::clone(&q.store), Arc::clone(&sink)));
    let tables = Arc::new(
        TableDataService::new(
            Arc::clone(&q.manager),
            q.runner.shared_store(),
            Arc::clone(&sink),
        )
        .with_journal(journal),
    );
    let edits = ResultEditService::new(
        Arc::clone(&q.manager),
        Arc::clone(&q.runner),
        Arc::clone(&tables),
    );
    Bench {
        meta: MetaService::new(sink),
        q,
        tables,
        edits,
    }
}

fn int(n: i64) -> Value {
    Value::int(n)
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

impl Bench {
    /// Runs `sql` in tab `tab`; its result sets.
    async fn results_in(&self, tab: &str, sql: &str) -> Vec<ResultSummary> {
        let run = self.q.run(tab, sql).await;
        assert_eq!(run.status, ExecutionStatus::Succeeded, "{sql}: {run:?}");
        run.results
    }

    async fn result(&self, sql: &str) -> ResultSummary {
        self.results_in(TAB, sql)
            .await
            .into_iter()
            .next()
            .expect("a result")
    }

    async fn describe(&self, result: &ResultSummary) -> ResultEditInfo {
        self.edits
            .describe(&self.meta, result.result_id)
            .await
            .expect("describe")
    }

    async fn reasons(&self, sql: &str) -> Vec<ResultReadOnlyReason> {
        let result = self.result(sql).await;
        self.describe(&result).await.read_only_reasons
    }

    /// Every cell of a result, as values.
    fn rows(&self, result_id: u32) -> Vec<Vec<Value>> {
        let stored = self.q.runner.shared_store().get(result_id).expect("result");
        stored.rows(0, stored.row_count())
    }

    /// The items as stored now, by id: (id, name, price, note, created) as texts.
    async fn items(&self, fx: &Fixture) -> Vec<Vec<Option<String>>> {
        let result = self
            .results_in(
                "check",
                &fx.sql("SELECT id, name, price, note, created FROM {t}items ORDER BY id"),
            )
            .await
            .remove(0);
        self.rows(result.result_id)
            .iter()
            .map(|row| row.iter().map(plain_text).collect())
            .collect()
    }
}

fn names(items: &[Vec<Option<String>>]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|row| {
            (
                row[0].clone().unwrap_or_default(),
                row[1].clone().unwrap_or_default(),
            )
        })
        .collect()
}

async fn suite(fx: &Fixture) {
    let b = bench(fx).await;
    editability(&b, fx).await;
    edits(&b, fx).await;
    conflicts(&b, fx).await;
    open_transaction(&b, fx).await;
    read_only(fx).await;
}

/// What makes a result editable, from what the engine said.
async fn editability(b: &Bench, fx: &Fixture) {
    // One table with its key: every column shown as stored.
    let result = b
        .result(&fx.sql("SELECT id, name, price FROM {t}items ORDER BY id"))
        .await;
    let info = b.describe(&result).await;
    assert_eq!(info.read_only_reasons, [], "{info:?}");
    assert_eq!(
        info.columns
            .iter()
            .map(|c| c.source.as_deref())
            .collect::<Vec<_>>(),
        [Some("id"), Some("name"), Some("price")]
    );
    assert_eq!(info.row_identity, ["id"]);
    assert_eq!(info.identity_columns, [0]);
    let table = info.table.expect("table");
    assert_eq!(table.name, "items");

    // Aliases of the table and of its columns: the engine still says which column.
    let info = b
        .describe(
            &b.result(&fx.sql("SELECT i.name AS label, i.id AS item FROM {t}items i"))
                .await,
        )
        .await;
    assert_eq!(info.read_only_reasons, [], "{info:?}");
    assert_eq!(
        info.columns
            .iter()
            .map(|c| c.source.as_deref())
            .collect::<Vec<_>>(),
        [Some("name"), Some("id")]
    );
    assert_eq!(info.identity_columns, [1]);

    // An expression and a column shown twice are read-only columns.
    let info = b
        .describe(
            &b.result(&fx.sql("SELECT id, UPPER(name) AS loud, name, id AS again FROM {t}items"))
                .await,
        )
        .await;
    assert_eq!(info.read_only_reasons, [], "{info:?}");
    let sources: Vec<_> = info.columns.iter().map(|c| c.source.as_deref()).collect();
    assert_eq!(sources, [Some("id"), None, Some("name"), None]);
    assert_eq!(
        info.columns[1].column.read_only_reason,
        Some(ColumnReadOnlyReason::Computed)
    );
    assert_eq!(info.columns[1].column.name, "loud");

    // Composite key.
    let info = b
        .describe(&b.result(&fx.sql("SELECT label, b, a FROM {t}pairs")).await)
        .await;
    assert_eq!(info.read_only_reasons, [], "{info:?}");
    assert_eq!(info.identity_columns, [2, 1]);

    // Not editable, with the reason.
    use ResultReadOnlyReason as R;
    assert_eq!(
        b.reasons(&fx.sql("SELECT a.id, b.name FROM {t}items a JOIN {t}items b ON b.id = a.id"))
            .await,
        [R::NotSingleTable]
    );
    assert_eq!(
        b.reasons(&fx.sql("SELECT name, price FROM {t}items")).await,
        [R::KeyNotSelected]
    );
    assert_eq!(
        b.reasons(&fx.sql("SELECT * FROM {t}tags")).await,
        [R::NoRowIdentity]
    );
    // PostgreSQL and MySQL name the view itself; SQLite and SQL Server (browse mode) its base
    // table, which the query does not name.
    let view = b.reasons(&fx.sql("SELECT * FROM {t}item_names")).await;
    match fx.engine {
        Engine::Postgres | Engine::Mysql => assert_eq!(view, [R::View]),
        Engine::Sqlite | Engine::Mssql => assert_eq!(view, [R::OtherSource]),
    }
    assert_eq!(
        b.reasons(&fx.sql("SELECT COUNT(*) AS n FROM {t}items"))
            .await,
        [R::OriginUnknown]
    );
    assert_eq!(
        b.reasons(&fx.sql("SELECT id, name FROM {t}items WHERE id IN (SELECT a FROM {t}pairs)"))
            .await,
        []
    );

    // A result paused at its row limit is editable already: its origins came with its columns.
    let id =
        b.q.run_limited(
            "paused",
            &fx.sql("SELECT id, name FROM {t}items ORDER BY id"),
            ResultLimits {
                max_rows: 2,
                max_bytes: u32::MAX,
            },
        )
        .await;
    let run =
        b.q.wait_for(id, |r| {
            r.results
                .first()
                .is_some_and(|x| x.status == ResultStatus::Paused)
        })
        .await;
    let paused = b.describe(&run.results[0]).await;
    assert_eq!(paused.read_only_reasons, [], "{paused:?}");
    b.q.runner.cancel("paused").await;
    b.q.wait(id).await;

    // What yadbe asked the engine is in the statement log.
    let log: Vec<String> = b.q.log.entries().into_iter().map(|e| e.sql).collect();
    let asked = match fx.engine {
        Engine::Postgres => log.iter().any(|sql| sql.contains("prepared, not run")),
        Engine::Mssql => log
            .iter()
            .any(|sql| sql.contains("sp_describe_first_result_set")),
        Engine::Mysql | Engine::Sqlite => true,
    };
    assert!(asked, "{log:?}");

    // Each result set of a multi-statement run on its own.
    let results = b
        .results_in(
            TAB,
            &fx.script(&[
                "SELECT id, name FROM {t}items",
                "SELECT name FROM {t}items",
                "SELECT label, a, b FROM {t}pairs",
            ]),
        )
        .await;
    assert_eq!(results.len(), 3);
    let mut reasons = Vec::new();
    for result in &results {
        reasons.push(b.describe(result).await.read_only_reasons);
    }
    assert_eq!(reasons, [vec![], vec![R::KeyNotSelected], vec![]]);

    // A SQL Server batch of two SELECTs: which statement a result set comes from cannot be
    // told, so neither is editable.
    if fx.engine == Engine::Mssql {
        let results = b
            .results_in(
                TAB,
                &fx.sql("SELECT id, name FROM {t}items; SELECT id, name FROM {t}items"),
            )
            .await;
        assert_eq!(results.len(), 2);
        for result in &results {
            assert_eq!(
                b.describe(result).await.read_only_reasons,
                [R::NotSingleTable]
            );
        }
    }
}

/// Updates and deletes through a result, journaled and reverted.
async fn edits(b: &Bench, fx: &Fixture) {
    let before = b.items(fx).await;
    let result = b
        .result(&fx.sql("SELECT id, UPPER(name) AS loud, name, price FROM {t}items ORDER BY id"))
        .await;
    let info = b.describe(&result).await;
    assert_eq!(info.read_only_reasons, []);
    let rows = b.rows(result.result_id);
    // Row 0 (id 1): new name and price; row 1 (id 2): deleted. As the grid sends them: the
    // values read, by table column.
    let update = |row: &[Value], column: &str, at: usize, value: Value| CellUpdate {
        key: vec![row[0].clone()],
        column: column.into(),
        value,
        original: Some(row[at].clone()),
    };
    let changes = ChangeSet {
        updates: vec![
            update(&rows[0], "name", 2, text("uno")),
            update(&rows[0], "price", 3, Value::Decimal("11.25".into())),
        ],
        inserts: vec![],
        deletes: vec![RowDelete {
            key: vec![rows[1][0].clone()],
            values: vec![
                ColumnValue {
                    column: "id".into(),
                    value: rows[1][0].clone(),
                },
                ColumnValue {
                    column: "name".into(),
                    value: rows[1][2].clone(),
                },
                ColumnValue {
                    column: "price".into(),
                    value: rows[1][3].clone(),
                },
            ],
        }],
    };
    let preview = b
        .edits
        .preview(&b.meta, result.result_id, &changes)
        .await
        .expect("preview");
    assert_eq!(preview.statements.len(), 2, "{preview:?}");
    assert!(preview.script.contains("items"), "{}", preview.script);
    let journal_id = match b
        .edits
        .apply(&b.meta, result.result_id, &changes)
        .await
        .expect("apply")
    {
        ApplyOutcome::Applied { journal_id, .. } => journal_id.expect("journaled"),
        other => panic!("not applied: {other:?}"),
    };
    let after = b.items(fx).await;
    assert_eq!(
        names(&after),
        [
            ("1".into(), "uno".into()),
            ("3".into(), "three".into()),
            ("4".into(), "four".into())
        ]
    );
    assert_eq!(
        after[0][2].as_deref().map(|p| p.trim_end_matches('0')),
        Some("11.25")
    );

    // The rows read again, in the result's columns: the expression keeps what it read.
    let fresh = b
        .edits
        .refresh(
            &b.meta,
            result.result_id,
            &[
                ResultRowRef {
                    row: 0,
                    key: vec![int(1)],
                },
                ResultRowRef {
                    row: 1,
                    key: vec![int(2)],
                },
            ],
        )
        .await
        .expect("refresh");
    assert_eq!(fresh.positions, [Some(0), None]);
    assert_eq!(fresh.window.columns.len(), 4);
    assert_eq!(fresh.window.columns[2].values[0].as_deref(), Some("uno"));
    assert_eq!(fresh.window.columns[1].values[0].as_deref(), Some("ONE"));

    // Journaled, then reverted from a table tab: the deleted row comes back whole, with the
    // columns the result did not show (note, created).
    let entry =
        b.q.store
            .journal_entry(journal_id)
            .expect("read")
            .expect("entry");
    assert!(entry.entry.revert_blocker.is_none(), "{entry:?}");
    let found =
        b.q.store
            .search_journal(&JournalQuery::default())
            .expect("search");
    assert!(found.entries.iter().any(|e| e.id == journal_id));
    let table = info.table.clone().expect("table");
    b.tables
        .open(&b.meta, "revert", &b.q.connection_id, &table)
        .await
        .expect("open");
    match b
        .tables
        .apply_revert("revert", journal_id)
        .await
        .expect("revert")
    {
        ApplyOutcome::Applied { .. } => {}
        other => panic!("not reverted: {other:?}"),
    }
    b.tables.close("revert").await;
    assert_eq!(b.items(fx).await, before);

    // The query's columns only: never a computed one, never an insert.
    let refused = b
        .edits
        .apply(
            &b.meta,
            result.result_id,
            &ChangeSet {
                updates: vec![CellUpdate {
                    key: vec![int(1)],
                    column: "loud".into(),
                    value: text("x"),
                    original: None,
                }],
                ..ChangeSet::default()
            },
        )
        .await
        .expect_err("refused");
    assert_eq!(refused.code, ErrorCode::InvalidArgument);
    b.edits.close(result.result_id).await;
}

/// A row changed by someone else since the query read it is reported, not overwritten.
async fn conflicts(b: &Bench, fx: &Fixture) {
    let result = b
        .result(&fx.sql("SELECT name, id FROM {t}items WHERE id = 3"))
        .await;
    assert_eq!(b.describe(&result).await.read_only_reasons, []);
    let row = b.rows(result.result_id).remove(0);
    b.results_in(
        "other",
        &fx.sql("UPDATE {t}items SET name = 'theirs' WHERE id = 3"),
    )
    .await;
    let outcome = b
        .edits
        .apply(
            &b.meta,
            result.result_id,
            &ChangeSet {
                updates: vec![CellUpdate {
                    key: vec![row[1].clone()],
                    column: "name".into(),
                    value: text("mine"),
                    original: Some(row[0].clone()),
                }],
                ..ChangeSet::default()
            },
        )
        .await
        .expect("apply");
    let ApplyOutcome::Conflicted { current, .. } = outcome else {
        panic!("no conflict: {outcome:?}");
    };
    assert_eq!(current.positions, [Some(0)]);
    // In the result's columns.
    assert_eq!(
        current.window.columns[0].values[0].as_deref(),
        Some("theirs")
    );
    let items = b.items(fx).await;
    assert_eq!(items[2][1].as_deref(), Some("theirs"), "not overwritten");
    b.results_in(
        "other",
        &fx.sql("UPDATE {t}items SET name = 'three' WHERE id = 3"),
    )
    .await;
}

/// The query tab's open transaction comes first.
async fn open_transaction(b: &Bench, fx: &Fixture) {
    b.results_in("tx", fx.begin()).await;
    let result = b
        .results_in("tx", &fx.sql("SELECT id, name FROM {t}items WHERE id = 1"))
        .await
        .remove(0);
    assert_eq!(b.describe(&result).await.read_only_reasons, []);
    let err = b
        .edits
        .apply(
            &b.meta,
            result.result_id,
            &ChangeSet {
                updates: vec![CellUpdate {
                    key: vec![int(1)],
                    column: "name".into(),
                    value: text("in tx"),
                    original: Some(text("one")),
                }],
                ..ChangeSet::default()
            },
        )
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::TableNotEditable);
    b.results_in("tx", "ROLLBACK").await;
    assert_eq!(b.items(fx).await[0][1].as_deref(), Some("one"));
}

/// A read-only connection says so, and its results cannot be changed.
async fn read_only(fx: &Fixture) {
    let mut def = fx.def.clone();
    def.read_only = true;
    let ro = Fixture {
        engine: fx.engine,
        def,
        password: fx.password(),
        prefix: fx.prefix.clone(),
    };
    let b = bench(&ro).await;
    let result = b.result(&ro.sql("SELECT id, name FROM {t}items")).await;
    assert_eq!(
        b.describe(&result).await.read_only_reasons,
        [ResultReadOnlyReason::ReadOnlyConnection]
    );
    let err = b
        .edits
        .apply(
            &b.meta,
            result.result_id,
            &ChangeSet {
                updates: vec![CellUpdate {
                    key: vec![int(1)],
                    column: "name".into(),
                    value: text("x"),
                    original: Some(text("one")),
                }],
                ..ChangeSet::default()
            },
        )
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::ReadOnlyViolation);
    assert_eq!(b.items(&ro).await[0][1].as_deref(), Some("one"));
}

// --- Engines ---------------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_result_edits() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("results.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create fixture");
    conn.execute_batch(include_str!("fixtures/result_edit_sqlite.sql"))
        .expect("fixture script");
    drop(conn);
    let mut def = blank(Engine::Sqlite, "results.sqlite");
    def.file_path = path.display().to_string();
    suite(&Fixture {
        engine: Engine::Sqlite,
        def,
        password: None,
        prefix: String::new(),
    })
    .await;
}

fn unique_name() -> String {
    common::unique_database("m37")
}

/// Drops what a server test created, on a runtime of its own.
struct DropAfter {
    def: ConnectionDefinition,
    password: Option<Secret>,
    sql: String,
}

impl Drop for DropAfter {
    fn drop(&mut self) {
        let def = self.def.clone();
        let password = self
            .password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned()));
        let sql = self.sql.clone();
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    if let Err(err) = conn.query(&sql, 0).await {
                        common::skip("dropping the fixture", &format!("{sql}: {err:?}"));
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

async fn run_script(
    def: &ConnectionDefinition,
    password: Option<&Secret>,
    script: &str,
    engine: Engine,
) {
    let conn = common::open(def, password).await.expect("connect");
    let syntax = engine.dialect().syntax();
    for statement in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[statement.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
}

#[tokio::test]
async fn postgres_result_edits() {
    let Some(url) = pg_url("postgres_result_edits") else {
        return;
    };
    let (mut def, password) = pg_definition(&url);
    if let Ok(ca) = std::env::var(common::PG_CA_ENV) {
        def.ca_cert_path = Some(ca);
    }
    let schema = unique_name();
    run_script(
        &def,
        password.as_ref(),
        &format!("CREATE SCHEMA \"{schema}\""),
        Engine::Postgres,
    )
    .await;
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: format!("DROP SCHEMA \"{schema}\" CASCADE"),
    };
    let script =
        include_str!("fixtures/result_edit_postgres.sql").replace("{s}", &format!("\"{schema}\""));
    run_script(&def, password.as_ref(), &script, Engine::Postgres).await;
    suite(&Fixture {
        engine: Engine::Postgres,
        def,
        password,
        prefix: format!("\"{schema}\"."),
    })
    .await;
}

#[tokio::test]
async fn mssql_result_edits() {
    let Some(url) = mssql_url("mssql_result_edits") else {
        return;
    };
    let (mut def, password) = common::from_url(&url);
    let name = unique_name();
    run_script(
        &def,
        password.as_ref(),
        &format!("CREATE DATABASE [{name}]"),
        Engine::Mssql,
    )
    .await;
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: format!(
            "ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]"
        ),
    };
    def.database = name.clone();
    run_script(
        &def,
        password.as_ref(),
        include_str!("fixtures/result_edit_mssql.sql"),
        Engine::Mssql,
    )
    .await;
    suite(&Fixture {
        engine: Engine::Mssql,
        def,
        password,
        prefix: "re.".into(),
    })
    .await;
}

#[tokio::test]
async fn mysql_result_edits() {
    let Some(url) = common::mysql_url("mysql_result_edits") else {
        return;
    };
    let database = common::MysqlDatabase::create(&url, "m37").await;
    let (def, password) = database.definition();
    run_script(
        &def,
        password.as_ref(),
        include_str!("fixtures/result_edit_mysql.sql"),
        Engine::Mysql,
    )
    .await;
    suite(&Fixture {
        engine: Engine::Mysql,
        def,
        password,
        prefix: String::new(),
    })
    .await;
    drop(database);
}
