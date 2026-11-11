//! Foreign key navigation (M3-2, F-088) against real engines: the foreign keys referencing a
//! table (self-references, composite keys, other schemas), the referenced row of a value,
//! bounded counts of referencing rows, the lookup page of the foreign key editor (search
//! with bound values), and cancellation. SQLite always runs; PostgreSQL and SQL Server when
//! their URLs are set.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{blank, mssql_url, pg_definition, pg_url};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::edit_dialect::plain_text;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::meta::{IncomingForeignKey, ObjectRef};
use yadbe_lib::db::value::Value;
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::MetaService;
use yadbe_lib::session::query_model::ResultWindow;
use yadbe_lib::session::reference_model::{KeyValue, LookupRequest};
use yadbe_lib::session::references::ReferenceService;
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::table_data::TableDataService;
use yadbe_lib::store::Store;

struct Bench {
    manager: Arc<ConnectionManager>,
    meta: Arc<MetaService>,
    store: Arc<ResultStore>,
    tables: Arc<TableDataService>,
    refs: ReferenceService,
    log: Arc<StatementLog>,
    db: Arc<Store>,
}

fn bench() -> Bench {
    let db = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(RecordingSink::default());
    let log = Arc::new(StatementLog::new(sink.clone()));
    let manager = Arc::new(ConnectionManager::new(
        Arc::clone(&db),
        secrets,
        Arc::clone(&log),
        sink.clone(),
    ));
    let store = Arc::new(ResultStore::default());
    let meta = Arc::new(MetaService::new(sink.clone()));
    let tables = Arc::new(TableDataService::new(
        Arc::clone(&manager),
        Arc::clone(&store),
        sink,
    ));
    let refs = ReferenceService::new(
        Arc::clone(&manager),
        Arc::clone(&meta),
        Arc::clone(&tables),
        Arc::clone(&store),
    );
    Bench {
        manager,
        meta,
        store,
        tables,
        refs,
        log,
        db,
    }
}

struct Fixture {
    engine: Engine,
    def: ConnectionDefinition,
    password: Option<Secret>,
    database: String,
    schema: Option<String>,
    /// The schema of the cross-schema `remote` table, on engines with schemas.
    other_schema: Option<String>,
}

impl Fixture {
    fn table(&self, name: &str) -> ObjectRef {
        ObjectRef {
            database: self.database.clone(),
            schema: self.schema.clone(),
            name: name.to_owned(),
        }
    }

    fn password(&self) -> Option<Secret> {
        self.password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned()))
    }
}

