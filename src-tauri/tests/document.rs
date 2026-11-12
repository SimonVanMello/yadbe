//! Conformance suite of the document family (M4-2), against real MongoDB servers: a
//! single-node replica set (`YADBE_TEST_MONGO_URL`) and a standalone server with
//! authentication and TLS (`YADBE_TEST_MONGO_STANDALONE_URL`, `YADBE_TEST_MONGO_CA`), from
//! `dev/compose.yml`. A test whose server is not configured prints SKIPPED.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{from_url, harness, skip};
use yadbe_lib::db::config::{ConnectionDefinition, TlsMode};
use yadbe_lib::db::document::classify::DangerKind;
use yadbe_lib::db::document::ejson::{to_ejson, to_value, type_of};
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::document::ops::{DocEvent, DocOp, DocReply, DocTopology, Namespace};
use yadbe_lib::db::driver::{ConnectRequest, DocumentConnection, NoRecorder};
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::secrets::Secret;
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::document::DocumentService;
use yadbe_lib::session::document::gate::{self, GateContext, GateOutcome, GateRequest, Origin};
use yadbe_lib::session::document::model::{CollectionQuery, CommandOutcome};
use yadbe_lib::session::history_hook::NoHistory;
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

const RS_ENV: &str = "YADBE_TEST_MONGO_URL";
const STANDALONE_ENV: &str = "YADBE_TEST_MONGO_STANDALONE_URL";
const CA_ENV: &str = "YADBE_TEST_MONGO_CA";

fn env(name: &str, test: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => {
            skip(test, &format!("{name} is not set"));
            None
        }
    }
}

/// The servers configured for this run, replica set first.
fn servers(test: &str) -> Vec<(&'static str, String)> {
    [("replica set", RS_ENV), ("standalone", STANDALONE_ENV)]
        .into_iter()
        .filter_map(|(label, name)| env(name, test).map(|url| (label, url)))
        .collect()
}

fn json(text: &str) -> Json {
    Json::parse(text).expect("json")
}

/// An open connection on a database of its own, dropped at the end.
struct Mongo {
    manager: Arc<ConnectionManager>,
    service: DocumentService,
    store: Arc<ResultStore>,
    log: Arc<StatementLog>,
    _db_store: Arc<Store>,
    id: String,
    database: String,
    def: ConnectionDefinition,
    password: Option<Secret>,
}

impl Mongo {
    async fn open(url: &str, tweak: impl FnOnce(&mut ConnectionDefinition)) -> Mongo {
        let h = harness();
        let (mut def, password) = from_url(url);
        def.database = common::unique_database("doc");
        tweak(&mut def);
        let saved = h
            .store
            .create_connection(&def.clone().normalized().expect("valid"))
            .expect("save");
        let manager = Arc::new(h.manager);
        manager
            .connect(&saved.id, password.clone())
            .await
            .expect("connect");
        let store = Arc::new(ResultStore::default());
        let service = DocumentService::new(
            Arc::clone(&manager),
            Arc::clone(&store),
            Arc::new(NoHistory),
        );
        Mongo {
            manager,
            service,
            store,
            log: h.log,
            _db_store: h.store,
            id: saved.id,
            database: def.database.clone(),
            def,
            password,
        }
    }

    fn conn(&self) -> Arc<dyn DocumentConnection> {
        self.manager
            .session(&self.id)
            .expect("session")
            .backend()
            .expect("backend")
            .into_document()
            .expect("document")
    }

    fn ns(&self, collection: &str) -> Namespace {
        Namespace::new(self.database.clone(), collection)
    }

    /// Runs through the gate as yadbe's own, read-write, confirmed; returns the reply and
    /// the cursor's documents.
    async fn run(&self, op: DocOp) -> (DocReply, Vec<Json>) {
        self.gated(op, false, true).await.expect("runs")
    }

