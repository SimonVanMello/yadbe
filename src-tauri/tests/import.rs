//! Data import (M3-10, F-091) against real engines: CSV and JSON written into tables, the
//! type check, the dry run, atomic failure, skipping bad rows with a rejects file, per-batch
//! commits, cancellation, the read-only refusal, and the compact statement log. Every test
//! checks the resulting table state. SQLite always runs; PostgreSQL, SQL Server and MySQL
//! when their URLs are set.

mod common;

use std::io::Write as _;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{blank, mssql_url, mysql_url, pg_definition, pg_url};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::meta::{ObjectRef, qualified_name};
use yadbe_lib::db::value::Value;
use yadbe_lib::events::{BackendEvent, RecordingSink};
use yadbe_lib::import::ImportManager;
use yadbe_lib::import::model::{
    ImportAnalysis, ImportCommit, ImportConvertOptions, ImportEncoding, ImportFinished,
    ImportFormat, ImportIssueKind, ImportMapping, ImportOnError, ImportParseOptions, ImportRequest,
    ImportStatus, ImportValueSource,
};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::MetaService;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

// --- Harness ---------------------------------------------------------------------------------

struct Bench {
    manager: Arc<ConnectionManager>,
    imports: Arc<ImportManager>,
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
    let meta = Arc::new(MetaService::new(sink.clone()));
    let imports = Arc::new(
        ImportManager::new(Arc::clone(&manager), meta, sink.clone())
            .with_progress_interval(Duration::from_millis(5)),
    );
    Bench {
        manager,
        imports,
        log,
        sink,
        db,
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

    async fn connect(&self, b: &Bench, read_only: bool) -> String {
        let mut def = self.def.clone();
        def.read_only = read_only;
        let saved = b.db.create_connection(&def).expect("save");
        b.manager
            .connect(&saved.id, self.password())
            .await
            .expect("connect");
        saved.id
    }

    /// A plain connection for reading the tables back.
    async fn reader(&self) -> Box<dyn yadbe_lib::db::driver::Connection> {
        common::open(&self.def, self.password.as_ref())
            .await
            .expect("reader")
    }

    async fn query(&self, sql: &str) -> Vec<Vec<Value>> {
        let conn = self.reader().await;
        let result = conn
            .query(sql, usize::MAX)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
        conn.close().await;
        result.rows
    }

    fn qualified(&self, name: &str) -> String {
        qualified_name(self.engine.dialect(), &self.table(name))
    }

    async fn count(&self, table: &str) -> i64 {
        let sql = format!("SELECT COUNT(*) FROM {}", self.qualified(table));
        let rows = self.query(&sql).await;
        show(&rows[0][0]).parse().expect("a count")
    }

    async fn clear(&self, table: &str) {
        let sql = format!("DELETE FROM {}", self.qualified(table));
        let conn = self.reader().await;
        conn.query(&sql, 0).await.expect("clear");
        conn.close().await;
    }
}

/// A value as text, the same across engines (booleans as 0 / 1, numbers without trailing
/// zeros, timestamps to the second).
fn show(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) => i32::from(*b).to_string(),
        Value::Int(s) | Value::Decimal(s) | Value::Float(s) => s
            .parse::<f64>()
            .map_or_else(|_| s.clone(), |n| format!("{n}")),
        Value::Date(s) => s.chars().take(10).collect(),
        Value::Timestamp(s) | Value::TimestampTz(s) => s.chars().take(19).collect(),
        Value::Uuid(s) | Value::Text(s) | Value::Other(s) => s.to_lowercase(),
        Value::Json(s) => s.clone(),
        Value::Bytes(h) => h.to_lowercase(),
        other => format!("{other:?}"),
    }
}

fn rows_text(rows: &[Vec<Value>]) -> Vec<Vec<String>> {
    rows.iter()
        .map(|row| row.iter().map(show).collect())
        .collect()
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
    let path = dir.join(name);
    std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(bytes))
        .expect("writes the file");
    path.display().to_string()
}

fn csv_options() -> ImportParseOptions {
    ImportParseOptions {
        null_token: Some("NULL".into()),
        ..ImportParseOptions::default()
    }
}