fn kv(column: &str, value: Value) -> KeyValue {
    KeyValue {
        column: column.into(),
        value,
    }
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

/// The rows of a window as text.
fn rows(b: &Bench, window: &ResultWindow, columns: usize) -> Vec<Vec<Option<String>>> {
    let stored = b.store.get(window.result_id).expect("stored");
    (0..window.row_count as usize)
        .map(|r| {
            (0..columns)
                .map(|c| plain_text(&stored.cell(r, c).expect("cell")))
                .collect()
        })
        .collect()
}

fn describe(key: &IncomingForeignKey) -> String {
    format!(
        "{}.{}({})->({})",
        key.table.schema.as_deref().unwrap_or("-"),
        key.table.name,
        key.foreign_key.columns.join(","),
        key.foreign_key.referenced_columns.join(",")
    )
}

async fn suite(fx: &Fixture) {
    let b = bench();
    let saved = b.db.create_connection(&fx.def).expect("save");
    b.manager
        .connect(&saved.id, fx.password())
        .await
        .expect("connect");
    let conn = saved.id.as_str();
    incoming(&b, conn, fx).await;
    b.tables
        .open(&b.meta, "child", conn, &fx.table("child"))
        .await
        .expect("open child");
    referenced_rows(&b, fx).await;
    counts(&b, fx).await;
    lookups(&b, fx).await;
    cancellation(&b, conn, fx).await;
    b.refs.close("child").await;
    b.tables.close("child").await;
}

async fn incoming(b: &Bench, conn: &str, fx: &Fixture) {
    let schema = fx.schema.as_deref().unwrap_or("-");
    let of = |name: &str| {
        let table = fx.table(name);
        async move {
            let found = b
                .meta
                .incoming_foreign_keys(&b.manager, None, conn, &table)
                .await
                .expect("incoming");
            assert!(found.supported);
            for key in &found.keys {
                assert_eq!(key.foreign_key.referenced_table, table);
            }
            found.keys.iter().map(describe).collect::<Vec<_>>()
        }
    };
    let mut parent = of("parent").await;
    parent.sort();
    let mut expected = vec![format!("{schema}.child(parent_id)->(id)")];
    match &fx.other_schema {
        Some(other) => expected.push(format!("{other}.remote(parent_id)->(id)")),
        None => expected.push("-.implicit(parent_id)->(id)".to_owned()),
    }
    expected.sort();
    assert_eq!(parent, expected);
    assert_eq!(
        of("Odd \"Parent\"").await,
        [format!("{schema}.child(a,b)->(Key A,key b)")]
    );
    assert_eq!(
        of("tree").await,
        [format!("{schema}.tree(parent_id)->(id)")]
    );
    assert!(of("child").await.is_empty());
    // Cached: the second read runs no statement.
    let logged = b.log.entries().len();
    of("tree").await;
    assert_eq!(b.log.entries().len(), logged);
}

async fn referenced_rows(b: &Bench, fx: &Fixture) {
    let odd = fx.table("Odd \"Parent\"");
    let row = b
        .refs
        .referenced_row(
            "child",
            "peek",
            &odd,
            &[kv("Key A", Value::int(1)), kv("key b", text("x'y"))],
        )
        .await
        .expect("peek");
    assert_eq!(row.matches, 1);
    let names: Vec<&str> = row.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Key A", "key b", "label"]);
    assert_eq!(
        rows(b, &row.window, 3),
        [[Some("1".into()), Some("x'y".into()), Some("first".into())]]
    );
    assert!(
        b.log
            .entries()
            .iter()
            .any(|e| e.sql.contains("x''y") && e.sql.contains("label")),
        "the peek is in the statement log with its values as literals"
    );

    let missing = b
        .refs
        .referenced_row(
            "child",
            "peek",
            &fx.table("parent"),
            &[kv("id", Value::int(99))],
        )
        .await
        .expect("peek");
    assert_eq!((missing.matches, missing.window.row_count), (0, 0));

    // A unique key other than the primary key, an injection attempt bound as a value.
    let by_code = b
        .refs
        .referenced_row(
            "child",
            "peek",
            &fx.table("parent"),
            &[kv("code", text("A1' OR '1'='1"))],
        )
        .await
        .expect("peek");
    assert_eq!(by_code.matches, 0);

    for (table, key) in [
        (fx.table("parent"), vec![kv("id", Value::Null)]),
        (fx.table("parent"), vec![kv("nope", Value::int(1))]),
        (fx.table("parent"), vec![]),
    ] {
        let err = b
            .refs
            .referenced_row("child", "peek", &table, &key)
            .await
            .expect_err("refused");
        assert_eq!(err.code, ErrorCode::InvalidArgument);
    }
    let err = b
        .refs
        .referenced_row(
            "child",
            "peek",
            &fx.table("gone"),
            &[kv("id", Value::int(1))],
        )
        .await
        .expect_err("missing table");
    assert_eq!(err.code, ErrorCode::ObjectNotFound);
    let err = b
        .refs
        .referenced_row(
            "nope",
            "peek",
            &fx.table("parent"),
            &[kv("id", Value::int(1))],
        )
        .await
        .expect_err("no tab");
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

async fn counts(b: &Bench, fx: &Fixture) {
    let child = fx.table("child");
    let count = |key: Vec<KeyValue>, limit: u32| {
        let child = child.clone();
        async move {
            let c = b
                .refs
                .count_rows("child", "count", &child, &key, limit)
                .await
                .expect("count");
            (c.count, c.more)
        }
    };
    assert_eq!(
        count(vec![kv("parent_id", Value::int(1))], 100).await,
        (3, false)
    );
    assert_eq!(
        count(vec![kv("parent_id", Value::int(1))], 3).await,
        (3, false)
    );
    assert_eq!(
        count(vec![kv("parent_id", Value::int(1))], 2).await,
        (2, true)
    );
    assert_eq!(
        count(vec![kv("parent_id", Value::int(3))], 100).await,
        (0, false)
    );
    assert_eq!(
        count(vec![kv("a", Value::int(1)), kv("b", text("x'y"))], 100).await,
        (2, false)
    );
    // Self-reference.
    let tree = b
        .refs
        .count_rows(
            "child",
            "count",
            &fx.table("tree"),
            &[kv("parent_id", Value::int(1))],
            1000,
        )
        .await
        .expect("count");
    assert_eq!((tree.count, tree.more), (2, false));
    if let Some(other) = &fx.other_schema {
        let remote = ObjectRef {
            database: fx.database.clone(),
            schema: Some(other.clone()),
            name: "remote".into(),
        };
        let c = b
            .refs
            .count_rows(
                "child",
                "count",
                &remote,
                &[kv("parent_id", Value::int(1))],
                10,
            )
            .await
            .expect("cross-schema count");
        assert_eq!((c.count, c.more), (1, false));
    }
    let err = b
        .refs
        .count_rows("child", "count", &child, &[kv("id", Value::int(1))], 0)
        .await
        .expect_err("limit");
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

async fn lookups(b: &Bench, fx: &Fixture) {
    let page = |search: Option<&str>, offset: u32, limit: u32| LookupRequest {
        table: fx.table("parent"),
        key_columns: vec!["id".into()],
        display_columns: vec!["name".into(), "code".into()],
        search: search.map(str::to_owned),
        offset,
        limit,
    };
    let first = b
        .refs
        .lookup("child", "lookup", &page(None, 0, 2))
        .await
        .expect("lookup");
    let names: Vec<&str> = first.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "code"]);
    assert!(first.has_more);
    assert_eq!(
        rows(b, &first.window, 3),
        [
            [Some("1".into()), Some("Alice".into()), Some("A1".into())],
            [Some("2".into()), Some("Bruno".into()), Some("B2".into())]
        ]
    );
    let rest = b
        .refs
        .lookup("child", "lookup", &page(None, 2, 2))
        .await
        .expect("lookup");
    assert!(!rest.has_more);
    assert_eq!(rest.window.row_count, 1);

    // Wildcards are searched literally, case-insensitively, through bound values.
    let ids = |search: &'static str| {
        let request = page(Some(search), 0, 50);
        async move {
            let found = b
                .refs
                .lookup("child", "lookup", &request)
                .await
                .expect("lookup");
            rows(b, &found.window, 1)
                .into_iter()
                .map(|r| r[0].clone().unwrap_or_default())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(ids("50%_").await, ["3"]);
    assert_eq!(ids("%").await, ["3"]);
    assert_eq!(ids("LIC").await, ["1"]);
    assert_eq!(ids("b2").await, ["2"]);
    assert!(ids("' OR 1=1 --").await.is_empty());

    // A composite key with odd names: both columns, searched together.
    let odd = b
        .refs
        .lookup(
            "child",
            "lookup",
            &LookupRequest {
                table: fx.table("Odd \"Parent\""),
                key_columns: vec!["Key A".into(), "key b".into()],
                display_columns: vec!["label".into()],
                search: Some("x'y".into()),
                offset: 0,
                limit: 10,
            },
        )
        .await
        .expect("lookup");
    assert_eq!(
        rows(b, &odd.window, 3),
        [
            [Some("1".into()), Some("x'y".into()), Some("first".into())],
            [Some("2".into()), Some("x'y".into()), Some("third".into())]
        ]
    );
}

/// A second session holds a lock on `parent`: a lookup waits for it until cancelled, a queued
/// one is cancelled before it runs, and the tab's lookups still work afterwards.
async fn cancellation(b: &Bench, conn: &str, fx: &Fixture) {
    // An unknown request: nothing happens.
    b.refs.cancel("never-started").await;
    let lock = match fx.engine {
        Engine::Postgres => format!(
            "LOCK TABLE {} IN ACCESS EXCLUSIVE MODE",
            yadbe_lib::db::meta::qualified_name(fx.engine.dialect(), &fx.table("parent"))
        ),
        Engine::Mssql => "SELECT TOP (1) id FROM fk.parent WITH (TABLOCKX, HOLDLOCK)".to_owned(),
        // A writer blocks SQLite readers through its busy handler only: no wait to cancel.
        _ => {
            let _ = conn;
            return;
        }
    };
    // The details are cached first: the catalog reads do not wait for the lock then.
    b.refs
        .referenced_row(
            "child",
            "warm",
            &fx.table("parent"),
            &[kv("id", Value::int(1))],
        )
        .await
        .expect("warm");
    let other = common::open(&fx.def, fx.password.as_ref())
        .await
        .expect("second connection");
    let begin = if fx.engine == Engine::Mssql {
        "BEGIN TRANSACTION"
    } else {
        "BEGIN"
    };
    other.query(begin, 0).await.expect("begin");
    other.query(&lock, 0).await.expect("lock");

    let started = std::time::Instant::now();
    let request = LookupRequest {
        table: fx.table("parent"),
        key_columns: vec!["id".into()],
        display_columns: vec!["name".into()],
        search: None,
        offset: 0,
        limit: 10,
    };
    let child = fx.table("child");
    let key = [kv("parent_id", Value::int(1))];
    let running = b.refs.lookup("child", "blocked", &request);
    let queued = b.refs.count_rows("child", "queued", &child, &key, 10);
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        b.refs.cancel("queued").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        b.refs.cancel("blocked").await;
    };
    let (running, queued, ()) = tokio::join!(running, queued, cancel);
    assert_eq!(running.expect_err("cancelled").code, ErrorCode::Cancelled);
    assert_eq!(queued.expect_err("cancelled").code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    other.query("ROLLBACK", 0).await.expect("rollback");
    other.close().await;

    let after = b
        .refs
        .lookup("child", "after", &request)
        .await
        .expect("after cancel");
    assert_eq!(after.window.row_count, 3);
}

#[tokio::test]
async fn sqlite_foreign_key_navigation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fk.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create fixture");
    conn.execute_batch(include_str!("fixtures/fk_sqlite.sql"))
        .expect("fixture script");
    drop(conn);
    let mut def = blank(Engine::Sqlite, "fk.sqlite");
    def.file_path = path.display().to_string();
    suite(&Fixture {
        engine: Engine::Sqlite,
        def,
        password: None,
        database: "main".into(),
        schema: None,
        other_schema: None,
    })
    .await;
}

fn unique_name(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("yadbe_m32_{tag}_{}_{nanos:x}", std::process::id())
}

/// Drops what a server test created, on a runtime of its own.
struct DropAfter {
    def: ConnectionDefinition,
    password: Option<Secret>,
    sql: Vec<String>,
}

impl Drop for DropAfter {
    fn drop(&mut self) {
        let def = self.def.clone();
        let password = self
            .password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned()));
        let statements = self.sql.clone();
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    for sql in statements {
                        if let Err(err) = conn.query(&sql, 0).await {
                            common::skip("dropping the fixture", &format!("{sql}: {err:?}"));
                        }
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

#[tokio::test]
async fn postgres_foreign_key_navigation() {
    let Some(url) = pg_url("postgres_foreign_key_navigation") else {
        return;
    };
    let (mut def, password) = pg_definition(&url);
    if let Ok(ca) = std::env::var(common::PG_CA_ENV) {
        def.ca_cert_path = Some(ca);
    }
    let schema = unique_name("a");
    let other = unique_name("b");
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    for name in [&schema, &other] {
        conn.query(&format!("CREATE SCHEMA \"{name}\""), 0)
            .await
            .expect("schema");
    }
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: vec![
            format!("DROP SCHEMA \"{other}\" CASCADE"),
            format!("DROP SCHEMA \"{schema}\" CASCADE"),
        ],
    };
    let script = include_str!("fixtures/fk_postgres.sql")
        .replace("{s2}", &format!("\"{other}\""))
        .replace("{s}", &format!("\"{schema}\""));
    let syntax = Engine::Postgres.dialect().syntax();
    for statement in yadbe_lib::db::split::split(&script, &syntax) {
        let sql = &script[statement.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    suite(&Fixture {
        engine: Engine::Postgres,
        database: def.database.clone(),
        def,
        password,
        schema: Some(schema),
        other_schema: Some(other),
    })
    .await;
}

#[tokio::test]
async fn mssql_foreign_key_navigation() {
    let Some(url) = mssql_url("mssql_foreign_key_navigation") else {
        return;
    };
    let (mut def, password) = common::from_url(&url);
    let name = unique_name("db");
    let master = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    master
        .query(&format!("CREATE DATABASE [{name}]"), 0)
        .await
        .expect("create database");
    master.close().await;
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: vec![format!(
            "ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]"
        )],
    };
    def.database = name.clone();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    let script = include_str!("fixtures/fk_mssql.sql");
    let syntax = Engine::Mssql.dialect().syntax();
    for batch in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[batch.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    suite(&Fixture {
        engine: Engine::Mssql,
        def,
        password,
        database: name,
        schema: Some("fk".into()),
        other_schema: Some("fk2".into()),
    })
    .await;
}