    async fn gated(
        &self,
        op: DocOp,
        read_only: bool,
        confirmed: bool,
    ) -> Result<(DocReply, Vec<Json>), yadbe_lib::db::errors::YadbeError> {
        let conn = self.conn();
        let ctx = GateContext {
            read_only,
            recorder: Arc::new(NoRecorder),
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let collect = async {
            let mut docs = Vec::new();
            while let Some(DocEvent::Documents(batch)) = rx.recv().await {
                docs.extend(batch);
            }
            docs
        };
        let request = GateRequest {
            op: &op,
            origin: Origin::User,
            confirmed,
            max_time: None,
            token: uuid::Uuid::new_v4().to_string(),
            max_documents: None,
        };
        let (outcome, docs) = tokio::join!(gate::run(&ctx, &*conn, request, tx), collect);
        match outcome? {
            GateOutcome::Done(reply) => Ok((reply, docs)),
            GateOutcome::Confirm(report) => panic!("unexpected confirmation: {report:?}"),
        }
    }

    async fn insert(&self, collection: &str, documents: Vec<Json>) {
        self.run(DocOp::Insert {
            ns: self.ns(collection),
            documents,
            ordered: true,
        })
        .await;
    }

    async fn count(&self, collection: &str) -> f64 {
        let (reply, _) = self
            .run(DocOp::Count {
                ns: self.ns(collection),
                filter: Json::empty(),
                limit: None,
            })
            .await;
        let DocReply::Document(reply) = reply else {
            panic!("a reply");
        };
        gate::reply_number(&reply, "count").expect("count")
    }

    async fn find_all(&self, collection: &str) -> Vec<Json> {
        self.run(DocOp::Find {
            ns: self.ns(collection),
            filter: Json::empty(),
            options: Default::default(),
        })
        .await
        .1
    }
}

impl Drop for Mongo {
    fn drop(&mut self) {
        let def = self.def.clone();
        let password = self.password.clone();
        // A runtime and a client of their own: the test's runtime is blocked here, and the
        // session's client runs its tasks on it.
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                let target = def.target();
                let Ok(backend) = common::driver(def.engine)
                    .connect(ConnectRequest {
                        target: &target,
                        password: password.as_ref(),
                        recorder: Arc::new(NoRecorder),
                    })
                    .await
                else {
                    return;
                };
                let link = backend.as_link();
                let Ok(conn) = backend.clone().into_document() else {
                    return;
                };
                let op = DocOp::DropDatabase {
                    database: def.database.clone(),
                };
                let (tx, _rx) = tokio::sync::mpsc::channel(1);
                let ctx = GateContext {
                    read_only: false,
                    recorder: Arc::new(NoRecorder),
                };
                let request = GateRequest {
                    op: &op,
                    origin: Origin::Yadbe,
                    confirmed: true,
                    max_time: None,
                    token: "cleanup".into(),
                    max_documents: None,
                };
                if let Err(err) = gate::run(&ctx, &*conn, request, tx).await {
                    skip("dropping the fixture database", &format!("{err:?}"));
                }
                link.close().await;
            });
        })
        .join();
    }
}

/// One value of every BSON type, canonical Extended JSON, in a known field order.
const EVERY_TYPE: &str = r#"{
  "_id": {"$oid": "5f2b8c9e1c9d440000a1b2c3"},
  "double": {"$numberDouble": "1.5"},
  "double_whole": {"$numberDouble": "3.0"},
  "double_neg_zero": {"$numberDouble": "-0.0"},
  "double_inf": {"$numberDouble": "-Infinity"},
  "double_nan": {"$numberDouble": "NaN"},
  "string": "héllo ☃",
  "object": {"z": {"$numberInt": "1"}, "a": {"deep": [{"$numberLong": "2"}, "x"]}},
  "array": [{"$numberInt": "1"}, "two", {"three": {"$numberInt": "3"}}],
  "binary": {"$binary": {"base64": "AP8Q", "subType": "00"}},
  "uuid": {"$binary": {"base64": "EjRWeJASNFZ4kBI0VniQEg==", "subType": "04"}},
  "binary_user": {"$binary": {"base64": "AQI=", "subType": "80"}},
  "undefined": {"$undefined": true},
  "bool": true,
  "date": {"$date": {"$numberLong": "1700000000123"}},
  "date_before_epoch": {"$date": {"$numberLong": "-1"}},
  "date_far": {"$date": {"$numberLong": "253402300800000"}},
  "null": null,
  "regex": {"$regularExpression": {"pattern": "^a", "options": "i"}},
  "code": {"$code": "x = 1"},
  "symbol": {"$symbol": "sym"},
  "int32": {"$numberInt": "42"},
  "int32_min": {"$numberInt": "-2147483648"},
  "int64_small": {"$numberLong": "5"},
  "int64_max": {"$numberLong": "9223372036854775807"},
  "timestamp": {"$timestamp": {"t": 1, "i": 2}},
  "decimal": {"$numberDecimal": "12345678901234567890.123"},
  "min": {"$minKey": 1},
  "max": {"$maxKey": 1}
}"#;

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
        let command = r#"{"delete": "big", "deletes": [{"q": {}, "limit": 0}]}"#;
        let outcome = mongo
            .service
            .run_command("console", &mongo.id, &mongo.database, command, false)
            .await
            .expect("outcome");
        let CommandOutcome::Confirm { danger } = outcome else {
            panic!("{label}: a confirmation");
        };
        assert_eq!(danger.kind, DangerKind::DeleteAll);
        assert_eq!(danger.documents, Some(7.0), "{label}");
        assert_eq!(mongo.count("big").await, 7.0, "nothing deleted yet");
        let outcome = mongo
            .service
            .run_command("console", &mongo.id, &mongo.database, command, true)
            .await
            .expect("outcome");
        assert!(matches!(
            outcome,
            CommandOutcome::Done { cursor: false, .. }
        ));
        assert_eq!(mongo.count("big").await, 0.0, "{label}");
        let outcome = mongo
            .service
            .run_command(
                "console",
                &mongo.id,
                &mongo.database,
                r#"{"dropDatabase": 1}"#,
                false,
            )
            .await
            .expect("outcome");
        let CommandOutcome::Confirm { danger } = outcome else {
            panic!("{label}: a confirmation");
        };
        assert_eq!(
            (danger.kind, danger.collections),
            (DangerKind::DropDatabase, Some(1.0))
        );
    }
}

