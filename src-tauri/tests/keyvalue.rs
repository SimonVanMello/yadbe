//! Conformance suite of the key-value family (M4-5), run against Redis and Valkey: connect
//! and authenticate (ACL user, `default` user), every type read back exactly (binary-safe),
//! `SCAN` completeness on a changing keyspace, paging of large collections, read-only refusals,
//! dangerous commands and their effect, unsupported commands, the statement timeout, secrets.
//!
//! `YADBE_TEST_REDIS_URL` / `YADBE_TEST_VALKEY_URL` (`dev/compose.yml`); unset: SKIPPED. Each
//! test works in its own database index, flushed first. `YADBE_TEST_REDIS_TLS_URL` +
//! `YADBE_TEST_REDIS_CA` add the TLS checks. `p_keyvalue_1m` (ignored) measures the explorer on a
//! keyspace of one million keys.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{driver, from_url, skip};
use yadbe_lib::db::config::TlsMode;
use yadbe_lib::db::driver::{ConnectRequest, KeyValueConnection, NoRecorder};
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::{ErrorCode, YadbeError};
use yadbe_lib::db::keyvalue::spec::KvDangerKind;
use yadbe_lib::db::keyvalue::{KvBytes, KvReply};
use yadbe_lib::db::value::Value;
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::history_hook::{HistoryEntry, HistoryRecorder};
use yadbe_lib::session::keyvalue::KeyValueService;
use yadbe_lib::session::keyvalue::model::{
    KvConsoleEntry, KvConsoleOutcome, KvKeyKind, KvLevelEntry, KvReplyView, KvScanState,
    KvScanStatus,
};
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::{ConnectionManager, ConnectionSession};
use yadbe_lib::store::Store;

const REDIS_URL_ENV: &str = "YADBE_TEST_REDIS_URL";
const VALKEY_URL_ENV: &str = "YADBE_TEST_VALKEY_URL";
const REDIS_TLS_URL_ENV: &str = "YADBE_TEST_REDIS_TLS_URL";
const REDIS_CA_ENV: &str = "YADBE_TEST_REDIS_CA";
const PASSWORD: &str = "yadbe-test-pw";

/// The servers configured, with their label.
fn servers(test: &str) -> Vec<(&'static str, String)> {
    let mut found = Vec::new();
    for (label, env) in [("redis", REDIS_URL_ENV), ("valkey", VALKEY_URL_ENV)] {
        match std::env::var(env) {
            Ok(url) if !url.trim().is_empty() => found.push((label, url)),
            _ => skip(&format!("{test} ({label})"), &format!("{env} is not set")),
        }
    }
    found
}

#[derive(Default)]
struct RecordingHistory(Mutex<Vec<HistoryEntry>>);

impl HistoryRecorder for RecordingHistory {
    fn record(&self, entry: HistoryEntry) {
        self.0.lock().expect("history").push(entry);
    }
}

struct Bench {
    log: Arc<StatementLog>,
    history: Arc<RecordingHistory>,
    manager: Arc<ConnectionManager>,
    kv: KeyValueService,
    store: Arc<ResultStore>,
    id: String,
    db: u32,
    /// A connection outside yadbe's gate, to set data up and check it.
    admin: Arc<dyn KeyValueConnection>,
}

async fn admin(url: &str, db: u32) -> Arc<dyn KeyValueConnection> {
    let (mut def, password) = from_url(url);
    def.database = db.to_string();
    let target = def.target();
    driver(Engine::Redis)
        .connect(ConnectRequest {
            target: &target,
            password: password.as_ref(),
            recorder: Arc::new(NoRecorder),
        })
        .await
        .expect("admin connection")
        .into_key_value()
        .expect("key-value")
}

fn args(parts: &[&[u8]]) -> Vec<Vec<u8>> {
    parts.iter().map(|p| p.to_vec()).collect()
}

impl Bench {
    async fn new(url: &str, db: u32, read_only: bool) -> Bench {
        let store = Arc::new(Store::open_in_memory().expect("store"));
        let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
        let sink = Arc::new(RecordingSink::default());
        let log = Arc::new(StatementLog::new(sink.clone()));
        let manager = Arc::new(ConnectionManager::new(
            Arc::clone(&store),
            secrets,
            Arc::clone(&log),
            sink.clone(),
        ));
        let (mut def, password) = from_url(url);
        def.database = db.to_string();
        def.read_only = read_only;
        let saved = store
            .create_connection(&def.normalized().expect("valid"))
            .expect("save");
        manager.connect(&saved.id, password).await.expect("connect");
        let history = Arc::new(RecordingHistory::default());
        let results = Arc::new(ResultStore::default());
        let kv = KeyValueService::new(
            Arc::clone(&manager),
            Arc::clone(&results),
            sink,
            history.clone(),
        );
        let admin = admin(url, db).await;
        admin.send(&args(&[b"FLUSHDB"])).await.expect("flush");
        Bench {
            log,
            history,
            manager,
            kv,
            store: results,
            id: saved.id,
            db,
            admin,
        }
    }

