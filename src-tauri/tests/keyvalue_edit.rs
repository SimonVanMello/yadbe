//! Key-value edits (M4-6), run against Redis and Valkey: every edit kind checked against the
//! resulting server state, its journal entry and a revert that brings the exact previous
//! state back (deleted keys with their expiry included); conflicts per type (nothing applied,
//! other keys of the change set included); revert conflicts; binary-safe keys and values;
//! read-only refusals; dangerous changes confirmed; the explorer following created and
//! deleted keys; a namespace of 100 000 keys deleted by batches and restored.
//!
//! `YADBE_TEST_REDIS_URL` / `YADBE_TEST_VALKEY_URL` (`dev/compose.yml`); unset: SKIPPED. Each
//! test works in its own database index, flushed first.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{driver, from_url, skip};
use yadbe_lib::db::driver::{ConnectRequest, KeyValueConnection, NoRecorder};
use yadbe_lib::db::engine::{Engine, EngineFamily};
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::keyvalue::edit::{
    KvChangeSet, KvConflictKind, KvEdit, KvField, KvNewValue, KvScored, KvTtl,
};
use yadbe_lib::db::keyvalue::{KvBytes, KvReply};
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::history_hook::NoHistory;
use yadbe_lib::session::journal::ChangeJournal;
use yadbe_lib::session::keyvalue::KeyValueService;
use yadbe_lib::session::keyvalue::edit::{KvApplyOutcome, KvEditDangerKind};
use yadbe_lib::session::keyvalue::model::{KvLevelEntry, KvScanState};
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::{JournalQuery, JournalTargetKind, Store};

const REDIS_URL_ENV: &str = "YADBE_TEST_REDIS_URL";
const VALKEY_URL_ENV: &str = "YADBE_TEST_VALKEY_URL";

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

fn t(text: &str) -> KvBytes {
    KvBytes::text(text)
}

fn b(bytes: &[u8]) -> KvBytes {
    KvBytes::from_bytes(bytes)
}

fn args(parts: &[&[u8]]) -> Vec<Vec<u8>> {
    parts.iter().map(|p| p.to_vec()).collect()
}

struct Bench {
    log: Arc<StatementLog>,
    store: Arc<Store>,
    kv: KeyValueService,
    id: String,
    db: u32,
    admin: Arc<dyn KeyValueConnection>,
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
        let journal = Arc::new(ChangeJournal::new(Arc::clone(&store), sink.clone()));
        let kv = KeyValueService::new(
            Arc::clone(&manager),
            Arc::new(ResultStore::default()),
            sink,
            Arc::new(NoHistory),
        )
        .with_journal(journal);
        let (mut admin_def, password) = from_url(url);
        admin_def.database = db.to_string();
        let target = admin_def.target();
        let admin = driver(Engine::Redis)
            .connect(ConnectRequest {
                target: &target,
                password: password.as_ref(),
                recorder: Arc::new(NoRecorder),
            })
            .await
            .expect("admin connection")
            .into_key_value()
            .expect("key-value");
        admin.send(&args(&[b"FLUSHDB"])).await.expect("flush");
        Bench {
            log,
            store,
            kv,
            id: saved.id,
            db,
            admin,
        }
    }

    async fn cmd(&self, parts: &[&[u8]]) -> KvReply {
        self.admin.send(&args(parts)).await.expect("admin command")
    }

    async fn json_module(&self) -> bool {
        matches!(
            self.cmd(&[b"COMMAND", b"INFO", b"json.get"]).await.items(),
            Some([KvReply::Array(_), ..])
        )
    }

    fn set(&self, edits: Vec<KvEdit>) -> KvChangeSet {
        KvChangeSet {
            database: self.db,
            edits,
        }
    }

    async fn apply(&self, edits: Vec<KvEdit>, confirmed: bool) -> KvApplyOutcome {
        self.kv
            .apply_changes(&self.id, &self.set(edits), confirmed)
            .await
            .expect("apply")
    }

    /// Applies and returns the journal entry, asserting that it applied and can be reverted.
    async fn applied(&self, edits: Vec<KvEdit>) -> u32 {
        match self.apply(edits, true).await {
            KvApplyOutcome::Applied {
                journal_id: Some(id),
                revertible: true,
                ..
            } => id,
            other => panic!("expected an applied, revertible change, got {other:?}"),
        }
    }

    async fn revert(&self, entry: u32) {
        match self.kv.apply_revert(&self.id, entry).await.expect("revert") {
            KvApplyOutcome::Applied { .. } => {}
            other => panic!("expected the revert to apply, got {other:?}"),
        }
        let detail = self
            .store
            .journal_entry(entry)
            .expect("journal")
            .expect("entry");
        assert!(
            detail.entry.reverted_by.is_some(),
            "entry {entry} marked reverted"
        );
    }

    /// Everything a key holds, canonical (unordered collections sorted), with its expiry.
    async fn state(&self, key: &[u8]) -> String {
        let kind = self.cmd(&[b"TYPE", key]).await.text().unwrap_or_default();
        let expiry = self.cmd(&[b"PEXPIRETIME", key]).await.int().unwrap_or(-3);
        let flat = |reply: KvReply| -> Vec<String> {
            reply
                .into_items()
                .unwrap_or_default()
                .iter()
                .map(|r| format!("{:?}", r.bytes()))
                .collect()
        };
        let content = match kind.as_str() {
            "string" => format!("{:?}", self.cmd(&[b"GET", key]).await.bytes()),
            "hash" => {
                let mut pairs: Vec<String> = self
                    .cmd(&[b"HGETALL", key])
                    .await
                    .into_pairs()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(f, v)| format!("{:?}={:?}", f.bytes(), v.bytes()))
                    .collect();
                pairs.sort();
                pairs.join(",")
            }
            "list" => flat(self.cmd(&[b"LRANGE", key, b"0", b"-1"]).await).join(","),
            "set" => {
                let mut members = flat(self.cmd(&[b"SMEMBERS", key]).await);
                members.sort();
                members.join(",")
            }
            "zset" => format!(
                "{:?}",
                self.cmd(&[b"ZRANGE", key, b"0", b"-1", b"WITHSCORES"])
                    .await
            ),
            "stream" => format!("{:?}", self.cmd(&[b"XRANGE", key, b"-", b"+"]).await),
            "ReJSON-RL" => format!("{:?}", self.cmd(&[b"JSON.GET", key]).await.text()),
            other => other.to_owned(),
        };
        format!("{kind}|{expiry}|{content}")
    }

    async fn states(&self, keys: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        for key in keys {
            out.push(self.state(key).await);
        }
        out
    }
}