fn mapping(columns: &[&str]) -> Vec<ImportMapping> {
    columns
        .iter()
        .enumerate()
        .map(|(i, name)| ImportMapping {
            column: (*name).to_owned(),
            source: ImportValueSource::File {
                index: u32::try_from(i).expect("index"),
            },
        })
        .collect()
}

fn request(
    fx: &Fixture,
    connection_id: &str,
    table: &str,
    path: &str,
    columns: &[&str],
) -> ImportRequest {
    ImportRequest {
        connection_id: connection_id.to_owned(),
        table: fx.table(table),
        path: path.to_owned(),
        parse: csv_options(),
        mapping: mapping(columns),
        convert: ImportConvertOptions::default(),
        on_error: ImportOnError::Stop,
        commit: ImportCommit::Single,
        dry_run: false,
        rejects_path: None,
    }
}

async fn finish(b: &Bench, request: ImportRequest) -> ImportFinished {
    let started = b.imports.start(request).await.expect("starts");
    wait_finished(b, started.import_id).await
}

async fn wait_finished(b: &Bench, import_id: u32) -> ImportFinished {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        for event in b.sink.events() {
            if let BackendEvent::ImportFinished(done) = event
                && done.import_id == import_id
            {
                return done;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the import never ended"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

const MAIN_COLUMNS: [&str; 11] = [
    "id", "name", "amount", "qty", "flag", "born", "seen", "note", "uid", "doc", "bin",
];

const MAIN_CSV: &str = "id,name,amount,qty,flag,born,seen,note,uid,doc,bin
1,Ana,12.50,3,true,1990-02-28,2024-01-31 10:20:30,héllo wörld 😀,123e4567-e89b-12d3-a456-426614174000,\"{\"\"a\"\": [1, 2]}\",deadbeef
2,\"Bob, Jr.\",0.05,-7,false,2000-12-31,2024-02-29T00:00:01,\"line1
line2\",,NULL,
3,Zoë,,,,,,,,,00
";

// --- Scenarios -------------------------------------------------------------------------------

async fn suite(fx: &Fixture) {
    let b = bench();
    let conn = fx.connect(&b, false).await;
    let dir = tempfile::tempdir().expect("dir");
    types_round_trip(&b, fx, &conn, dir.path()).await;
    dry_run(&b, fx, &conn, dir.path()).await;
    analysis_counts_bad_values(&b, fx, &conn, dir.path()).await;
    atomic_failure(&b, fx, &conn, dir.path()).await;
    skip_bad_rows(&b, fx, &conn, dir.path()).await;
    per_batch_commits(&b, fx, &conn, dir.path()).await;
    json_files(&b, fx, &conn, dir.path()).await;
    encodings(&b, fx, &conn, dir.path()).await;
    mapping_rules(&b, fx, &conn, dir.path()).await;
    cancellation(&b, fx, &conn, dir.path()).await;
    read_only_connection(&b, fx, dir.path()).await;
    statement_log(&b, fx, &conn, dir.path()).await;
}

async fn types_round_trip(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let path = write(dir, "main.csv", MAIN_CSV.as_bytes());
    let mut req = request(fx, conn, "imp_main", &path, &MAIN_COLUMNS);
    req.on_error = ImportOnError::Stop;
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Done, "{:?}", done.error);
    assert_eq!(
        (done.rows_read, done.inserted, done.kept, done.rejected),
        (3, 3, 3, 0)
    );
    let sql = format!(
        "SELECT id, name, amount, qty, flag, born, seen, note, uid, doc, bin FROM {} ORDER BY id",
        fx.qualified("imp_main")
    );
    let rows = rows_text(&fx.query(&sql).await);
    assert_eq!(rows.len(), 3);
    let first = &rows[0];
    assert_eq!(&first[..4], ["1", "ana", "12.5", "3"]);
    assert_eq!(first[4], "1");
    assert_eq!(first[5], "1990-02-28");
    assert_eq!(first[6], "2024-01-31 10:20:30");
    assert_eq!(first[7], "héllo wörld 😀");
    assert_eq!(first[8], "123e4567-e89b-12d3-a456-426614174000");
    assert!(first[9].contains("\"a\""), "json kept: {}", first[9]);
    assert_eq!(first[10], "deadbeef");
    let second = &rows[1];
    assert_eq!(&second[..4], ["2", "bob, jr.", "0.05", "-7"]);
    assert_eq!(second[4], "0");
    assert_eq!(second[6], "2024-02-29 00:00:01");
    assert_eq!(second[7], "line1\nline2");
    assert_eq!(second[8], "NULL", "an empty field is NULL");
    assert_eq!(second[9], "NULL", "the null token is NULL");
    assert_eq!(second[10], "NULL");
    let third = &rows[2];
    assert_eq!(&third[1..4], ["zoë", "NULL", "NULL"]);
    assert_eq!(third[10], "00");
    assert!(
        b.sink
            .events()
            .iter()
            .any(|e| matches!(e, BackendEvent::TableDataChanged(c) if c.inserted == 3)),
        "open table tabs are told to read again"
    );
    fx.clear("imp_main").await;
}

async fn dry_run(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let path = write(dir, "dry.csv", MAIN_CSV.as_bytes());
    let mut req = request(fx, conn, "imp_main", &path, &MAIN_COLUMNS);
    req.dry_run = true;
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Done, "{:?}", done.error);
    assert!(done.dry_run);
    assert_eq!((done.inserted, done.kept), (3, 0));
    assert_eq!(fx.count("imp_main").await, 0, "a dry run writes nothing");

    // The dry run reports what would fail, atomically.
    let dup = "id,name\n1,a\n2,b\n1,c\n";
    let path = write(dir, "dry-dup.csv", dup.as_bytes());
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    req.dry_run = true;
    req.on_error = ImportOnError::Skip;
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Done, "{:?}", done.error);
    assert_eq!((done.inserted, done.rejected, done.kept), (2, 1, 0));
    assert_eq!(done.reject_samples[0].line, 4);
    assert_eq!(done.reject_samples[0].reason, ImportIssueKind::Constraint);
    assert_eq!(fx.count("imp_main").await, 0);
}