    fn session(&self) -> Arc<ConnectionSession> {
        self.manager.session(&self.id).expect("session")
    }

    async fn cmd(&self, parts: &[&[u8]]) -> KvReply {
        self.admin.send(&args(parts)).await.expect("admin command")
    }

    /// Writes many commands in batches (one round trip each).
    async fn bulk(&self, commands: Vec<Vec<Vec<u8>>>) {
        for chunk in commands.chunks(5_000) {
            for reply in self.admin.send_all(chunk).await {
                reply.expect("bulk command");
            }
        }
    }

    async fn console(&self, text: &str, confirmed: bool) -> KvConsoleOutcome {
        self.kv
            .console_run("tab-1", &self.id, text, confirmed)
            .await
            .expect("console run")
    }

    async fn ran(&self, text: &str) -> Vec<KvConsoleEntry> {
        match self.console(text, false).await {
            KvConsoleOutcome::Ran { entries, .. } => entries,
            other => panic!("expected a run, got {other:?}"),
        }
    }

    /// Polls the database's scan until `done` holds.
    async fn wait_scan(
        &self,
        pattern: Option<&str>,
        done: impl Fn(&KvScanStatus) -> bool,
    ) -> KvScanStatus {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let status = self
                .kv
                .scan_status(&self.id, self.db, pattern.map(str::to_owned))
                .expect("scan status");
            if done(&status) {
                return status;
            }
            assert!(Instant::now() < deadline, "scan stuck: {status:?}");
            assert!(
                status.state != KvScanState::Failed,
                "scan failed: {status:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Every row of a collection, after reading it all.
    async fn collection(&self, key: &KvBytes, first: u32) -> (Vec<String>, Vec<Vec<Value>>) {
        let opened = self
            .kv
            .open_collection(&self.id, self.db, key, first)
            .await
            .expect("open collection");
        let full = self
            .kv
            .collection_more(opened.result_id, None)
            .await
            .expect("read all");
        assert!(full.done);
        let result = self.store.get(full.result_id).expect("result");
        let rows = result.rows(0, result.row_count());
        let names = full.columns.iter().map(|c| c.name.clone()).collect();
        self.kv.close_collection(full.result_id);
        (names, rows)
    }

    fn logged(&self) -> Vec<String> {
        self.log.entries().into_iter().map(|e| e.sql).collect()
    }
}

fn text(value: &Value) -> String {
    match value {
        Value::Text(t) | Value::Int(t) | Value::Float(t) | Value::Json(t) | Value::Bytes(t) => {
            t.clone()
        }
        other => format!("{other:?}"),
    }
}

/// The cell a value of any bytes shows: text when UTF-8, else hexadecimal.
fn cell_of(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(t) => Value::Text(t.to_owned()),
        Err(_) => Value::bytes(bytes),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn connects_with_acl_and_default_users() {
    for (label, url) in servers("connects_with_acl_and_default_users") {
        let b = Bench::new(&url, 1, false).await;
        let version = b.session().info().server_version.unwrap_or_default();
        let product = if label == "valkey" {
            "Valkey "
        } else {
            "Redis "
        };
        assert!(version.starts_with(product), "{label}: {version}");
        assert!(
            b.logged().iter().any(|sql| sql == "INFO server"),
            "version read is logged"
        );

        // The `default` user, by password only.
        let (mut def, _) = from_url(&url);
        def.username = String::new();
        let target = def.target();
        let password = Secret::new(PASSWORD.to_owned());
        let conn = driver(Engine::Redis)
            .connect(ConnectRequest {
                target: &target,
                password: Some(&password),
                recorder: Arc::new(NoRecorder),
            })
            .await
            .expect("default user")
            .into_key_value()
            .expect("kv");
        let who = conn
            .send(&args(&[b"ACL", b"WHOAMI"]))
            .await
            .expect("whoami");
        assert_eq!(who.text().as_deref(), Some("default"), "{label}");

        // Refusals, typed, without the password anywhere.
        let wrong = Secret::new("not-the-password".to_owned());
        let refused = driver(Engine::Redis)
            .connect(ConnectRequest {
                target: &from_url(&url).0.target(),
                password: Some(&wrong),
                recorder: Arc::new(NoRecorder),
            })
            .await
            .err()
            .expect("wrong password refused");
        assert_eq!(refused.code, ErrorCode::AuthFailed, "{label}: {refused:?}");
        assert!(!format!("{refused:?}").contains("not-the-password"));
        let missing = driver(Engine::Redis)
            .connect(ConnectRequest {
                target: &target,
                password: None,
                recorder: Arc::new(NoRecorder),
            })
            .await
            .err()
            .expect("no password refused");
        assert_eq!(
            missing.code,
            ErrorCode::PasswordRequired,
            "{label}: {missing:?}"
        );
        let (mut far, password) = from_url(&url);
        far.database = "99999".into();
        let out_of_range = driver(Engine::Redis)
            .connect(ConnectRequest {
                target: &far.target(),
                password: password.as_ref(),
                recorder: Arc::new(NoRecorder),
            })
            .await
            .err()
            .expect("db out of range");
        assert_eq!(
            out_of_range.code,
            ErrorCode::UnknownDatabase,
            "{label}: {out_of_range:?}"
        );

        // The explorer's databases: the connection's own is always listed.
        b.cmd(&[b"SET", b"k", b"v"]).await;
        let databases = b.kv.databases(&b.id).await.expect("databases");
        let own = databases.iter().find(|d| d.index == 1).expect("db1");
        assert!(own.current && own.keys >= 1, "{label}: {databases:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_type_reads_back_exactly() {
    for (label, url) in servers("every_type_reads_back_exactly") {
        let b = Bench::new(&url, 2, false).await;
        let binary_key: &[u8] = b"bin:\xff\x00k";
        let binary_value: Vec<u8> = (0..=255_u8).collect();
        b.cmd(&[b"SET", binary_key, &binary_value]).await;
        b.cmd(&[b"SET", b"text", "héllo wörld".as_bytes()]).await;
        b.cmd(&[b"PEXPIRE", b"text", b"600000"]).await;
        // A string larger than a window, read in chunks.
        let big: Vec<u8> = (0..300_000_u32).map(|i| (i % 251) as u8).collect();
        b.cmd(&[b"SET", b"big", &big]).await;

        // Collections large enough to need several pages.
        let mut setup = Vec::new();
        let mut hash = BTreeMap::new();
        for i in 0..1_300_u32 {
            let field = format!("f{i:05}").into_bytes();
            let value = if i == 7 {
                vec![0xfe, 0xff]
            } else {
                format!("v{i}").into_bytes()
            };
            setup.push(vec![
                b"HSET".to_vec(),
                b"h".to_vec(),
                field.clone(),
                value.clone(),
            ]);
            hash.insert(field, value);
        }
        let mut list = Vec::new();
        for i in 0..1_234_u32 {
            let item = format!("item {i}").into_bytes();
            setup.push(vec![b"RPUSH".to_vec(), b"l".to_vec(), item.clone()]);
            list.push(item);
        }
        let mut set = BTreeSet::new();
        for i in 0..1_100_u32 {
            let member = format!("m{i}").into_bytes();
            setup.push(vec![b"SADD".to_vec(), b"s".to_vec(), member.clone()]);
            set.insert(member);
        }
        for i in 0..1_050_u32 {
            setup.push(vec![
                b"ZADD".to_vec(),
                b"z".to_vec(),
                format!("{}", f64::from(i) / 2.0).into_bytes(),
                format!("z{i:04}").into_bytes(),
            ]);
        }
        for i in 0..1_020_u32 {
            setup.push(vec![
                b"XADD".to_vec(),
                b"x".to_vec(),
                format!("{}-0", i + 1).into_bytes(),
                b"n".to_vec(),
                i.to_string().into_bytes(),
                b"who".to_vec(),
                b"ada".to_vec(),
            ]);
        }
        b.bulk(setup).await;

        // Kinds and headers.
        let key = |k: &[u8]| KvBytes::from_bytes(k);
        let info =
            b.kv.key_info(&b.id, b.db, &key(binary_key))
                .await
                .expect("info");
        assert_eq!(info.kind, KvKeyKind::String);
        assert_eq!(info.key.to_bytes().expect("bytes"), binary_key);
        assert_eq!(info.length, Some(256));
        let text_info =
            b.kv.key_info(&b.id, b.db, &key(b"text"))
                .await
                .expect("info");
        assert!(
            text_info.ttl_ms.is_some_and(|ttl| ttl > 0.0),
            "{label}: {text_info:?}"
        );
        assert!(text_info.encoding.is_some() && text_info.memory.is_some());
        for (k, kind) in [
            (b"h".as_slice(), KvKeyKind::Hash),
            (b"l", KvKeyKind::List),
            (b"s", KvKeyKind::Set),
            (b"z", KvKeyKind::Zset),
            (b"x", KvKeyKind::Stream),
            (b"nothing", KvKeyKind::Missing),
        ] {
            let info = b.kv.key_info(&b.id, b.db, &key(k)).await.expect("info");
            assert_eq!(info.kind, kind, "{label} {}", String::from_utf8_lossy(k));
        }

        // Strings, binary-safe, by windows.
        let chunk =
            b.kv.read_string(&b.id, b.db, &key(binary_key), 0, 1024)
                .await
                .expect("string");
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(chunk.base64)
            .expect("base64");
        assert_eq!(decoded, binary_value);
        let mut read = Vec::new();
        while read.len() < big.len() {
            let window =
                b.kv.read_string(&b.id, b.db, &key(b"big"), read.len() as u64, 128 * 1024)
                    .await
                    .expect("window");
            assert_eq!(window.total as usize, big.len());
            read.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(window.base64)
                    .expect("b64"),
            );
        }
        assert_eq!(read, big, "{label}: windows join up");

        // Collections, paged, every element exactly once.
        let (columns, rows) = b.collection(&key(b"h"), 100).await;
        assert_eq!(columns, ["field", "value"]);
        let got: BTreeMap<String, Value> = rows
            .into_iter()
            .map(|r| (text(&r[0]), r[1].clone()))
            .collect();
        let want: BTreeMap<String, Value> = hash
            .iter()
            .map(|(f, v)| (text(&cell_of(f)), cell_of(v)))
            .collect();
        assert_eq!(got.len(), want.len(), "{label}: hash size");
        assert!(got == want, "{label}: hash content");

        let (columns, rows) = b.collection(&key(b"l"), 10).await;
        assert_eq!(columns, ["index", "value"]);
        assert_eq!(rows.len(), list.len());
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(row[0], Value::int(i));
            assert_eq!(row[1], cell_of(&list[i]));
        }

        let (_, rows) = b.collection(&key(b"s"), 10).await;
        let got: BTreeSet<String> = rows.iter().map(|r| text(&r[0])).collect();
        let want: BTreeSet<String> = set
            .iter()
            .map(|m| String::from_utf8_lossy(m).into_owned())
            .collect();
        assert_eq!(got, want, "{label}: set");

        let (columns, rows) = b.collection(&key(b"z"), 10).await;
        assert_eq!(columns, ["rank", "member", "score"]);
        assert_eq!(rows.len(), 1_050);
        assert_eq!(
            rows[3],
            vec![
                Value::int(3),
                Value::Text("z0003".into()),
                Value::float(1.5)
            ]
        );

        let (columns, rows) = b.collection(&key(b"x"), 10).await;
        assert_eq!(columns, ["id", "fields"]);
        assert_eq!(rows.len(), 1_020);
        assert_eq!(rows[0][0], Value::Text("1-0".into()));
        let fields: serde_json::Value = serde_json::from_str(&text(&rows[1019][1])).expect("json");
        assert_eq!(fields, serde_json::json!({ "n": "1019", "who": "ada" }));

        // RedisJSON: a document where the module is, unknown elsewhere.
        let json_module = b
            .admin
            .send(&args(&[
                b"JSON.SET",
                b"doc",
                b"$",
                br#"{"a":[1,2,{"b":null}],"c":"d"}"#,
            ]))
            .await
            .is_ok();
        let info =
            b.kv.key_info(&b.id, b.db, &key(b"doc"))
                .await
                .expect("info");
        if json_module {
            assert_eq!(info.kind, KvKeyKind::Json, "{label}");
            let doc =
                b.kv.read_json(&b.id, b.db, &key(b"doc"))
                    .await
                    .expect("json");
            let parsed: serde_json::Value = serde_json::from_str(&doc).expect("valid json");
            assert_eq!(
                parsed,
                serde_json::json!({ "a": [1, 2, { "b": null }], "c": "d" })
            );
        } else {
            assert!(!info.json_module);
            assert_eq!(
                info.kind,
                KvKeyKind::Missing,
                "{label}: no module, no document"
            );
        }

        // Summaries of rows on screen.
        let summaries =
            b.kv.key_summaries(&b.id, b.db, vec![key(b"h"), key(b"text"), key(b"nothing")])
                .await
                .expect("summaries");
        assert_eq!(summaries[0].kind, KvKeyKind::Hash);
        assert!(summaries[0].memory.is_some_and(|m| m > 0.0));
        assert!(summaries[1].ttl_ms.is_some());
        assert_eq!(summaries[2].kind, KvKeyKind::Missing);
        assert!(!b.logged().iter().any(|sql| sql.starts_with("KEYS")));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn scans_every_key_in_batches_and_groups_them() {
    for (label, url) in servers("scans_every_key_in_batches_and_groups_them") {
        let b = Bench::new(&url, 3, false).await;
        let mut setup = Vec::new();
        for i in 0..24_000_u32 {
            let key = match i % 3 {
                0 => format!("user:{i}:name"),
                1 => format!("session:{i}"),
                _ => format!("plain{i}"),
            };
            setup.push(vec![b"SET".to_vec(), key.into_bytes(), b"1".to_vec()]);
        }
        b.bulk(setup).await;

        let paused = b.wait_scan(None, |s| s.state == KvScanState::Paused).await;
        assert!(
            paused.loaded >= 10_000 && paused.loaded < 24_000,
            "{label}: {paused:?}"
        );
        assert_eq!(paused.estimate, Some(24_000));
        b.kv.scan_more(&b.id, b.db, None).expect("more");
        let done = b.wait_scan(None, |s| s.state == KvScanState::Done).await;
        assert_eq!(done.loaded, 24_000, "{label}");

        let root =
            b.kv.scan_level(&b.id, b.db, &KvBytes::text(""), ":", 0, 10)
                .expect("root");
        assert_eq!(
            root.total,
            2 + 8_000,
            "{label}: two namespaces and the plain keys"
        );
        match &root.entries[0] {
            KvLevelEntry::Namespace { name, keys, .. } => {
                assert_eq!(name.text, "session");
                assert_eq!(*keys, 8_000);
            }
            other => panic!("{other:?}"),
        }
        let users =
            b.kv.scan_level(&b.id, b.db, &KvBytes::text("user:"), ":", 0, 5)
                .expect("users");
        assert_eq!(users.total, 8_000);
        assert!(matches!(&users.entries[0], KvLevelEntry::Namespace { keys, .. } if *keys == 1));

        // A MATCH pattern starts another scan of the same database.
        let matched = b
            .wait_scan(Some("session:1*"), |s| s.state == KvScanState::Done)
            .await;
        assert_eq!(matched.pattern.as_deref(), Some("session:1*"));
        let expected = (0..24_000_u32)
            .filter(|i| i % 3 == 1 && i.to_string().starts_with('1'))
            .count();
        assert_eq!(matched.loaded as usize, expected, "{label}");

        // Stop between batches, then go on.
        b.kv.scan_restart(&b.id, b.db).expect("restart");
        let restarted = b.kv.scan_stop(&b.id, b.db).expect("stop");
        let stopped = b
            .wait_scan(restarted.pattern.as_deref(), |s| {
                matches!(s.state, KvScanState::Stopped | KvScanState::Done)
            })
            .await;
        assert!(stopped.scan_id > done.scan_id);
        let log = b.logged();
        assert!(
            log.iter()
                .any(|sql| sql.starts_with("SCAN 0") && sql.contains("COUNT 1000")),
            "{log:?}"
        );
        assert!(
            !log.iter().any(|sql| sql.starts_with("KEYS")),
            "yadbe never sends KEYS"
        );
    }
}

#[tokio::test]
async fn finds_scanned_keys_and_lists_the_server_commands() {
    for (label, url) in servers("finds_scanned_keys_and_lists_the_server_commands") {
        let b = Bench::new(&url, 3, false).await;
        b.bulk(
            ["User:1", "user:2", "order:7", "session:user:9"]
                .iter()
                .map(|key| vec![b"SET".to_vec(), key.as_bytes().to_vec(), b"1".to_vec()])
                .collect(),
        )
        .await;
        b.wait_scan(None, |s| s.state == KvScanState::Done).await;
        let found = b.kv.find_keys(&b.id, b.db, "USER", 10).expect("find");
        let names: Vec<String> = found.keys.iter().map(|k| k.text.clone()).collect();
        assert_eq!(names, ["User:1", "session:user:9", "user:2"], "{label}");
        assert_eq!(found.scanned, 4, "{label}");
        let limited = b.kv.find_keys(&b.id, b.db, "user", 1).expect("find");
        assert_eq!(limited.keys.len(), 1, "{label}");

        let hints = b.kv.command_hints(&b.id).await.expect("hints");
        let get = hints.iter().find(|h| h.name == "get").expect("GET listed");
        assert_eq!(get.arity, 2, "{label}");
        let del = hints.iter().find(|h| h.name == "del").expect("DEL listed");
        assert!(del.arity < 0, "{label}: at least one key");
        assert!(hints.iter().all(|h| !h.name.contains('|')), "{label}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn scan_is_complete_on_a_changing_keyspace() {
    for (label, url) in servers("scan_is_complete_on_a_changing_keyspace") {
        let b = Bench::new(&url, 4, false).await;
        let stable: Vec<Vec<u8>> = (0..30_000_u32)
            .map(|i| format!("stable:{i}").into_bytes())
            .collect();
        b.bulk(
            stable
                .iter()
                .map(|k| vec![b"SET".to_vec(), k.clone(), b"x".to_vec()])
                .collect(),
        )
        .await;
        b.kv.scan_status(&b.id, b.db, None).expect("start");
        b.kv.scan_more(&b.id, b.db, None).expect("all");
        // Keys come and go while the scan runs (rehashing included).
        let churn = admin(&url, b.db).await;
        let churner = tokio::spawn(async move {
            for round in 0..40_u32 {
                let adds: Vec<Vec<Vec<u8>>> = (0..500_u32)
                    .map(|i| {
                        vec![
                            b"SET".to_vec(),
                            format!("churn:{round}:{i}").into_bytes(),
                            b"y".to_vec(),
                        ]
                    })
                    .collect();
                for reply in churn.send_all(&adds).await {
                    reply.expect("add");
                }
                if round > 0 {
                    let dels: Vec<Vec<Vec<u8>>> = (0..500_u32)
                        .map(|i| {
                            vec![
                                b"DEL".to_vec(),
                                format!("churn:{}:{i}", round - 1).into_bytes(),
                            ]
                        })
                        .collect();
                    for reply in churn.send_all(&dels).await {
                        reply.expect("del");
                    }
                }
            }
        });
        let done = b.wait_scan(None, |s| s.state == KvScanState::Done).await;
        churner.await.expect("churn");
        // Every key present for the whole scan was found (SCAN's guarantee), once.
        let level =
            b.kv.scan_level(&b.id, b.db, &KvBytes::text("stable:"), ":", 0, 50_000)
                .expect("level");
        assert_eq!(level.total, 30_000, "{label}: {done:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_refuses_writes_scripts_and_unknown_commands() {
    for (label, url) in servers("read_only_refuses_writes_scripts_and_unknown_commands") {
        let b = Bench::new(&url, 5, true).await;
        b.cmd(&[b"SET", b"k", b"v"]).await;
        for line in [
            "SET k other",
            "DEL k",
            "EVAL \"return 1\" 0",
            "EVALSHA abcdef 0",
            "FCALL f 0",
            "SCRIPT LOAD \"return 1\"",
            "FUNCTION LIST",
            "CONFIG SET maxmemory 0",
            "PUBLISH channel hi",
            "NOSUCHCOMMAND x",
            "SHUTDOWN NOSAVE",
            "FLUSHDB",
        ] {
            let outcome = b.console(line, true).await;
            let KvConsoleOutcome::Ran { entries, .. } = outcome else {
                panic!("{label} {line}: ran expected");
            };
            let error = entries[0]
                .error
                .as_ref()
                .unwrap_or_else(|| panic!("{label}: {line} refused"));
            assert_eq!(
                error.code,
                ErrorCode::ReadOnlyViolation,
                "{label} {line}: {error:?}"
            );
        }
        assert_eq!(
            b.cmd(&[b"GET", b"k"]).await.text().as_deref(),
            Some("v"),
            "nothing changed"
        );
        for line in [
            "GET k",
            "INFO keyspace",
            "CONFIG GET maxmemory",
            "TYPE k",
            "SCAN 0",
            "PING",
        ] {
            let entries = b.ran(line).await;
            assert!(
                entries[0].error.is_none(),
                "{label} {line}: {:?}",
                entries[0].error
            );
        }
        // Refusals go to the history like the rest.
        assert!(
            b.history
                .0
                .lock()
                .expect("history")
                .iter()
                .any(|e| e.sql == "SET k other" && e.outcome.is_err())
        );

        // Read-only turned on under an open read-write session applies at once.
        let rw = Bench::new(&url, 6, false).await;
        assert!(rw.ran("SET a 1").await[0].error.is_none());
        rw.session()
            .set_read_only(true)
            .await
            .expect("read-only on");
        let refused = rw.ran("SET a 2").await;
        assert_eq!(
            refused[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::ReadOnlyViolation)
        );
        rw.session()
            .set_read_only(false)
            .await
            .expect("read-only off");
        assert!(rw.ran("SET a 3").await[0].error.is_none());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dangerous_commands_are_confirmed_with_their_effect() {
    for (label, url) in servers("dangerous_commands_are_confirmed_with_their_effect") {
        let b = Bench::new(&url, 7, false).await;
        b.bulk(
            (0..42_u32)
                .map(|i| vec![b"SET".to_vec(), format!("k{i}").into_bytes(), b"v".to_vec()])
                .collect(),
        )
        .await;
        let KvConsoleOutcome::NeedsConfirmation { dangers } =
            b.console("PING\nFLUSHDB", false).await
        else {
            panic!("{label}: FLUSHDB needs a confirmation");
        };
        assert_eq!(dangers.len(), 1);
        assert_eq!(dangers[0].line, 1);
        assert_eq!(dangers[0].kind, KvDangerKind::FlushDb);
        assert!(
            dangers[0].effect.en.contains("42 keys"),
            "{:?}",
            dangers[0].effect
        );
        assert_eq!(b.cmd(&[b"DBSIZE"]).await.int(), Some(42), "nothing ran");

        let KvConsoleOutcome::NeedsConfirmation { dangers } = b.console("KEYS *", false).await
        else {
            panic!("KEYS needs a confirmation");
        };
        assert_eq!(dangers[0].kind, KvDangerKind::Keys);
        let many: Vec<String> = (0..12).map(|i| format!("k{i}")).collect();
        let del = format!("DEL {} missing1", many.join(" "));
        let KvConsoleOutcome::NeedsConfirmation { dangers } = b.console(&del, false).await else {
            panic!("DEL of many keys needs a confirmation");
        };
        assert_eq!(dangers[0].kind, KvDangerKind::DeleteMany { keys: 13 });
        assert!(
            dangers[0].effect.en.contains("12 of them exist"),
            "{:?}",
            dangers[0].effect
        );
        let KvConsoleOutcome::NeedsConfirmation { dangers } =
            b.console("CONFIG SET maxmemory-samples 7", false).await
        else {
            panic!("CONFIG SET needs a confirmation");
        };
        assert!(
            dangers[0].effect.en.contains("maxmemory-samples: 5 → 7"),
            "{:?}",
            dangers[0].effect
        );

        // Confirmed, they run.
        let KvConsoleOutcome::Ran { entries, .. } = b.console("FLUSHDB", true).await else {
            panic!("ran");
        };
        assert!(entries[0].error.is_none());
        assert_eq!(b.cmd(&[b"DBSIZE"]).await.int(), Some(0), "{label}");
        let probes = b.logged();
        assert!(
            probes.iter().any(|sql| sql == "DBSIZE"),
            "the effect probe is logged"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn console_runs_lines_as_typed_and_shapes_replies() {
    for (label, url) in servers("console_runs_lines_as_typed_and_shapes_replies") {
        let b = Bench::new(&url, 8, false).await;
        let text = "SET \"sp ace\" \"a\\x00b\"\n# a comment\n\nGET \"sp ace\"\nHSET h f1 v1 f2 v2\nHGETALL h\nRPUSH l a b c\nLRANGE l 0 -1\nZADD z 1 m1 2 m2\nZRANGE z 0 -1 WITHSCORES\nXADD x 1-0 a 1\nXRANGE x - +\nGET missing\nSELECT 9\nDBSIZE";
        let KvConsoleOutcome::Ran {
            entries,
            database,
            skipped,
        } = b.console(text, false).await
        else {
            panic!("ran");
        };
        assert_eq!(skipped, 0);
        assert_eq!(database, 9, "{label}: SELECT moves the console");
        assert_eq!(entries.len(), 13);
        assert!(entries.iter().all(|e| e.error.is_none()), "{entries:?}");
        assert_eq!(entries[1].line, 3);
        match &entries[1].reply {
            Some(KvReplyView::Scalar { value, .. }) => {
                assert_eq!(value.to_bytes().expect("bytes"), b"a\x00b", "binary bulk");
            }
            other => panic!("{other:?}"),
        }
        assert!(
            matches!(&entries[3].reply, Some(KvReplyView::Grid { columns, row_count, .. }) if columns[0].name == "field" && *row_count == 2),
            "{:?}",
            entries[3].reply
        );
        assert!(
            matches!(&entries[5].reply, Some(KvReplyView::Grid { row_count, .. }) if *row_count == 3)
        );
        assert!(
            matches!(&entries[7].reply, Some(KvReplyView::Grid { .. })),
            "{:?}",
            entries[7].reply
        );
        assert!(
            matches!(&entries[9].reply, Some(KvReplyView::Tree { .. })),
            "{:?}",
            entries[9].reply
        );
        assert_eq!(entries[10].reply, Some(KvReplyView::Nil));
        assert_eq!(entries[12].database, 9);
        // The history has every command, as typed.
        let history: Vec<String> = b
            .history
            .0
            .lock()
            .expect("h")
            .iter()
            .map(|e| e.sql.clone())
            .collect();
        assert!(
            history.contains(&"SET \"sp ace\" \"a\\x00b\"".to_owned()),
            "{history:?}"
        );

        // A server error stops the run; unbalanced quotes run nothing.
        let KvConsoleOutcome::Ran {
            entries, skipped, ..
        } = b.console("SET s v\nHGET s f\nPING", false).await
        else {
            panic!("ran");
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(skipped, 1);
        assert!(
            entries[1]
                .error
                .as_ref()
                .and_then(|e| e.detail.as_deref())
                .is_some_and(|d| d.contains("WRONGTYPE"))
        );
        let KvConsoleOutcome::Ran { entries, .. } = b.console("PING\nSET \"open", false).await
        else {
            panic!("ran");
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::InvalidArgument)
        );

        // Streaming and blocking commands are not supported yet.
        for line in [
            "MONITOR",
            "SUBSCRIBE ch",
            "PSUBSCRIBE c*",
            "BLPOP l 1",
            "XREAD BLOCK 10 STREAMS x $",
        ] {
            let entries = b.ran(line).await;
            assert_eq!(
                entries[0].error.as_ref().map(|e| e.code),
                Some(ErrorCode::NotSupported),
                "{label} {line}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn statement_timeout_stops_waiting() {
    for (label, url) in servers("statement_timeout_stops_waiting") {
        let b = Bench::new(&url, 10, false).await;
        b.session()
            .set_statement_timeout(Some(Duration::from_secs(1)));
        // Writes wait while clients are paused for writes; reads go on.
        b.cmd(&[b"CLIENT", b"PAUSE", b"2500", b"WRITE"]).await;
        let started = Instant::now();
        let entries = b.ran("SET slow 1").await;
        let elapsed = started.elapsed();
        assert_eq!(
            entries[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::StatementTimeout),
            "{label}: {entries:?}"
        );
        assert!(
            elapsed < Duration::from_millis(2_000),
            "{label}: {elapsed:?}"
        );
        b.cmd(&[b"CLIENT", b"UNPAUSE"]).await;
        b.session().set_statement_timeout(None);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn secrets_never_reach_logs_history_or_errors() {
    for (label, url) in servers("secrets_never_reach_logs_history_or_errors") {
        let b = Bench::new(&url, 11, false).await;
        let lines = format!(
            "AUTH yadbe {PASSWORD}\nHELLO 3 AUTH yadbe {PASSWORD}\nAUTH yadbe wrong-{PASSWORD}"
        );
        let KvConsoleOutcome::Ran { entries, .. } = b.console(&lines, false).await else {
            panic!("ran");
        };
        assert!(
            entries.iter().all(|e| !e.command.contains(PASSWORD)),
            "{entries:?}"
        );
        assert!(
            entries
                .iter()
                .all(|e| !format!("{:?}", e.error).contains(PASSWORD))
        );
        let history = b.history.0.lock().expect("h").clone();
        assert!(!history.is_empty());
        for entry in &history {
            assert!(!entry.sql.contains(PASSWORD), "{label}: {}", entry.sql);
            assert!(!format!("{:?}", entry.outcome).contains(PASSWORD));
        }
        for sql in b.logged() {
            assert!(!sql.contains(PASSWORD), "{label}: {sql}");
        }
        let (def, _) = from_url(&url);
        assert!(
            !format!("{def:?}").contains(PASSWORD),
            "the definition holds no secret"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn tls_with_the_dev_ca() {
    let (Ok(url), Ok(ca)) = (
        std::env::var(REDIS_TLS_URL_ENV),
        std::env::var(REDIS_CA_ENV),
    ) else {
        skip(
            "tls_with_the_dev_ca",
            &format!("{REDIS_TLS_URL_ENV} or {REDIS_CA_ENV} is not set"),
        );
        return;
    };
    let (mut def, password) = from_url(&url);
    assert_eq!(def.tls_mode, TlsMode::VerifyFull);
    def.ca_cert_path = Some(ca);
    let target = def.target();
    let conn = driver(Engine::Redis)
        .connect(ConnectRequest {
            target: &target,
            password: password.as_ref(),
            recorder: Arc::new(NoRecorder),
        })
        .await
        .expect("TLS with the dev CA")
        .into_key_value()
        .expect("kv");
    assert_eq!(
        conn.send(&args(&[b"PING"]))
            .await
            .expect("ping")
            .text()
            .as_deref(),
        Some("PONG")
    );
    // The OS trust store does not know the dev CA.
    def.ca_cert_path = None;
    let refused: YadbeError = driver(Engine::Redis)
        .connect(ConnectRequest {
            target: &def.target(),
            password: password.as_ref(),
            recorder: Arc::new(NoRecorder),
        })
        .await
        .err()
        .expect("unknown CA refused");
    assert_eq!(refused.code, ErrorCode::TlsFailed, "{refused:?}");
}

/// P (explorer on a large keyspace): one million keys, listed by the explorer's scan, then the
/// levels the tree reads. `cargo test --test keyvalue p_keyvalue_1m -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "measurement: fills a database with one million keys"]
async fn p_keyvalue_1m() {
    for (label, url) in servers("p_keyvalue_1m") {
        let b = Bench::new(&url, 12, false).await;
        let fill = Instant::now();
        let mut batch = Vec::with_capacity(10_000);
        for i in 0..1_000_000_u32 {
            let key = format!("app:{}:user:{i}", i % 20);
            batch.push(vec![b"SET".to_vec(), key.into_bytes(), b"1".to_vec()]);
            if batch.len() == 10_000 {
                b.bulk(std::mem::take(&mut batch)).await;
            }
        }
        println!("{label}: filled 1M keys in {:?}", fill.elapsed());

        let started = Instant::now();
        let first = b.wait_scan(None, |s| s.state == KvScanState::Paused).await;
        println!(
            "{label}: first {} keys (pause) in {:?}",
            first.loaded,
            started.elapsed()
        );
        let level = Instant::now();
        let root =
            b.kv.scan_level(&b.id, b.db, &KvBytes::text(""), ":", 0, 1000)
                .expect("root");
        println!(
            "{label}: root level at {} keys: {:?}",
            first.loaded,
            level.elapsed()
        );
        assert_eq!(root.total, 1);

        let all = Instant::now();
        b.kv.scan_more(&b.id, b.db, None).expect("all");
        let done = b.wait_scan(None, |s| s.state == KvScanState::Done).await;
        println!("{label}: all {} keys in {:?}", done.loaded, all.elapsed());
        assert_eq!(done.loaded, 1_000_000);

        for (prefix, what) in [
            ("", "root"),
            ("app:", "app (20 namespaces)"),
            ("app:3:user:", "app:3:user (50k keys)"),
        ] {
            let t = Instant::now();
            let page =
                b.kv.scan_level(&b.id, b.db, &KvBytes::text(prefix), ":", 0, 1000)
                    .expect("level");
            let first = t.elapsed();
            let t = Instant::now();
            b.kv.scan_level(&b.id, b.db, &KvBytes::text(prefix), ":", 49_000, 1000)
                .expect("deep page");
            println!(
                "{label}: level {what}: total {}, first page {first:?}, page at 49 000 {:?}",
                page.total,
                t.elapsed()
            );
        }
        let keys: Vec<KvBytes> = (0..60)
            .map(|i| KvBytes::text(format!("app:3:user:{}", 3 + 20 * i)))
            .collect();
        let t = Instant::now();
        let summaries =
            b.kv.key_summaries(&b.id, b.db, keys)
                .await
                .expect("summaries");
        println!("{label}: summaries of 60 visible keys: {:?}", t.elapsed());
        assert!(summaries.iter().all(|s| s.kind == KvKeyKind::String));
        b.cmd(&[b"FLUSHDB"]).await;
    }
}
