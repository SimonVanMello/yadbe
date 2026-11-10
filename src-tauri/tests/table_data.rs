//! Table data and edits (M2-1, M2-2) against real engines: browsing with filters, sort,
//! paging and counts, editability, and every generated-DML path checked on the resulting
//! database state. SQLite always runs; PostgreSQL and SQL Server when their URLs are set.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{blank, mssql_url, pg_definition, pg_url};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::edit_dialect::plain_text;
use yadbe_lib::db::errors::{ConstraintKind, ErrorCode, YadbeError};
use yadbe_lib::db::meta::ObjectRef;
use yadbe_lib::db::value::Value;
use yadbe_lib::edit::model::{
    ApplyOutcome, CellUpdate, ChangeSet, ColumnValue, InsertedRows, PlannedChange, RowInsert,
    StatementFailure,
};
use yadbe_lib::events::{BackendEvent, RecordingSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::MetaService;
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::{StatementLog, StatementOutcome};
use yadbe_lib::session::table_data::TableDataService;
use yadbe_lib::session::table_model::{
    ColumnFilter, ColumnReadOnlyReason, CountMode, FilterOp, SortDirection, SortKey, TableDataInfo,
    TableFilter, TablePageRequest, TableReadOnlyReason,
};
use yadbe_lib::store::Store;

// --- Harness ---------------------------------------------------------------------------------

struct Bench {
    manager: Arc<ConnectionManager>,
    meta: MetaService,
    store: Arc<ResultStore>,
    tables: TableDataService,
    log: Arc<StatementLog>,
    sink: Arc<RecordingSink>,
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
    let tables = TableDataService::new(Arc::clone(&manager), Arc::clone(&store), sink.clone());
    Bench {
        meta: MetaService::new(sink.clone()),
        manager,
        store,
        tables,
        log,
        sink,
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

/// One engine's fixture: where its tables are and how to connect.
struct Fixture {
    engine: Engine,
    def: ConnectionDefinition,
    password: Option<Secret>,
    database: String,
    schema: Option<String>,
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

/// A table tab of the suite.
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

    async fn apply(&self, changes: ChangeSet) -> Result<ApplyOutcome, YadbeError> {
        self.b.tables.apply(&self.id, &changes).await
    }

    async fn applied(&self, changes: ChangeSet) -> InsertedRows {
        match self.apply(changes).await.expect("apply") {
            ApplyOutcome::Applied {
                inserted,
                statements,
                ..
            } => {
                assert!(statements.iter().all(|s| s.rows_affected == Some(1.0)));
                inserted
            }
            ApplyOutcome::RolledBack { failure } => panic!("rolled back: {failure:?}"),
        }
    }

    async fn failed(&self, changes: ChangeSet) -> StatementFailure {
        match self.apply(changes).await.expect("apply") {
            ApplyOutcome::RolledBack { failure } => *failure,
            ApplyOutcome::Applied { .. } => panic!("applied"),
        }
    }

    /// The row of `key` as stored now, `None` when it does not exist.
    async fn row(&self, key: Vec<Value>) -> Option<Vec<Value>> {
        let rows = self
            .b
            .tables
            .refresh_rows(&self.id, vec![key])
            .await
            .expect("refresh");
        let at = rows.positions[0]?;
        let stored = self.b.store.get(rows.window.result_id).expect("stored");
        Some(
            (0..self.info.columns.len())
                .map(|c| stored.cell(at as usize, c).expect("cell"))
                .collect(),
        )
    }

    async fn page(
        &self,
        filter: TableFilter,
        sort: Vec<SortKey>,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<Vec<Value>>, bool), YadbeError> {
        let page = self
            .b
            .tables
            .page(
                &self.id,
                TablePageRequest {
                    filter,
                    sort,
                    offset,
                    limit,
                },
            )
            .await?;
        let stored = self.b.store.get(page.result_id).expect("stored");
        let rows = (0..page.row_count as usize)
            .map(|r| {
                (0..page.columns.len())
                    .map(|c| stored.cell(r, c).expect("cell"))
                    .collect()
            })
            .collect();
        Ok((rows, page.has_more))
    }

    async fn count(&self, filter: TableFilter, mode: CountMode) -> Option<f64> {
        self.b
            .tables
            .count(&self.id, filter, mode)
            .await
            .expect("count")
            .count
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

fn int(n: i64) -> Value {
    Value::int(n)
}

fn insert(values: &[(&str, Value)]) -> RowInsert {
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

fn update(key: Vec<Value>, column: &str, value: Value) -> CellUpdate {
    CellUpdate {
        key,
        column: column.into(),
        value,
    }
}

fn inserts(rows: Vec<RowInsert>) -> ChangeSet {
    ChangeSet {
        inserts: rows,
        ..ChangeSet::default()
    }
}

fn updates(cells: Vec<CellUpdate>) -> ChangeSet {
    ChangeSet {
        updates: cells,
        ..ChangeSet::default()
    }
}

fn texts(row: &[Value]) -> Vec<Option<String>> {
    row.iter().map(plain_text).collect()
}

/// A column, an operator and its values.
type Condition = (&'static str, FilterOp, Vec<Value>);

fn filter(conditions: Vec<Condition>, raw: Option<&str>) -> TableFilter {
    TableFilter {
        conditions: conditions
            .into_iter()
            .map(|(column, op, values)| ColumnFilter {
                column: column.into(),
                op,
                values,
            })
            .collect(),
        raw_where: raw.map(str::to_owned),
    }
}

// --- Per engine --------------------------------------------------------------------------------

/// `(column, value written, text read back)` for every value kind the engine has.
fn kind_values(engine: Engine) -> Vec<(&'static str, Value, &'static str)> {
    let label = "it's \"quoted\" é😀\n\ttab";
    match engine {
        Engine::Postgres => vec![
            ("flag", Value::Bool(true), "true"),
            ("small", int(-32768), "-32768"),
            ("big", int(i64::MAX), "9223372036854775807"),
            (
                "amount",
                Value::Decimal("12345678901234567890.0123456789".into()),
                "12345678901234567890.0123456789",
            ),
            ("ratio", Value::Float("0.1".into()), "0.1"),
            ("label", text(label), label),
            ("code", text("abc"), "abc"),
            ("raw", Value::bytes(&[0, 255, 16]), "00ff10"),
            ("day", Value::Date("2024-02-29".into()), "2024-02-29"),
            (
                "at_time",
                Value::Time("23:59:59.123456".into()),
                "23:59:59.123456",
            ),
            (
                "local_at",
                Value::Timestamp("2025-02-28 12:34:56.789012".into()),
                "2025-02-28 12:34:56.789012",
            ),
            (
                "at_tz",
                Value::TimestampTz("2025-02-28 12:34:56+00".into()),
                "2025-02-28 12:34:56+00",
            ),
            (
                "span",
                Value::Interval("1 year 2 mons 3 days 04:05:06".into()),
                "1 year 2 mons 3 days 04:05:06",
            ),
            (
                "ref",
                Value::Uuid("5f0c00a1-7b2e-4c3d-9e8f-000000000001".into()),
                "5f0c00a1-7b2e-4c3d-9e8f-000000000001",
            ),
            (
                "doc",
                Value::Json(r#"{"a": 12345678901234567890.1, "b": [1, null]}"#.into()),
                r#"{"a": 12345678901234567890.1, "b": [1, null]}"#,
            ),
            (
                "tags",
                Value::Array(vec![text("a b"), Value::Null, text("c\"d")]),
                r#"[{"kind":"text","value":"a b"},{"kind":"null"},{"kind":"text","value":"c\"d"}]"#,
            ),
            ("spot", Value::Other("(1.5,2)".into()), "(1.5,2)"),
            ("mood", text("happy"), "happy"),
        ],
        Engine::Mssql => vec![
            ("flag", Value::Bool(true), "true"),
            ("small", int(-32768), "-32768"),
            ("big", int(i64::MAX), "9223372036854775807"),
            (
                "amount",
                Value::Decimal("12345678901234567890.0123456789".into()),
                "12345678901234567890.0123456789",
            ),
            ("ratio", Value::Float("0.1".into()), "0.1"),
            ("label", text(label), label),
            ("code", text("abc"), "abc"),
            ("raw", Value::bytes(&[0, 255, 16]), "00ff10"),
            ("day", Value::Date("2024-02-29".into()), "2024-02-29"),
            (
                "at_time",
                Value::Time("23:59:59.1234567".into()),
                "23:59:59.1234567",
            ),
            (
                "local_at",
                Value::Timestamp("2025-02-28 12:34:56.789012".into()),
                "2025-02-28 12:34:56.789012",
            ),
            (
                "old_at",
                Value::Timestamp("2025-02-28 12:34:56.790".into()),
                "2025-02-28 12:34:56.790",
            ),
            (
                "at_tz",
                Value::TimestampTz("2025-02-28 14:34:56.7890000+02:00".into()),
                "2025-02-28 14:34:56.7890000+02:00",
            ),
            (
                "ref",
                Value::Uuid("5F0C00A1-7B2E-4C3D-9E8F-000000000001".into()),
                "5F0C00A1-7B2E-4C3D-9E8F-000000000001",
            ),
            ("doc", text(r#"{"a": 1}"#), r#"{"a": 1}"#),
        ],
        Engine::Sqlite | Engine::Mysql => vec![
            ("flag", Value::Bool(true), "1"),
            ("small", int(-32768), "-32768"),
            ("big", int(i64::MAX), "9223372036854775807"),
            ("amount", Value::Decimal("12.5".into()), "12.5"),
            ("ratio", Value::Float("0.1".into()), "0.1"),
            ("label", text(label), label),
            ("code", text("abc"), "abc"),
            ("raw", Value::bytes(&[0, 255, 16]), "00ff10"),
            ("day", Value::Date("2024-02-29".into()), "2024-02-29"),
            (
                "local_at",
                Value::Timestamp("2025-02-28 12:34:56".into()),
                "2025-02-28 12:34:56",
            ),
            (
                "ref",
                Value::Uuid("5f0c00a1-7b2e-4c3d-9e8f-000000000001".into()),
                "5f0c00a1-7b2e-4c3d-9e8f-000000000001",
            ),
            ("doc", Value::Json(r#"{"a": 1}"#.into()), r#"{"a": 1}"#),
        ],
    }
}

// --- The suite -------------------------------------------------------------------------------

async fn suite(fx: &Fixture) {
    let b = bench();
    let conn = b.connect(&fx.def, fx.password()).await;
    let engine = fx.engine;

    editability(&b, &conn, fx).await;
    round_trips(&b, &conn, fx).await;
    keys_and_identifiers(&b, &conn, fx).await;
    one_row_check(&b, &conn, fx).await;
    constraints(&b, &conn, fx).await;
    browsing(&b, &conn, fx).await;
    cancellation(&b, &conn, fx).await;
    if engine == Engine::Mssql {
        triggers(&b, &conn, fx).await;
    }

    // Statement log: values written as literals, the transaction around them.
    let logged: Vec<String> = b.log.entries().into_iter().map(|e| e.sql).collect();
    let begin = engine.dialect().begin_transaction();
    assert!(logged.iter().any(|s| s == begin), "{logged:?}");
    assert!(logged.iter().any(|s| s == "COMMIT"));
    assert!(logged.iter().any(|s| s == "ROLLBACK"));
    assert!(
        logged
            .iter()
            .any(|s| s.starts_with("UPDATE ") && s.contains("'renamed'")),
        "{logged:?}"
    );
    let edits = logged.iter().filter(|s| {
        s.starts_with("UPDATE ") || s.starts_with("INSERT ") || s.starts_with("DELETE ")
    });
    for sql in edits {
        assert!(
            !sql.contains("$1") && !sql.contains("@P1") && !sql.contains("?1"),
            "placeholders in the log: {sql}"
        );
    }
    // Errors are logged with their outcome.
    assert!(b.log.entries().iter().any(|e| matches!(
        &e.outcome,
        StatementOutcome::Error { error } if error.code == ErrorCode::ConstraintViolation
    )));

    // A read-only connection: shown as such, refused in the backend.
    let mut def = fx.def.clone();
    def.read_only = true;
    def.name = "read only".into();
    let ro = b.connect(&def, fx.password()).await;
    let tab = open(&b, &ro, fx.table("items"), "ro").await;
    assert!(
        tab.info
            .read_only_reasons
            .contains(&TableReadOnlyReason::ReadOnlyConnection)
    );
    let err = tab
        .apply(inserts(vec![insert(&[
            ("sku", text("ro")),
            ("qty", int(1)),
        ])]))
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::ReadOnlyViolation);
    let (rows, _) = tab
        .page(
            filter(vec![("sku", FilterOp::Eq, vec![text("ro")])], None),
            vec![],
            0,
            10,
        )
        .await
        .expect("page");
    assert!(rows.is_empty());
    // A raw WHERE cannot smuggle a write in (T-SQL needs no `;` between statements).
    let err = tab
        .page(
            filter(vec![], Some("1 = 1) DELETE FROM items WHERE (1 = 1")),
            vec![],
            0,
            10,
        )
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::ReadOnlyViolation);
    b.tables.close("ro").await;
}

async fn editability(b: &Bench, conn: &str, fx: &Fixture) {
    let kinds = open(b, conn, fx.table("kinds"), "kinds").await;
    assert_eq!(kinds.info.row_identity, Some(vec!["id".to_owned()]));
    assert!(kinds.info.read_only_reasons.is_empty());
    let reason = |name: &str| kinds.info.columns[kinds.col(name)].read_only_reason;
    let id_reason = match fx.engine {
        // `INTEGER PRIMARY KEY` aliases the rowid: generated when omitted, writable.
        Engine::Sqlite => None,
        _ => Some(ColumnReadOnlyReason::Identity),
    };
    assert_eq!(reason("id"), id_reason);
    assert_eq!(reason("label"), None);
    assert!(kinds.info.columns[kinds.col("note")].optional_on_insert);
    if fx.engine == Engine::Mssql {
        assert_eq!(reason("version"), Some(ColumnReadOnlyReason::RowVersion));
        assert_eq!(
            reason("variant"),
            Some(ColumnReadOnlyReason::UnsupportedType)
        );
    }
    if fx.engine == Engine::Postgres {
        assert_eq!(
            kinds.info.columns[kinds.col("mood")].enum_values,
            Some(vec!["sad".to_owned(), "ok".to_owned(), "happy".to_owned()])
        );
        assert_eq!(
            reason("spot"),
            None,
            "point is written back through its text form"
        );
    }

    let items = open(b, conn, fx.table("items"), "items").await;
    assert_eq!(
        items.info.columns[items.col("total")].read_only_reason,
        Some(ColumnReadOnlyReason::Generated)
    );

    let uniq = open(b, conn, fx.table("uniq"), "uniq").await;
    assert_eq!(uniq.info.row_identity, Some(vec!["code".to_owned()]));

    let keyless = open(b, conn, fx.table("keyless"), "keyless").await;
    assert_eq!(keyless.info.row_identity, None);
    assert_eq!(
        keyless.info.read_only_reasons,
        [TableReadOnlyReason::NoRowIdentity]
    );
    assert!(
        keyless
            .info
            .columns
            .iter()
            .all(|c| c.read_only_reason == Some(ColumnReadOnlyReason::Table))
    );
    let err = keyless
        .apply(inserts(vec![insert(&[("name", text("x"))])]))
        .await
        .expect_err("keyless");
    assert_eq!(err.code, ErrorCode::TableNotEditable);
    // Browsable all the same.
    keyless
        .page(TableFilter::default(), vec![], 0, 10)
        .await
        .expect("keyless page");

    let view = open(b, conn, fx.table("items_view"), "view").await;
    assert_eq!(view.info.read_only_reasons, [TableReadOnlyReason::View]);
    let err = b
        .tables
        .preview(
            "view",
            &ChangeSet {
                deletes: vec![vec![int(1)]],
                ..ChangeSet::default()
            },
        )
        .expect_err("view");
    assert_eq!(err.code, ErrorCode::TableNotEditable);
    for id in ["kinds", "items", "uniq", "keyless", "view"] {
        b.tables.close(id).await;
    }
}

async fn round_trips(b: &Bench, conn: &str, fx: &Fixture) {
    let tab = open(b, conn, fx.table("kinds"), "kinds").await;
    let values = kind_values(fx.engine);
    // Insert: every kind given, the defaults and the identity filled by the server.
    let row: Vec<(&str, Value)> = values.iter().map(|(c, v, _)| (*c, v.clone())).collect();
    let inserted = tab.applied(inserts(vec![insert(&row)])).await;
    assert_eq!(inserted.positions, [Some(0)]);
    let stored = b
        .store
        .get(inserted.window.result_id)
        .expect("inserted rows");
    let id = stored.cell(0, tab.col("id")).expect("id");
    assert!(
        matches!(&id, Value::Int(n) if n.parse::<i64>().is_ok()),
        "{id:?}"
    );
    assert_eq!(
        stored.cell(0, tab.col("note")),
        Some(text("hello")),
        "default applied"
    );
    let read = tab.row(vec![id.clone()]).await.expect("inserted row");
    for (column, _, expected) in &values {
        assert_eq!(
            plain_text(&read[tab.col(column)]).as_deref(),
            Some(*expected),
            "{column} after insert"
        );
        assert_eq!(
            plain_text(&stored.cell(0, tab.col(column)).expect("cell")).as_deref(),
            Some(*expected),
            "{column} returned by the insert"
        );
    }

    // Update: every column to NULL in one statement, then back to its value.
    let nulls: Vec<CellUpdate> = values
        .iter()
        .map(|(c, _, _)| update(vec![id.clone()], c, Value::Null))
        .collect();
    let preview = b
        .tables
        .preview("kinds", &updates(nulls.clone()))
        .expect("preview");
    assert_eq!(
        preview.statements.len(),
        1,
        "cell updates of a row are merged"
    );
    tab.applied(updates(nulls)).await;
    let read = tab.row(vec![id.clone()]).await.expect("row");
    for (column, _, _) in &values {
        assert_eq!(read[tab.col(column)], Value::Null, "{column} set to NULL");
    }
    let back: Vec<CellUpdate> = values
        .iter()
        .map(|(c, v, _)| update(vec![id.clone()], c, v.clone()))
        .collect();
    tab.applied(updates(back)).await;
    let read = tab.row(vec![id.clone()]).await.expect("row");
    for (column, _, expected) in &values {
        assert_eq!(
            plain_text(&read[tab.col(column)]).as_deref(),
            Some(*expected),
            "{column} after update"
        );
    }

    // NULL and the empty string stay apart; text typed for a typed column is converted.
    let mut cells = vec![update(vec![id.clone()], "label", text(""))];
    if fx.engine != Engine::Sqlite {
        cells.push(update(vec![id.clone()], "small", text("42")));
        cells.push(update(vec![id.clone()], "flag", text("false")));
    }
    tab.applied(updates(cells)).await;
    let read = tab.row(vec![id.clone()]).await.expect("row");
    assert_eq!(read[tab.col("label")], text(""));
    if fx.engine != Engine::Sqlite {
        assert_eq!(read[tab.col("small")], int(42));
        assert_eq!(read[tab.col("flag")], Value::Bool(false));
        // A value the engine cannot convert.
        let failure = tab
            .failed(updates(vec![update(
                vec![id.clone()],
                "ref",
                text("not-a-uuid"),
            )]))
            .await;
        assert_eq!(failure.error.code, ErrorCode::InvalidValue, "{failure:?}");
        assert!(failure.server.is_some());
    }

    // An empty insert: everything from the defaults.
    let inserted = tab.applied(inserts(vec![insert(&[])])).await;
    let stored = b
        .store
        .get(inserted.window.result_id)
        .expect("inserted rows");
    assert_eq!(stored.cell(0, tab.col("note")), Some(text("hello")));
    assert_eq!(stored.cell(0, tab.col("label")), Some(Value::Null));

    // Delete.
    tab.applied(ChangeSet {
        deletes: vec![vec![id.clone()]],
        ..ChangeSet::default()
    })
    .await;
    assert!(tab.row(vec![id]).await.is_none());
    b.tables.close("kinds").await;
}

async fn keys_and_identifiers(b: &Bench, conn: &str, fx: &Fixture) {
    // Composite key: insert, update a non-key and a key column, delete.
    let tab = open(b, conn, fx.table("composite"), "composite").await;
    assert_eq!(
        tab.info.row_identity,
        Some(vec!["a".to_owned(), "b".to_owned()])
    );
    tab.applied(inserts(vec![
        insert(&[("a", int(1)), ("b", text("x")), ("value", text("one"))]),
        insert(&[("a", int(1)), ("b", text("y")), ("value", text("two"))]),
    ]))
    .await;
    tab.applied(updates(vec![
        update(vec![int(1), text("x")], "value", text("uno")),
        update(vec![int(1), text("y")], "b", text("z")),
    ]))
    .await;
    let row = tab.row(vec![int(1), text("x")]).await.expect("row");
    assert_eq!(row[tab.col("value")], text("uno"));
    assert!(tab.row(vec![int(1), text("y")]).await.is_none());
    let row = tab.row(vec![int(1), text("z")]).await.expect("moved row");
    assert_eq!(row[tab.col("value")], text("two"));
    // A deleted key can be reused in the same change set (deletes run first).
    tab.applied(ChangeSet {
        deletes: vec![vec![int(1), text("z")]],
        inserts: vec![insert(&[
            ("a", int(1)),
            ("b", text("z")),
            ("value", text("new")),
        ])],
        ..ChangeSet::default()
    })
    .await;
    let row = tab.row(vec![int(1), text("z")]).await.expect("row");
    assert_eq!(row[tab.col("value")], text("new"));
    b.tables.close("composite").await;

    // Identifiers that need quoting.
    let tab = open(b, conn, fx.table("Odd \"Table\""), "odd").await;
    tab.applied(inserts(vec![insert(&[
        ("id", int(7)),
        ("Select", text("a")),
        ("two words", text("b")),
    ])]))
    .await;
    tab.applied(updates(vec![update(
        vec![int(7)],
        "Select",
        text("renamed"),
    )]))
    .await;
    let row = tab.row(vec![int(7)]).await.expect("row");
    assert_eq!(
        texts(&row),
        [Some("7".into()), Some("renamed".into()), Some("b".into())]
    );
    tab.applied(ChangeSet {
        deletes: vec![vec![int(7)]],
        ..ChangeSet::default()
    })
    .await;
    assert!(tab.row(vec![int(7)]).await.is_none());
    b.tables.close("odd").await;

    // A unique key on non-null columns as the row identity.
    let tab = open(b, conn, fx.table("uniq"), "uniq").await;
    tab.applied(inserts(vec![insert(&[
        ("code", text("A1")),
        ("label", text("first")),
    ])]))
    .await;
    tab.applied(updates(vec![update(
        vec![text("A1")],
        "label",
        text("second"),
    )]))
    .await;
    let row = tab.row(vec![text("A1")]).await.expect("row");
    assert_eq!(row[tab.col("label")], text("second"));
    b.tables.close("uniq").await;
}

async fn one_row_check(b: &Bench, conn: &str, fx: &Fixture) {
    let tab = open(b, conn, fx.table("items"), "items").await;
    let inserted = tab
        .applied(inserts(vec![
            insert(&[("sku", text("check-1")), ("qty", int(1))]),
            insert(&[
                ("sku", text("check-2")),
                ("qty", int(2)),
                ("price", Value::Decimal("2.50".into())),
            ]),
        ]))
        .await;
    let stored = b.store.get(inserted.window.result_id).expect("inserted");
    let first = stored.cell(0, tab.col("id")).expect("id");
    let second = stored.cell(1, tab.col("id")).expect("id");
    // The computed column comes back with the row.
    assert_eq!(
        plain_text(&stored.cell(1, tab.col("total")).expect("total"))
            .map(|t| t.parse::<f64>().ok()),
        Some(Some(5.0))
    );
    // The second statement matches no row: the first one is rolled back too.
    let failure = tab
        .failed(updates(vec![
            update(vec![first.clone()], "qty", int(10)),
            update(vec![int(999_999)], "qty", int(11)),
        ]))
        .await;
    assert_eq!(failure.error.code, ErrorCode::RowNotFound);
    assert_eq!(failure.statement_index, Some(1));
    assert_eq!(failure.rows_affected, Some(0.0));
    assert!(
        matches!(failure.change, Some(PlannedChange::Update { ref key, .. }) if key == &[int(999_999)])
    );
    assert!(failure.error.message.en.contains("id = 999999"));
    let row = tab.row(vec![first.clone()]).await.expect("row");
    assert_eq!(row[tab.col("qty")], int(1), "rolled back");
    // A delete that matches nothing.
    let failure = tab
        .failed(ChangeSet {
            deletes: vec![vec![second.clone()], vec![int(999_998)]],
            ..ChangeSet::default()
        })
        .await;
    assert_eq!(failure.error.code, ErrorCode::RowNotFound);
    assert!(tab.row(vec![second]).await.is_some(), "delete rolled back");
    b.tables.close("items").await;
}

async fn constraints(b: &Bench, conn: &str, fx: &Fixture) {
    let tab = open(b, conn, fx.table("items"), "items").await;
    let inserted = tab
        .applied(inserts(vec![insert(&[
            ("sku", text("dup")),
            ("qty", int(1)),
        ])]))
        .await;
    let id = b
        .store
        .get(inserted.window.result_id)
        .expect("inserted")
        .cell(0, tab.col("id"))
        .expect("id");

    let unique = tab
        .failed(inserts(vec![insert(&[
            ("sku", text("dup")),
            ("qty", int(1)),
        ])]))
        .await;
    assert_eq!(unique.error.code, ErrorCode::ConstraintViolation);
    let violation = unique.violation.expect("violation");
    assert_eq!(violation.kind, ConstraintKind::Unique);
    match fx.engine {
        Engine::Sqlite => assert_eq!(violation.column.as_deref(), Some("sku")),
        _ => assert_eq!(violation.name.as_deref(), Some("items_sku_key")),
    }

    let check = tab
        .failed(updates(vec![update(vec![id.clone()], "qty", int(-1))]))
        .await;
    let violation = check.violation.expect("violation");
    assert_eq!(violation.kind, ConstraintKind::Check);
    assert_eq!(violation.name.as_deref(), Some("items_qty_check"));

    let not_null = tab
        .failed(updates(vec![update(vec![id.clone()], "sku", Value::Null)]))
        .await;
    let violation = not_null.violation.expect("violation");
    assert_eq!(violation.kind, ConstraintKind::NotNull);
    assert_eq!(violation.column.as_deref(), Some("sku"));

    // Foreign keys are enforced by the server engines (SQLite only with a pragma).
    if fx.engine != Engine::Sqlite {
        let child = open(b, conn, fx.table("child"), "child").await;
        let fk = child
            .failed(inserts(vec![insert(&[
                ("id", int(1)),
                ("item_id", int(999_999)),
            ])]))
            .await;
        let violation = fk.violation.expect("violation");
        assert_eq!(violation.kind, ConstraintKind::ForeignKey);
        assert_eq!(violation.name.as_deref(), Some("child_item_fkey"));
        b.tables.close("child").await;
    }
    let row = tab.row(vec![id]).await.expect("row");
    assert_eq!(row[tab.col("qty")], int(1));
    b.tables.close("items").await;
}

async fn browsing(b: &Bench, conn: &str, fx: &Fixture) {
    let tab = open(b, conn, fx.table("items"), "browse").await;
    let rows: Vec<RowInsert> = (1..=30)
        .map(|n| {
            insert(&[
                ("sku", text(&format!("page-{n:02}"))),
                ("qty", int(n % 7)),
                ("price", Value::Decimal(format!("{n}.25"))),
            ])
        })
        .collect();
    tab.applied(inserts(rows)).await;
    let mine = || vec![("sku", FilterOp::StartsWith, vec![text("page-")])];

    // Default order (the key), pages that do not overlap.
    let (first, more) = tab
        .page(filter(mine(), None), vec![], 0, 12)
        .await
        .expect("page");
    assert_eq!((first.len(), more), (12, true));
    let (last, more) = tab
        .page(filter(mine(), None), vec![], 24, 12)
        .await
        .expect("page");
    assert_eq!((last.len(), more), (6, false));
    let sku = tab.col("sku");
    assert_eq!(first[0][sku], text("page-01"));
    assert_eq!(last[5][sku], text("page-30"));

    // Sort on a non-unique column: the key breaks ties.
    let by_qty = vec![SortKey {
        column: "qty".into(),
        direction: SortDirection::Desc,
    }];
    let (sorted, _) = tab
        .page(filter(mine(), None), by_qty, 0, 30)
        .await
        .expect("page");
    let qty: Vec<i64> = sorted
        .iter()
        .map(|r| {
            plain_text(&r[tab.col("qty")])
                .and_then(|t| t.parse().ok())
                .unwrap_or(-1)
        })
        .collect();
    assert!(qty.windows(2).all(|w| w[0] >= w[1]), "{qty:?}");
    assert_eq!(sorted[0][sku], text("page-06"), "qty 6, lowest id first");

    // Every operator, values bound.
    let cases: Vec<(Vec<Condition>, usize)> = vec![
        (vec![("sku", FilterOp::Eq, vec![text("page-03")])], 1),
        (vec![("qty", FilterOp::Ne, vec![int(0)])], 26),
        (vec![("qty", FilterOp::Lt, vec![int(2)])], 9),
        (vec![("qty", FilterOp::Le, vec![int(2)])], 14),
        (vec![("qty", FilterOp::Gt, vec![int(5)])], 4),
        (vec![("qty", FilterOp::Ge, vec![int(5)])], 8),
        (vec![("sku", FilterOp::Contains, vec![text("GE-1")])], 10),
        (vec![("sku", FilterOp::EndsWith, vec![text("0")])], 3),
        (vec![("qty", FilterOp::In, vec![int(1), int(3)])], 9),
        (
            vec![("price", FilterOp::Between, vec![int(10), int(20)])],
            10,
        ),
        (vec![("sku", FilterOp::IsNull, vec![])], 0),
        (vec![("sku", FilterOp::IsNotNull, vec![])], 30),
        // `%` and `_` are taken literally.
        (vec![("sku", FilterOp::Contains, vec![text("%")])], 0),
        (vec![("sku", FilterOp::Contains, vec![text("_")])], 0),
    ];
    for (conditions, expected) in cases {
        let mut all = mine();
        all.extend(conditions.clone());
        let (rows, _) = tab
            .page(filter(all.clone(), None), vec![], 0, 100)
            .await
            .unwrap_or_else(|e| panic!("{conditions:?}: {e:?}"));
        assert_eq!(rows.len(), expected, "{conditions:?}");
        let exact = tab.count(filter(all, None), CountMode::Exact).await;
        assert_eq!(exact, Some(expected as f64), "count of {conditions:?}");
    }

    // A raw WHERE, sent as written, with a trailing comment.
    let raw = "qty * 2 = 4 -- doubled";
    let (rows, _) = tab
        .page(filter(mine(), Some(raw)), vec![], 0, 100)
        .await
        .expect("raw WHERE");
    assert_eq!(rows.len(), 5);
    let err = tab
        .page(
            filter(vec![], Some("1 = 1; DELETE FROM items")),
            vec![],
            0,
            10,
        )
        .await
        .expect_err("two statements");
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let err = tab
        .page(filter(vec![], Some("no_such_column = 1")), vec![], 0, 10)
        .await
        .expect_err("engine error");
    assert_eq!(err.code, ErrorCode::QueryFailed);

    // Estimates.
    let estimate = b
        .tables
        .count("browse", filter(mine(), None), CountMode::Estimate)
        .await
        .expect("estimate");
    match fx.engine {
        Engine::Postgres => assert!(estimate.count.is_some() && estimate.filtered),
        Engine::Mssql => assert!(estimate.count.is_some() && !estimate.filtered),
        _ => assert_eq!(estimate.count, None),
    }
    let unfiltered = b
        .tables
        .count("browse", TableFilter::default(), CountMode::Estimate)
        .await
        .expect("estimate");
    if fx.engine == Engine::Mssql {
        assert!(unfiltered.filtered);
        assert!(unfiltered.count.unwrap_or(0.0) >= 30.0);
    }

    // Refresh several rows, one of them gone.
    let ids: Vec<Value> = first
        .iter()
        .take(3)
        .map(|r| r[tab.col("id")].clone())
        .collect();
    tab.applied(ChangeSet {
        deletes: vec![vec![ids[1].clone()]],
        ..ChangeSet::default()
    })
    .await;
    let refreshed = b
        .tables
        .refresh_rows("browse", ids.iter().map(|id| vec![id.clone()]).collect())
        .await
        .expect("refresh");
    assert_eq!(refreshed.positions, [Some(0), None, Some(1)]);
    assert_eq!(refreshed.window.row_count, 2);

    // The change event names the table.
    assert!(b.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::TableDataChanged(c) if c.tab_id == "browse" && c.deleted == 1
    )));
    let bad = tab.page(TableFilter::default(), vec![], 0, 0).await;
    assert_eq!(bad.expect_err("limit").code, ErrorCode::InvalidArgument);
    b.tables.close("browse").await;
}

async fn cancellation(b: &Bench, conn: &str, fx: &Fixture) {
    let tab = open(b, conn, fx.table("items"), "cancel").await;
    let mut blocker = None;
    let raw = match fx.engine {
        Engine::Postgres => "pg_sleep(30) IS NOT NULL".to_owned(),
        Engine::Sqlite => "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
SELECT max(x) FROM c) > 0"
            .to_owned(),
        _ => {
            // A row locked by another session: the read waits for it.
            let other = common::open(&fx.def, fx.password.as_ref())
                .await
                .expect("second connection");
            other.query("BEGIN TRANSACTION", 0).await.expect("begin");
            other
                .query("UPDATE edits.items SET qty = qty WHERE sku = N'page-01'", 0)
                .await
                .expect("lock");
            blocker = Some(other);
            "1 = 1".to_owned()
        }
    };
    let started = std::time::Instant::now();
    let page = tab.page(filter(vec![], Some(&raw)), vec![], 0, 10);
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        b.tables.cancel("cancel").await;
    };
    let (result, ()) = tokio::join!(page, cancel);
    assert_eq!(result.expect_err("cancelled").code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    if let Some(other) = blocker {
        other.query("ROLLBACK", 0).await.expect("rollback");
        other.close().await;
    }
    // The tab's connection still works.
    tab.page(TableFilter::default(), vec![], 0, 5)
        .await
        .expect("after cancel");
    b.tables.close("cancel").await;
}

/// SQL Server refuses `OUTPUT` on a table with triggers, and its triggers report row counts
/// of their own.
async fn triggers(b: &Bench, conn: &str, fx: &Fixture) {
    let tab = open(b, conn, fx.table("audited"), "audited").await;
    let preview = b
        .tables
        .preview("audited", &inserts(vec![insert(&[("name", text("a"))])]))
        .expect("preview");
    assert!(
        preview.statements[0].sql.contains("SCOPE_IDENTITY()"),
        "{}",
        preview.statements[0].sql
    );
    let inserted = tab
        .applied(inserts(vec![insert(&[("name", text("a"))])]))
        .await;
    assert_eq!(inserted.positions, [Some(0)]);
    let id = b
        .store
        .get(inserted.window.result_id)
        .expect("row")
        .cell(0, tab.col("id"))
        .expect("id");
    tab.applied(updates(vec![update(vec![id.clone()], "name", text("b"))]))
        .await;
    let row = tab.row(vec![id]).await.expect("row");
    assert_eq!(row[tab.col("name")], text("b"));
    b.tables.close("audited").await;
}

// --- Engines ---------------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_table_data_and_edits() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("edits.sqlite");
    let conn = rusqlite::Connection::open(&path).expect("create fixture");
    conn.execute_batch(include_str!("fixtures/edit_sqlite.sql"))
        .expect("fixture script");
    drop(conn);
    let mut def = blank(Engine::Sqlite, "edits.sqlite");
    def.file_path = path.display().to_string();
    let fx = Fixture {
        engine: Engine::Sqlite,
        def,
        password: None,
        database: "main".into(),
        schema: None,
    };
    suite(&fx).await;
}

fn unique_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("yadbe_m22_{}_{nanos:x}", std::process::id())
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
async fn postgres_table_data_and_edits() {
    let Some(url) = pg_url("postgres_table_data_and_edits") else {
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
        include_str!("fixtures/edit_postgres.sql").replace("{s}", &format!("\"{schema}\""));
    let syntax = Engine::Postgres.dialect().syntax();
    for statement in yadbe_lib::db::split::split(&script, &syntax) {
        let sql = &script[statement.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    let fx = Fixture {
        engine: Engine::Postgres,
        database: def.database.clone(),
        def,
        password,
        schema: Some(schema),
    };
    suite(&fx).await;
}

#[tokio::test]
async fn mssql_table_data_and_edits() {
    let Some(url) = mssql_url("mssql_table_data_and_edits") else {
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
    let script = include_str!("fixtures/edit_mssql.sql");
    let syntax = Engine::Mssql.dialect().syntax();
    for batch in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[batch.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
    let fx = Fixture {
        engine: Engine::Mssql,
        def,
        password,
        database: name,
        schema: Some("edits".into()),
    };
    suite(&fx).await;
}
