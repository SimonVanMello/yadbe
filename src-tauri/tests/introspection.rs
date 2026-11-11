//! Introspection through the metadata cache (M1-1): the conformance suite on every engine
//! available, engine-specific details, and the P-02 measurements (`--ignored`).
//!
//! PostgreSQL runs when `YADBE_TEST_PG_URL` is set; the fixture lives in uniquely named
//! schemas (`yadbe_m11_…`) dropped at the end, so runs can share a database.

mod common;
#[path = "conformance/introspection.rs"]
mod conformance;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{pg_definition, pg_url};
use conformance::{Ctx, Shop};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::meta::{Identity, MetaNode, ObjectDetail, ObjectKind, ObjectRef, TypeCategory};
use yadbe_lib::db::value::ValueKind;
use yadbe_lib::events::{BackendEvent, EventSink, RecordingSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::{MetaService, ObservingSink};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

struct Harness {
    store: Arc<Store>,
    log: Arc<StatementLog>,
    sink: Arc<RecordingSink>,
    meta: Arc<MetaService>,
    manager: ConnectionManager,
}

/// The services wired like `AppState`: the cache observes connection states.
fn harness() -> Harness {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(RecordingSink::default());
    let meta = Arc::new(MetaService::new(sink.clone()));
    let observing: Arc<dyn EventSink> = Arc::new(ObservingSink {
        inner: sink.clone(),
        meta: Arc::clone(&meta),
    });
    let log = Arc::new(StatementLog::new(Arc::clone(&observing)));
    let manager = ConnectionManager::new(Arc::clone(&store), secrets, Arc::clone(&log), observing);
    Harness {
        store,
        log,
        sink,
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

    fn ctx<'a>(&'a self, connection_id: &'a str) -> Ctx<'a> {
        Ctx {
            meta: &self.meta,
            manager: &self.manager,
            log: &self.log,
            sink: &self.sink,
            connection_id,
        }
    }
}

// --- SQLite ---------------------------------------------------------------------------------

fn sqlite_file(script: &str) -> (tempfile::TempDir, ConnectionDefinition) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("shop.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create");
    conn.execute_batch(script).expect("fixture script");
    let mut def = common::blank(Engine::Sqlite, "shop.sqlite");
    def.file_path = path.display().to_string();
    (dir, def)
}

fn sqlite_shop() -> Shop {
    Shop {
        engine: Engine::Sqlite,
        database: "main".into(),
        shop: None,
        sales: None,
        odd: None,
    }
}

#[tokio::test]
async fn sqlite_conformance() {
    let (_dir, def) = sqlite_file(include_str!("fixtures/meta_sqlite.sql"));
    let h = harness();
    let id = h.open(&def, None).await;
    conformance::check(&h.ctx(&id), &sqlite_shop()).await;
}

#[tokio::test]
async fn sqlite_specifics() {
    let (_dir, def) = sqlite_file(include_str!("fixtures/meta_sqlite.sql"));
    let h = harness();
    let id = h.open(&def, None).await;
    let shop = sqlite_shop();
    // AUTOINCREMENT creates `sqlite_sequence`: listed, flagged system.
    let tables = h
        .meta
        .objects(&h.manager, None, &id, "main", None, ObjectKind::Table)
        .await
        .expect("tables");
    let sequence = tables.iter().find(|t| t.name == "sqlite_sequence");
    assert!(sequence.is_some_and(|t| t.system), "{tables:?}");
    // A rowid alias is an identity; a WITHOUT ROWID integer key is not.
    let customers = h.ctx(&id).table(&shop.shop("customers")).await;
    assert_eq!(customers.columns[0].identity, Some(Identity::ByDefault));
    assert_eq!(customers.columns[0].kind, ValueKind::Int);
    // A named check keeps its name; column checks have none.
    let products = h.ctx(&id).table(&shop.shop("products")).await;
    assert!(
        products
            .checks
            .iter()
            .any(|c| c.name.as_deref() == Some("products_price_check"))
    );
    assert!(products.checks.iter().any(|c| c.name.is_none()));
    // Other databases do not exist.
    let error = h
        .meta
        .schemas(&h.manager, None, &id, "other")
        .await
        .expect_err("unknown database");
    assert_eq!(error.code, ErrorCode::UnknownDatabase);
    // A schema on an engine without schemas is refused.
    let error = h
        .meta
        .object_counts(&h.manager, None, &id, "main", Some("main"))
        .await
        .expect_err("no schemas");
    assert_eq!(error.code, ErrorCode::InvalidArgument);
}

#[tokio::test]
async fn closing_forgets_the_cache_and_requires_a_session() {
    let (_dir, def) = sqlite_file(include_str!("fixtures/meta_sqlite.sql"));
    let h = harness();
    let id = h.open(&def, None).await;
    h.meta
        .databases(&h.manager, None, &id)
        .await
        .expect("databases");
    h.manager.disconnect(&id).await;
    let error = h
        .meta
        .databases(&h.manager, None, &id)
        .await
        .expect_err("closed");
    assert_eq!(error.code, ErrorCode::NotConnected);
    // A new session reads again.
    h.manager.connect(&id, None).await.expect("connect");
    let before = h.log.entries().len();
    h.meta
        .objects(&h.manager, None, &id, "main", None, ObjectKind::View)
        .await
        .expect("views");
    assert!(h.log.entries().len() > before);
    // Refreshing the connection is announced even with nothing cached.
    h.meta.refresh(&id, MetaNode::Connection);
    assert!(h.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::MetaRefreshed(r) if r.node == MetaNode::Connection
    )));
}