fn conflicts(outcome: KvApplyOutcome) -> Vec<(u32, KvConflictKind)> {
    match outcome {
        KvApplyOutcome::Conflicted { conflicts } => {
            conflicts.into_iter().map(|c| (c.edit, c.kind)).collect()
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
}

/// Applies, checks the result, reverts, checks the state is back exactly.
async fn round_trip(
    bench: &Bench,
    keys: &[&[u8]],
    edits: Vec<KvEdit>,
    check: impl AsyncFnOnce(&Bench),
) {
    let before = bench.states(keys).await;
    let entry = bench.applied(edits).await;
    check(bench).await;
    assert_ne!(
        bench.states(keys).await,
        before,
        "the apply changed something"
    );
    bench.revert(entry).await;
    assert_eq!(
        bench.states(keys).await,
        before,
        "the revert restored the keys"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn strings_hashes_and_ttls_change_and_revert_exactly() {
    for (label, url) in servers("strings_hashes_and_ttls_change_and_revert_exactly") {
        let bench = Bench::new(&url, 1, false).await;
        bench.cmd(&[b"SET", b"s", b"v1", b"PX", b"600000"]).await;
        round_trip(
            &bench,
            &[b"s"],
            vec![KvEdit::StringSet {
                key: t("s"),
                original: Some(t("v1")),
                value: t("v2"),
            }],
            async |b| {
                assert_eq!(b.cmd(&[b"GET", b"s"]).await.bytes(), Some(b"v2".to_vec()));
                // KEEPTTL: the expiry is untouched.
                assert!(b.cmd(&[b"PTTL", b"s"]).await.int().unwrap_or(-1) > 0);
            },
        )
        .await;

        // Binary-safe key and value.
        let key = [0xff_u8, 0, b'k'];
        bench.cmd(&[b"SET", &key, &[0, 0xff, 1]]).await;
        round_trip(
            &bench,
            &[&key],
            vec![KvEdit::StringSet {
                key: b(&key),
                original: Some(b(&[0, 0xff, 1])),
                value: b(&[0xfe, b'"', b'\\']),
            }],
            async |b| {
                assert_eq!(
                    b.cmd(&[b"GET", &key]).await.bytes(),
                    Some(vec![0xfe, b'"', b'\\'])
                );
            },
        )
        .await;

        bench
            .cmd(&[
                b"HSET", b"h", b"name", b"Ada", b"plan", b"free", b"old", b"x",
            ])
            .await;
        round_trip(
            &bench,
            &[b"h"],
            vec![
                KvEdit::HashSet {
                    key: t("h"),
                    field: t("name"),
                    original: Some(t("Ada")),
                    value: t("Ada L."),
                },
                KvEdit::HashSet {
                    key: t("h"),
                    field: t("city"),
                    original: None,
                    value: t("London"),
                },
                KvEdit::HashDelete {
                    key: t("h"),
                    field: t("old"),
                    original: t("x"),
                },
                KvEdit::HashRename {
                    key: t("h"),
                    field: t("plan"),
                    to: t("tier"),
                    value: t("free"),
                },
            ],
            async |b| {
                let mut fields: Vec<(Vec<u8>, Vec<u8>)> = b
                    .cmd(&[b"HGETALL", b"h"])
                    .await
                    .into_pairs()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(f, v)| (f.bytes().unwrap_or_default(), v.bytes().unwrap_or_default()))
                    .collect();
                fields.sort();
                assert_eq!(
                    fields,
                    [
                        (b"city".to_vec(), b"London".to_vec()),
                        (b"name".to_vec(), b"Ada L.".to_vec()),
                        (b"tier".to_vec(), b"free".to_vec()),
                    ],
                    "{label}"
                );
            },
        )
        .await;

        bench.cmd(&[b"SET", b"p", b"1"]).await;
        bench.cmd(&[b"SET", b"e", b"1", b"PX", b"900000"]).await;
        let expire = bench
            .cmd(&[b"PEXPIRETIME", b"e"])
            .await
            .int()
            .expect("expiry");
        round_trip(
            &bench,
            &[b"p", b"e"],
            vec![
                KvEdit::Expire {
                    key: t("p"),
                    original: None,
                    ttl: KvTtl::In { ms: 60_000.0 },
                },
                KvEdit::Expire {
                    key: t("e"),
                    original: Some(expire as f64),
                    ttl: KvTtl::Persist,
                },
            ],
            async |b| {
                let ttl = b.cmd(&[b"PTTL", b"p"]).await.int().expect("ttl");
                assert!((1..=60_000).contains(&ttl), "{ttl}");
                assert_eq!(b.cmd(&[b"PTTL", b"e"]).await.int(), Some(-1));
            },
        )
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_sets_sorted_sets_and_streams_change_and_revert_exactly() {
    for (label, url) in servers("lists_sets_sorted_sets_and_streams_change_and_revert_exactly") {
        let bench = Bench::new(&url, 2, false).await;
        // Remove by index: the second "b" goes, not the first.
        bench
            .cmd(&[b"RPUSH", b"l", b"a", b"b", b"c", b"b", b"d"])
            .await;
        round_trip(
            &bench,
            &[b"l"],
            vec![
                KvEdit::ListSet {
                    key: t("l"),
                    index: 0,
                    original: t("a"),
                    value: t("A"),
                },
                KvEdit::ListRemove {
                    key: t("l"),
                    index: 3,
                    original: t("b"),
                },
                KvEdit::ListPush {
                    key: t("l"),
                    head: true,
                    values: vec![t("x")],
                },
                KvEdit::ListPush {
                    key: t("l"),
                    head: false,
                    values: vec![t("y"), t("z")],
                },
            ],
            async |b| {
                assert_eq!(
                    b.cmd(&[b"LRANGE", b"l", b"0", b"-1"]).await,
                    KvReply::Array(
                        ["x", "A", "b", "c", "d", "y", "z"]
                            .iter()
                            .map(|v| KvReply::Bulk(v.as_bytes().to_vec()))
                            .collect()
                    ),
                    "{label}"
                );
            },
        )
        .await;
        // Without a removal the revert goes edit by edit (indices shifted by the push).
        round_trip(
            &bench,
            &[b"l"],
            vec![
                KvEdit::ListSet {
                    key: t("l"),
                    index: 2,
                    original: t("c"),
                    value: t("C"),
                },
                KvEdit::ListPush {
                    key: t("l"),
                    head: true,
                    values: vec![t("h1"), t("h2")],
                },
            ],
            async |b| {
                assert_eq!(
                    b.cmd(&[b"LINDEX", b"l", b"4"]).await.bytes(),
                    Some(b"C".to_vec())
                );
            },
        )
        .await;
        // Removing every element removes the key; the revert brings it back.
        bench.cmd(&[b"RPUSH", b"one", b"only"]).await;
        round_trip(
            &bench,
            &[b"one"],
            vec![KvEdit::ListRemove {
                key: t("one"),
                index: 0,
                original: t("only"),
            }],
            async |b| {
                assert_eq!(b.cmd(&[b"EXISTS", b"one"]).await.int(), Some(0));
            },
        )
        .await;

        bench.cmd(&[b"SADD", b"st", b"a", b"b"]).await;
        round_trip(
            &bench,
            &[b"st"],
            vec![
                KvEdit::SetAdd {
                    key: t("st"),
                    member: b(&[0xff, 0]),
                },
                KvEdit::SetRemove {
                    key: t("st"),
                    member: t("a"),
                },
            ],
            async |b| {
                assert_eq!(b.cmd(&[b"SCARD", b"st"]).await.int(), Some(2));
                assert_eq!(
                    b.cmd(&[b"SISMEMBER", b"st", &[0xff, 0]]).await.int(),
                    Some(1)
                );
            },
        )
        .await;

        bench
            .cmd(&[b"ZADD", b"z", b"1", b"a", b"2.5", b"b", b"3", b"c"])
            .await;
        round_trip(
            &bench,
            &[b"z"],
            vec![
                KvEdit::ZsetSet {
                    key: t("z"),
                    member: t("b"),
                    original: Some("2.5".into()),
                    score: "-7.25".into(),
                },
                KvEdit::ZsetSet {
                    key: t("z"),
                    member: t("d"),
                    original: None,
                    score: "0.1".into(),
                },
                KvEdit::ZsetRemove {
                    key: t("z"),
                    member: t("c"),
                    original: "3".into(),
                },
            ],
            async |b| {
                assert_eq!(b.cmd(&[b"ZSCORE", b"z", b"b"]).await.float(), Some(-7.25));
                assert_eq!(b.cmd(&[b"ZSCORE", b"z", b"d"]).await.float(), Some(0.1));
                assert_eq!(b.cmd(&[b"ZSCORE", b"z", b"c"]).await, KvReply::Nil);
            },
        )
        .await;

        bench.cmd(&[b"XADD", b"x", b"1-1", b"f", b"v"]).await;
        bench.cmd(&[b"XADD", b"x", b"2-1", b"g", b"w"]).await;
        round_trip(
            &bench,
            &[b"x"],
            vec![KvEdit::StreamAdd {
                key: t("x"),
                fields: vec![KvField {
                    field: t("n"),
                    value: b(&[0xff]),
                }],
            }],
            async |b| {
                assert_eq!(b.cmd(&[b"XLEN", b"x"]).await.int(), Some(3));
            },
        )
        .await;
        round_trip(
            &bench,
            &[b"x"],
            vec![KvEdit::StreamDelete {
                key: t("x"),
                id: "1-1".into(),
                fields: vec![KvField {
                    field: t("f"),
                    value: t("v"),
                }],
            }],
            async |b| {
                assert_eq!(b.cmd(&[b"XLEN", b"x"]).await.int(), Some(1));
            },
        )
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn keys_are_created_copied_renamed_and_deleted_and_come_back() {
    for (label, url) in servers("keys_are_created_copied_renamed_and_deleted_and_come_back") {
        let bench = Bench::new(&url, 3, false).await;
        let json = bench.json_module().await;
        let mut creates = vec![
            KvEdit::Create {
                key: t("new:s"),
                value: KvNewValue::String { value: t("v") },
                ttl_ms: Some(120_000.0),
            },
            KvEdit::Create {
                key: t("new:h"),
                value: KvNewValue::Hash {
                    fields: vec![KvField {
                        field: t("f"),
                        value: t("v"),
                    }],
                },
                ttl_ms: None,
            },
            KvEdit::Create {
                key: t("new:l"),
                value: KvNewValue::List {
                    values: vec![t("1"), t("2")],
                },
                ttl_ms: None,
            },
            KvEdit::Create {
                key: t("new:set"),
                value: KvNewValue::Set {
                    members: vec![t("m")],
                },
                ttl_ms: None,
            },
            KvEdit::Create {
                key: t("new:z"),
                value: KvNewValue::Zset {
                    members: vec![KvScored {
                        member: t("m"),
                        score: "4".into(),
                    }],
                },
                ttl_ms: None,
            },
            KvEdit::Create {
                key: t("new:x"),
                value: KvNewValue::Stream {
                    fields: vec![KvField {
                        field: t("f"),
                        value: t("v"),
                    }],
                },
                ttl_ms: None,
            },
        ];
        let mut keys: Vec<&[u8]> =
            vec![b"new:s", b"new:h", b"new:l", b"new:set", b"new:z", b"new:x"];
        if json {
            creates.push(KvEdit::Create {
                key: t("new:j"),
                value: KvNewValue::Json {
                    value: r#"{"a":[1,2],"b":"c"}"#.into(),
                },
                ttl_ms: None,
            });
            keys.push(b"new:j");
        }
        let types = keys.len();
        round_trip(&bench, &keys, creates, async |b| {
            let mut found = Vec::new();
            for key in &keys {
                found.push(b.cmd(&[b"TYPE", key]).await.text().unwrap_or_default());
            }
            assert_eq!(
                found.iter().filter(|t| *t != "none").count(),
                types,
                "{label}"
            );
            assert!(b.cmd(&[b"PTTL", b"new:s"]).await.int().unwrap_or(-1) > 0);
        })
        .await;
        // A key that exists is not created over.
        bench.cmd(&[b"SET", b"taken", b"1"]).await;
        assert_eq!(
            conflicts(
                bench
                    .apply(
                        vec![KvEdit::Create {
                            key: t("taken"),
                            value: KvNewValue::String { value: t("2") },
                            ttl_ms: None,
                        }],
                        true,
                    )
                    .await
            ),
            [(0, KvConflictKind::Exists)]
        );

        bench.cmd(&[b"HSET", b"src", b"f", b"v"]).await;
        round_trip(
            &bench,
            &[b"src", b"copy"],
            vec![KvEdit::Copy {
                key: t("src"),
                to: t("copy"),
            }],
            async |b| {
                assert_eq!(b.state(b"copy").await, b.state(b"src").await);
            },
        )
        .await;

        // Rename: refused over an existing key unless asked, then confirmed.
        bench.cmd(&[b"SET", b"a", b"A", b"PX", b"500000"]).await;
        bench.cmd(&[b"RPUSH", b"b", b"B"]).await;
        let rename = |overwrite| {
            vec![KvEdit::Rename {
                key: t("a"),
                to: t("b"),
                overwrite,
            }]
        };
        assert_eq!(
            conflicts(bench.apply(rename(false), true).await),
            [(0, KvConflictKind::Exists)]
        );
        match bench.apply(rename(true), false).await {
            KvApplyOutcome::NeedsConfirmation { dangers } => {
                assert!(matches!(
                    dangers[0].kind,
                    KvEditDangerKind::Overwrite { .. }
                ));
                assert!(dangers[0].effect.en.contains("list"), "{:?}", dangers[0]);
            }
            other => panic!("expected a confirmation, got {other:?}"),
        }
        round_trip(&bench, &[b"a", b"b"], rename(true), async |b| {
            assert_eq!(b.cmd(&[b"EXISTS", b"a"]).await.int(), Some(0));
            assert_eq!(b.cmd(&[b"GET", b"b"]).await.bytes(), Some(b"A".to_vec()));
        })
        .await;
        round_trip(
            &bench,
            &[b"a", b"c"],
            vec![KvEdit::Rename {
                key: t("a"),
                to: t("c"),
                overwrite: false,
            }],
            async |b| {
                assert_eq!(b.cmd(&[b"GET", b"c"]).await.bytes(), Some(b"A".to_vec()));
            },
        )
        .await;

        // Deleted keys come back with their exact expiry.
        bench.cmd(&[b"SET", b"d1", b"1", b"PX", b"700000"]).await;
        bench.cmd(&[b"ZADD", b"d2", b"1", b"m"]).await;
        let entry = {
            let before = bench.states(&[b"d1", b"d2"]).await;
            let entry = bench
                .applied(vec![
                    KvEdit::Delete {
                        key: t("d1"),
                        guard: None,
                    },
                    KvEdit::Delete {
                        key: t("d2"),
                        guard: None,
                    },
                ])
                .await;
            assert_eq!(bench.cmd(&[b"EXISTS", b"d1", b"d2"]).await.int(), Some(0));
            bench.revert(entry).await;
            assert_eq!(bench.states(&[b"d1", b"d2"]).await, before);
            entry
        };
        let detail = bench
            .store
            .journal_entry(entry)
            .expect("journal")
            .expect("entry");
        assert_eq!(detail.entry.family, EngineFamily::KeyValue);
        assert_eq!(detail.entry.target_kind, JournalTargetKind::Keys);
        assert_eq!(detail.entry.deleted, 2);
        assert_eq!(
            detail
                .statements
                .iter()
                .map(|s| s.sql.as_str())
                .collect::<Vec<_>>(),
            ["UNLINK d1", "UNLINK d2"]
        );
        assert!(detail.inverse_statements[0].starts_with("RESTORE d2 0 <DUMP payload"));
        assert!(detail.inverse_statements[1].contains("ABSTTL"));

        if json {
            bench
                .cmd(&[b"JSON.SET", b"doc", b"$", br#"{"name":"Ada","tags":[1,2]}"#])
                .await;
            round_trip(
                &bench,
                &[b"doc"],
                vec![KvEdit::JsonSet {
                    key: t("doc"),
                    path: "$.name".into(),
                    original: Some(r#""Ada""#.into()),
                    value: r#""Grace""#.into(),
                }],
                async |b| {
                    assert_eq!(
                        b.cmd(&[b"JSON.GET", b"doc", b"$.name"])
                            .await
                            .text()
                            .as_deref(),
                        Some(r#"["Grace"]"#)
                    );
                },
            )
            .await;
            round_trip(
                &bench,
                &[b"doc"],
                vec![KvEdit::JsonSet {
                    key: t("doc"),
                    path: "$".into(),
                    original: Some(r#"{"name":"Ada","tags":[1,2]}"#.into()),
                    value: r#"{"new":true}"#.into(),
                }],
                async |_| {},
            )
            .await;
        } else {
            skip(
                &format!("json edits ({label})"),
                "the server has no RedisJSON module",
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn conflicts_apply_nothing_for_every_type() {
    for (label, url) in servers("conflicts_apply_nothing_for_every_type") {
        let bench = Bench::new(&url, 4, false).await;
        bench.cmd(&[b"SET", b"s", b"seen"]).await;
        bench.cmd(&[b"HSET", b"h", b"f", b"seen"]).await;
        bench.cmd(&[b"RPUSH", b"l", b"a", b"b"]).await;
        bench.cmd(&[b"SADD", b"st", b"m"]).await;
        bench.cmd(&[b"ZADD", b"z", b"1", b"m"]).await;
        bench.cmd(&[b"XADD", b"x", b"1-1", b"f", b"v"]).await;
        bench.cmd(&[b"SET", b"other", b"untouched"]).await;
        // What the user saw, then someone else changed each key.
        bench.cmd(&[b"SET", b"s", b"theirs"]).await;
        bench.cmd(&[b"HSET", b"h", b"f", b"theirs"]).await;
        bench.cmd(&[b"LSET", b"l", b"1", b"theirs"]).await;
        bench.cmd(&[b"SREM", b"st", b"m"]).await;
        bench.cmd(&[b"ZADD", b"z", b"9", b"m"]).await;
        bench.cmd(&[b"XDEL", b"x", b"1-1"]).await;
        bench.cmd(&[b"PEXPIRE", b"other", b"900000"]).await;
        let before = bench
            .states(&[b"s", b"h", b"l", b"st", b"z", b"x", b"other"])
            .await;
        // Each stale edit with a sound one on another key: nothing at all runs.
        let sound = KvEdit::StringSet {
            key: t("other"),
            original: Some(t("untouched")),
            value: t("changed"),
        };
        let stale: Vec<(KvEdit, KvConflictKind)> = vec![
            (
                KvEdit::StringSet {
                    key: t("s"),
                    original: Some(t("seen")),
                    value: t("mine"),
                },
                KvConflictKind::Changed,
            ),
            (
                KvEdit::HashSet {
                    key: t("h"),
                    field: t("f"),
                    original: Some(t("seen")),
                    value: t("mine"),
                },
                KvConflictKind::Changed,
            ),
            (
                KvEdit::ListRemove {
                    key: t("l"),
                    index: 1,
                    original: t("b"),
                },
                KvConflictKind::Changed,
            ),
            (
                KvEdit::SetRemove {
                    key: t("st"),
                    member: t("m"),
                },
                KvConflictKind::Missing,
            ),
            (
                KvEdit::ZsetSet {
                    key: t("z"),
                    member: t("m"),
                    original: Some("1".into()),
                    score: "2".into(),
                },
                KvConflictKind::Changed,
            ),
            (
                KvEdit::StreamDelete {
                    key: t("x"),
                    id: "1-1".into(),
                    fields: vec![KvField {
                        field: t("f"),
                        value: t("v"),
                    }],
                },
                KvConflictKind::Missing,
            ),
            (
                KvEdit::Expire {
                    key: t("other"),
                    original: None,
                    ttl: KvTtl::Persist,
                },
                KvConflictKind::Changed,
            ),
            // A key whose type changed: the list edit cannot run on a string.
            (
                KvEdit::ListPush {
                    key: t("s"),
                    head: false,
                    values: vec![t("v")],
                },
                KvConflictKind::TypeChanged,
            ),
        ];
        for (edit, kind) in stale {
            let found = conflicts(bench.apply(vec![sound.clone(), edit.clone()], true).await);
            assert_eq!(found, [(1, kind)], "{label}: {edit:?}");
        }
        assert_eq!(
            bench
                .states(&[b"s", b"h", b"l", b"st", b"z", b"x", b"other"])
                .await,
            before,
            "{label}: nothing applied"
        );
        // A conflict says what is there now, so "keep mine" can apply over it.
        match bench
            .apply(
                vec![KvEdit::HashSet {
                    key: t("h"),
                    field: t("f"),
                    original: Some(t("seen")),
                    value: t("mine"),
                }],
                true,
            )
            .await
        {
            KvApplyOutcome::Conflicted { conflicts } => {
                assert_eq!(conflicts[0].current, Some(t("theirs")));
                assert!(conflicts[0].rebasable);
            }
            other => panic!("{other:?}"),
        }
        bench
            .applied(vec![KvEdit::HashSet {
                key: t("h"),
                field: t("f"),
                original: Some(t("theirs")),
                value: t("mine"),
            }])
            .await;
        assert_eq!(
            bench.cmd(&[b"HGET", b"h", b"f"]).await.bytes(),
            Some(b"mine".to_vec())
        );
        // The applies are in the statement log, the conflicted ones as their checks only.
        let logged = bench.log.entries();
        assert!(
            logged
                .iter()
                .any(|e| e.sql.starts_with("MULTI\nHSET h f mine\nEXEC"))
        );
        assert!(logged.iter().any(|e| e.sql.starts_with("WATCH other s\n")));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn reverts_conflict_when_the_key_changed_since() {
    for (label, url) in servers("reverts_conflict_when_the_key_changed_since") {
        let bench = Bench::new(&url, 5, false).await;
        bench.cmd(&[b"HSET", b"h", b"f", b"1"]).await;
        let entry = bench
            .applied(vec![KvEdit::HashSet {
                key: t("h"),
                field: t("f"),
                original: Some(t("1")),
                value: t("2"),
            }])
            .await;
        bench.cmd(&[b"HSET", b"h", b"f", b"3"]).await;
        let found = conflicts(
            bench
                .kv
                .apply_revert(&bench.id, entry)
                .await
                .expect("revert"),
        );
        assert_eq!(found, [(0, KvConflictKind::Changed)], "{label}");
        assert_eq!(
            bench.cmd(&[b"HGET", b"h", b"f"]).await.bytes(),
            Some(b"3".to_vec())
        );
        // A deleted key that someone created again is not overwritten by the revert.
        bench.cmd(&[b"SET", b"k", b"v"]).await;
        let entry = bench
            .applied(vec![KvEdit::Delete {
                key: t("k"),
                guard: None,
            }])
            .await;
        bench.cmd(&[b"SET", b"k", b"someone else"]).await;
        let found = conflicts(
            bench
                .kv
                .apply_revert(&bench.id, entry)
                .await
                .expect("revert"),
        );
        assert_eq!(found, [(0, KvConflictKind::Exists)]);
        // A created key that changed is not deleted by the revert.
        let entry = bench
            .applied(vec![KvEdit::Create {
                key: t("c"),
                value: KvNewValue::String { value: t("1") },
                ttl_ms: None,
            }])
            .await;
        bench.cmd(&[b"APPEND", b"c", b"2"]).await;
        let found = conflicts(
            bench
                .kv
                .apply_revert(&bench.id, entry)
                .await
                .expect("revert"),
        );
        assert_eq!(found, [(0, KvConflictKind::Changed)]);
        assert_eq!(
            bench.cmd(&[b"GET", b"c"]).await.bytes(),
            Some(b"12".to_vec())
        );
        // A reverted entry cannot be reverted twice.
        bench.cmd(&[b"SET", b"r", b"1"]).await;
        let entry = bench
            .applied(vec![KvEdit::StringSet {
                key: t("r"),
                original: Some(t("1")),
                value: t("2"),
            }])
            .await;
        bench.revert(entry).await;
        let again = bench
            .kv
            .apply_revert(&bench.id, entry)
            .await
            .expect_err("twice");
        assert_eq!(again.code, ErrorCode::InvalidArgument);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_connections_refuse_every_edit() {
    for (label, url) in servers("read_only_connections_refuse_every_edit") {
        let bench = Bench::new(&url, 6, true).await;
        bench.cmd(&[b"SET", b"k", b"v"]).await;
        let refused = bench
            .kv
            .apply_changes(
                &bench.id,
                &bench.set(vec![KvEdit::StringSet {
                    key: t("k"),
                    original: Some(t("v")),
                    value: t("w"),
                }]),
                true,
            )
            .await
            .expect_err("read-only");
        assert_eq!(refused.code, ErrorCode::ReadOnlyViolation, "{label}");
        let refused = bench
            .kv
            .delete_namespace(&bench.id, bench.db, &t("k"))
            .await
            .expect_err("read-only");
        assert_eq!(refused.code, ErrorCode::ReadOnlyViolation);
        assert_eq!(
            bench.cmd(&[b"GET", b"k"]).await.bytes(),
            Some(b"v".to_vec())
        );
        // The preview still works: it reads nothing.
        bench
            .kv
            .preview_changes(
                &bench.id,
                &bench.set(vec![KvEdit::Delete {
                    key: t("k"),
                    guard: None,
                }]),
            )
            .await
            .expect("preview");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn many_deletes_are_confirmed_with_their_effect() {
    for (label, url) in servers("many_deletes_are_confirmed_with_their_effect") {
        let bench = Bench::new(&url, 7, false).await;
        for i in 0..11 {
            bench.cmd(&[b"SET", format!("k{i}").as_bytes(), b"v"]).await;
        }
        let edits: Vec<KvEdit> = (0..12)
            .map(|i| KvEdit::Delete {
                key: t(&format!("k{i}")),
                guard: None,
            })
            .collect();
        match bench.apply(edits.clone(), false).await {
            KvApplyOutcome::NeedsConfirmation { dangers } => {
                assert_eq!(dangers[0].kind, KvEditDangerKind::DeleteKeys { count: 12 });
                assert!(
                    dangers[0].effect.en.contains("11 of them exist"),
                    "{label}: {:?}",
                    dangers[0].effect
                );
            }
            other => panic!("expected a confirmation, got {other:?}"),
        }
        assert_eq!(bench.cmd(&[b"DBSIZE"]).await.int(), Some(11));
        let preview = bench
            .kv
            .preview_changes(&bench.id, &bench.set(edits.clone()))
            .await
            .expect("preview");
        assert_eq!(preview.commands, 12);
        assert_eq!(preview.dangers.len(), 1);
        let entry = bench.applied(edits).await;
        assert_eq!(bench.cmd(&[b"DBSIZE"]).await.int(), Some(0));
        bench.revert(entry).await;
        assert_eq!(bench.cmd(&[b"DBSIZE"]).await.int(), Some(11));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_explorer_follows_created_renamed_and_deleted_keys() {
    for (label, url) in servers("the_explorer_follows_created_renamed_and_deleted_keys") {
        let bench = Bench::new(&url, 8, false).await;
        bench.cmd(&[b"SET", b"app:a", b"1"]).await;
        bench.cmd(&[b"SET", b"app:b", b"1"]).await;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let status = bench
                .kv
                .scan_status(&bench.id, bench.db, None)
                .expect("scan");
            if status.state == KvScanState::Done {
                break;
            }
            assert!(Instant::now() < deadline, "{label}: scan stuck");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let level = |b: &Bench| {
            b.kv.scan_level(&b.id, b.db, &t("app:"), ":", 0, 100)
                .expect("level")
                .entries
                .into_iter()
                .filter_map(|e| match e {
                    KvLevelEntry::Key { key, .. } => Some(key.text),
                    KvLevelEntry::Namespace { .. } => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(level(&bench), ["app:a", "app:b"]);
        bench
            .applied(vec![
                KvEdit::Create {
                    key: t("app:c"),
                    value: KvNewValue::String { value: t("1") },
                    ttl_ms: None,
                },
                KvEdit::Rename {
                    key: t("app:a"),
                    to: t("app:z"),
                    overwrite: false,
                },
                KvEdit::Delete {
                    key: t("app:b"),
                    guard: None,
                },
            ])
            .await;
        assert_eq!(level(&bench), ["app:c", "app:z"], "{label}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_namespace_of_100k_keys_is_deleted_by_batches_and_restored() {
    for (label, url) in servers("a_namespace_of_100k_keys_is_deleted_by_batches_and_restored") {
        let bench = Bench::new(&url, 9, false).await;
        let mut commands = Vec::new();
        for i in 0..100_000 {
            commands.push(args(&[b"SET", format!("ns:{i}").as_bytes(), b"v"]));
        }
        commands.push(args(&[b"SET", b"ns:ttl", b"v", b"PX", b"800000"]));
        for i in 0..10 {
            commands.push(args(&[b"SET", format!("other:{i}").as_bytes(), b"v"]));
        }
        // A key whose name has glob characters: only the literal prefix is deleted.
        commands.push(args(&[b"SET", b"ns*", b"v"]));
        for chunk in commands.chunks(5_000) {
            for reply in bench.admin.send_all(chunk).await {
                reply.expect("bulk");
            }
        }
        let expire = bench.cmd(&[b"PEXPIRETIME", b"ns:ttl"]).await.int();
        let count = bench
            .kv
            .namespace_count(&bench.id, bench.db, &t("ns:"))
            .await
            .expect("count");
        assert_eq!(count.keys, 100_001.0, "{label}");
        assert_eq!(count.pattern, "ns:*");
        assert_eq!(count.sample.len(), 20);

        let start = Instant::now();
        let done = bench
            .kv
            .delete_namespace(&bench.id, bench.db, &t("ns:"))
            .await
            .expect("delete");
        let took = start.elapsed();
        assert_eq!(done.deleted, 100_001.0);
        assert!(done.revertible, "{label}: 100k small keys fit the bound");
        assert_eq!(bench.cmd(&[b"DBSIZE"]).await.int(), Some(11));
        println!(
            "{label}: namespace of 100 001 keys deleted in {took:?} ({} batches)",
            done.batches
        );
        let entry = done.journal_id.expect("journaled");
        let page = bench
            .store
            .search_journal(&JournalQuery::default())
            .expect("journal");
        let listed = page.entries.iter().find(|e| e.id == entry).expect("listed");
        assert_eq!(listed.target_kind, JournalTargetKind::Namespace);
        assert_eq!(listed.table.name, "ns:*");
        assert_eq!(listed.deleted, 100_001);

        let start = Instant::now();
        bench.revert(entry).await;
        println!("{label}: namespace restored in {:?}", start.elapsed());
        assert_eq!(bench.cmd(&[b"DBSIZE"]).await.int(), Some(100_012));
        assert_eq!(bench.cmd(&[b"PEXPIRETIME", b"ns:ttl"]).await.int(), expire);
    }
}
