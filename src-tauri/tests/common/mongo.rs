//! The MongoDB servers of the document family's suites (`document`, `mongosh`) and an open
//! connection on a database of its own, dropped at the end.

use std::sync::{Arc, Mutex, OnceLock, Weak};

use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::document::ops::{DocEvent, DocOp, DocReply, Namespace};
use yadbe_lib::db::driver::{ConnectRequest, DocumentConnection, NoRecorder};
use yadbe_lib::events::{BackendEvent, EventSink};
use yadbe_lib::secrets::Secret;
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::document::DocumentService;
use yadbe_lib::session::document::gate::{self, GateContext, GateOutcome, GateRequest, Origin};
use yadbe_lib::session::document::model::{MongoScriptConfirm, ScriptOutcome, ScriptRequest};
use yadbe_lib::session::history_hook::NoHistory;
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

use super::{from_url, harness, skip};

/// The confirmations a script asked for; each is answered at once with `answer` (none: the
/// script keeps waiting).
#[derive(Default)]
pub struct AutoConfirm {
    pub answer: Mutex<Option<bool>>,
    pub asked: Mutex<Vec<MongoScriptConfirm>>,
    pub service: OnceLock<Weak<DocumentService>>,
}

impl AutoConfirm {
    pub fn set(&self, answer: Option<bool>) {
        *self.answer.lock().expect("lock") = answer;
    }

    pub fn asked(&self) -> Vec<MongoScriptConfirm> {
        self.asked.lock().expect("lock").clone()
    }
}

impl EventSink for AutoConfirm {
    fn emit(&self, event: BackendEvent) {
        if let BackendEvent::MongoScriptConfirm(request) = event {
            self.asked.lock().expect("lock").push(request.clone());
            let answer = *self.answer.lock().expect("lock");
            if let Some(answer) = answer
                && let Some(service) = self.service.get().and_then(Weak::upgrade)
            {
                service.script_confirm(&request.tab_id, request.request_id, answer);
            }
        }
    }
}

pub const RS_ENV: &str = "YADBE_TEST_MONGO_URL";
pub const STANDALONE_ENV: &str = "YADBE_TEST_MONGO_STANDALONE_URL";
pub const CA_ENV: &str = "YADBE_TEST_MONGO_CA";

pub fn env(name: &str, test: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => {
            skip(test, &format!("{name} is not set"));
            None
        }
    }
}

/// The servers configured for this run, replica set first.
pub fn servers(test: &str) -> Vec<(&'static str, String)> {
    [("replica set", RS_ENV), ("standalone", STANDALONE_ENV)]
        .into_iter()
        .filter_map(|(label, name)| env(name, test).map(|url| (label, url)))
        .collect()
}

pub fn json(text: &str) -> Json {
    Json::parse(text).expect("json")
}

/// An open connection on a database of its own, dropped at the end.
pub struct Mongo {
    pub manager: Arc<ConnectionManager>,
    pub service: Arc<DocumentService>,
    /// Answers the confirmations scripts ask for (`answer`), and keeps them.
    pub confirms: Arc<AutoConfirm>,
    pub store: Arc<ResultStore>,
    pub log: Arc<StatementLog>,
    pub _db_store: Arc<Store>,
    pub id: String,
    pub database: String,
    pub def: ConnectionDefinition,
    pub password: Option<Secret>,
}

impl Mongo {
    pub async fn open(url: &str, tweak: impl FnOnce(&mut ConnectionDefinition)) -> Mongo {
        let h = harness();
        let (mut def, password) = from_url(url);
        def.database = super::unique_database("doc");
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
        let confirms = Arc::new(AutoConfirm::default());
        let service = Arc::new(
            DocumentService::new(
                Arc::clone(&manager),
                Arc::clone(&store),
                Arc::new(NoHistory),
            )
            .with_events(Arc::clone(&confirms) as Arc<dyn EventSink>),
        );
        let _ = confirms.service.set(Arc::downgrade(&service));
        Mongo {
            manager,
            service,
            confirms,
            store,
            log: h.log,
            _db_store: h.store,
            id: saved.id,
            database: def.database.clone(),
            def,
            password,
        }
    }

    pub fn conn(&self) -> Arc<dyn DocumentConnection> {
        self.manager
            .session(&self.id)
            .expect("session")
            .backend()
            .expect("backend")
            .into_document()
            .expect("document")
    }

    pub fn ns(&self, collection: &str) -> Namespace {
        Namespace::new(self.database.clone(), collection)
    }

    /// Runs through the gate as yadbe's own, read-write, confirmed; returns the reply and
    /// the cursor's documents.
    pub async fn run(&self, op: DocOp) -> (DocReply, Vec<Json>) {
        self.gated(op, false, true).await.expect("runs")
    }

    pub async fn gated(
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

    /// Runs through the gate as the user's own, read-write.
    pub async fn outcome(
        &self,
        op: &DocOp,
        confirmed: bool,
    ) -> Result<GateOutcome, yadbe_lib::db::errors::YadbeError> {
        let conn = self.conn();
        let ctx = GateContext {
            read_only: false,
            recorder: Arc::new(NoRecorder),
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let drain = async { while rx.recv().await.is_some() {} };
        let request = GateRequest {
            op,
            origin: Origin::User,
            confirmed,
            max_time: None,
            token: uuid::Uuid::new_v4().to_string(),
            max_documents: None,
        };
        let (outcome, ()) = tokio::join!(gate::run(&ctx, &*conn, request, tx), drain);
        outcome
    }

    /// Runs a mongosh script in query tab `tab`, on the fixture database.
    pub async fn script(&self, tab: &str, text: &str) -> ScriptOutcome {
        self.service
            .run_script(
                tab,
                &self.id,
                ScriptRequest {
                    database: self.database.clone(),
                    text: text.to_owned(),
                    range: None,
                },
            )
            .await
            .expect("the script ran")
    }

    pub async fn insert(&self, collection: &str, documents: Vec<Json>) {
        self.run(DocOp::Insert {
            ns: self.ns(collection),
            documents,
            ordered: true,
        })
        .await;
    }

    pub async fn count(&self, collection: &str) -> f64 {
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

    pub async fn find_all(&self, collection: &str) -> Vec<Json> {
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
                let Ok(backend) = super::driver(def.engine)
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
pub const EVERY_TYPE: &str = r#"{
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
