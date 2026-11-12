//! Object tools (M3-8) on every engine available: the DDL of every object of the "shop"
//! fixture replayed into a fresh namespace and compared with the original through
//! introspection, table properties, and drop / truncate / rename checked on the database.
//!
//! SQLite always runs; PostgreSQL, SQL Server and MySQL run when their `YADBE_TEST_*_URL`
//! is set (the fixtures live in uniquely named schemas / databases, dropped at the end).

mod common;

use std::sync::Arc;

use serde::Serialize;
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::driver::SqlConnection;
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::meta::{MetaNode, ObjectKind, ObjectRef, qualified_name};
use yadbe_lib::db::object_model::{
    DdlSource, DdlTarget, DependencyLink, ObjectAction, ObjectActionRequest,
};
use yadbe_lib::db::split::{SqlSyntax, split};
use yadbe_lib::events::{BackendEvent, EventSink, MetaRefreshReason, RecordingSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::{MetaService, ObservingSink};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

use common::SqlEngine as _;
use common::{pg_definition, pg_url};

// --- Harness --------------------------------------------------------------------------------

struct Harness {
    store: Arc<Store>,
    log: Arc<StatementLog>,
    sink: Arc<RecordingSink>,
    meta: Arc<MetaService>,
    manager: ConnectionManager,
}

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

    async fn ddl(&self, id: &str, target: &DdlTarget) -> yadbe_lib::db::object_model::ObjectDdl {
        self.meta
            .object_ddl(&self.manager, None, id, target)
            .await
            .unwrap_or_else(|e| panic!("ddl of {target:?}: {e:?}"))
    }
}

/// Where the fixture lives on one engine, and which part of an object's address is its
/// namespace.
struct Shop {
    engine: Engine,
    database: String,
    /// The schema of PostgreSQL / SQL Server; `None` elsewhere.
    schema: Option<String>,
    /// A scratch schema for the tests that create and drop their own tables.
    scratch_schema: Option<String>,
}

impl Shop {
    fn at(&self, name: &str) -> ObjectRef {
        ObjectRef {
            database: self.database.clone(),
            schema: self.schema.clone(),
            name: name.to_owned(),
        }
    }

    fn scratch(&self, name: &str) -> ObjectRef {
        ObjectRef {
            database: self.database.clone(),
            schema: self.scratch_schema.clone().or_else(|| self.schema.clone()),
            name: name.to_owned(),
        }
    }
}

fn object_target(object: &ObjectRef, kind: ObjectKind) -> DdlTarget {
    DdlTarget::Object {
        object: object.clone(),
        kind,
        id: object.name.clone(),
    }
}

// --- Replay: DDL of every object, run in a fresh namespace ----------------------------------

/// Which part of an address the copy changes.
#[derive(Clone, Copy)]
enum Namespace {
    Schema,
    Database,
    /// The copy is another file, read through another connection.
    File,
}

struct Replay {
    raw: Arc<dyn SqlConnection>,
    /// The connection the copy is read through.
    read_id: String,
    namespace: Namespace,
    original: String,
    copy: String,
    syntax: SqlSyntax,
}

impl Replay {
    fn rewrite(&self, sql: &str) -> String {
        match self.namespace {
            Namespace::File => sql.to_owned(),
            _ => sql.replace(&self.original, &self.copy),
        }
    }

    fn locate(&self, object: &ObjectRef) -> ObjectRef {
        let mut copy = object.clone();
        match self.namespace {
            Namespace::Schema => copy.schema = Some(self.copy.clone()),
            Namespace::Database => copy.database.clone_from(&self.copy),
            Namespace::File => {}
        }
        copy
    }
}

const KIND_ORDER: [ObjectKind; 7] = [
    ObjectKind::Type,
    ObjectKind::Sequence,
    ObjectKind::Table,
    ObjectKind::View,
    ObjectKind::MaterializedView,
    ObjectKind::Function,
    ObjectKind::Procedure,
];

/// A statement that is not only comments.
fn has_code(sql: &str) -> bool {
    sql.lines()
        .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with("--"))
}