async fn analysis_counts_bad_values(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let csv = "id,name,amount,qty,born\n1,ok,1.5,1,2020-01-01\nx,waytoolongname,1.555,70000,2020-02-30\n3,fine,,,\n";
    let path = write(dir, "analysis.csv", csv.as_bytes());
    let req = request(
        fx,
        conn,
        "imp_main",
        &path,
        &["id", "name", "amount", "qty", "born"],
    );
    let analysis: ImportAnalysis = b.imports.analyze(req).await.expect("analyzes");
    assert_eq!(analysis.rows_examined, 3);
    assert!(!analysis.sampled);
    let by = |name: &str| {
        analysis
            .columns
            .iter()
            .find(|c| c.column == name)
            .unwrap_or_else(|| panic!("column {name}"))
    };
    assert_eq!(by("id").invalid, 1);
    assert_eq!(by("id").samples[0].value, "x");
    assert_eq!(by("name").samples[0].reason, ImportIssueKind::TooLong);
    assert_eq!(
        by("amount").samples[0].reason,
        ImportIssueKind::TooManyDecimals
    );
    assert_eq!(by("qty").samples[0].reason, ImportIssueKind::OutOfRange);
    assert_eq!(by("born").samples[0].reason, ImportIssueKind::InvalidFormat);
    assert_eq!(by("amount").nulls, 1);
    // `name` and `id` are the only NOT NULL columns without a default and both are mapped.
    assert!(analysis.missing_required.is_empty());
    let narrow = request(fx, conn, "imp_main", &path, &["id"]);
    let analysis = b.imports.analyze(narrow).await.expect("analyzes");
    assert_eq!(analysis.missing_required, ["name"]);
}

async fn atomic_failure(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    // 2 500 rows over three batches; row 2 400 repeats an id of the first batch.
    let mut csv = String::from("id,name\n");
    for i in 1..=2500 {
        let id = if i == 2400 { 7 } else { i };
        csv.push_str(&format!("{id},n{i}\n"));
    }
    let path = write(dir, "atomic.csv", csv.as_bytes());
    let req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Failed);
    let error = done.error.expect("an error");
    assert_eq!(error.code, ErrorCode::ImportRejected);
    assert!(
        error.message.en.contains("line 2401"),
        "the line of the duplicate (header + 2400): {}",
        error.message.en
    );
    assert_eq!(done.kept, 0);
    assert_eq!(fx.count("imp_main").await, 0, "everything was rolled back");
    assert_eq!(done.reject_samples[0].line, 2401);
}

