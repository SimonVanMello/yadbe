//! EF Core awareness (F-143, M3-11): `__EFMigrationsHistory` read as a migrations timeline on
//! every engine available, found by the explorer's object list, and a connection copied as a
//! .NET connection string with its password only when asked for.
//!
//! SQLite always runs; PostgreSQL, SQL Server and MySQL run when their `YADBE_TEST_*_URL` is
//! set (the fixtures live in uniquely named schemas / databases, dropped at the end).

mod common;

use std::sync::Arc;

use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::dotnet::{ConnectionStringFlavor, ConnectionStringNote};
use yadbe_lib::db::ef::{EfMigrations, HISTORY_TABLE};
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::meta::{ObjectKind, ObjectRef};
use yadbe_lib::db::split::split;
use yadbe_lib::events::{EventSink, RecordingSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretKind, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::connection_string::copy_connection_string;
use yadbe_lib::session::meta_cache::{MetaService, ObservingSink};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

use common::{pg_url, unique_database};

struct Harness {
    store: Arc<Store>,
    secrets: Arc<SecretStore>,
    log: Arc<StatementLog>,
    meta: Arc<MetaService>,
    manager: ConnectionManager,
}

fn harness() -> Harness {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(RecordingSink::default());
    let meta = Arc::new(MetaService::new(sink.clone()));
    let observing: Arc<dyn EventSink> = Arc::new(ObservingSink {
        inner: sink,
        meta: Arc::clone(&meta),
    });
    let log = Arc::new(StatementLog::new(Arc::clone(&observing)));
    let manager = ConnectionManager::new(
        Arc::clone(&store),
        Arc::clone(&secrets),
        Arc::clone(&log),
        observing,
    );
    Harness {
        store,
        secrets,
        log,
        meta,
        manager,
    }
}

impl Harness {
    async fn open(&self, def: &ConnectionDefinition, password: Option<Secret>) -> String {
        let saved = self
            .store
            .create_connection(&def.clone().normalized().expect("valid"))
            .expect("save");
        self.manager
            .connect(&saved.id, password)
            .await
            .expect("connect");
        saved.id
    }
}

/// Runs a fixture script, split like the app splits a script of the engine.
async fn run_script(conn: &dyn yadbe_lib::db::driver::Connection, engine: Engine, script: &str) {
    let syntax = engine.dialect().syntax();
    for statement in split(script, &syntax) {
        let sql = &script[statement.range()];
        if sql
            .lines()
            .all(|l| l.trim().is_empty() || l.trim_start().starts_with("--"))
        {
            continue;
        }
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
}

/// What every engine must read back from its fixture: sorted by id, each id split, the
/// version kept.
fn check_timeline(history: &EfMigrations) {
    let rows: Vec<_> = history
        .migrations
        .iter()
        .map(|m| {
            (
                m.id.as_str(),
                m.name.as_str(),
                m.timestamp.as_deref(),
                m.product_version.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "00000000000000_Legacy",
                "00000000000000_Legacy",
                None,
                Some("3.1.0")
            ),
            (
                "20230214091200_InitialCreate",
                "InitialCreate",
                Some("2023-02-14 09:12:00"),
                Some("7.0.2")
            ),
            (
                "20230301154501_AddCustomers",
                "AddCustomers",
                Some("2023-03-01 15:45:01"),
                Some("7.0.3")
            ),
            (
                "20240608141755_AddAuditColumns",
                "AddAuditColumns",
                Some("2024-06-08 14:17:55"),
                Some("8.0.6")
            ),
        ]
    );
    assert!(!history.truncated);
}

/// The explorer lists the history table, the migrations read, and what is asked wrongly fails
/// with a typed error.
async fn check_history(
    h: &Harness,
    id: &str,
    table: &ObjectRef,
    other_namespace: Option<&ObjectRef>,
) {
    let listed = h
        .meta
        .objects(
            &h.manager,
            None,
            id,
            &table.database,
            table.schema.as_deref(),
            ObjectKind::Table,
        )
        .await
        .expect("objects");
    assert!(
        listed.iter().any(|o| o.name == HISTORY_TABLE),
        "the explorer lists the history table: {:?}",
        listed.iter().map(|o| &o.name).collect::<Vec<_>>()
    );
    let history = h
        .meta
        .ef_migrations(&h.manager, None, id, table)
        .await
        .expect("migrations");
    assert_eq!(&history.table, table);
    check_timeline(&history);
    assert!(
        h.log
            .entries()
            .iter()
            .any(|e| e.sql.contains("MigrationId") && e.sql.contains(HISTORY_TABLE)),
        "the read is in the statement log"
    );

    let not_history = ObjectRef {
        name: "orders".into(),
        ..table.clone()
    };
    let err = h
        .meta
        .ef_migrations(&h.manager, None, id, &not_history)
        .await
        .expect_err("not a history table");
    assert_eq!(err.code, ErrorCode::InvalidArgument, "{err:?}");
    if let Some(other) = other_namespace {
        let err = h
            .meta
            .ef_migrations(&h.manager, None, id, other)
            .await
            .expect_err("no such table");
        assert_eq!(err.code, ErrorCode::ObjectNotFound, "{err:?}");
    }
}

#[tokio::test]
async fn sqlite_migrations() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("app.sqlite");
    rusqlite::Connection::open(&path)
        .expect("create")
        .execute_batch(include_str!("fixtures/ef_sqlite.sql"))
        .expect("fixture");
    let empty_path = dir.path().join("empty.sqlite");
    rusqlite::Connection::open(&empty_path).expect("create");
    let mut def = common::blank(Engine::Sqlite, "app");
    def.file_path = path.display().to_string();
    let mut empty = common::blank(Engine::Sqlite, "empty");
    empty.file_path = empty_path.display().to_string();
    let h = harness();
    let id = h.open(&def, None).await;
    let table = ObjectRef {
        database: "main".into(),
        schema: None,
        name: HISTORY_TABLE.into(),
    };
    // The same address on a file without the table.
    let empty_id = h.open(&empty, None).await;
    let err = h
        .meta
        .ef_migrations(&h.manager, None, &empty_id, &table)
        .await
        .expect_err("no such table");
    assert_eq!(err.code, ErrorCode::ObjectNotFound, "{err:?}");
    check_history(&h, &id, &table, None).await;
}

#[tokio::test]
async fn postgres_migrations() {
    let Some(url) = pg_url("postgres_migrations") else {
        return;
    };
    let schema = unique_database("m311ef").to_lowercase();
    let (def, password) = common::pg_definition(&url);
    let raw = common::open(&def, password.as_ref()).await.expect("raw");
    raw.query(&format!("CREATE SCHEMA \"{schema}\""), 0)
        .await
        .expect("schema");
    let _guard = PgSchema {
        url: url.clone(),
        name: schema.clone(),
    };
    let script = include_str!("fixtures/ef_postgres.sql").replace("{ef}", &format!("\"{schema}\""));
    run_script(&*raw, Engine::Postgres, &script).await;
    // A schema without the table.
    let bare = format!("{schema}_bare");
    raw.query(&format!("CREATE SCHEMA \"{bare}\""), 0)
        .await
        .expect("schema");
    let _bare_guard = PgSchema {
        url: url.clone(),
        name: bare.clone(),
    };
    let h = harness();
    let id = h.open(&def, password).await;
    let database = def.database.clone();
    let at = |schema: &str| ObjectRef {
        database: database.clone(),
        schema: Some(schema.to_owned()),
        name: HISTORY_TABLE.into(),
    };
    check_history(&h, &id, &at(&schema), Some(&at(&bare))).await;
}

struct PgSchema {
    url: String,
    name: String,
}

impl Drop for PgSchema {
    fn drop(&mut self) {
        let url = self.url.clone();
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                let (def, password) = common::pg_definition(&url);
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    let sql = format!("DROP SCHEMA IF EXISTS \"{name}\" CASCADE");
                    if let Err(err) = conn.query(&sql, 0).await {
                        common::skip("dropping a fixture schema", &format!("{name}: {err:?}"));
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

struct MssqlDatabase {
    url: String,
    name: String,
}

impl Drop for MssqlDatabase {
    fn drop(&mut self) {
        let url = self.url.clone();
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                let (def, password) = common::from_url(&url);
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    let sql = format!(
                        "ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]"
                    );
                    if let Err(err) = conn.query(&sql, 0).await {
                        common::skip("dropping the fixture database", &format!("{name}: {err:?}"));
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

#[tokio::test]
async fn mssql_migrations() {
    let Some(url) = common::mssql_url("mssql_migrations") else {
        return;
    };
    let name = unique_database("m311ef");
    let (mut def, password) = common::from_url(&url);
    let master = common::open(&def, password.as_ref()).await.expect("raw");
    master
        .query(&format!("CREATE DATABASE [{name}]"), 0)
        .await
        .expect("database");
    let _guard = MssqlDatabase {
        url: url.clone(),
        name: name.clone(),
    };
    def.database.clone_from(&name);
    let raw = common::open(&def, password.as_ref()).await.expect("raw");
    run_script(&*raw, Engine::Mssql, include_str!("fixtures/ef_mssql.sql")).await;
    raw.query("CREATE SCHEMA bare", 0).await.expect("schema");
    let h = harness();
    let id = h.open(&def, password).await;
    let at = |schema: &str| ObjectRef {
        database: name.clone(),
        schema: Some(schema.to_owned()),
        name: HISTORY_TABLE.into(),
    };
    check_history(&h, &id, &at("dbo"), Some(&at("bare"))).await;
}

#[tokio::test]
async fn mysql_migrations() {
    let Some(url) = common::mysql_url("mysql_migrations") else {
        return;
    };
    let guard = common::MysqlDatabase::create(&url, "m311ef").await;
    let bare = common::MysqlDatabase::create(&url, "m311eb").await;
    let (def, password) = guard.definition();
    let raw = common::open(&def, password.as_ref()).await.expect("raw");
    run_script(&*raw, Engine::Mysql, include_str!("fixtures/ef_mysql.sql")).await;
    let h = harness();
    let id = h.open(&def, password).await;
    let at = |database: &str| ObjectRef {
        database: database.to_owned(),
        schema: None,
        name: HISTORY_TABLE.into(),
    };
    // Another database of the same server, read through the same connection.
    check_history(&h, &id, &at(&guard.name), Some(&at(&bare.name))).await;
}

// --- Connection strings ---------------------------------------------------------------------

fn saved(h: &Harness, engine: Engine, remember: Option<&str>) -> String {
    let mut def = common::blank(engine, "orders");
    def.host = "db.example.com".into();
    def.port = Some(6543);
    def.database = "shop".into();
    def.username = "app".into();
    def.auth = yadbe_lib::db::config::AuthMethod::Password;
    def.tls_mode = yadbe_lib::db::config::TlsMode::VerifyFull;
    if engine == Engine::Sqlite {
        def.host.clear();
        def.file_path = "/data/app.sqlite".into();
    }
    let saved = h
        .store
        .create_connection(&def.normalized().expect("valid"))
        .expect("save");
    if let Some(password) = remember {
        h.secrets
            .set(&saved.id, SecretKind::Password, Secret::new(password), true)
            .expect("remember");
    }
    saved.id
}

#[test]
fn the_password_is_copied_only_when_asked_for() {
    let h = harness();
    let id = saved(&h, Engine::Postgres, Some("s3;cr=t\"x"));
    let copy = |flavor, include| copy_connection_string(&h.store, &h.secrets, &id, flavor, include);

    let plain = copy(ConnectionStringFlavor::AdoNet, false).expect("copy");
    assert!(!plain.includes_password);
    assert!(!plain.text.expose().contains("Password"));
    assert!(!plain.text.expose().contains("s3;cr"));
    assert!(plain.notes.contains(&ConnectionStringNote::PasswordLeftOut));
    assert_eq!(plain.provider.ado_net, "Npgsql");
    assert!(plain.text.expose().starts_with(
        "Host=db.example.com;Port=6543;Database=shop;Username=app;SSL Mode=VerifyFull"
    ));

    let with = copy(ConnectionStringFlavor::AdoNet, true).expect("copy");
    assert!(with.includes_password);
    assert!(with.text.expose().contains("Password='s3;cr=t\"x'"));
    assert!(!with.notes.contains(&ConnectionStringNote::PasswordLeftOut));
    // The EF Core form is C# around the same string.
    let ef = copy(ConnectionStringFlavor::EfCore, true).expect("copy");
    assert!(
        ef.text
            .expose()
            .contains("options.UseNpgsql(connectionString);")
    );
    assert!(ef.text.expose().contains("Password='s3;cr=t\\\"x'"));

    // Nothing that holds the secret prints it, and nothing was logged or recorded.
    assert!(!format!("{with:?}").contains("s3;cr"));
    assert!(h.log.entries().is_empty());
    assert!(!format!("{:?}", h.store.connection(&id).expect("stored")).contains("s3;cr"));
}

#[test]
fn asking_for_a_password_that_is_not_stored_says_so() {
    let h = harness();
    let id = saved(&h, Engine::Mssql, None);
    let err = copy_connection_string(
        &h.store,
        &h.secrets,
        &id,
        ConnectionStringFlavor::AdoNet,
        true,
    )
    .expect_err("no password stored");
    assert_eq!(err.code, ErrorCode::PasswordRequired, "{err:?}");
    // Without asking for it, the same connection copies fine.
    let copy = copy_connection_string(
        &h.store,
        &h.secrets,
        &id,
        ConnectionStringFlavor::AdoNet,
        false,
    )
    .expect("copy");
    assert_eq!(copy.provider.ado_net, "Microsoft.Data.SqlClient");
    assert!(
        copy.text
            .expose()
            .starts_with("Server=db.example.com,6543;Database=shop;User Id=app;")
    );
    let err = copy_connection_string(
        &h.store,
        &h.secrets,
        "missing",
        ConnectionStringFlavor::AdoNet,
        false,
    )
    .expect_err("no such connection");
    assert_eq!(err.code, ErrorCode::ConnectionNotFound, "{err:?}");
}

#[test]
fn a_file_database_has_no_password_to_copy() {
    let h = harness();
    let id = saved(&h, Engine::Sqlite, None);
    let copy = copy_connection_string(
        &h.store,
        &h.secrets,
        &id,
        ConnectionStringFlavor::AdoNet,
        true,
    )
    .expect("copy");
    assert_eq!(copy.text.expose(), "Data Source=/data/app.sqlite");
    assert!(!copy.includes_password);
    assert!(!copy.notes.contains(&ConnectionStringNote::PasswordLeftOut));
}
