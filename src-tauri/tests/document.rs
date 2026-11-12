//! Conformance suite of the document family (M4-2), against real MongoDB servers: a
//! single-node replica set (`YADBE_TEST_MONGO_URL`) and a standalone server with
//! authentication and TLS (`YADBE_TEST_MONGO_STANDALONE_URL`, `YADBE_TEST_MONGO_CA`), from
//! `dev/compose.yml`. A test whose server is not configured prints SKIPPED.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::mongo::{CA_ENV, EVERY_TYPE, Mongo, RS_ENV, STANDALONE_ENV, env, json, servers};
use common::{from_url, harness};
use yadbe_lib::db::config::TlsMode;
use yadbe_lib::db::document::classify::DangerKind;
use yadbe_lib::db::document::ejson::{to_ejson, to_value, type_of};
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::document::ops::{DocOp, DocReply, DocTopology};
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::secrets::Secret;
use yadbe_lib::session::document::gate::GateOutcome;
use yadbe_lib::session::document::model::CollectionQuery;

#[tokio::test]
async fn connects_and_knows_the_topology() {
    for (label, url) in servers("connects_and_knows_the_topology") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let conn = mongo.conn();
        assert!(!conn.server_version().is_empty(), "{label}");
        let expected = if label == "standalone" {
            DocTopology::Standalone
        } else {
            DocTopology::ReplicaSet
        };
        assert_eq!(conn.topology(), expected, "{label}");
        mongo
            .manager
            .session(&mongo.id)
            .expect("session")
            .ping()
            .await
            .expect("ping");
    }
}