/// Comments and statistics differ between a fixture and its replay without meaning anything.
fn normalized(value: &impl Serialize, replay: &Replay) -> String {
    fn strip(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                map.remove("comment");
                map.remove("rowEstimate");
                map.values_mut().for_each(strip);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut json = serde_json::to_value(value).expect("serializes");
    strip(&mut json);
    let text = serde_json::to_string_pretty(&json).expect("prints");
    match replay.namespace {
        Namespace::File => text,
        _ => text.replace(&replay.original, &replay.copy),
    }
}

/// Runs the DDL of every object of the fixture in the copy, then compares what introspection
/// says about both. Returns the sources the texts came from, by kind.
async fn replay_and_compare(
    h: &Harness,
    id: &str,
    shop: &Shop,
    replay: &Replay,
    kinds: &[ObjectKind],
) -> Vec<(ObjectKind, String, DdlSource)> {
    let (db, schema) = (shop.database.as_str(), shop.schema.as_deref());
    let mut statements: Vec<(String, String)> = Vec::new();
    let mut originals = Vec::new();
    let mut sources = Vec::new();
    for kind in KIND_ORDER.into_iter().filter(|k| kinds.contains(k)) {
        let list = h
            .meta
            .objects(&h.manager, None, id, db, schema, kind)
            .await
            .expect("objects");
        for info in list.into_iter().filter(|o| !o.system) {
            let object = shop.at(&info.name);
            let target = DdlTarget::Object {
                object: object.clone(),
                kind,
                id: info.id.clone(),
            };
            let ddl = h.ddl(id, &target).await;
            sources.push((kind, info.id.clone(), ddl.source));
            let text = replay.rewrite(&ddl.sql);
            for statement in split(&text, &replay.syntax) {
                let sql = text[statement.range()].to_owned();
                if has_code(&sql) {
                    statements.push((format!("{kind:?} {}", info.id), sql));
                }
            }
            originals.push((kind, info));
        }
    }

    // Objects depend on each other (foreign keys, defaults, types): run what can run, again
    // and again, until everything has or nothing more can.
    let mut pending = statements;
    loop {
        let mut failed = Vec::new();
        let mut last = String::new();
        for (label, sql) in pending.iter().cloned() {
            if let Err(err) = replay.raw.query(&sql, 0).await {
                last.push_str(&format!("{label}: {:?}\n{sql}\n\n", err.detail));
                failed.push((label, sql));
            }
        }
        if failed.is_empty() {
            break;
        }
        assert!(failed.len() < pending.len(), "replay stuck:\n{last}");
        pending = failed;
    }

    let copy_schema = replay.locate(&shop.at("x")).schema;
    let copy_db = replay.locate(&shop.at("x")).database;
    for (kind, info) in originals {
        let listed = h
            .meta
            .objects(
                &h.manager,
                None,
                &replay.read_id,
                &copy_db,
                copy_schema.as_deref(),
                kind,
            )
            .await
            .expect("copy objects");
        let copied = listed
            .iter()
            .find(|o| o.id == info.id)
            .unwrap_or_else(|| panic!("{kind:?} {} missing from the copy: {listed:?}", info.id));
        assert_eq!(
            normalized(&info, replay),
            normalized(copied, replay),
            "{kind:?} {}",
            info.id
        );
        if kind.is_relation() {
            let original = h
                .meta
                .table_details(&h.manager, None, id, &shop.at(&info.name))
                .await
                .expect("details");
            let copy = h
                .meta
                .table_details(
                    &h.manager,
                    None,
                    &replay.read_id,
                    &replay.locate(&shop.at(&info.name)),
                )
                .await
                .expect("copy details");
            assert_eq!(
                normalized(&original, replay),
                normalized(&copy, replay),
                "details of {kind:?} {}",
                info.id
            );
        }
    }
    sources
}

// --- Checks shared by every engine ----------------------------------------------------------

fn refresh_all(h: &Harness, id: &str, shop: &Shop) {
    h.meta.refresh(
        id,
        MetaNode::Database {
            database: shop.database.clone(),
        },
    );
}

async fn exists(h: &Harness, id: &str, object: &ObjectRef) -> bool {
    match h.meta.table_details(&h.manager, None, id, object).await {
        Ok(_) => true,
        Err(e) if e.code == ErrorCode::ObjectNotFound => false,
        Err(e) => panic!("details of {object:?}: {e:?}"),
    }
}

async fn count(raw: &dyn SqlConnection, object: &ObjectRef, engine: Engine) -> i64 {
    let name = qualified_name(engine.dialect(), object);
    let sql = format!("SELECT COUNT(*) FROM {name}");
    raw.query(&sql, 1)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e:?}"))
        .scalar_text()
        .and_then(|s| s.parse().ok())
        .expect("a count")
}