async fn skip_bad_rows(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let csv = "id,name,qty\n1,a,1\nx,b,2\n3,waytoolongname,3\n4,,4\n1,dup,5\n6,f,6\n7,g\n8,h,9\n";
    let path = write(dir, "skip.csv", csv.as_bytes());
    let rejects = dir.join("rejects.csv").display().to_string();
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name", "qty"]);
    req.on_error = ImportOnError::Skip;
    req.rejects_path = Some(rejects.clone());
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Done, "{:?}", done.error);
    assert_eq!(done.rows_read, 8);
    assert_eq!(done.inserted, 3, "ids 1, 6 and 8");
    assert_eq!(done.rejected, 5);
    let reasons: Vec<(u32, ImportIssueKind)> = done
        .reject_samples
        .iter()
        .map(|r| (r.line, r.reason))
        .collect();
    assert_eq!(
        reasons,
        [
            (3, ImportIssueKind::InvalidFormat),
            (4, ImportIssueKind::TooLong),
            (5, ImportIssueKind::NullNotAllowed),
            (6, ImportIssueKind::Constraint),
            (8, ImportIssueKind::FieldCount),
        ]
    );
    let rows = rows_text(
        &fx.query(&format!(
            "SELECT id, name, qty FROM {} ORDER BY id",
            fx.qualified("imp_main")
        ))
        .await,
    );
    assert_eq!(rows, [["1", "a", "1"], ["6", "f", "6"], ["8", "h", "9"]]);
    let written = std::fs::read_to_string(&rejects).expect("rejects file");
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(lines[0], "line,error,id,name,qty");
    assert_eq!(lines.len(), 6);
    assert!(
        lines[1].starts_with("3,") && lines[1].ends_with(",x,b,2"),
        "{}",
        lines[1]
    );
    assert!(lines[5].starts_with("8,"), "{}", lines[5]);
    assert_eq!(done.rejects_path.as_deref(), Some(rejects.as_str()));
    fx.clear("imp_main").await;
}

async fn per_batch_commits(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    // The second batch holds a duplicate of an id in the first.
    let mut csv = String::from("id,name\n");
    for i in 1..=1500 {
        let id = if i == 1200 { 5 } else { i };
        csv.push_str(&format!("{id},n{i}\n"));
    }
    let path = write(dir, "per-batch.csv", csv.as_bytes());
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    req.commit = ImportCommit::PerBatch;
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Failed);
    assert_eq!(
        done.error.as_ref().map(|e| e.code),
        Some(ErrorCode::ImportRejected)
    );
    let count = fx.count("imp_main").await;
    assert_eq!(
        count,
        i64::from(done.kept),
        "what was committed is what is reported"
    );
    assert!(count >= 1000, "the first batch stays: {count}");
    assert_eq!(count, 1199, "rows before the duplicate");
    fx.clear("imp_main").await;

    // Skipping in per-batch mode.
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    req.commit = ImportCommit::PerBatch;
    req.on_error = ImportOnError::Skip;
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Done, "{:?}", done.error);
    assert_eq!((done.inserted, done.rejected), (1499, 1));
    assert_eq!(fx.count("imp_main").await, 1499);
    fx.clear("imp_main").await;
}

