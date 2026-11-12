//! Optimistic concurrency (F-089) and the change journal (F-090) against real engines, each
//! case checked on the resulting database state: no false conflict for any value kind, a row
//! changed or deleted elsewhere reported instead of overwritten (update and delete, NULLs,
//! decimals, timestamps, binary), and a mixed change set reverted to the exact previous state,
//! a revert of a row changed since reported as a conflict. SQLite always runs; PostgreSQL,
//! SQL Server and MySQL when their URLs are set.

mod common;

use std::sync::Arc;

use common::SqlEngine as _;
use common::{blank, mssql_url, pg_definition, pg_url};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::edit_dialect::plain_text;
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::{ErrorCode, YadbeError};
use yadbe_lib::db::meta::ObjectRef;
use yadbe_lib::db::value::Value;
use yadbe_lib::edit::model::{
    ApplyOutcome, CellUpdate, ChangeSet, ColumnValue, PlannedChange, RowDelete, RowInsert,
};
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::journal::ChangeJournal;
use yadbe_lib::session::meta_cache::MetaService;
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::table_data::TableDataService;
use yadbe_lib::session::table_model::{TableDataInfo, TableFilter, TablePageRequest};
use yadbe_lib::store::{JournalQuery, RevertBlocker, Store};

// --- Harness ---------------------------------------------------------------------------------

struct Bench {
    manager: Arc<ConnectionManager>,
    meta: MetaService,
    store: Arc<ResultStore>,
    tables: Arc<TableDataService>,
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
        log,
        sink.clone(),
    ));
    let store = Arc::new(ResultStore::default());
    let journal = Arc::new(ChangeJournal::new(Arc::clone(&db), sink.clone()));
    let tables = Arc::new(
        TableDataService::new(Arc::clone(&manager), Arc::clone(&store), sink.clone())
            .with_journal(journal),
    );
    Bench {
        meta: MetaService::new(sink),
        manager,
        store,
        tables,
        db,
    }
}

impl Bench {
    async fn connect(&self, def: &ConnectionDefinition, password: Option<Secret>) -> String {
        let saved = self.db.create_connection(def).expect("save");
        self.manager
            .connect(&saved.id, password)
            .await
            .expect("connect");
        saved.id
    }
}

struct Fixture {
    engine: Engine,
    def: ConnectionDefinition,
    password: Option<Secret>,
    database: String,
    schema: Option<String>,
}

impl Fixture {
    fn table(&self) -> ObjectRef {
        ObjectRef {
            database: self.database.clone(),
            schema: self.schema.clone(),
            name: "accounts".to_owned(),
        }
    }

    fn password(&self) -> Option<Secret> {
        self.password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned()))
    }
}

type Row = Vec<Value>;

struct Tab<'a> {
    b: &'a Bench,
    id: String,
    info: TableDataInfo,
}