#[tokio::test]
async fn wrong_password_unknown_host_and_secrets() {
    let Some(url) = env(STANDALONE_ENV, "wrong_password_unknown_host_and_secrets") else {
        return;
    };
    let h = harness();
    let (mut def, _) = from_url(&url);
    def.connect_timeout_secs = Some(5);
    let wrong = Secret::new("not-the-password-42");
    let err = h
        .manager
        .test("t1".into(), def.clone(), Some(wrong), None)
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::AuthFailed, "{err:?}");
    let text = serde_json::to_string(&err).expect("json");
    assert!(!text.contains("not-the-password-42"), "{text}");
    for entry in h.log.entries() {
        assert!(!entry.sql.contains("not-the-password-42"), "{}", entry.sql);
    }
    let mut refused = def.clone();
    refused.host = "localhost".into();
    refused.port = Some(1);
    let err = h
        .manager
        .test("t2".into(), refused, Some(Secret::new("x")), None)
        .await
        .expect_err("refused");
    assert!(
        matches!(
            err.code,
            ErrorCode::ConnectionRefused | ErrorCode::ConnectionTimeout
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn connects_with_tls() {
    let (Some(url), Some(ca)) = (
        env(STANDALONE_ENV, "connects_with_tls"),
        env(CA_ENV, "connects_with_tls"),
    ) else {
        return;
    };
    // Full verification against the dev CA's `localhost` certificate.
    let verified = Mongo::open(&url, |def| {
        def.tls_mode = TlsMode::VerifyFull;
        def.ca_cert_path = Some(ca.clone());
    })
    .await;
    assert!(!verified.conn().server_version().is_empty());
    // Encryption without a CA: no verification.
    let encrypted = Mongo::open(&url, |def| def.tls_mode = TlsMode::Require).await;
    assert!(!encrypted.conn().server_version().is_empty());
    // The OS trust store does not know the dev CA.
    let h = harness();
    let (mut def, password) = from_url(&url);
    def.tls_mode = TlsMode::VerifyFull;
    let err = h
        .manager
        .test("tls".into(), def, password, None)
        .await
        .expect_err("untrusted");
    assert_eq!(err.code, ErrorCode::TlsFailed, "{err:?}");
}

/// Every BSON type is read back exactly as written, and a value read, turned into a cell and
/// written back (the edit path) is the same value.
#[tokio::test]
async fn every_bson_type_round_trips() {
    for (label, url) in servers("every_bson_type_round_trips") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let written = json(EVERY_TYPE);
        mongo.insert("types", vec![written.clone()]).await;
        let read = mongo.find_all("types").await;
        assert_eq!(read.len(), 1, "{label}");
        let read = &read[0];
        let keys = |j: &Json| -> Vec<String> {
            j.as_object()
                .expect("object")
                .iter()
                .map(|(k, _)| k.clone())
                .collect()
        };
        assert_eq!(keys(read), keys(&written), "{label}: field order");
        assert_eq!(
            read.clone().into_value(),
            written.clone().into_value(),
            "{label}: values and types"
        );
        // Through the grid cell and back, with the type the value had.
        let mut back = Vec::new();
        for (key, value) in read.as_object().expect("object") {
            let cell = to_value(value);
            let again = to_ejson(&cell, Some(type_of(value)))
                .expect("converts")
                .expect("present");
            back.push((key.clone(), again));
        }
        let mut copy = Json::Object(back);
        if let Json::Object(entries) = &mut copy {
            entries[0].1 = json(r#"{"$oid": "5f2b8c9e1c9d440000a1b2c4"}"#);
        }
        mongo.insert("types", vec![copy]).await;
        let both = mongo.find_all("types").await;
        let strip = |j: &Json| {
            let mut v = j.clone().into_value();
            v.as_object_mut().expect("object").remove("_id");
            v
        };
        assert_eq!(
            strip(&both[1]),
            strip(&both[0]),
            "{label}: cells round trip"
        );
    }
}

#[tokio::test]
async fn pages_follow_the_id_and_stay_stable() {
    for (label, url) in servers("pages_follow_the_id_and_stay_stable") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let docs: Vec<Json> = (0..250)
            .map(|i| {
                json(&format!(
                    r#"{{"_id": {}, "n": {}, "even": {}}}"#,
                    1000 + i,
                    i,
                    i % 2 == 0
                ))
            })
            .collect();
        mongo.insert("items", docs).await;
        let query = CollectionQuery {
            filter: String::new(),
            projection: String::new(),
            sort: String::new(),
            page_size: 100,
        };
        let ns = |m: &Mongo| m.ns("items");
        let first = mongo
            .service
            .page("tab", &mongo.id, ns(&mongo), query.clone(), 0)
            .await
            .expect("page 0");
        assert!(first.keyset && first.has_more, "{label}");
        assert_eq!(first.documents.count, 100);
        // A document inserted before the current position does not shift the next page.
        mongo
            .insert("items", vec![json(r#"{"_id": 5, "n": -1}"#)])
            .await;
        let ids = |page: &yadbe_lib::session::document::model::CollectionPage| -> Vec<i64> {
            mongo
                .service
                .documents(page.documents.documents_id, 0, 500)
                .expect("documents")
                .iter()
                .map(|t| {
                    let doc = json(t);
                    match to_value(doc.get("_id").expect("_id")) {
                        yadbe_lib::db::value::Value::Int(n) => n.parse().expect("int"),
                        other => panic!("{other:?}"),
                    }
                })
                .collect()
        };
        let second = mongo
            .service
            .page("tab", &mongo.id, ns(&mongo), query.clone(), 1)
            .await
            .expect("page 1");
        // A page's results stay until the tab reads the next one.
        assert_eq!(ids(&second).first(), Some(&1100), "{label}");
        let third = mongo
            .service
            .page("tab", &mongo.id, ns(&mongo), query.clone(), 2)
            .await
            .expect("page 2");
        assert!(second.has_more && !third.has_more, "{label}");
        assert_eq!(third.documents.count, 50);
        assert_eq!(ids(&third).last(), Some(&1249), "{label}");
        assert!(
            mongo
                .service
                .documents(second.documents.documents_id, 0, 1)
                .is_err(),
            "the previous page is freed"
        );
        // A filter and a sort on another field: pages skip, with `_id` breaking ties.
        let sorted = CollectionQuery {
            filter: r#"{"even": true}"#.into(),
            sort: r#"{"even": -1}"#.into(),
            projection: r#"{"n": 1}"#.into(),
            page_size: 100,
        };
        let page = mongo
            .service
            .page("tab", &mongo.id, ns(&mongo), sorted.clone(), 1)
            .await
            .expect("skip page");
        assert!(!page.keyset, "{label}");
        assert_eq!(page.documents.count, 25);
        let columns: Vec<&str> = page
            .documents
            .result
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(columns, ["_id", "n"], "{label}: projection");
        let exact = mongo
            .service
            .count("tab", &mongo.id, ns(&mongo), r#"{"even": true}"#)
            .await
            .expect("count");
        assert_eq!(exact, 125.0);
        let info = mongo
            .service
            .open_collection("tab", &mongo.id, ns(&mongo))
            .await
            .expect("open");
        assert_eq!(info.estimated_count, Some(251.0), "{label}");
        mongo.service.close_tab("tab").await;
        assert!(
            mongo.store.get(page.documents.result.result_id).is_err(),
            "freed"
        );
    }
}

#[tokio::test]
async fn explorer_lists_and_samples() {
    for (label, url) in servers("explorer_lists_and_samples") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo
            .insert(
                "people",
                vec![
                    json(r#"{"name": "a", "address": {"city": "Lyon"}, "age": 3}"#),
                    json(r#"{"name": "b", "tags": ["x"], "age": {"$numberLong": "4"}}"#),
                ],
            )
            .await;
        mongo
            .run(DocOp::CreateIndexes {
                ns: mongo.ns("people"),
                indexes: vec![json(
                    r#"{"key": {"name": 1}, "name": "name_1", "unique": true}"#,
                )],
            })
            .await;
        mongo
            .run(DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(r#"{"create": "adults", "viewOn": "people", "pipeline": [{"$match": {"age": {"$gte": 4}}}]}"#),
            })
            .await;
        let databases = mongo.service.databases(&mongo.id).await.expect("databases");
        assert!(
            databases.iter().any(|d| d.name == mongo.database),
            "{label}"
        );
        assert!(databases.iter().any(|d| d.name == "admin" && d.system));
        let collections = mongo
            .service
            .collections(&mongo.id, &mongo.database)
            .await
            .expect("collections");
        let kinds: Vec<(String, String)> = collections
            .iter()
            .map(|c| (c.name.clone(), format!("{:?}", c.kind)))
            .collect();
        assert!(
            kinds.contains(&("people".into(), "Collection".into())),
            "{kinds:?}"
        );
        assert!(
            kinds.contains(&("adults".into(), "View".into())),
            "{kinds:?}"
        );
        let indexes = mongo
            .service
            .indexes(&mongo.id, &mongo.database, "people")
            .await
            .expect("indexes");
        let unique = indexes.iter().find(|i| i.name == "name_1").expect("index");
        assert!(unique.unique);
        assert_eq!(unique.keys, r#"{"name":1}"#);
        let sample = mongo
            .service
            .sample(&mongo.id, &mongo.database, "people", Some(100))
            .await
            .expect("sample");
        assert_eq!(sample.sampled, 2, "{label}");
        let age = sample.fields.iter().find(|f| f.path == "age").expect("age");
        assert_eq!(age.present, 2);
        assert_eq!(age.types.len(), 2, "int and long");
        assert!(
            sample
                .fields
                .iter()
                .any(|f| f.path == "address.city" && f.depth == 1)
        );
        // The view's sample works too.
        let view = mongo
            .service
            .sample(&mongo.id, &mongo.database, "adults", None)
            .await
            .expect("view sample");
        assert_eq!(view.sampled, 1);
    }
}

/// Every write, typed or as a command, is refused on a read-only connection before it is
/// sent: the data does not change.
#[tokio::test]
async fn read_only_refuses_every_write_at_the_gate() {
    for (label, url) in servers("read_only_refuses_every_write_at_the_gate") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo
            .insert("data", vec![json(r#"{"_id": 1, "a": 1}"#)])
            .await;
        let ns = mongo.ns("data");
        let doc = json(r#"{"a": 2}"#);
        let writes = vec![
            DocOp::Insert {
                ns: ns.clone(),
                documents: vec![doc.clone()],
                ordered: true,
            },
            DocOp::Update {
                ns: ns.clone(),
                filter: json(r#"{"_id": 1}"#),
                update: json(r#"{"$set": {"a": 3}}"#),
                many: false,
                upsert: false,
                array_filters: None,
            },
            DocOp::Replace {
                ns: ns.clone(),
                filter: json(r#"{"_id": 1}"#),
                replacement: doc.clone(),
                upsert: false,
            },
            DocOp::Delete {
                ns: ns.clone(),
                filter: json(r#"{"_id": 1}"#),
                many: false,
            },
            DocOp::Delete {
                ns: ns.clone(),
                filter: Json::empty(),
                many: true,
            },
            DocOp::CreateIndexes {
                ns: ns.clone(),
                indexes: vec![json(r#"{"key": {"a": 1}, "name": "a_1"}"#)],
            },
            DocOp::DropIndexes {
                ns: ns.clone(),
                name: "*".into(),
            },
            DocOp::CreateCollection {
                database: mongo.database.clone(),
                name: "other".into(),
                options: Json::empty(),
            },
            DocOp::DropCollection { ns: ns.clone() },
            DocOp::DropDatabase {
                database: mongo.database.clone(),
            },
            DocOp::RenameCollection {
                from: ns.clone(),
                to: mongo.ns("renamed"),
                drop_target: false,
            },
            DocOp::Aggregate {
                database: mongo.database.clone(),
                collection: Some("data".into()),
                pipeline: vec![json(r#"{"$out": "copy"}"#)],
                allow_disk_use: None,
                batch_size: None,
                options: Default::default(),
            },
            DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(r#"{"insert": "data", "documents": [{"a": 9}]}"#),
            },
            DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(
                    r#"{"update": "data", "updates": [{"q": {}, "u": {"$set": {"a": 9}}}]}"#,
                ),
            },
            DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(r#"{"delete": "data", "deletes": [{"q": {}, "limit": 0}]}"#),
            },
            DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(r#"{"findAndModify": "data", "query": {}, "remove": true}"#),
            },
            DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(r#"{"drop": "data"}"#),
            },
            DocOp::RunCommand {
                database: mongo.database.clone(),
                command: json(
                    r#"{"aggregate": "data", "pipeline": [{"$merge": {"into": "copy"}}], "cursor": {}}"#,
                ),
            },
        ];
        for op in writes {
            let err = mongo
                .gated(op.clone(), true, true)
                .await
                .expect_err("refused");
            assert_eq!(
                err.code,
                ErrorCode::ReadOnlyViolation,
                "{label}: {}",
                op.display()
            );
        }
        assert_eq!(
            mongo.find_all("data").await,
            vec![json(
                r#"{"_id": {"$numberInt": "1"}, "a": {"$numberInt": "1"}}"#
            )]
        );
        let names: Vec<String> = mongo
            .service
            .collections(&mongo.id, &mongo.database)
            .await
            .expect("collections")
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, ["data"], "{label}");
        // Reads still run.
        let read = mongo
            .gated(
                DocOp::RunCommand {
                    database: mongo.database.clone(),
                    command: json(r#"{"find": "data", "filter": {}}"#),
                },
                true,
                false,
            )
            .await
            .expect("read");
        assert_eq!(read.1.len(), 1);
    }
}

#[tokio::test]
async fn dangerous_commands_wait_for_a_confirmation() {
    for (label, url) in servers("dangerous_commands_wait_for_a_confirmation") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo
            .insert(
                "big",
                (0..7).map(|i| json(&format!(r#"{{"i": {i}}}"#))).collect(),
            )
            .await;
        let op = DocOp::RunCommand {
            database: mongo.database.clone(),
            command: json(r#"{"delete": "big", "deletes": [{"q": {}, "limit": 0}]}"#),
        };
        let GateOutcome::Confirm(danger) = mongo.outcome(&op, false).await.expect("outcome") else {
            panic!("{label}: a confirmation");
        };
        assert_eq!(danger.kind, DangerKind::DeleteAll);
        assert_eq!(danger.documents, Some(7.0), "{label}");
        assert_eq!(mongo.count("big").await, 7.0, "nothing deleted yet");
        let outcome = mongo.outcome(&op, true).await.expect("outcome");
        assert!(matches!(outcome, GateOutcome::Done(DocReply::Document(_))));
        assert_eq!(mongo.count("big").await, 0.0, "{label}");
        let drop = DocOp::RunCommand {
            database: mongo.database.clone(),
            command: json(r#"{"dropDatabase": 1}"#),
        };
        let GateOutcome::Confirm(danger) = mongo.outcome(&drop, false).await.expect("outcome")
        else {
            panic!("{label}: a confirmation");
        };
        assert_eq!(
            (danger.kind, danger.collections),
            (DangerKind::DropDatabase, Some(1.0))
        );
    }
}

async fn slow_fixture(mongo: &Mongo) {
    mongo
        .insert(
            "slow",
            (0..50).map(|i| json(&format!(r#"{{"i": {i}}}"#))).collect(),
        )
        .await;
}

/// A command typed in a script, sent as written: no `maxTimeMS` is added to it.
const SLOW_FIND: &str =
    r#"db.runCommand({"find": "slow", "filter": {"$where": "sleep(200) || true"}})"#;

/// The operations still running on the server against a collection.
async fn active_on(mongo: &Mongo, collection: &str) -> usize {
    let ns = format!("{}.{collection}", mongo.database);
    let (_, docs) = mongo
        .run(DocOp::Aggregate {
            database: "admin".into(),
            collection: None,
            pipeline: vec![
                json(r#"{"$currentOp": {"allUsers": true}}"#),
                Json::object([(
                    "$match",
                    Json::object([("ns", Json::string(ns)), ("active", Json::Bool(true))]),
                )]),
            ],
            allow_disk_use: None,
            batch_size: None,
            options: Default::default(),
        })
        .await;
    docs.len()
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_stops_a_slow_find_on_the_server() {
    for (label, url) in servers("cancel_stops_a_slow_find_on_the_server") {
        let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
        slow_fixture(&mongo).await;
        let runner = Arc::clone(&mongo);
        let started = Instant::now();
        let task = tokio::spawn(async move { runner.script("console", SLOW_FIND).await });
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(active_on(&mongo, "slow").await, 1, "{label}: it runs");
        mongo.service.cancel("console").await.expect("cancel");
        let outcome = task.await.expect("task");
        let failure = outcome.failure.expect("cancelled");
        assert_eq!(failure.error.code, ErrorCode::Cancelled, "{label}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{label}: {:?}",
            started.elapsed()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while active_on(&mongo, "slow").await > 0 {
            assert!(
                Instant::now() < deadline,
                "{label}: still running on the server"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let log = mongo.log.entries();
        assert!(
            log.iter().any(|e| e.sql.contains("killOp")),
            "{label}: kill recorded"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn statement_timeout_stops_slow_operations() {
    for (label, url) in servers("statement_timeout_stops_slow_operations") {
        let mongo = Mongo::open(&url, |def| def.statement_timeout_secs = Some(1)).await;
        slow_fixture(&mongo).await;
        // A collection page carries maxTimeMS: the server stops it.
        let query = CollectionQuery {
            filter: r#"{"$where": "sleep(200) || true"}"#.into(),
            projection: String::new(),
            sort: String::new(),
            page_size: 100,
        };
        let started = Instant::now();
        let err = mongo
            .service
            .page("tab", &mongo.id, mongo.ns("slow"), query, 0)
            .await
            .expect_err("timed out");
        assert_eq!(err.code, ErrorCode::StatementTimeout, "{label}: {err:?}");
        assert!(started.elapsed() < Duration::from_secs(4), "{label}");
        // A command typed in a script is sent as written: the gate's own wait runs out and
        // kills it.
        let started = Instant::now();
        let outcome = mongo.script("console", SLOW_FIND).await;
        let failure = outcome.failure.expect("timed out");
        assert_eq!(
            failure.error.code,
            ErrorCode::StatementTimeout,
            "{label}: {failure:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(7), "{label}");
        let deadline = Instant::now() + Duration::from_secs(3);
        while active_on(&mongo, "slow").await > 0 {
            assert!(
                Instant::now() < deadline,
                "{label}: still running on the server"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_changes_under_an_open_session() {
    let Some(url) = env(RS_ENV, "read_only_changes_under_an_open_session") else {
        return;
    };
    let mongo = Mongo::open(&url, |_| {}).await;
    let session = mongo.manager.session(&mongo.id).expect("session");
    session.set_read_only(true).await.expect("read-only");
    let outcome = mongo.script("console", "db.x.insertOne({})").await;
    assert_eq!(
        outcome.failure.expect("refused").error.code,
        ErrorCode::ReadOnlyViolation
    );
    session.set_read_only(false).await.expect("read-write");
    let outcome = mongo.script("console", "db.x.insertOne({})").await;
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
}