async fn json_files(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let array = "[ {\"id\": 1, \"name\": \"Ana\", \"amount\": 12.5, \"flag\": true, \"note\": \"caf\\u00e9 \\ud83d\\ude00\", \"doc\": {\"k\": [1]}},
                   {\"id\": 2, \"name\": \"Bob\", \"amount\": null, \"flag\": false} ]";
    let path = write(dir, "rows.json", array.as_bytes());
    let mut req = request(
        fx,
        conn,
        "imp_main",
        &path,
        &["id", "name", "amount", "flag", "note", "doc"],
    );
    req.parse = ImportParseOptions {
        format: ImportFormat::Json,
        ..ImportParseOptions::default()
    };
    let done = finish(b, req).await;
    assert_eq!(done.status, ImportStatus::Done, "{:?}", done.error);
    assert_eq!(done.inserted, 2);
    let sql = format!(
        "SELECT id, name, amount, flag, note FROM {} ORDER BY id",
        fx.qualified("imp_main")
    );
    let rows = rows_text(&fx.query(&sql).await);
    assert_eq!(rows[0], ["1", "ana", "12.5", "1", "café 😀"]);
    assert_eq!(rows[1], ["2", "bob", "NULL", "0", "NULL"]);
    fx.clear("imp_main").await;

    let lines = "{\"id\": 10, \"name\": \"x\"}\n{\"id\": 11, \"name\": \"y\"}\n";
    let path = write(dir, "rows.jsonl", lines.as_bytes());
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    req.parse = ImportParseOptions {
        format: ImportFormat::JsonLines,
        ..ImportParseOptions::default()
    };
    let done = finish(b, req).await;
    assert_eq!(
        (done.status, done.inserted),
        (ImportStatus::Done, 2),
        "{:?}",
        done.error
    );
    fx.clear("imp_main").await;
}

async fn encodings(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let text = "id;name\n1;Zoë\n2;Ça va\n";
    let mut utf16 = vec![0xff, 0xfe];
    for unit in text.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    let path = write(dir, "utf16.csv", &utf16);
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    req.parse = ImportParseOptions {
        encoding: ImportEncoding::Utf16le,
        delimiter: yadbe_lib::import::model::ImportDelimiter::Semicolon,
        ..ImportParseOptions::default()
    };
    let done = finish(b, req).await;
    assert_eq!(
        (done.status, done.inserted),
        (ImportStatus::Done, 2),
        "{:?}",
        done.error
    );
    let sql = format!("SELECT name FROM {} ORDER BY id", fx.qualified("imp_main"));
    assert_eq!(rows_text(&fx.query(&sql).await), [["zoë"], ["ça va"]]);
    fx.clear("imp_main").await;

    // Windows-1252 bytes read as UTF-8 are flagged, not silently replaced.
    let latin1 = b"id,name\n1,Zo\xeb\n";
    let path = write(dir, "latin1.csv", latin1);
    let preview = b.imports.preview(&path, None, 5).await.expect("preview");
    assert_eq!(preview.invalid_bytes, 1);
    let mut req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    req.parse = ImportParseOptions {
        encoding: ImportEncoding::Latin1,
        ..ImportParseOptions::default()
    };
    let done = finish(b, req).await;
    assert_eq!((done.status, done.invalid_bytes), (ImportStatus::Done, 0));
    assert_eq!(rows_text(&fx.query(&sql).await), [["zoë"]]);
    fx.clear("imp_main").await;
}

async fn mapping_rules(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let path = write(dir, "map.csv", b"label,extra\nfirst,1\nsecond,2\n");
    // The server fills the identity and the default; a constant and NULL are written.
    let mut req = request(fx, conn, "imp_ident", &path, &["label"]);
    req.parse = ImportParseOptions::default();
    let done = finish(b, req).await;
    assert_eq!(
        (done.status, done.inserted),
        (ImportStatus::Done, 2),
        "{:?}",
        done.error
    );
    let sql = format!(
        "SELECT id, label FROM {} ORDER BY id",
        fx.qualified("imp_ident")
    );
    let rows = rows_text(&fx.query(&sql).await);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][1], "first");
    assert_ne!(
        rows[0][0], rows[1][0],
        "the server generated the identities"
    );
    fx.clear("imp_ident").await;

    let mut req = request(fx, conn, "imp_main", &path, &["name"]);
    req.mapping.push(ImportMapping {
        column: "id".into(),
        source: ImportValueSource::Constant { value: "42".into() },
    });
    req.dry_run = true;
    // The same constant on every row breaks the key on the second row.
    req.on_error = ImportOnError::Skip;
    let done = finish(b, req).await;
    assert_eq!((done.inserted, done.rejected), (1, 1), "{:?}", done.error);

    // A column the server always generates, an unknown one, a NOT NULL one left out.
    if fx.engine != Engine::Sqlite && fx.engine != Engine::Mysql {
        let req = request(fx, conn, "imp_ident", &path, &["id", "label"]);
        let error = b.imports.start(req).await.expect_err("identity refused");
        assert_eq!(error.code, ErrorCode::InvalidArgument);
    }
    let req = request(fx, conn, "imp_main", &path, &["nope"]);
    assert_eq!(
        b.imports.start(req).await.expect_err("unknown").code,
        ErrorCode::InvalidArgument
    );
    let req = request(fx, conn, "imp_main", &path, &["id"]);
    assert_eq!(
        b.imports
            .start(req)
            .await
            .expect_err("name is required")
            .code,
        ErrorCode::InvalidArgument
    );
    let mut req = request(fx, conn, "imp_main", "relative/path.csv", &["id"]);
    req.path = "relative/path.csv".into();
    assert_eq!(
        b.imports.start(req).await.expect_err("relative").code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(fx.count("imp_main").await, 0);
}