impl Tab<'_> {
    fn col(&self, name: &str) -> usize {
        self.info
            .columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("no column {name}"))
    }

    fn name(&self, index: usize) -> String {
        self.info.columns[index].name.clone()
    }

    async fn apply(&self, changes: &ChangeSet) -> Result<ApplyOutcome, YadbeError> {
        self.b.tables.apply(&self.id, changes).await
    }

    /// Applied; returns the journal entry.
    async fn applied(&self, changes: &ChangeSet) -> u32 {
        match self.apply(changes).await.expect("apply") {
            ApplyOutcome::Applied { journal_id, .. } => journal_id.expect("journaled"),
            other => panic!("not applied: {other:?}"),
        }
    }

    /// Conflicted; returns the conflicting rows' labels and whether each still exists.
    async fn conflicted(&self, changes: &ChangeSet) -> Vec<(String, bool)> {
        match self.apply(changes).await.expect("apply") {
            ApplyOutcome::Conflicted {
                conflicts, current, ..
            } => conflicts
                .into_iter()
                .zip(current.positions)
                .map(|(c, at)| (c.row, at.is_some()))
                .collect(),
            other => panic!("no conflict: {other:?}"),
        }
    }

    /// Every row, by id, as a page reads them (what the grid sends back as originals).
    async fn rows(&self) -> Vec<Row> {
        let page = self
            .b
            .tables
            .page(
                &self.id,
                TablePageRequest {
                    filter: TableFilter::default(),
                    sort: vec![],
                    offset: 0,
                    limit: 1000,
                },
            )
            .await
            .expect("page");
        let stored = self.b.store.get(page.result_id).expect("stored");
        (0..page.row_count as usize)
            .map(|r| {
                (0..page.columns.len())
                    .map(|c| stored.cell(r, c).expect("cell"))
                    .collect()
            })
            .collect()
    }

    async fn row(&self, id: &Value) -> Option<Row> {
        let key = plain_text(id);
        self.rows()
            .await
            .into_iter()
            .find(|row| plain_text(&row[0]) == key)
    }

    /// An update of `column` with the value it was read with.
    fn update(&self, row: &Row, column: &str, value: Value) -> CellUpdate {
        CellUpdate {
            key: vec![row[0].clone()],
            column: column.into(),
            value,
            original: Some(row[self.col(column)].clone()),
        }
    }

    /// A delete of the row as read.
    fn delete(&self, row: &Row) -> RowDelete {
        RowDelete {
            key: vec![row[0].clone()],
            values: row
                .iter()
                .enumerate()
                .map(|(c, value)| ColumnValue {
                    column: self.name(c),
                    value: value.clone(),
                })
                .collect(),
        }
    }

    /// The rows as texts, without what the server rewrites on its own (a row version).
    async fn snapshot(&self) -> Vec<Vec<Option<String>>> {
        let skip = self.info.columns.iter().position(|c| c.name == "version");
        self.rows()
            .await
            .iter()
            .map(|row| {
                row.iter()
                    .enumerate()
                    .filter(|(c, _)| Some(*c) != skip)
                    .map(|(_, v)| plain_text(v))
                    .collect()
            })
            .collect()
    }
}

async fn open<'a>(b: &'a Bench, connection: &str, table: ObjectRef, id: &str) -> Tab<'a> {
    let info = b
        .tables
        .open(&b.meta, id, connection, &table)
        .await
        .unwrap_or_else(|e| panic!("open {table:?}: {e:?}"));
    Tab {
        b,
        id: id.to_owned(),
        info,
    }
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn updates(cells: Vec<CellUpdate>) -> ChangeSet {
    ChangeSet {
        updates: cells,
        ..ChangeSet::default()
    }
}

/// An update without the value it replaces (as another session would: no check).
fn blind(row: &Row, column: &str, value: Value) -> CellUpdate {
    CellUpdate {
        key: vec![row[0].clone()],
        column: column.into(),
        value,
        original: None,
    }
}