// --- PostgreSQL -----------------------------------------------------------------------------

/// Unique schema names for one run, dropped when the guard goes.
struct PgSchemas {
    url: String,
    names: Vec<String>,
}

fn unique_prefix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("yadbe_m11_{}_{nanos:x}", std::process::id())
}

impl Drop for PgSchemas {
    fn drop(&mut self) {
        let url = self.url.clone();
        let names = std::mem::take(&mut self.names);
        // A runtime of its own: the test's runtime may be shutting down.
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                let (def, password) = pg_definition(&url);
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    for name in names {
                        // Tables first, a few hundred per transaction: one `DROP SCHEMA` of
                        // thousands of tables exceeds the server's lock table.
                        let list = format!(
                            "SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') \
                             FROM (SELECT relname, relnamespace FROM pg_class \
                             WHERE relkind = 'r' AND relnamespace = \
                             (SELECT oid FROM pg_namespace WHERE nspname = '{name}') LIMIT 300) c \
                             JOIN pg_namespace n ON n.oid = c.relnamespace"
                        );
                        while let Ok(result) = conn.query(&list, 1).await {
                            let Some(tables) = result.scalar_text() else {
                                break;
                            };
                            if conn
                                .query(&format!("DROP TABLE {tables} CASCADE"), 0)
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        let sql = format!("DROP SCHEMA IF EXISTS \"{name}\" CASCADE");
                        if let Err(err) = conn.query(&sql, 0).await {
                            common::skip("dropping a fixture schema", &format!("{name}: {err:?}"));
                        }
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

/// Splits a fixture script into statements: `;` at the end of a line, outside `$$` bodies.
fn statements(script: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_body = false;
    for line in script.lines() {
        let trimmed = line.trim();
        if current.is_empty() && (trimmed.is_empty() || trimmed.starts_with("--")) {
            continue;
        }
        in_body ^= line.matches("$$").count() % 2 == 1;
        current.push_str(line);
        current.push('\n');
        if !in_body && trimmed.ends_with(';') {
            out.push(std::mem::take(&mut current));
        }
    }
    out
}

async fn pg_fixture(url: &str) -> (PgSchemas, Shop) {
    let prefix = unique_prefix();
    let (shop, sales, odd) = (
        format!("{prefix}_shop"),
        format!("{prefix}_sales"),
        format!("{prefix}_Odd Schema"),
    );
    let guard = PgSchemas {
        url: url.to_owned(),
        names: vec![shop.clone(), sales.clone(), odd.clone()],
    };
    let script = include_str!("fixtures/meta_postgres.sql")
        .replace("{shop}", &format!("\"{shop}\""))
        .replace("{sales}", &format!("\"{sales}\""))
        .replace("{odd}", &format!("\"{odd}\""));
    let (def, password) = pg_definition(url);
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    for statement in statements(&script) {
        conn.query(&statement, 0)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e:?}"));
    }
    conn.close().await;
    let database = def.database.clone();
    (
        guard,
        Shop {
            engine: Engine::Postgres,
            database,
            shop: Some(shop),
            sales: Some(sales),
            odd: Some(odd),
        },
    )
}

#[tokio::test]
async fn postgres_conformance_and_specifics() {
    let Some(url) = pg_url("postgres_conformance_and_specifics") else {
        return;
    };
    let (_guard, shop) = pg_fixture(&url).await;
    let h = harness();
    let (def, password) = pg_definition(&url);
    let id = h.open(&def, password).await;
    conformance::check(&h.ctx(&id), &shop).await;

    let meta: &MetaService = &h.meta;
    let manager = &h.manager;
    let db = shop.database.as_str();
    let connection = id.as_str();
    let list = |schema: &Option<String>, kind| {
        let schema = schema.clone();
        async move {
            meta.objects(manager, None, connection, db, schema.as_deref(), kind)
                .await
                .expect("objects")
        }
    };

    // Comments, exact types, domains and enums mapped to their logical family.
    let customers = h.ctx(&id).table(&shop.shop("customers")).await;
    assert_eq!(customers.comment.as_deref(), Some("People who ordered"));
    assert_eq!(customers.columns[0].identity, Some(Identity::Always));
    assert_eq!(customers.columns[1].comment.as_deref(), Some("Lower-cased"));
    assert_eq!(customers.columns[2].type_name, "character varying(200)");
    let orders = h.ctx(&id).table(&shop.shop("orders")).await;
    assert_eq!(
        orders.columns[0]
            .default
            .as_deref()
            .map(|d| d.starts_with("nextval(")),
        Some(true)
    );
    assert_eq!(
        orders.columns[2].kind,
        ValueKind::Decimal,
        "domain over numeric"
    );
    assert!(
        orders.columns[4].default.is_none(),
        "generated, not a default"
    );
    assert!(
        orders.triggers[0]
            .function
            .as_deref()
            .is_some_and(|f| f.ends_with(".touch"))
    );
    let products = h.ctx(&id).table(&shop.shop("products")).await;
    assert_eq!(products.columns[4].kind, ValueKind::Text, "enum");
    assert_eq!(products.columns[0].identity, Some(Identity::ByDefault));

    // Overloads are distinct; procedures apart from functions.
    let functions = list(&shop.shop, ObjectKind::Function).await;
    let totals: Vec<_> = functions
        .iter()
        .filter(|f| f.name == "order_total")
        .collect();
    assert_eq!(totals.len(), 2);
    assert_ne!(totals[0].id, totals[1].id);
    assert!(
        totals
            .iter()
            .any(|f| f.comment.as_deref() == Some("Total of an order"))
    );
    let Some(ObjectDetail::Routine(signature)) = totals.first().map(|f| &f.detail) else {
        panic!("routine detail");
    };
    assert_eq!(signature.return_type.as_deref(), Some("numeric"));
    assert_eq!(signature.language.as_deref(), Some("sql"));
    let procedures = list(&shop.sales, ObjectKind::Procedure).await;
    assert_eq!(procedures.len(), 1);
    let Some(ObjectDetail::Routine(procedure)) = procedures.first().map(|p| &p.detail) else {
        panic!("procedure detail");
    };
    assert_eq!(procedure.arguments, "IN p_before date");
    assert!(procedure.return_type.is_none());

    // Sequences, owned or not; materialized views; types.
    let sequences = list(&shop.shop, ObjectKind::Sequence).await;
    let owned = sequences
        .iter()
        .find(|s| s.name == "orders_id_seq")
        .and_then(|s| match &s.detail {
            ObjectDetail::Sequence(seq) => seq.owned_by.clone(),
            _ => None,
        })
        .expect("serial sequence");
    assert_eq!(
        (owned.table.name.as_str(), owned.column.as_str()),
        ("orders", "id")
    );
    let sales_sequences = list(&shop.sales, ObjectKind::Sequence).await;
    let invoice_seq = sales_sequences
        .iter()
        .find(|s| s.name == "invoice_number_seq")
        .expect("sequence");
    let ObjectDetail::Sequence(seq) = &invoice_seq.detail else {
        panic!("sequence detail");
    };
    assert_eq!(
        (seq.start.as_str(), seq.data_type.as_str()),
        ("1000", "bigint")
    );
    assert!(seq.owned_by.is_none());
    let matviews = list(&shop.sales, ObjectKind::MaterializedView).await;
    assert_eq!(matviews.len(), 1);
    let daily = h.ctx(&id).table(&shop.sales("daily_sales")).await;
    assert_eq!(daily.kind, ObjectKind::MaterializedView);
    let types = list(&shop.shop, ObjectKind::Type).await;
    let type_detail = |name: &str| {
        types
            .iter()
            .find(|t| t.name == name)
            .and_then(|t| match &t.detail {
                ObjectDetail::Type(detail) => Some(detail.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("type {name} in {types:?}"))
    };
    let status = type_detail("product_status");
    assert_eq!(status.category, TypeCategory::Enum);
    assert_eq!(status.enum_values, ["draft", "active", "archived"]);
    let amount = type_detail("positive_amount");
    assert_eq!(amount.category, TypeCategory::Domain);
    assert_eq!(amount.base_type.as_deref(), Some("numeric(12,2)"));
    let money = type_detail("money_amount");
    assert_eq!(money.category, TypeCategory::Composite);
    assert_eq!(money.attributes.len(), 2);
    let counts = meta
        .object_counts(manager, None, &id, db, shop.shop.as_deref())
        .await
        .expect("counts");
    let count_of = |kind| counts.iter().find(|c| c.kind == kind).map(|c| c.count);
    assert_eq!(count_of(ObjectKind::Type), Some(3));
    assert_eq!(count_of(ObjectKind::Function), Some(3));
    assert_eq!(
        count_of(ObjectKind::Table),
        Some(u32::try_from(list(&shop.shop, ObjectKind::Table).await.len()).unwrap_or(0))
    );

    // System schemas are flagged and their objects readable.
    let schemas = meta.schemas(manager, None, &id, db).await.expect("schemas");
    assert!(schemas.iter().any(|s| s.name == "pg_catalog" && s.system));
    assert!(schemas.iter().all(|s| !s.name.starts_with("pg_temp_")));
    let missing = meta
        .object_counts(manager, None, &id, db, Some("no_such_schema_m11"))
        .await
        .expect_err("missing schema");
    assert_eq!(missing.code, ErrorCode::ObjectNotFound);
    let catalog = meta
        .completion_catalog(manager, None, &id, db, true)
        .await
        .expect("catalog with system objects");
    assert!(catalog.schemas.iter().any(|s| s.name == "pg_catalog"));
    assert!(catalog.routines.iter().any(|r| r.name == "now"));
    assert!(catalog.search_path.iter().all(|s| !s.is_empty()));

    // Another database goes through a metadata connection of its own.
    let databases = meta.databases(manager, None, &id).await.expect("databases");
    if let Some(other) = databases
        .iter()
        .find(|d| !d.current && d.accessible && !d.system)
    {
        let schemas = meta
            .schemas(manager, None, &id, &other.name)
            .await
            .expect("schemas of another database");
        assert!(schemas.iter().any(|s| s.name == "pg_catalog"));
    } else {
        common::skip("postgres other database", "no other accessible database");
    }

    // Every metadata statement is in the statement log, with bound names.
    let entries = h.log.entries();
    assert!(
        entries
            .iter()
            .any(|e| e.sql.contains("FROM pg_attribute a"))
    );
    assert!(
        entries
            .iter()
            .all(|e| !e.sql.contains(shop.shop.as_deref().unwrap_or("-")))
    );
}

#[tokio::test]
async fn postgres_cancel_and_reconnect() {
    let Some(url) = pg_url("postgres_cancel_and_reconnect") else {
        return;
    };
    let h = harness();
    let (def, password) = pg_definition(&url);
    let id = h.open(&def, password).await;
    let db = def.database.clone();

    // Cancelled while it runs: fails with `cancelled`, and the next call works. The cancel
    // is repeated until it lands (it is ignored before the call registers its id).
    h.meta
        .databases(&h.manager, None, &id)
        .await
        .expect("databases");
    let call = h
        .meta
        .completion_catalog(&h.manager, Some("req-1"), &id, &db, true);
    tokio::pin!(call);
    let result = loop {
        tokio::select! {
            result = &mut call => break result,
            () = tokio::time::sleep(Duration::from_millis(2)) => h.meta.cancel("req-1"),
        }
    };
    match result {
        Err(error) => assert_eq!(error.code, ErrorCode::Cancelled),
        Ok(_) => common::skip("postgres cancel", "the call finished before the cancel"),
    }
    h.meta
        .databases(&h.manager, None, &id)
        .await
        .expect("usable after a cancel");

    // The server kills the backend: the cache empties and is announced once back.
    let pid = h
        .manager
        .session(&id)
        .expect("session")
        .query("SELECT pg_backend_pid()", 1)
        .await
        .expect("pid")
        .scalar_text()
        .expect("pid value");
    let (admin_def, admin_password) = pg_definition(&url);
    let admin = common::open(&admin_def, admin_password.as_ref())
        .await
        .expect("admin");
    admin
        .query(&format!("SELECT pg_terminate_backend({pid})"), 1)
        .await
        .expect("terminate");
    admin.close().await;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let reconnected = h.sink.events().iter().any(|e| {
            matches!(e, BackendEvent::MetaRefreshed(r) if r.connection_id == id
                && r.node == MetaNode::Connection)
        });
        if reconnected {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "no meta-refreshed after the reconnection"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    h.meta
        .databases(&h.manager, None, &id)
        .await
        .expect("databases after the reconnection");
}

// --- P-02 -------------------------------------------------------------------------------------

/// The explorer's first level for one schema, cold: databases, schemas, counts, tables.
async fn first_level(h: &Harness, id: &str, database: &str, schema: Option<&str>) -> Duration {
    let started = Instant::now();
    h.meta
        .databases(&h.manager, None, id)
        .await
        .expect("databases");
    h.meta
        .schemas(&h.manager, None, id, database)
        .await
        .expect("schemas");
    h.meta
        .object_counts(&h.manager, None, id, database, schema)
        .await
        .expect("counts");
    let tables = h
        .meta
        .objects(&h.manager, None, id, database, schema, ObjectKind::Table)
        .await
        .expect("tables");
    let elapsed = started.elapsed();
    assert!(tables.len() >= 500, "{}", tables.len());
    elapsed
}

/// Statements logged since entry `from`, with their duration (server + transfer + decoding;
/// pipelined statements overlap).
fn print_statements(log: &StatementLog, from: usize) {
    for entry in log.entries().iter().skip(from) {
        let sql: String = entry.sql.split_whitespace().collect::<Vec<_>>().join(" ");
        println!(
            "    {:>8.1} ms  {}",
            entry.duration_ms,
            &sql[..sql.len().min(90)]
        );
    }
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

/// `tables` tables of `columns` columns (key + foreign key to the previous table), `views`
/// views and `functions` functions, as SQL statements of at most 500 objects each.
fn generated_schema(
    schema: &str,
    tables: usize,
    columns: usize,
    views: usize,
    functions: usize,
    quote: &dyn Fn(&str) -> String,
    with_functions: bool,
) -> Vec<String> {
    let s = |name: String| match schema {
        "" => quote(&name),
        _ => format!("{}.{}", quote(schema), quote(&name)),
    };
    let mut out = Vec::new();
    let mut batch = String::new();
    for t in 0..tables {
        let mut cols = vec!["id integer PRIMARY KEY".to_owned()];
        if t > 0 {
            cols.push(format!(
                "parent_id integer REFERENCES {}",
                s(format!("table_{:05}", t - 1))
            ));
        }
        for c in cols.len()..columns {
            let ty = ["text", "integer", "numeric(12,2)", "timestamp", "boolean"][c % 5];
            cols.push(format!("col_{c:02} {ty}"));
        }
        batch.push_str(&format!(
            "CREATE TABLE {} ({});\n",
            s(format!("table_{t:05}")),
            cols.join(", ")
        ));
        if (t + 1) % 500 == 0 {
            out.push(std::mem::take(&mut batch));
        }
    }
    for v in 0..views {
        batch.push_str(&format!(
            "CREATE VIEW {} AS SELECT id FROM {};\n",
            s(format!("view_{v:05}")),
            s(format!("table_{:05}", v % tables.max(1)))
        ));
    }
    if with_functions {
        for f in 0..functions {
            batch.push_str(&format!(
                "CREATE FUNCTION {}(p integer) RETURNS integer LANGUAGE sql AS 'SELECT p';\n",
                s(format!("fn_{f:05}"))
            ));
        }
    }
    if !batch.is_empty() {
        out.push(batch);
    }
    out
}

#[tokio::test]
#[ignore = "P-02 measurement: cargo test --test introspection p02 -- --ignored --nocapture"]
async fn p02_sqlite() {
    let quote = |n: &str| format!("\"{n}\"");
    for (tables, views, label) in [(500, 0, "500 tables"), (9_500, 500, "10k objects")] {
        let script = generated_schema("", tables, 10, views, 0, &quote, false).join("");
        let (_dir, def) = sqlite_file(&script);
        let h = harness();
        let id = h.open(&def, None).await;
        let level = first_level(&h, &id, "main", None).await;
        let logged = h.log.entries().len();
        let started = Instant::now();
        let catalog = h
            .meta
            .completion_catalog(&h.manager, None, &id, "main", false)
            .await
            .expect("catalog");
        let catalog_time = started.elapsed();
        print_statements(&h.log, logged);
        let json = serde_json::to_vec(&catalog).expect("json").len();
        println!(
            "P-02 SQLite {label}: first level {} ms; catalog {} ms ({} relations, {} KiB JSON)",
            ms(level),
            ms(catalog_time),
            catalog.relations.len(),
            json / 1024
        );
    }
}

#[tokio::test]
#[ignore = "P-02 measurement: cargo test --test introspection p02 -- --ignored --nocapture"]
async fn p02_postgres() {
    let Some(url) = pg_url("p02_postgres") else {
        return;
    };
    let prefix = unique_prefix();
    let (small, large) = (format!("{prefix}_p02_500"), format!("{prefix}_p02_10k"));
    let _guard = PgSchemas {
        url: url.clone(),
        names: vec![small.clone(), large.clone()],
    };
    let (def, password) = pg_definition(&url);
    let quote = |n: &str| format!("\"{n}\"");
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    for (schema, tables, views, functions) in [(&small, 500, 0, 0), (&large, 9_000, 500, 500)] {
        conn.query(&format!("CREATE SCHEMA {}", quote(schema)), 0)
            .await
            .expect("schema");
        for batch in generated_schema(schema, tables, 10, views, functions, &quote, true) {
            // One DO block per batch: one round trip, bounded locks per transaction.
            conn.query(&format!("DO $b$ BEGIN\n{batch}END $b$"), 0)
                .await
                .expect("generate");
        }
    }
    conn.close().await;

    for (schema, label) in [(&small, "500 tables"), (&large, "10k objects")] {
        let h = harness();
        let started = Instant::now();
        let id = h.open(&def, password.clone()).await;
        let connect = started.elapsed();
        let level = first_level(&h, &id, &def.database, Some(schema)).await;
        let started = Instant::now();
        let details = h
            .meta
            .table_details(
                &h.manager,
                None,
                &id,
                &ObjectRef {
                    database: def.database.clone(),
                    schema: Some(schema.clone()),
                    name: "table_00042".into(),
                },
            )
            .await
            .expect("details");
        let details_time = started.elapsed();
        assert_eq!(details.columns.len(), 10);
        let logged = h.log.entries().len();
        let started = Instant::now();
        let catalog = h
            .meta
            .completion_catalog(&h.manager, None, &id, &def.database, false)
            .await
            .expect("catalog");
        let catalog_time = started.elapsed();
        print_statements(&h.log, logged);
        let json = serde_json::to_vec(&catalog).expect("json").len();
        println!(
            "P-02 PostgreSQL {label}: connect {} ms; first level {} ms; table details {} ms; \
             catalog of the database {} ms ({} relations, {} routines, {} KiB JSON)",
            ms(connect),
            ms(level),
            ms(details_time),
            ms(catalog_time),
            catalog.relations.len(),
            catalog.routines.len(),
            json / 1024
        );
    }
}

// --- SQL Server -----------------------------------------------------------------------------

/// A database created for one run, dropped when the guard goes.
struct MssqlDatabase {
    url: String,
    name: String,
}

impl Drop for MssqlDatabase {
    fn drop(&mut self) {
        let url = self.url.clone();
        let name = self.name.clone();
        // A runtime of its own: the test's runtime may be shutting down.
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

/// Creates the fixture database and loads `meta_mssql.sql` into it, batch by batch.
async fn mssql_fixture(url: &str) -> (MssqlDatabase, Shop, ConnectionDefinition, Option<Secret>) {
    let name = unique_prefix().replace("m11", "m17");
    let (mut def, password) = common::from_url(url);
    let master = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    master
        .query(&format!("CREATE DATABASE [{name}]"), 0)
        .await
        .expect("create database");
    master.close().await;
    let guard = MssqlDatabase {
        url: url.to_owned(),
        name: name.clone(),
    };
    def.database = name.clone();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect to the fixture database");
    let script = include_str!("fixtures/meta_mssql.sql");
    let syntax = Engine::Mssql.dialect().syntax();
    for batch in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[batch.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    (
        guard,
        Shop {
            engine: Engine::Mssql,
            database: name,
            shop: Some("shop".into()),
            sales: Some("sales".into()),
            odd: Some("Odd Schema".into()),
        },
        def,
        password,
    )
}

#[tokio::test]
async fn mssql_conformance_and_specifics() {
    let Some(url) = common::mssql_url("mssql_conformance_and_specifics") else {
        return;
    };
    let (_guard, shop, def, password) = mssql_fixture(&url).await;
    let h = harness();
    let id = h.open(&def, password).await;
    conformance::check(&h.ctx(&id), &shop).await;

    let meta: &MetaService = &h.meta;
    let manager = &h.manager;
    let db = shop.database.as_str();
    let connection = id.as_str();
    let list = |schema: &Option<String>, kind| {
        let schema = schema.clone();
        async move {
            meta.objects(manager, None, connection, db, schema.as_deref(), kind)
                .await
                .expect("objects")
        }
    };

    // Comments, exact types, identity, alias types mapped to their family.
    let customers = h.ctx(&id).table(&shop.shop("customers")).await;
    assert_eq!(customers.comment.as_deref(), Some("People who ordered"));
    assert_eq!(customers.columns[0].identity, Some(Identity::Always));
    assert_eq!(customers.columns[1].comment.as_deref(), Some("Lower-cased"));
    assert_eq!(customers.columns[2].type_name, "nvarchar(200)");
    assert_eq!(customers.columns[3].type_name, "datetime2(3)");
    assert_eq!(customers.columns[3].kind, ValueKind::Timestamp);
    assert_eq!(customers.row_estimate, Some(0.0));
    let orders = h.ctx(&id).table(&shop.shop("orders")).await;
    assert_eq!(orders.columns[2].type_name, "positive_amount");
    assert_eq!(
        orders.columns[2].kind,
        ValueKind::Decimal,
        "alias of decimal"
    );
    let total = &orders.columns[4];
    assert_eq!(
        total
            .generated
            .as_ref()
            .and_then(|g| g.expression.as_deref()),
        Some("([subtotal]+[shipping])")
    );
    assert!(total.default.is_none());
    assert_eq!(
        orders.triggers[0].events,
        [yadbe_lib::db::meta::TriggerEvent::Update]
    );
    assert!(
        orders.triggers[0]
            .definition
            .as_deref()
            .is_some_and(|d| d.contains("CREATE TRIGGER")),
        "{:?}",
        orders.triggers
    );
    let index = orders
        .indexes
        .iter()
        .find(|i| i.name == "orders_created_at_idx")
        .expect("filtered index");
    assert_eq!(index.columns, ["created_at DESC"]);
    assert_eq!(index.method.as_deref(), Some("nonclustered"));

    // Functions (scalar and table-valued) apart from procedures, with their signatures.
    let functions = list(&shop.shop, ObjectKind::Function).await;
    let signature = |name: &str| {
        functions
            .iter()
            .chain(&[])
            .find(|f| f.name == name)
            .and_then(|f| match &f.detail {
                ObjectDetail::Routine(r) => Some((f.comment.clone(), r.clone())),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} in {functions:?}"))
    };
    let (comment, total_fn) = signature("order_total");
    assert_eq!(comment.as_deref(), Some("Total of an order"));
    assert_eq!(total_fn.arguments, "@order_id int");
    assert_eq!(total_fn.return_type.as_deref(), Some("decimal(13,2)"));
    assert_eq!(
        signature("orders_of").1.return_type.as_deref(),
        Some("TABLE")
    );
    let procedures = list(&shop.sales, ObjectKind::Procedure).await;
    assert_eq!(procedures.len(), 1);
    let Some(ObjectDetail::Routine(procedure)) = procedures.first().map(|p| &p.detail) else {
        panic!("procedure detail");
    };
    assert_eq!(procedure.arguments, "@before date, @archived int OUTPUT");
    assert_eq!(procedure.identity_arguments, "date, int");
    assert!(procedure.return_type.is_none());

    // Sequences and user-defined types (alias, table type).
    let sequences = list(&shop.sales, ObjectKind::Sequence).await;
    let Some(ObjectDetail::Sequence(seq)) = sequences
        .iter()
        .find(|s| s.name == "invoice_number_seq")
        .map(|s| &s.detail)
    else {
        panic!("sequence in {sequences:?}");
    };
    assert_eq!(
        (seq.start.as_str(), seq.data_type.as_str()),
        ("1000", "bigint")
    );
    let types = list(&shop.shop, ObjectKind::Type).await;
    let type_detail = |name: &str| {
        types
            .iter()
            .find(|t| t.name == name)
            .and_then(|t| match &t.detail {
                ObjectDetail::Type(detail) => Some(detail.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("type {name} in {types:?}"))
    };
    let amount = type_detail("positive_amount");
    assert_eq!(amount.category, TypeCategory::Domain);
    assert_eq!(amount.base_type.as_deref(), Some("decimal(12,2)"));
    let lines = type_detail("order_lines");
    assert_eq!(lines.category, TypeCategory::Composite);
    assert_eq!(
        lines
            .attributes
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["product_id", "quantity"]
    );
    let counts = meta
        .object_counts(manager, None, &id, db, shop.shop.as_deref())
        .await
        .expect("counts");
    let count_of = |kind| counts.iter().find(|c| c.kind == kind).map(|c| c.count);
    assert_eq!(count_of(ObjectKind::Type), Some(2));
    assert_eq!(count_of(ObjectKind::Function), Some(2));
    let missing = meta
        .object_counts(manager, None, &id, db, Some("no_such_schema_m17"))
        .await
        .expect_err("missing schema");
    assert_eq!(missing.code, ErrorCode::ObjectNotFound);

    // System schemas and databases are flagged; other databases are read on the same
    // connection.
    let schemas = meta.schemas(manager, None, &id, db).await.expect("schemas");
    assert!(schemas.iter().any(|s| s.name == "sys" && s.system));
    assert!(schemas.iter().any(|s| s.name == "dbo" && !s.system));
    assert!(schemas.iter().any(|s| s.name == "db_owner" && s.system));
    let databases = meta.databases(manager, None, &id).await.expect("databases");
    assert!(
        databases
            .iter()
            .any(|d| d.name == "master" && d.system && !d.current)
    );
    let before = h.log.entries().len();
    let master_schemas = meta
        .schemas(manager, None, &id, "master")
        .await
        .expect("master schemas");
    assert!(master_schemas.iter().any(|s| s.name == "dbo"));
    assert!(
        h.log.entries()[before..]
            .iter()
            .any(|e| e.sql.contains("[master].sys.schemas")),
        "qualified with the database"
    );
    let error = meta
        .schemas(manager, None, &id, "no_such_db_m17")
        .await
        .expect_err("unknown database");
    assert_eq!(error.code, ErrorCode::UnknownDatabase);
    let catalog = meta
        .completion_catalog(manager, None, &id, db, true)
        .await
        .expect("catalog with system objects");
    assert!(catalog.schemas.iter().any(|s| s.name == "sys"));
    assert!(catalog.relations.iter().any(|r| r.name == "objects"));
    assert_eq!(catalog.search_path, ["dbo"]);
    assert!(
        catalog
            .routines
            .iter()
            .any(|r| r.name == "archive_invoices" && r.kind == ObjectKind::Procedure)
    );
}

// --- MySQL / MariaDB ------------------------------------------------------------------------

/// Creates the fixture database and loads `meta_mysql.sql` into it, statement by statement.
async fn mysql_fixture(
    url: &str,
) -> (
    common::MysqlDatabase,
    Shop,
    ConnectionDefinition,
    Option<Secret>,
) {
    let guard = common::MysqlDatabase::create(url, "m31").await;
    let (def, password) = guard.definition();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect to the fixture database");
    let script = include_str!("fixtures/meta_mysql.sql");
    let syntax = Engine::Mysql.dialect().syntax();
    for statement in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[statement.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    let shop = Shop {
        engine: Engine::Mysql,
        database: guard.name.clone(),
        shop: None,
        sales: None,
        odd: None,
    };
    (guard, shop, def, password)
}

#[tokio::test]
async fn mysql_conformance_and_specifics() {
    let Some(url) = common::mysql_url("mysql_conformance_and_specifics") else {
        return;
    };
    let (guard, shop, def, password) = mysql_fixture(&url).await;
    let h = harness();
    let id = h.open(&def, password.clone()).await;
    conformance::check(&h.ctx(&id), &shop).await;

    let meta: &MetaService = &h.meta;
    let manager = &h.manager;
    let db = shop.database.as_str();
    let version = manager
        .session(&id)
        .and_then(|s| s.connection())
        .expect("connection")
        .server_version()
        .to_owned();
    let mariadb = version.starts_with("MariaDB");

    // Comments, exact types, identity, defaults written as SQL.
    let customers = h.ctx(&id).table(&shop.shop("customers")).await;
    assert_eq!(customers.comment.as_deref(), Some("People who ordered"));
    assert_eq!(customers.columns[0].identity, Some(Identity::ByDefault));
    assert_eq!(customers.columns[1].comment.as_deref(), Some("Lower-cased"));
    assert_eq!(customers.columns[2].type_name, "varchar(200)");
    assert_eq!(customers.columns[3].type_name, "datetime(3)");
    assert_eq!(customers.columns[3].kind, ValueKind::Timestamp);
    assert!(
        customers.columns[3]
            .default
            .as_deref()
            .is_some_and(|d| d.to_ascii_lowercase().starts_with("current_timestamp(3)")),
        "{:?}",
        customers.columns[3]
    );
    let products = h.ctx(&id).table(&shop.shop("products")).await;
    let status = &products.columns[4];
    assert_eq!(status.type_name, "enum('draft','active','archived')");
    assert_eq!(status.kind, ValueKind::Text);
    assert_eq!(status.default.as_deref(), Some("'draft'"));
    assert_eq!(products.columns[3].kind, ValueKind::Decimal);
    let invoices = h.ctx(&id).table(&shop.sales("invoices")).await;
    // MariaDB keeps the display width (`bigint(20) unsigned`).
    let id_type = &invoices.columns[0].type_name;
    assert!(
        id_type.starts_with("bigint") && id_type.ends_with(" unsigned"),
        "{id_type}"
    );
    assert_eq!(invoices.columns[0].kind, ValueKind::Int);
    let orders = h.ctx(&id).table(&shop.shop("orders")).await;
    let total = &orders.columns[4];
    assert!(total.default.is_none());
    assert!(total.generated.as_ref().is_some_and(|g| g.stored));
    assert_eq!(orders.columns[3].default.as_deref(), Some("0.00"));
    assert!(
        orders.triggers[0].definition.as_deref().is_some_and(|d| d
            .starts_with("CREATE TRIGGER `orders_touch` BEFORE UPDATE ON `orders` FOR EACH ROW")),
        "{:?}",
        orders.triggers
    );
    let index = orders
        .indexes
        .iter()
        .find(|i| i.name == "orders_created_at_idx")
        .expect("index");
    assert_eq!(index.method.as_deref(), Some("btree"));
    assert!(
        orders
            .checks
            .iter()
            .any(|c| c.name.as_deref() == Some("orders_subtotal_check")),
        "{:?}",
        orders.checks
    );
    // The index MySQL creates for a foreign key is listed, not taken for a unique key.
    assert!(orders.unique_keys.is_empty(), "{:?}", orders.unique_keys);

    // Functions apart from procedures, with their signatures.
    let connection = id.as_str();
    let list = |kind| async move {
        meta.objects(manager, None, connection, db, None, kind)
            .await
            .expect("objects")
    };
    let functions = list(ObjectKind::Function).await;
    let Some(ObjectDetail::Routine(total_fn)) = functions
        .iter()
        .find(|f| f.name == "order_total")
        .map(|f| &f.detail)
    else {
        panic!("order_total in {functions:?}");
    };
    // MariaDB keeps display widths: `int(11)`.
    let widthless = |s: &str| s.replace("(11)", "");
    assert_eq!(widthless(&total_fn.arguments), "p_order_id int");
    assert_eq!(total_fn.return_type.as_deref(), Some("decimal(13,2)"));
    assert_eq!(functions[0].comment.as_deref(), Some("Total of an order"));
    let procedures = list(ObjectKind::Procedure).await;
    let Some(ObjectDetail::Routine(procedure)) = procedures.first().map(|p| &p.detail) else {
        panic!("procedure in {procedures:?}");
    };
    assert_eq!(
        widthless(&procedure.arguments),
        "IN p_before date, OUT p_archived int"
    );
    assert_eq!(widthless(&procedure.identity_arguments), "date, int");
    assert!(procedure.return_type.is_none());
    let counts = meta
        .object_counts(manager, None, &id, db, None)
        .await
        .expect("counts");
    let count_of = |kind| counts.iter().find(|c| c.kind == kind).map(|c| c.count);
    assert_eq!(count_of(ObjectKind::Table), Some(6));
    assert_eq!(count_of(ObjectKind::View), Some(1));
    assert_eq!(count_of(ObjectKind::Procedure), Some(1));

    // Databases: the server's own are flagged system and read on the same connection.
    let databases = meta.databases(manager, None, &id).await.expect("databases");
    assert!(
        databases
            .iter()
            .any(|d| d.name == "information_schema" && d.system && !d.current)
    );
    assert!(
        databases
            .iter()
            .any(|d| d.name == db && d.current && !d.system)
    );
    let system = meta
        .objects(
            manager,
            None,
            &id,
            "information_schema",
            None,
            ObjectKind::View,
        )
        .await
        .expect("information_schema views");
    assert!(
        system
            .iter()
            .any(|v| v.name.eq_ignore_ascii_case("tables") && v.system)
    );
    let error = meta
        .object_counts(manager, None, &id, "yadbe_no_such_db_m31", None)
        .await
        .expect_err("unknown database");
    assert_eq!(error.code, ErrorCode::UnknownDatabase);
    let catalog = meta
        .completion_catalog(manager, None, &id, db, true)
        .await
        .expect("catalog");
    assert!(catalog.schemas.is_empty() && catalog.search_path.is_empty());
    assert!(
        catalog
            .routines
            .iter()
            .any(|r| r.name == "archive_invoices" && r.kind == ObjectKind::Procedure)
    );

    // MySQL 8 indexes expressions (functional key parts); MariaDB does not.
    if !mariadb {
        let conn = common::open(&def, password.as_ref())
            .await
            .expect("connect");
        conn.query(
            "CREATE INDEX customers_lower_email_idx ON customers ((lower(email)))",
            0,
        )
        .await
        .expect("functional index");
        conn.close().await;
        meta.refresh(
            &id,
            MetaNode::Table {
                table: shop.shop("customers"),
            },
        );
        let customers = h.ctx(&id).table(&shop.shop("customers")).await;
        let lower = customers
            .indexes
            .iter()
            .find(|i| i.name == "customers_lower_email_idx")
            .expect("expression index");
        assert_eq!(lower.columns, ["lower(`email`)"]);
        assert!(!lower.unique);
        assert_eq!(
            customers.unique_keys.len(),
            1,
            "an expression index is no key"
        );
    }
    drop(guard);
}

#[tokio::test]
#[ignore = "P-02 measurement: cargo test --test introspection p02 -- --ignored --nocapture"]
async fn p02_mysql() {
    let Some(url) = common::mysql_url("p02_mysql") else {
        return;
    };
    let guard = common::MysqlDatabase::create(&url, "p02").await;
    let (def, password) = guard.definition();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    for t in 0..500 {
        let mut cols = vec!["id int PRIMARY KEY".to_owned()];
        if t > 0 {
            cols.push("parent_id int".to_owned());
            cols.push(format!(
                "FOREIGN KEY (parent_id) REFERENCES table_{:05} (id)",
                t - 1
            ));
        }
        for c in 2..10 {
            let ty = ["text", "int", "decimal(12,2)", "datetime", "boolean"][c % 5];
            cols.push(format!("col_{c:02} {ty}"));
        }
        conn.query(
            &format!("CREATE TABLE table_{t:05} ({})", cols.join(", ")),
            0,
        )
        .await
        .expect("generate");
    }
    conn.close().await;
    let h = harness();
    let started = Instant::now();
    let id = h.open(&def, password).await;
    let connect = started.elapsed();
    let level = first_level(&h, &id, &def.database, None).await;
    let started = Instant::now();
    let details = h
        .meta
        .table_details(
            &h.manager,
            None,
            &id,
            &ObjectRef {
                database: def.database.clone(),
                schema: None,
                name: "table_00042".into(),
            },
        )
        .await
        .expect("details");
    let details_time = started.elapsed();
    assert_eq!(details.columns.len(), 10);
    let logged = h.log.entries().len();
    let started = Instant::now();
    let catalog = h
        .meta
        .completion_catalog(&h.manager, None, &id, &def.database, false)
        .await
        .expect("catalog");
    let catalog_time = started.elapsed();
    print_statements(&h.log, logged);
    println!(
        "P-02 {} 500 tables: connect {} ms; first level {} ms; table details {} ms; \
         catalog {} ms ({} relations)",
        h.manager
            .session(&id)
            .and_then(|s| s.connection())
            .map(|c| c.server_version().to_owned())
            .unwrap_or_default(),
        ms(connect),
        ms(level),
        ms(details_time),
        ms(catalog_time),
        catalog.relations.len(),
    );
    drop(guard);
}