async fn cancellation(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    let mut csv = String::from("id,a,b,c\n");
    for i in 1..=300_000 {
        csv.push_str(&format!("{i},text {i},{},{}.25\n", i % 1000, i % 977));
    }
    let path = write(dir, "big.csv", csv.as_bytes());
    let req = request(fx, conn, "imp_big", &path, &["id", "a", "b", "c"]);
    let started = b.imports.start(req).await.expect("starts");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let seen = b.sink.events().iter().any(|e| {
            matches!(e, BackendEvent::ImportProgress(p)
                if p.import_id == started.import_id && p.inserted > 0)
        });
        if seen {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "no progress");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    b.imports.cancel(started.import_id);
    let done = wait_finished(b, started.import_id).await;
    assert_eq!(done.status, ImportStatus::Cancelled, "{:?}", done.error);
    assert!(done.error.is_none());
    assert!(
        done.inserted < 300_000,
        "cancelled before the end: {}",
        done.inserted
    );
    assert_eq!(done.kept, 0);
    assert_eq!(
        fx.count("imp_big").await,
        0,
        "a cancelled import is rolled back"
    );
}

async fn read_only_connection(b: &Bench, fx: &Fixture, dir: &Path) {
    let read_only = fx.connect(b, true).await;
    let path = write(dir, "ro.csv", b"id,name\n1,a\n");
    let req = request(fx, &read_only, "imp_main", &path, &["id", "name"]);
    let error = b.imports.start(req).await.expect_err("refused");
    assert_eq!(error.code, ErrorCode::ReadOnlyViolation);
    assert_eq!(fx.count("imp_main").await, 0);
}

async fn statement_log(b: &Bench, fx: &Fixture, conn: &str, dir: &Path) {
    b.log.clear();
    let mut csv = String::from("id,name\n");
    for i in 1..=2500 {
        csv.push_str(&format!("{i},zz{i}zz\n"));
    }
    let path = write(dir, "log.csv", csv.as_bytes());
    let req = request(fx, conn, "imp_main", &path, &["id", "name"]);
    let done = finish(b, req).await;
    assert_eq!(
        (done.status, done.inserted),
        (ImportStatus::Done, 2500),
        "{:?}",
        done.error
    );
    let inserts: Vec<String> = b
        .log
        .entries()
        .into_iter()
        .map(|e| e.sql)
        .filter(|sql| sql.starts_with("INSERT"))
        .collect();
    assert_eq!(inserts.len(), done.batches as usize);
    assert!(inserts.len() >= 3, "{} batches", inserts.len());
    for sql in &inserts {
        assert!(sql.contains("/* import:"), "{sql}");
        assert!(!sql.contains("zz"), "no row values in the log: {sql}");
        assert!(sql.len() < 300, "compact: {sql}");
    }
    fx.clear("imp_main").await;
}

// --- Engines ---------------------------------------------------------------------------------