fn request(object: &ObjectRef, kind: ObjectKind, action: ObjectAction) -> ObjectActionRequest {
    ObjectActionRequest {
        object: object.clone(),
        kind,
        id: object.name.clone(),
        action,
    }
}

/// Drop, truncate and rename on scratch tables, checked on the database.
async fn check_actions(
    h: &Harness,
    id: &str,
    raw: &dyn SqlConnection,
    shop: &Shop,
    read_only_id: &str,
) {
    let engine = shop.engine;
    let name = |n: &str| qualified_name(engine.dialect(), &shop.scratch(n));
    for sql in [
        format!(
            "CREATE TABLE {} (id integer PRIMARY KEY)",
            name("scratch_parent")
        ),
        format!(
            "CREATE TABLE {} (id integer PRIMARY KEY, parent_id integer, FOREIGN KEY (parent_id) REFERENCES {} (id))",
            name("scratch_child"),
            name("scratch_parent")
        ),
        format!("CREATE TABLE {} (id integer)", name("scratch_rows")),
        format!(
            "INSERT INTO {} (id) VALUES (1), (2), (3)",
            name("scratch_rows")
        ),
        format!("INSERT INTO {} (id) VALUES (1)", name("scratch_parent")),
        format!("CREATE TABLE {} (id integer)", name("scratch_other")),
        format!(
            "CREATE VIEW {} AS SELECT id FROM {}",
            name("scratch_view"),
            name("scratch_rows")
        ),
    ] {
        raw.query(&sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    refresh_all(h, id, shop);

    let parent = shop.scratch("scratch_parent");
    let child = shop.scratch("scratch_child");
    let rows = shop.scratch("scratch_rows");
    let other = shop.scratch("scratch_other");
    let view = shop.scratch("scratch_view");

    // The plan shows the statement and what depends on the table, never CASCADE.
    let plan = h
        .meta
        .plan_action(
            &h.manager,
            None,
            id,
            &request(&parent, ObjectKind::Table, ObjectAction::Drop),
        )
        .await
        .expect("plan");
    assert!(plan.sql.starts_with("DROP TABLE"), "{}", plan.sql);
    assert!(
        !plan.sql.to_ascii_uppercase().contains("CASCADE"),
        "{}",
        plan.sql
    );
    assert!(
        plan.dependents
            .items
            .iter()
            .any(|d| d.object.name == "scratch_child"
                && matches!(d.via, Some(DependencyLink::ForeignKey { .. }))),
        "{:?}",
        plan.dependents
    );
    let referenced_view_plan = h
        .meta
        .plan_action(
            &h.manager,
            None,
            id,
            &request(&rows, ObjectKind::Table, ObjectAction::Drop),
        )
        .await
        .expect("plan");
    if referenced_view_plan.dependents.complete {
        assert!(
            referenced_view_plan
                .dependents
                .items
                .iter()
                .any(|d| d.object.name == "scratch_view" && d.kind == ObjectKind::View),
            "{:?}",
            referenced_view_plan.dependents
        );
    }

    // Dropping a referenced table is the server's to refuse: nothing implies CASCADE.
    if engine != Engine::Sqlite {
        let refused = h
            .meta
            .run_action(
                &h.manager,
                None,
                id,
                &request(&parent, ObjectKind::Table, ObjectAction::Drop),
            )
            .await
            .expect_err("a foreign key references it");
        assert_eq!(refused.code, ErrorCode::QueryFailed, "{refused:?}");
        assert!(exists(h, id, &parent).await);
    }

    // Truncate removes the rows and nothing else.
    assert_eq!(count(raw, &rows, engine).await, 3);
    let before = h.sink.events().len();
    let outcome = h
        .meta
        .run_action(
            &h.manager,
            None,
            id,
            &request(&rows, ObjectKind::Table, ObjectAction::Truncate),
        )
        .await
        .expect("truncate");
    assert_eq!(count(raw, &rows, engine).await, 0);
    assert!(exists(h, id, &rows).await);
    assert!(
        h.log.entries().iter().any(|e| e.sql == outcome.sql),
        "{} is in the statement log",
        outcome.sql
    );
    let events = h.sink.events();
    assert!(
        events[before..].iter().any(|event| matches!(
            event,
            BackendEvent::MetaRefreshed(r) if r.reason == MetaRefreshReason::Ddl && r.connection_id == id
        )),
        "the explorer is told"
    );

    // A view cannot be truncated; a name is validated.
    let refused = h
        .meta
        .plan_action(
            &h.manager,
            None,
            id,
            &request(&view, ObjectKind::View, ObjectAction::Truncate),
        )
        .await
        .expect_err("a view has no rows of its own");
    assert_eq!(refused.code, ErrorCode::NotSupported);
    let refused = h
        .meta
        .plan_action(
            &h.manager,
            None,
            id,
            &request(
                &other,
                ObjectKind::Table,
                ObjectAction::Rename {
                    new_name: "  ".into(),
                },
            ),
        )
        .await
        .expect_err("empty name");
    assert_eq!(refused.code, ErrorCode::InvalidArgument);

    // Rename: the table answers to its new name, awkward characters included.
    let new_name = "scratch \"renamed\"";
    let outcome = h
        .meta
        .run_action(
            &h.manager,
            None,
            id,
            &request(
                &other,
                ObjectKind::Table,
                ObjectAction::Rename {
                    new_name: new_name.into(),
                },
            ),
        )
        .await
        .expect("rename");
    let renamed = outcome.renamed_to.expect("the new address");
    assert_eq!(renamed.name, new_name);
    assert!(exists(h, id, &renamed).await);
    assert!(!exists(h, id, &other).await);
    assert_eq!(count(raw, &renamed, engine).await, 0);

    // Drop: a view, then the tables, children first.
    let support = engine.dialect().object_support(ObjectKind::View);
    assert!(support.drop);
    for (object, kind) in [
        (&view, ObjectKind::View),
        (&child, ObjectKind::Table),
        (&parent, ObjectKind::Table),
        (&rows, ObjectKind::Table),
        (&renamed, ObjectKind::Table),
    ] {
        h.meta
            .run_action(
                &h.manager,
                None,
                id,
                &request(object, kind, ObjectAction::Drop),
            )
            .await
            .unwrap_or_else(|e| panic!("drop {object:?}: {e:?}"));
        assert!(!exists(h, id, object).await, "{object:?} is gone");
    }

    // Read-only connections are refused in the backend, whatever the frontend shows.
    let survivor = shop.at("customers");
    for action in [
        ObjectAction::Drop,
        ObjectAction::Truncate,
        ObjectAction::Rename {
            new_name: "people".into(),
        },
    ] {
        let refused = h
            .meta
            .run_action(
                &h.manager,
                None,
                read_only_id,
                &request(&survivor, ObjectKind::Table, action),
            )
            .await
            .expect_err("read-only");
        assert_eq!(refused.code, ErrorCode::ReadOnlyViolation);
    }
    assert!(exists(h, id, &survivor).await);
}

/// Facts every engine can give, and the DDL texts of single objects.
async fn check_texts(
    h: &Harness,
    id: &str,
    shop: &Shop,
    sources: &[(ObjectKind, String, DdlSource)],
) {
    let engine = shop.engine;
    let caps = engine.dialect().meta_capabilities();
    let source = |kind: ObjectKind, name: &str| {
        sources
            .iter()
            .find(|(k, n, _)| *k == kind && n == name)
            .map(|(_, _, s)| *s)
            .unwrap_or_else(|| panic!("{kind:?} {name} was replayed"))
    };
    let tables_are_native = matches!(engine, Engine::Sqlite | Engine::Mysql);
    assert_eq!(
        source(ObjectKind::Table, "customers"),
        if tables_are_native {
            DdlSource::Catalog
        } else {
            DdlSource::Reconstructed
        }
    );
    assert_eq!(
        source(ObjectKind::View, "customer_orders"),
        DdlSource::Catalog
    );

    let customers = shop.at("customers");
    let ddl = h
        .ddl(id, &object_target(&customers, ObjectKind::Table))
        .await;
    assert!(
        ddl.sql.to_ascii_uppercase().contains("CREATE TABLE"),
        "{}",
        ddl.sql
    );
    assert!(ddl.sql.contains("full_name"), "{}", ddl.sql);
    assert_eq!(
        ddl.sql.starts_with("-- Reconstructed by yadbe"),
        ddl.source == DdlSource::Reconstructed,
        "{}",
        ddl.sql
    );

    // A trigger and an index, asked for alone.
    let orders = shop.at("orders");
    let trigger = h
        .ddl(
            id,
            &DdlTarget::Trigger {
                table: orders.clone(),
                name: "orders_touch".into(),
            },
        )
        .await;
    assert!(trigger.sql.contains("orders_touch"), "{}", trigger.sql);
    let index = h
        .ddl(
            id,
            &DdlTarget::Index {
                table: orders.clone(),
                name: "orders_created_at_idx".into(),
            },
        )
        .await;
    assert!(
        index.sql.to_ascii_uppercase().contains("CREATE"),
        "{}",
        index.sql
    );
    assert!(index.sql.contains("orders_created_at_idx"), "{}", index.sql);
    // The table's own text carries both.
    let orders_ddl = h.ddl(id, &object_target(&orders, ObjectKind::Table)).await;
    assert!(
        orders_ddl.sql.contains("orders_created_at_idx"),
        "{}",
        orders_ddl.sql
    );
    assert!(
        orders_ddl.sql.contains("orders_touch"),
        "{}",
        orders_ddl.sql
    );

    // Properties: present where the engine has them, never an error where it has not.
    let facts = h
        .meta
        .properties(&h.manager, None, id, &customers, ObjectKind::Table)
        .await
        .expect("properties");
    assert_eq!(facts.object, customers);
    match engine {
        Engine::Postgres => {
            assert!(
                facts.owner.is_some() && facts.total_bytes.unwrap_or(0.0) > 0.0,
                "{facts:?}"
            );
            assert_eq!(facts.comment.as_deref(), Some("People who ordered"));
        }
        Engine::Mssql => {
            assert!(
                facts.owner.is_some() && facts.created.is_some(),
                "{facts:?}"
            );
            assert!(
                facts.data_bytes.is_some() && facts.index_bytes.is_some(),
                "{facts:?}"
            );
        }
        Engine::Mysql => {
            assert_eq!(facts.storage_engine.as_deref(), Some("InnoDB"), "{facts:?}");
            assert!(
                facts.collation.is_some() && facts.created.is_some(),
                "{facts:?}"
            );
            assert!(facts.data_bytes.is_some(), "{facts:?}");
        }
        Engine::Sqlite => assert!(facts.owner.is_none()),
    }
    let view_facts = h
        .meta
        .properties(
            &h.manager,
            None,
            id,
            &shop.at("customer_orders"),
            ObjectKind::View,
        )
        .await
        .expect("view properties");
    assert!(view_facts.data_bytes.is_none(), "{view_facts:?}");
    if caps.object_kinds.contains(&ObjectKind::Function) {
        let refused = h
            .meta
            .properties(
                &h.manager,
                None,
                id,
                &shop.at("order_total"),
                ObjectKind::Function,
            )
            .await
            .expect_err("only relations have properties");
        assert_eq!(refused.code, ErrorCode::NotSupported);
    }

    // What references a table, as far as the engine tells.
    let plan = h
        .meta
        .plan_action(
            &h.manager,
            None,
            id,
            &request(&customers, ObjectKind::Table, ObjectAction::Drop),
        )
        .await
        .expect("plan");
    assert!(
        plan.dependents
            .items
            .iter()
            .any(|d| d.object.name == "orders"),
        "{:?}",
        plan.dependents
    );
    assert!(caps.object_kinds.contains(&ObjectKind::View));
}

// --- SQLite ---------------------------------------------------------------------------------

fn sqlite_file(dir: &std::path::Path, name: &str, script: &str) -> ConnectionDefinition {
    let path = dir.join(name);
    let conn = rusqlite::Connection::open(&path).expect("create");
    conn.execute_batch(script).expect("fixture script");
    let mut def = common::blank(Engine::Sqlite, name);
    def.file_path = path.display().to_string();
    def
}

#[tokio::test]
async fn sqlite_objects() {
    let dir = tempfile::tempdir().expect("tempdir");
    let def = sqlite_file(
        dir.path(),
        "shop.sqlite",
        include_str!("fixtures/meta_sqlite.sql"),
    );
    let copy_def = sqlite_file(dir.path(), "copy.sqlite", "");
    let mut read_only = def.clone();
    read_only.read_only = true;
    let h = harness();
    let id = h.open(&def, None).await;
    let read_only_id = h.open(&read_only, None).await;
    let copy_id = h.open(&copy_def, None).await;
    let shop = Shop {
        engine: Engine::Sqlite,
        database: "main".into(),
        schema: None,
        scratch_schema: None,
    };
    let replay = Replay {
        raw: common::open(&copy_def, None).await.expect("raw copy"),
        read_id: copy_id,
        namespace: Namespace::File,
        original: String::new(),
        copy: String::new(),
        syntax: Engine::Sqlite.dialect().syntax(),
    };
    let sources = replay_and_compare(
        &h,
        &id,
        &shop,
        &replay,
        &[ObjectKind::Table, ObjectKind::View],
    )
    .await;
    check_texts(&h, &id, &shop, &sources).await;
    let raw = common::open(&def, None).await.expect("raw");
    check_actions(&h, &id, &*raw, &shop, &read_only_id).await;
    // A view has no rename on SQLite.
    let refused = h
        .meta
        .plan_action(
            &h.manager,
            None,
            &id,
            &request(
                &shop.at("customer_orders"),
                ObjectKind::View,
                ObjectAction::Rename {
                    new_name: "v".into(),
                },
            ),
        )
        .await
        .expect_err("unsupported");
    assert_eq!(refused.code, ErrorCode::NotSupported);
}

// --- PostgreSQL -----------------------------------------------------------------------------

fn unique_prefix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("yadbe_m38_{}_{nanos:x}", std::process::id())
}

/// Schemas created for one run, dropped when the guard goes.
struct PgSchemas {
    url: String,
    names: Vec<String>,
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

#[tokio::test]
async fn postgres_objects() {
    let Some(url) = pg_url("postgres_objects") else {
        return;
    };
    let prefix = unique_prefix();
    let (shop_schema, sales, odd, copy, scratch) = (
        format!("{prefix}_shop"),
        format!("{prefix}_sales"),
        format!("{prefix}_odd"),
        format!("{prefix}_copy"),
        format!("{prefix}_scratch"),
    );
    let _guard = PgSchemas {
        url: url.clone(),
        names: vec![
            shop_schema.clone(),
            sales.clone(),
            odd.clone(),
            copy.clone(),
            scratch.clone(),
        ],
    };
    let script = include_str!("fixtures/meta_postgres.sql")
        .replace("{shop}", &format!("\"{shop_schema}\""))
        .replace("{sales}", &format!("\"{sales}\""))
        .replace("{odd}", &format!("\"{odd}\""));
    let (def, password) = pg_definition(&url);
    let raw = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    for statement in statements(&script) {
        raw.query(&statement, 0)
            .await
            .unwrap_or_else(|e| panic!("{statement}: {e:?}"));
    }
    for schema in [&copy, &scratch] {
        raw.query(&format!("CREATE SCHEMA \"{schema}\""), 0)
            .await
            .expect("schema");
    }

    let h = harness();
    let id = h.open(&def, password.clone()).await;
    let mut read_only = def.clone();
    read_only.read_only = true;
    let read_only_id = h.open(&read_only, password.clone()).await;
    let shop = Shop {
        engine: Engine::Postgres,
        database: def.database.clone(),
        schema: Some(shop_schema.clone()),
        scratch_schema: Some(scratch),
    };
    let replay = Replay {
        raw: common::open(&def, password.as_ref())
            .await
            .expect("raw copy"),
        read_id: id.clone(),
        namespace: Namespace::Schema,
        original: shop_schema.clone(),
        copy,
        syntax: Engine::Postgres.dialect().syntax(),
    };
    let sources = replay_and_compare(&h, &id, &shop, &replay, &KIND_ORDER).await;
    check_texts(&h, &id, &shop, &sources).await;

    // Overloads have a text each; the others are written the way the server accepts them.
    let routine = |name: &str, id: &str, kind| DdlTarget::Object {
        object: shop.at(name),
        kind,
        id: id.to_owned(),
    };
    let both = h
        .ddl(
            &id,
            &routine(
                "order_total",
                "order_total(p_order_id integer, p_with_shipping boolean)",
                ObjectKind::Function,
            ),
        )
        .await;
    assert!(both.sql.contains("p_with_shipping"), "{}", both.sql);
    assert_eq!(both.source, DdlSource::Catalog);
    let domain = h
        .ddl(
            &id,
            &routine("positive_amount", "positive_amount", ObjectKind::Type),
        )
        .await;
    assert!(
        domain.sql.contains("CREATE DOMAIN") && domain.sql.contains("CHECK"),
        "{}",
        domain.sql
    );
    let status = h
        .ddl(
            &id,
            &routine("product_status", "product_status", ObjectKind::Type),
        )
        .await;
    assert!(
        status.sql.contains("ENUM ('draft', 'active', 'archived')"),
        "{}",
        status.sql
    );
    let sales_object = |name: &str, kind| {
        let object = ObjectRef {
            database: def.database.clone(),
            schema: Some(sales.clone()),
            name: name.to_owned(),
        };
        object_target(&object, kind)
    };
    let sequence = h
        .ddl(
            &id,
            &sales_object("invoice_number_seq", ObjectKind::Sequence),
        )
        .await;
    assert!(sequence.sql.contains("START WITH 1000"), "{}", sequence.sql);
    let matview = h
        .ddl(
            &id,
            &sales_object("daily_sales", ObjectKind::MaterializedView),
        )
        .await;
    assert!(
        matview.sql.contains("CREATE MATERIALIZED VIEW"),
        "{}",
        matview.sql
    );
    assert_eq!(matview.source, DdlSource::Catalog);
    // An enum is used by a column: dropping it lists the table.
    let plan = h
        .meta
        .plan_action(
            &h.manager,
            None,
            &id,
            &request(
                &shop.at("product_status"),
                ObjectKind::Type,
                ObjectAction::Drop,
            ),
        )
        .await
        .expect("plan");
    assert_eq!(
        plan.sql,
        format!("DROP TYPE \"{shop_schema}\".\"product_status\"")
    );
    assert!(
        plan.dependents
            .items
            .iter()
            .any(|d| d.object.name == "products")
    );
    // A routine is dropped by its signature.
    let plan = h
        .meta
        .plan_action(
            &h.manager,
            None,
            &id,
            &ObjectActionRequest {
                object: shop.at("order_total"),
                kind: ObjectKind::Function,
                id: "order_total(p_order_id integer)".into(),
                action: ObjectAction::Drop,
            },
        )
        .await
        .expect("plan");
    assert!(
        plan.sql.ends_with(".\"order_total\"(p_order_id integer)"),
        "{}",
        plan.sql
    );
    assert!(
        plan.dependents.items.is_empty() && !plan.dependents.complete,
        "routines are not tracked"
    );
    check_actions(&h, &id, &*raw, &shop, &read_only_id).await;
    // Dependent views block a drop on the server's terms.
    let dropped = h
        .meta
        .run_action(
            &h.manager,
            None,
            &id,
            &request(&shop.at("orders"), ObjectKind::Table, ObjectAction::Drop),
        )
        .await
        .expect_err("a view and foreign keys depend on it");
    assert_eq!(dropped.code, ErrorCode::QueryFailed);
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

#[tokio::test]
async fn mssql_objects() {
    let Some(url) = common::mssql_url("mssql_objects") else {
        return;
    };
    let name = unique_prefix();
    let (mut def, password) = common::from_url(&url);
    let master = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    master
        .query(&format!("CREATE DATABASE [{name}]"), 0)
        .await
        .expect("create database");
    master.close().await;
    let _guard = MssqlDatabase {
        url: url.clone(),
        name: name.clone(),
    };
    def.database = name.clone();
    let raw = common::open(&def, password.as_ref())
        .await
        .expect("connect to the fixture database");
    let script = include_str!("fixtures/meta_mssql.sql");
    let syntax = Engine::Mssql.dialect().syntax();
    for batch in split(script, &syntax) {
        let sql = &script[batch.range()];
        raw.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    for schema in ["replica", "scratch"] {
        raw.query(&format!("CREATE SCHEMA {schema}"), 0)
            .await
            .expect("schema");
    }

    let h = harness();
    let id = h.open(&def, password.clone()).await;
    let read_only_id = h.open(&def, password.clone()).await;
    let shop = Shop {
        engine: Engine::Mssql,
        database: name,
        schema: Some("shop".into()),
        scratch_schema: Some("scratch".into()),
    };
    let replay = Replay {
        raw: common::open(&def, password.as_ref())
            .await
            .expect("raw copy"),
        read_id: id.clone(),
        namespace: Namespace::Schema,
        original: "shop".into(),
        copy: "replica".into(),
        syntax,
    };
    let kinds = Engine::Mssql.dialect().meta_capabilities().object_kinds;
    let sources = replay_and_compare(&h, &id, &shop, &replay, kinds).await;
    check_texts(&h, &id, &shop, &sources).await;
    // SQL Server has no read-only session: the backend refuses on the definition's flag.
    let mut read_only = def.clone();
    read_only.read_only = true;
    let read_only_id = {
        let _ = read_only_id;
        h.open(&read_only, password.clone()).await
    };

    // Routines come from `sys.sql_modules`, a sequence and a type are rebuilt.
    let function = h
        .ddl(
            &id,
            &object_target(&shop.at("order_total"), ObjectKind::Function),
        )
        .await;
    assert!(function.sql.contains("CREATE FUNCTION"), "{}", function.sql);
    assert_eq!(function.source, DdlSource::Catalog);
    let sales = ObjectRef {
        database: shop.database.clone(),
        schema: Some("sales".into()),
        name: "invoice_number_seq".into(),
    };
    let sequence = h
        .ddl(&id, &object_target(&sales, ObjectKind::Sequence))
        .await;
    assert!(sequence.sql.contains("START WITH 1000"), "{}", sequence.sql);
    assert_eq!(sequence.source, DdlSource::Reconstructed);
    // Triggers start their own batch in the table's text.
    let orders = h
        .ddl(&id, &object_target(&shop.at("orders"), ObjectKind::Table))
        .await;
    assert!(
        orders.sql.contains("\nGO\nCREATE TRIGGER"),
        "{}",
        orders.sql
    );
    // A view or a procedure is recreated, not renamed.
    let refused = h
        .meta
        .plan_action(
            &h.manager,
            None,
            &id,
            &request(
                &shop.at("customer_orders"),
                ObjectKind::View,
                ObjectAction::Rename {
                    new_name: "v".into(),
                },
            ),
        )
        .await
        .expect_err("unsupported");
    assert_eq!(refused.code, ErrorCode::NotSupported);
    // A view that reads a table is a dependent of it.
    let plan = h
        .meta
        .plan_action(
            &h.manager,
            None,
            &id,
            &request(&shop.at("orders"), ObjectKind::Table, ObjectAction::Drop),
        )
        .await
        .expect("plan");
    assert!(
        plan.dependents
            .items
            .iter()
            .any(|d| d.object.name == "customer_orders" && d.kind == ObjectKind::View),
        "{:?}",
        plan.dependents
    );
    check_actions(&h, &id, &*raw, &shop, &read_only_id).await;
}

// --- MySQL ----------------------------------------------------------------------------------

#[tokio::test]
async fn mysql_objects() {
    let Some(url) = common::mysql_url("mysql_objects") else {
        return;
    };
    let guard = common::MysqlDatabase::create(&url, "m38").await;
    let copy_guard = common::MysqlDatabase::create(&url, "m38c").await;
    let (def, password) = guard.definition();
    let (copy_def, _) = copy_guard.definition();
    let raw = common::open(&def, password.as_ref())
        .await
        .expect("connect to the fixture database");
    let script = include_str!("fixtures/meta_mysql.sql");
    let syntax = Engine::Mysql.dialect().syntax();
    for statement in split(script, &syntax) {
        let sql = &script[statement.range()];
        raw.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }

    let h = harness();
    let id = h.open(&def, password.clone()).await;
    let mut read_only = def.clone();
    read_only.read_only = true;
    let read_only_id = h.open(&read_only, password.clone()).await;
    let shop = Shop {
        engine: Engine::Mysql,
        database: guard.name.clone(),
        schema: None,
        scratch_schema: None,
    };
    // The copy is another database; `SHOW CREATE` text names none, the views' text does.
    let replay = Replay {
        raw: common::open(&copy_def, password.as_ref())
            .await
            .expect("raw copy"),
        read_id: id.clone(),
        namespace: Namespace::Database,
        original: guard.name.clone(),
        copy: copy_guard.name.clone(),
        syntax,
    };
    let kinds = Engine::Mysql.dialect().meta_capabilities().object_kinds;
    let sources = replay_and_compare(&h, &id, &shop, &replay, kinds).await;
    check_texts(&h, &id, &shop, &sources).await;

    // The routine keeps its body whole, `DELIMITER` included when it holds `;`.
    let procedure = h
        .ddl(
            &id,
            &object_target(&shop.at("archive_invoices"), ObjectKind::Procedure),
        )
        .await;
    assert!(
        procedure.sql.starts_with("DELIMITER //"),
        "{}",
        procedure.sql
    );
    assert!(procedure.sql.contains("CREATE"), "{}", procedure.sql);
    // Routines cannot be renamed here; a table and a view can.
    let refused = h
        .meta
        .plan_action(
            &h.manager,
            None,
            &id,
            &request(
                &shop.at("order_total"),
                ObjectKind::Function,
                ObjectAction::Rename {
                    new_name: "total".into(),
                },
            ),
        )
        .await
        .expect_err("unsupported");
    assert_eq!(refused.code, ErrorCode::NotSupported);
    check_actions(&h, &id, &*raw, &shop, &read_only_id).await;
}