#[tokio::test]
async fn console_runs_commands_as_written() {
    for (label, url) in servers("console_runs_commands_as_written") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo
            .insert(
                "orders",
                (0..30)
                    .map(|i| {
                        json(&format!(
                            r#"{{"i": {i}, "status": "{}"}}"#,
                            if i % 3 == 0 { "paid" } else { "open" }
                        ))
                    })
                    .collect(),
            )
            .await;
        let outcome = mongo
            .service
            .run_command(
                "console",
                &mongo.id,
                &mongo.database,
                r#"{"find": "orders", "filter": {"status": "paid"}, "batchSize": 2}"#,
                false,
            )
            .await
            .expect("find");
        let CommandOutcome::Done {
            documents,
            cursor,
            truncated,
            ..
        } = outcome
        else {
            panic!("done");
        };
        assert!(cursor && !truncated, "{label}");
        assert_eq!(
            documents.count, 10,
            "{label}: past the first batch (getMore)"
        );
        let outcome = mongo
            .service
            .run_command(
                "console",
                &mongo.id,
                &mongo.database,
                r#"{"count": "orders"}"#,
                false,
            )
            .await
            .expect("count");
        let CommandOutcome::Done {
            documents, cursor, ..
        } = outcome
        else {
            panic!("done");
        };
        assert!(!cursor);
        assert_eq!(documents.count, 1, "the reply document");
        let err = mongo
            .service
            .run_command(
                "console",
                &mongo.id,
                &mongo.database,
                r#"{"nope": 1}"#,
                false,
            )
            .await
            .expect_err("unknown command");
        assert_eq!(err.code, ErrorCode::QueryFailed);
        let err = mongo
            .service
            .run_command(
                "console",
                &mongo.id,
                &mongo.database,
                r#"{find: "x"}"#,
                false,
            )
            .await
            .expect_err("not JSON");
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        // The statement log has yadbe's own operations only, never the console's.
        assert!(
            !mongo
                .log
                .entries()
                .iter()
                .any(|e| e.sql.contains("\"status\":\"paid\"")),
            "{label}"
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

const SLOW_FIND: &str = r#"{"find": "slow", "filter": {"$where": "sleep(200) || true"}}"#;

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
        })
        .await;
    docs.len()
}

#[tokio::test]
async fn cancel_stops_a_slow_find_on_the_server() {
    for (label, url) in servers("cancel_stops_a_slow_find_on_the_server") {
        let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
        slow_fixture(&mongo).await;
        let runner = Arc::clone(&mongo);
        let started = Instant::now();
        let task = tokio::spawn(async move {
            runner
                .service
                .run_command("console", &runner.id, &runner.database, SLOW_FIND, false)
                .await
        });
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(active_on(&mongo, "slow").await, 1, "{label}: it runs");
        mongo.service.cancel("console").await.expect("cancel");
        let err = task.await.expect("task").expect_err("cancelled");
        assert_eq!(err.code, ErrorCode::Cancelled, "{label}");
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

#[tokio::test]
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
        // A console command is sent as written: the gate's own wait runs out and kills it.
        let started = Instant::now();
        let err = mongo
            .service
            .run_command("console", &mongo.id, &mongo.database, SLOW_FIND, false)
            .await
            .expect_err("timed out");
        assert_eq!(err.code, ErrorCode::StatementTimeout, "{label}: {err:?}");
        assert!(started.elapsed() < Duration::from_secs(6), "{label}");
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

#[tokio::test]
async fn read_only_changes_under_an_open_session() {
    let Some(url) = env(RS_ENV, "read_only_changes_under_an_open_session") else {
        return;
    };
    let mongo = Mongo::open(&url, |_| {}).await;
    let session = mongo.manager.session(&mongo.id).expect("session");
    session.set_read_only(true).await.expect("read-only");
    let err = mongo
        .service
        .run_command(
            "console",
            &mongo.id,
            &mongo.database,
            r#"{"insert": "x", "documents": [{}]}"#,
            false,
        )
        .await
        .expect_err("refused");
    assert_eq!(err.code, ErrorCode::ReadOnlyViolation);
    session.set_read_only(false).await.expect("read-write");
    mongo
        .service
        .run_command(
            "console",
            &mongo.id,
            &mongo.database,
            r#"{"insert": "x", "documents": [{}]}"#,
            false,
        )
        .await
        .expect("written");
}