fn ddl(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => {
            "CREATE TABLE {s}.imp_main (id integer PRIMARY KEY, name varchar(10) NOT NULL, amount numeric(10,2), qty smallint, flag boolean, born date, seen timestamp, note text, uid uuid, doc jsonb, bin bytea);
CREATE TABLE {s}.imp_big (id integer PRIMARY KEY, a text, b integer, c numeric(12,2));
CREATE TABLE {s}.imp_ident (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL, created timestamp DEFAULT now())"
        }
        Engine::Mssql => {
            "CREATE TABLE dbo.imp_main (id int PRIMARY KEY, name nvarchar(10) NOT NULL, amount decimal(10,2), qty smallint, flag bit, born date, seen datetime2, note nvarchar(max), uid uniqueidentifier, doc nvarchar(max), bin varbinary(max));
CREATE TABLE dbo.imp_big (id int PRIMARY KEY, a nvarchar(max), b int, c decimal(12,2));
CREATE TABLE dbo.imp_ident (id int IDENTITY(1,1) PRIMARY KEY, label nvarchar(50) NOT NULL, created datetime2 DEFAULT SYSUTCDATETIME())"
        }
        Engine::Mysql => {
            "CREATE TABLE imp_main (id int PRIMARY KEY, name varchar(10) NOT NULL, amount decimal(10,2), qty smallint, flag boolean, born date, seen datetime, note text, uid char(36), doc json, bin blob) DEFAULT CHARSET utf8mb4;
CREATE TABLE imp_big (id int PRIMARY KEY, a text, b int, c decimal(12,2)) DEFAULT CHARSET utf8mb4;
CREATE TABLE imp_ident (id int AUTO_INCREMENT PRIMARY KEY, label varchar(50) NOT NULL, created timestamp DEFAULT CURRENT_TIMESTAMP)"
        }
        Engine::Sqlite => {
            "CREATE TABLE imp_main (id integer PRIMARY KEY, name varchar(10) NOT NULL, amount decimal(10,2), qty smallint, flag boolean, born date, seen timestamp, note text, uid text, doc text, bin blob);
CREATE TABLE imp_big (id integer PRIMARY KEY, a text, b integer, c decimal(12,2));
CREATE TABLE imp_ident (id integer PRIMARY KEY AUTOINCREMENT, label text NOT NULL, created timestamp DEFAULT CURRENT_TIMESTAMP)"
        }
    }
}

async fn create_tables(def: &ConnectionDefinition, password: Option<&Secret>, script: &str) {
    let conn = common::open(def, password).await.expect("connect");
    let syntax = def.engine.dialect().syntax();
    for statement in yadbe_lib::db::split::split(script, &syntax) {
        let sql = &script[statement.range()];
        conn.query(sql, 0)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
    conn.close().await;
}

fn unique_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("yadbe_m310_{}_{nanos:x}", std::process::id())
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
async fn sqlite_import() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("import.sqlite");
    let mut def = blank(Engine::Sqlite, "import.sqlite");
    def.file_path = path.display().to_string();
    rusqlite::Connection::open(&path)
        .and_then(|c| c.execute_batch(ddl(Engine::Sqlite)))
        .expect("fixture");
    let fx = Fixture {
        engine: Engine::Sqlite,
        def,
        password: None,
        database: "main".into(),
        schema: None,
    };
    suite(&fx).await;
}