/// A value of each writable column, different for each `round`.
fn values(engine: Engine, round: u8) -> Vec<(&'static str, Value)> {
    let n = i64::from(round);
    let mut values = vec![
        ("name", text(&format!("account {round}"))),
        ("balance", Value::Decimal(format!("{}.0125", 1000 + n))),
        (
            "ratio",
            Value::Float(if round.is_multiple_of(2) {
                "0.1".into()
            } else {
                "0.30000000000000004".into()
            }),
        ),
        (
            "seen",
            Value::Timestamp(format!("2025-01-0{} 03:04:05.12345{round}", 1 + round % 8)),
        ),
        ("raw", Value::bytes(&[round, 255, 0, 16])),
        ("note", text(&format!("it's note {round} é"))),
    ];
    match engine {
        Engine::Postgres => {
            values.push((
                "doc",
                Value::Json(format!(r#"{{"a": {round}, "b": [1, null]}}"#)),
            ));
            values.push(("spot", Value::Other(format!("({round}.5,2)"))));
        }
        Engine::Mssql => {
            values.push((
                "old_seen",
                Value::Timestamp(format!("2025-01-02 03:04:0{}.120", round % 10)),
            ));
            values.push(("legacy", text(&format!("legacy {round}"))));
            values.push(("doc", text(&format!("<a n=\"{round}\">x</a>"))));
        }
        Engine::Mysql => {
            values.push(("doc", Value::Json(format!(r#"{{"a": {round}}}"#))));
            values.push(("small_ratio", Value::Float("0.1".into())));
        }
        Engine::Sqlite => {
            values.push(("doc", Value::Json(format!(r#"{{"a": {round}}}"#))));
        }
    }
    values
}

fn insert_of(values: &[(&str, Value)]) -> RowInsert {
    RowInsert {
        values: values
            .iter()
            .map(|(column, value)| ColumnValue {
                column: (*column).to_owned(),
                value: value.clone(),
            })
            .collect(),
    }
}

// --- The suite -------------------------------------------------------------------------------

async fn suite(fx: &Fixture) {
    let b = bench();
    let conn = b.connect(&fx.def, fx.password()).await;
    let a = open(&b, &conn, fx.table(), "a").await;
    // Another tab: its own server connection, like another session.
    let other = open(&b, &conn, fx.table(), "b").await;
    let engine = fx.engine;

    // Three rows; the first one's note is NULL.
    let mut first = values(engine, 1);
    first.retain(|(c, _)| *c != "note");
    a.applied(&ChangeSet {
        inserts: vec![
            insert_of(&first),
            insert_of(&values(engine, 2)),
            insert_of(&values(engine, 3)),
        ],
        ..ChangeSet::default()
    })
    .await;
    let rows = a.rows().await;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0][a.col("note")], Value::Null);

    no_false_conflict(&a, engine).await;
    conflicts(&a, &other, engine).await;
    revert(&a, &other, engine).await;

    b.tables.close("a").await;
    b.tables.close("b").await;
}

/// Every column updated with the value it was read with matches: no kind is a false
/// conflict, whether it was written by yadbe or not, NULL included.
async fn no_false_conflict(a: &Tab<'_>, engine: Engine) {
    for round in [4, 5] {
        let rows = a.rows().await;
        let row = &rows[0];
        let cells = values(engine, round)
            .into_iter()
            .map(|(column, value)| a.update(row, column, value))
            .collect();
        let id = a.applied(&updates(cells)).await;
        let after = a.row(&row[0]).await.expect("row");
        assert_eq!(
            plain_text(&after[a.col("name")]).as_deref(),
            Some(format!("account {round}").as_str())
        );
        // The checks the dialect writes: through a text form, or none.
        let detail = a.b.db.journal_entry(id).expect("entry").expect("found");
        let sql = &detail.statements[0].sql;
        let checks = sql.split(" WHERE ").nth(1).expect("where");
        let (through, unchecked): (&[&str], &[&str]) = match engine {
            Engine::Postgres => (
                &[
                    r#"CAST("doc" AS text) = CAST("#,
                    r#"CAST("spot" AS text) = CAST("#,
                ],
                &[],
            ),
            Engine::Mssql => (
                &[
                    "CAST([legacy] AS nvarchar(max)) = CAST(",
                    "CAST([doc] AS nvarchar(max)) = CAST(",
                ],
                &[],
            ),
            Engine::Mysql => (
                &["JSON_EXTRACT(`doc`, '$') = JSON_EXTRACT("],
                &["`small_ratio`"],
            ),
            Engine::Sqlite => (&[r#""doc" = '{"a""#], &[]),
        };
        for check in through {
            assert!(checks.contains(check), "{check} in {checks}");
        }
        for column in unchecked {
            assert!(!checks.contains(column), "{column} in {checks}");
        }
        assert!(checks.contains("balance"), "{checks}");
    }
    // Deleting a row checks every value it was read with.
    let rows = a.rows().await;
    let last = rows.last().expect("row").clone();
    a.applied(&ChangeSet {
        deletes: vec![a.delete(&last)],
        ..ChangeSet::default()
    })
    .await;
    assert!(a.row(&last[0]).await.is_none(), "deleted");
    a.applied(&ChangeSet {
        inserts: vec![insert_of(&values(engine, 3))],
        ..ChangeSet::default()
    })
    .await;
}

/// A row changed or deleted elsewhere since it was read is reported, not overwritten.
async fn conflicts(a: &Tab<'_>, other: &Tab<'_>, engine: Engine) {
    // A value changed elsewhere, for each kind that matters (decimal, timestamp, binary).
    for (column, theirs, mine) in [
        (
            "balance",
            Value::Decimal("7.5000".into()),
            Value::Decimal("8.25".into()),
        ),
        (
            "seen",
            Value::Timestamp("2030-06-07 08:09:10.5".into()),
            Value::Timestamp("2031-01-01 00:00:00".into()),
        ),
        ("raw", Value::bytes(&[9, 9]), Value::bytes(&[8])),
    ] {
        let rows = a.rows().await;
        let row = rows[0].clone();
        other
            .applied(&updates(vec![blind(&row, column, theirs.clone())]))
            .await;
        let found = a
            .conflicted(&updates(vec![a.update(&row, column, mine)]))
            .await;
        assert_eq!(found.len(), 1, "{column}");
        assert!(found[0].1, "{column}: the row still exists");
        let now = a.row(&row[0]).await.expect("row");
        let col = a.col(column);
        assert_eq!(
            plain_text(&now[col]).map(|t| t.trim_end_matches('0').to_owned()),
            plain_text(&other.row(&row[0]).await.expect("row")[col])
                .map(|t| t.trim_end_matches('0').to_owned()),
            "{column}: theirs kept"
        );
        assert_ne!(plain_text(&now[col]), plain_text(&row[col]), "{column}");
    }

    // NULL read, a value now.
    let rows = a.rows().await;
    let row = rows[0].clone();
    other
        .applied(&updates(vec![blind(&row, "note", Value::Null)]))
        .await;
    let row = a.row(&row[0]).await.expect("row");
    assert_eq!(row[a.col("note")], Value::Null);
    other
        .applied(&updates(vec![blind(&row, "note", text("theirs"))]))
        .await;
    let found = a
        .conflicted(&updates(vec![a.update(&row, "note", text("mine"))]))
        .await;
    assert_eq!(found.len(), 1);
    assert_eq!(
        a.row(&row[0]).await.expect("row")[a.col("note")],
        text("theirs")
    );

    // A change elsewhere to another column is no conflict: both changes stay (edited
    // columns only).
    let rows = a.rows().await;
    let row = rows[0].clone();
    other
        .applied(&updates(vec![blind(&row, "name", text("their name"))]))
        .await;
    a.applied(&updates(vec![a.update(&row, "note", text("my note"))]))
        .await;
    let now = a.row(&row[0]).await.expect("row");
    assert_eq!(now[a.col("name")], text("their name"));
    assert_eq!(now[a.col("note")], text("my note"));

    // A delete of a row changed elsewhere, then of a row deleted elsewhere; with a good
    // update in the same change set, which is rolled back with them.
    let rows = a.rows().await;
    let (first, second, third) = (rows[0].clone(), rows[1].clone(), rows[2].clone());
    other
        .applied(&updates(vec![blind(&second, "note", text("changed"))]))
        .await;
    other
        .applied(&ChangeSet {
            deletes: vec![RowDelete {
                key: vec![third[0].clone()],
                values: Vec::new(),
            }],
            ..ChangeSet::default()
        })
        .await;
    let found = a
        .conflicted(&ChangeSet {
            updates: vec![a.update(&first, "name", text("rolled back"))],
            deletes: vec![a.delete(&second), a.delete(&third)],
            ..ChangeSet::default()
        })
        .await;
    assert_eq!(found.iter().map(|f| f.1).collect::<Vec<_>>(), [true, false]);
    assert_ne!(
        a.row(&first[0]).await.expect("row")[a.col("name")],
        text("rolled back")
    );
    assert!(a.row(&second[0]).await.is_some(), "not deleted");
    // An update of a row deleted elsewhere.
    let found = a
        .conflicted(&updates(vec![a.update(&third, "name", text("gone"))]))
        .await;
    assert_eq!(found, [(found[0].0.clone(), false)]);
    if engine != Engine::Sqlite {
        assert!(found[0].0.starts_with("id = "), "{found:?}");
    }
    // Back to three rows.
    a.applied(&ChangeSet {
        inserts: vec![insert_of(&values(engine, 6))],
        ..ChangeSet::default()
    })
    .await;
}

/// A mixed change set (insert, update, delete) reverted, and the revert reverted: the exact
/// previous state each time. A row changed since stops a revert.
async fn revert(a: &Tab<'_>, other: &Tab<'_>, engine: Engine) {
    let journal = |query: JournalQuery| a.b.db.search_journal(&query).expect("journal");
    let before = a.snapshot().await;
    let rows = a.rows().await;
    let (first, second) = (rows[0].clone(), rows[1].clone());
    let mut cells: Vec<CellUpdate> = values(engine, 7)
        .into_iter()
        .filter(|(c, _)| matches!(*c, "balance" | "seen" | "raw" | "doc" | "note"))
        .map(|(column, value)| a.update(&first, column, value))
        .collect();
    cells.push(a.update(&first, "name", text("changed by the set")));
    let changes = ChangeSet {
        updates: cells,
        inserts: vec![insert_of(&values(engine, 8))],
        deletes: vec![a.delete(&second)],
    };
    let id = a.applied(&changes).await;
    let after = a.snapshot().await;
    assert_ne!(after, before);

    let detail = a.b.db.journal_entry(id).expect("entry").expect("found");
    assert_eq!(detail.entry.revert_blocker, None);
    assert_eq!(
        (
            detail.entry.updated,
            detail.entry.inserted,
            detail.entry.deleted
        ),
        (1, 1, 1)
    );
    assert_eq!(detail.statements.len(), 3);
    assert_eq!(detail.inverse_statements.len(), 3);
    for statement in &detail.statements {
        assert!(
            !statement.sql.contains("$1") && !statement.sql.contains("@P1"),
            "{}",
            statement.sql
        );
    }

    let preview = a.b.tables.preview_revert("a", id).expect("preview");
    let kinds: Vec<&str> = preview
        .statements
        .iter()
        .map(|s| match s.change {
            PlannedChange::Update { .. } => "update",
            PlannedChange::Insert { .. } => "insert",
            PlannedChange::Delete { .. } => "delete",
        })
        .collect();
    assert_eq!(kinds, ["delete", "update", "insert"]);
    let reverted = match a.b.tables.apply_revert("a", id).await.expect("revert") {
        ApplyOutcome::Applied { journal_id, .. } => journal_id.expect("journaled"),
        other => panic!("not reverted: {other:?}"),
    };
    assert_eq!(a.snapshot().await, before, "the exact previous state");
    let entries = journal(JournalQuery::default()).entries;
    assert_eq!(entries[0].id, reverted);
    assert_eq!(entries[0].reverts, Some(id));
    assert_eq!(entries[1].reverted_by, Some(reverted));
    let err =
        a.b.tables
            .preview_revert("a", id)
            .expect_err("already reverted");
    assert_eq!(err.code, ErrorCode::InvalidArgument);

    // The revert is a change set too: reverting it brings the change back, identities included.
    match a.b.tables.apply_revert("a", reverted).await.expect("redo") {
        ApplyOutcome::Applied { .. } => {}
        other => panic!("not reverted: {other:?}"),
    }
    assert_eq!(a.snapshot().await, after, "the change back");

    // A row changed since the change set: the revert stops, their change stays.
    let rows = a.rows().await;
    let row = rows[0].clone();
    let id = a
        .applied(&updates(vec![a.update(&row, "name", text("mine"))]))
        .await;
    let row = a.row(&row[0]).await.expect("row");
    other
        .applied(&updates(vec![blind(&row, "name", text("theirs since"))]))
        .await;
    match a.b.tables.apply_revert("a", id).await.expect("revert") {
        ApplyOutcome::Conflicted { conflicts, .. } => assert_eq!(conflicts.len(), 1),
        other => panic!("no conflict: {other:?}"),
    }
    assert_eq!(
        a.row(&row[0]).await.expect("row")[a.col("name")],
        text("theirs since")
    );

    // A change set sent without the values it replaces cannot be reverted faithfully.
    let id = a
        .applied(&updates(vec![blind(&row, "name", text("blind"))]))
        .await;
    let entry =
        a.b.db
            .journal_entry(id)
            .expect("entry")
            .expect("found")
            .entry;
    assert_eq!(
        entry.revert_blocker,
        Some(RevertBlocker::OriginalUnknown {
            column: "name".into()
        })
    );
    let err = a.b.tables.preview_revert("a", id).expect_err("refused");
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert!(err.message.en.contains("faithfully"), "{}", err.message.en);

    // Filtered by table and searched by value.
    let found = journal(JournalQuery {
        text: Some("changed by the set".into()),
        table: Some(a.info.table.clone()),
        ..JournalQuery::default()
    });
    assert!(!found.entries.is_empty());
}

// --- Engines ---------------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_concurrency_and_journal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("journal.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create fixture");
    conn.execute_batch(include_str!("fixtures/journal_sqlite.sql"))
        .expect("fixture script");
    drop(conn);
    let mut def = blank(Engine::Sqlite, "journal.sqlite");
    def.file_path = path.display().to_string();
    suite(&Fixture {
        engine: Engine::Sqlite,
        def,
        password: None,
        database: "main".into(),
        schema: None,
    })
    .await;
}

fn unique_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("yadbe_m36_{}_{nanos:x}", std::process::id())
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

#[tokio::test]
async fn postgres_concurrency_and_journal() {
    let Some(url) = pg_url("postgres_concurrency_and_journal") else {
        return;
    };
    let (mut def, password) = pg_definition(&url);
    if let Ok(ca) = std::env::var(common::PG_CA_ENV) {
        def.ca_cert_path = Some(ca);
    }
    let schema = unique_name();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    conn.query(&format!("CREATE SCHEMA \"{schema}\""), 0)
        .await
        .expect("schema");
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: format!("DROP SCHEMA \"{schema}\" CASCADE"),
    };
    let script =
        include_str!("fixtures/journal_postgres.sql").replace("{s}", &format!("\"{schema}\""));
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
    })
    .await;
}

#[tokio::test]
async fn mssql_concurrency_and_journal() {
    let Some(url) = mssql_url("mssql_concurrency_and_journal") else {
        return;
    };
    let (mut def, password) = common::from_url(&url);
    let name = unique_name();
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
        sql: format!(
            "ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]"
        ),
    };
    def.database = name.clone();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    let script = include_str!("fixtures/journal_mssql.sql");
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
        schema: Some("journal".into()),
    })
    .await;
}

#[tokio::test]
async fn mysql_concurrency_and_journal() {
    let Some(url) = common::mysql_url("mysql_concurrency_and_journal") else {
        return;
    };
    let database = common::MysqlDatabase::create(&url, "m36").await;
    let (def, password) = database.definition();
    let conn = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    let script = include_str!("fixtures/journal_mysql.sql");
    let syntax = Engine::Mysql.dialect().syntax();
    for statement in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[statement.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    suite(&Fixture {
        engine: Engine::Mysql,
        def,
        password,
        database: database.name.clone(),
        schema: None,
    })
    .await;
    drop(database);
}