#[tokio::test]
async fn postgres_import() {
    let Some(url) = pg_url("postgres_import") else {
        return;
    };
    let (mut def, password) = pg_definition(&url);
    if let Ok(ca) = std::env::var(common::PG_CA_ENV) {
        def.ca_cert_path = Some(ca);
    }
    let schema = unique_name();
    let setup = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    setup
        .query(&format!("CREATE SCHEMA \"{schema}\""), 0)
        .await
        .expect("schema");
    setup.close().await;
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: format!("DROP SCHEMA \"{schema}\" CASCADE"),
    };
    let script = ddl(Engine::Postgres).replace("{s}", &format!("\"{schema}\""));
    create_tables(&def, password.as_ref(), &script).await;
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
async fn mssql_import() {
    let Some(url) = mssql_url("mssql_import") else {
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
    create_tables(&def, password.as_ref(), ddl(Engine::Mssql)).await;
    let fx = Fixture {
        engine: Engine::Mssql,
        def,
        password,
        database: name,
        schema: Some("dbo".into()),
    };
    suite(&fx).await;
}

#[tokio::test]
async fn mysql_import() {
    let Some(url) = mysql_url("mysql_import") else {
        return;
    };
    let database = common::MysqlDatabase::create(&url, "m310").await;
    let (def, password) = database.definition();
    create_tables(&def, password.as_ref(), ddl(Engine::Mysql)).await;
    let fx = Fixture {
        engine: Engine::Mysql,
        def,
        password,
        database: database.name.clone(),
        schema: None,
    };
    suite(&fx).await;
    drop(database);
}

// --- Throughput ------------------------------------------------------------------------------

/// P-import: one million rows of a CSV file into a table, in one transaction. Prints the
/// rows per second. `cargo test --release --test import throughput -- --ignored --nocapture`
/// with the engines' URLs set; SQLite always runs.
async fn throughput(fx: &Fixture, label: &str) {
    let b = bench();
    let conn = fx.connect(&b, false).await;
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("million.csv");
    {
        let file = std::fs::File::create(&path).expect("file");
        let mut out = std::io::BufWriter::new(file);
        writeln!(out, "id,a,b,c").expect("write");
        for i in 1..=1_000_000 {
            writeln!(out, "{i},some text {i},{},{}.25", i % 1000, i % 977).expect("write");
        }
        out.flush().expect("flush");
    }
    let size = std::fs::metadata(&path).expect("meta").len();
    let req = request(
        fx,
        &conn,
        "imp_big",
        &path.display().to_string(),
        &["id", "a", "b", "c"],
    );
    let started = std::time::Instant::now();
    let done = finish(&b, req).await;
    let elapsed = started.elapsed();
    assert_eq!(
        (done.status, done.inserted),
        (ImportStatus::Done, 1_000_000),
        "{:?}",
        done.error
    );
    assert_eq!(fx.count("imp_big").await, 1_000_000);
    #[allow(clippy::cast_precision_loss)]
    {
        println!(
            "P-import {label}: 1 000 000 rows ({} MB CSV) in {:.2} s = {:.0} rows/s, {} batches",
            size / 1_000_000,
            elapsed.as_secs_f64(),
            1_000_000.0 / elapsed.as_secs_f64(),
            done.batches
        );
    }
    fx.clear("imp_big").await;
}

#[tokio::test]
#[ignore = "benchmark: 1M rows"]
async fn throughput_sqlite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("bench.sqlite");
    let mut def = blank(Engine::Sqlite, "bench.sqlite");
    def.file_path = path.display().to_string();
    rusqlite::Connection::open(&path)
        .and_then(|c| c.execute_batch(ddl(Engine::Sqlite)))
        .expect("fixture");
    let fx = Fixture {
        engine: Engine::Sqlite,
        def,
        password: None,
        database: "main".into(),
        schema: None,
    };
    throughput(&fx, "sqlite").await;
}

#[tokio::test]
#[ignore = "benchmark: 1M rows"]
async fn throughput_postgres() {
    let Some(url) = pg_url("throughput_postgres") else {
        return;
    };
    let (mut def, password) = pg_definition(&url);
    if let Ok(ca) = std::env::var(common::PG_CA_ENV) {
        def.ca_cert_path = Some(ca);
    }
    let schema = unique_name();
    let setup = common::open(&def, password.as_ref())
        .await
        .expect("connect");
    setup
        .query(&format!("CREATE SCHEMA \"{schema}\""), 0)
        .await
        .expect("schema");
    setup.close().await;
    let _guard = DropAfter {
        def: def.clone(),
        password: password
            .as_ref()
            .map(|s| Secret::new(s.expose().to_owned())),
        sql: format!("DROP SCHEMA \"{schema}\" CASCADE"),
    };
    let script = ddl(Engine::Postgres).replace("{s}", &format!("\"{schema}\""));
    create_tables(&def, password.as_ref(), &script).await;
    let fx = Fixture {
        engine: Engine::Postgres,
        database: def.database.clone(),
        def,
        password,
        schema: Some(schema),
    };
    throughput(&fx, "postgres").await;
}

#[tokio::test]
#[ignore = "benchmark: 1M rows"]
async fn throughput_mssql() {
    let Some(url) = mssql_url("throughput_mssql") else {
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
    create_tables(&def, password.as_ref(), ddl(Engine::Mssql)).await;
    let fx = Fixture {
        engine: Engine::Mssql,
        def,
        password,
        database: name,
        schema: Some("dbo".into()),
    };
    throughput(&fx, "mssql").await;
}

#[tokio::test]
#[ignore = "benchmark: 1M rows"]
async fn throughput_mysql() {
    let Some(url) = mysql_url("throughput_mysql") else {
        return;
    };
    let database = common::MysqlDatabase::create(&url, "m310b").await;
    let (def, password) = database.definition();
    create_tables(&def, password.as_ref(), ddl(Engine::Mysql)).await;
    let fx = Fixture {
        engine: Engine::Mysql,
        def,
        password,
        database: database.name.clone(),
        schema: None,
    };
    throughput(&fx, "mysql").await;
    drop(database);
}
