//! The command gate of the document family: the one function every operation goes through
//! before the driver, whoever asks (the explorer, the collection tab, the console and, from
//! M4-3, each call a mongosh script makes). In order:
//!
//! 1. **Read-only** (F-008): the session's live flag; an operation that is not on the
//!    allow-list (`db::document::classify`) is refused before anything is sent.
//! 2. **Danger**: a drop, or a delete / update of a whole collection, is not sent until the
//!    caller says it was confirmed; until then the gate answers with what it would touch
//!    (documents counted by the server).
//! 3. **Timeout**: `maxTimeMS` where the operation takes it, and the wait itself bounded,
//!    with a `killOp` when it runs out (F-014).
//! 4. **Statement log** (rule 5): operations yadbe authors are recorded with their duration
//!    and outcome; the user's own go to the history, which the caller writes.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use specta::Type;

use crate::db::document::classify::{Access, DangerKind, classify};
use crate::db::document::json::Json;
use crate::db::document::ops::{DocOp, DocReply, DocSender, ExecOptions, Namespace};
use crate::db::driver::{DocumentConnection, RecordedStatement, StatementRecorder};
use crate::db::errors::YadbeError;
use crate::session::ConnectionSession;

/// Extra wait past the server's own `maxTimeMS` before the gate gives up on an answer.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);

/// Who asked for an operation, which decides where it is recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// yadbe built it (explorer, collection pages, counts): statement log.
    Yadbe,
    /// The user wrote it (console): the caller records it in the history.
    User,
    /// A call a mongosh script makes: in the statement log, each one (a script is many
    /// operations the history does not show one by one); the caller records the script
    /// itself in the history.
    Script,
}

/// One operation for the gate.
pub struct GateRequest<'a> {
    pub op: &'a DocOp,
    pub origin: Origin,
    /// The user confirmed this operation after seeing its danger report.
    pub confirmed: bool,
    /// The statement timeout to apply, if any (query tabs and collection tabs).
    pub max_time: Option<Duration>,
    /// Identifies the operation for [`DocumentConnection::kill`]: the caller keeps it to cancel.
    pub token: String,
    /// A cursor stops after this many documents.
    pub max_documents: Option<u64>,
}

/// What a dangerous operation would do, for the confirmation (rule 10).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DangerReport {
    pub kind: DangerKind,
    /// The command as the user knows it (`deleteMany`, `drop`…).
    pub command: String,
    pub database: String,
    pub collection: Option<String>,
    /// Documents it would delete, update or drop, as the server counts them now (estimated
    /// for a whole collection); `null` when they could not be counted.
    pub documents: Option<f64>,
    /// Collections it would drop (`dropDatabase`).
    pub collections: Option<f64>,
}

/// How a gated operation ended.
#[derive(Debug)]
pub enum GateOutcome {
    Done(DocReply),
    /// Nothing was sent: the operation is dangerous and waits for a confirmation.
    Confirm(DangerReport),
}

/// What the gate reads of the session, at the time of each operation.
pub struct GateContext {
    /// Read-only as saved now (the flag can change under an open session).
    pub read_only: bool,
    pub recorder: Arc<dyn StatementRecorder>,
}

impl GateContext {
    pub fn of(session: &ConnectionSession) -> Self {
        Self {
            read_only: session.read_only(),
            recorder: session.recorder(),
        }
    }
}

fn record(
    ctx: &GateContext,
    op: &DocOp,
    started_at: SystemTime,
    start: Instant,
    outcome: &Result<DocReply, YadbeError>,
) {
    ctx.recorder.record(RecordedStatement {
        sql: op.display(),
        started_at,
        duration: start.elapsed(),
        outcome: match outcome {
            Ok(DocReply::Cursor { documents, .. }) => Ok(Some(*documents)),
            Ok(DocReply::Document(_)) => Ok(None),
            Err(err) => Err(err.clone()),
        },
    });
}

/// Runs `request` on `conn` through every check. See the module documentation.
pub async fn run(
    ctx: &GateContext,
    conn: &dyn DocumentConnection,
    request: GateRequest<'_>,
    events: DocSender,
) -> Result<GateOutcome, YadbeError> {
    let classified = classify(request.op);
    if ctx.read_only && classified.access == Access::Write {
        return Err(YadbeError::read_only_violation(&classified.name));
    }
    if let Some(danger) = &classified.danger
        && !request.confirmed
    {
        return Ok(GateOutcome::Confirm(
            report(ctx, conn, danger, &classified.name).await,
        ));
    }
    let options = ExecOptions {
        max_time: request.max_time,
        token: request.token.clone(),
        max_documents: request.max_documents,
    };
    let started_at = SystemTime::now();
    let start = Instant::now();
    let work = conn.execute(request.op, &options, events);
    let result = match request.max_time {
        Some(limit) => match tokio::time::timeout(limit + TIMEOUT_GRACE, work).await {
            Ok(result) => result,
            Err(_) => {
                if let Err(err) = conn.kill(&request.token).await {
                    tracing::warn!(error = %err, "could not stop an operation past its timeout");
                }
                Err(YadbeError::statement_timeout(limit.as_secs()))
            }
        },
        None => work.await,
    };
    if matches!(request.origin, Origin::Yadbe | Origin::Script) {
        record(ctx, request.op, started_at, start, &result);
    }
    result.map(GateOutcome::Done)
}

/// Runs an operation yadbe authors and returns its reply: never dangerous, recorded in the
/// statement log, refused on a read-only connection if it writes.
pub async fn run_own(
    ctx: &GateContext,
    conn: &dyn DocumentConnection,
    op: &DocOp,
    events: DocSender,
) -> Result<DocReply, YadbeError> {
    let request = GateRequest {
        op,
        origin: Origin::Yadbe,
        confirmed: false,
        max_time: None,
        token: uuid::Uuid::new_v4().to_string(),
        max_documents: None,
    };
    match run(ctx, conn, request, events).await? {
        GateOutcome::Done(reply) => Ok(reply),
        GateOutcome::Confirm(_) => Err(YadbeError::internal(
            "an operation yadbe authors was classified as dangerous",
        )),
    }
}

/// A count in a reply document (`{"count": …}`, `{"n": …}`), whatever its integer form.
pub fn reply_number(reply: &Json, key: &str) -> Option<f64> {
    match reply.get(key)? {
        Json::Number(n) => n.as_f64(),
        wrapped @ Json::Object(_) => ["$numberInt", "$numberLong", "$numberDouble"]
            .iter()
            .find_map(|k| wrapped.get(k))
            .and_then(Json::as_str)
            .and_then(|t| t.parse().ok()),
        _ => None,
    }
}

/// A read yadbe sends to size a dangerous operation: straight to the driver (it only reads)
/// and recorded.
async fn read_own(
    ctx: &GateContext,
    conn: &dyn DocumentConnection,
    op: &DocOp,
    events: DocSender,
) -> Result<DocReply, YadbeError> {
    let options = ExecOptions {
        max_time: None,
        token: uuid::Uuid::new_v4().to_string(),
        max_documents: None,
    };
    let started_at = SystemTime::now();
    let start = Instant::now();
    let result = conn.execute(op, &options, events).await;
    record(ctx, op, started_at, start, &result);
    result
}

async fn count(ctx: &GateContext, conn: &dyn DocumentConnection, op: DocOp) -> Option<f64> {
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    match read_own(ctx, conn, &op, tx).await {
        Ok(DocReply::Document(reply)) => reply_number(&reply, "count"),
        Ok(DocReply::Cursor { .. }) => None,
        Err(err) => {
            tracing::debug!(error = %err, "could not count what a dangerous operation touches");
            None
        }
    }
}

async fn report(
    ctx: &GateContext,
    conn: &dyn DocumentConnection,
    danger: &crate::db::document::classify::Danger,
    command: &str,
) -> DangerReport {
    let mut report = DangerReport {
        kind: danger.kind,
        command: command.to_owned(),
        database: danger.database.clone(),
        collection: danger.collection.clone(),
        documents: None,
        collections: None,
    };
    match (danger.kind, &danger.collection) {
        (DangerKind::DropDatabase, _) => {
            let (tx, mut rx) = tokio::sync::mpsc::channel(16);
            let op = DocOp::ListCollections {
                database: danger.database.clone(),
                filter: None,
            };
            let collect = async {
                let mut names = 0_usize;
                while let Some(crate::db::document::ops::DocEvent::Documents(batch)) =
                    rx.recv().await
                {
                    names += batch.len();
                }
                names
            };
            let (result, names) = tokio::join!(read_own(ctx, conn, &op, tx), collect);
            if result.is_ok() {
                report.collections = Some(names as f64);
            }
        }
        (_, Some(collection)) => {
            let ns = Namespace::new(danger.database.clone(), collection.clone());
            report.documents = count(ctx, conn, DocOp::EstimatedCount { ns }).await;
        }
        (_, None) => {}
    }
    report
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::db::document::ops::{DocEvent, DocTopology};
    use crate::db::driver::{BoxFuture, CancelHandle, Link, LinkWatch};

    /// Answers every operation, remembers what it was sent and what was killed.
    #[derive(Default)]
    struct FakeDocs {
        sent: Mutex<Vec<String>>,
        killed: Mutex<Vec<String>>,
        slow: bool,
    }

    struct NoCancel;
    impl CancelHandle for NoCancel {
        fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
            Box::pin(async { Ok(()) })
        }
    }

    impl Link for FakeDocs {
        fn server_version(&self) -> &str {
            "7.0"
        }
        fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
            Box::pin(async { Ok(()) })
        }
        fn link(&self) -> LinkWatch {
            LinkWatch::never()
        }
        fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
            Arc::new(NoCancel)
        }
        fn close(&self) -> BoxFuture<'_, ()> {
            Box::pin(async {})
        }
    }

    impl DocumentConnection for FakeDocs {
        fn execute<'a>(
            &'a self,
            op: &'a DocOp,
            _options: &'a ExecOptions,
            events: DocSender,
        ) -> BoxFuture<'a, Result<DocReply, YadbeError>> {
            Box::pin(async move {
                self.sent.lock().expect("lock").push(op.display());
                if self.slow {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                }
                match op {
                    DocOp::EstimatedCount { .. } => Ok(DocReply::Document(
                        Json::parse(r#"{"count":{"$numberLong":"1234"}}"#).expect("json"),
                    )),
                    DocOp::ListCollections { .. } => {
                        let _ = events
                            .send(DocEvent::Documents(vec![Json::empty(), Json::empty()]))
                            .await;
                        Ok(DocReply::Cursor {
                            documents: 2,
                            more: false,
                        })
                    }
                    _ => Ok(DocReply::Document(Json::empty())),
                }
            })
        }
        fn kill<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), YadbeError>> {
            Box::pin(async move {
                self.killed.lock().expect("lock").push(token.to_owned());
                Ok(())
            })
        }
        fn topology(&self) -> DocTopology {
            DocTopology::Standalone
        }
    }

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);
    impl StatementRecorder for Log {
        fn record(&self, statement: RecordedStatement) {
            self.0.lock().expect("lock").push(statement.sql);
        }
    }

    fn ctx(read_only: bool) -> (GateContext, Arc<Log>) {
        let log = Arc::new(Log::default());
        (
            GateContext {
                read_only,
                recorder: Arc::clone(&log) as Arc<dyn StatementRecorder>,
            },
            log,
        )
    }

    fn request(op: &DocOp, origin: Origin, confirmed: bool) -> GateRequest<'_> {
        GateRequest {
            op,
            origin,
            confirmed,
            max_time: None,
            token: "t1".into(),
            max_documents: None,
        }
    }

    fn ns() -> Namespace {
        Namespace::new("shop", "orders")
    }

    fn every_write() -> Vec<DocOp> {
        let doc = Json::parse(r#"{"a":1}"#).expect("json");
        vec![
            DocOp::Insert {
                ns: ns(),
                documents: vec![doc.clone()],
                ordered: true,
            },
            DocOp::Update {
                ns: ns(),
                filter: doc.clone(),
                update: Json::parse(r#"{"$set":{"a":2}}"#).expect("json"),
                many: false,
                upsert: false,
                array_filters: None,
            },
            DocOp::Replace {
                ns: ns(),
                filter: doc.clone(),
                replacement: doc.clone(),
                upsert: false,
            },
            DocOp::Delete {
                ns: ns(),
                filter: doc.clone(),
                many: false,
            },
            DocOp::CreateIndexes {
                ns: ns(),
                indexes: vec![],
            },
            DocOp::DropIndexes {
                ns: ns(),
                name: "a_1".into(),
            },
            DocOp::CreateCollection {
                database: "shop".into(),
                name: "x".into(),
                options: Json::empty(),
            },
            DocOp::DropCollection { ns: ns() },
            DocOp::DropDatabase {
                database: "shop".into(),
            },
            DocOp::RenameCollection {
                from: ns(),
                to: Namespace::new("shop", "y"),
                drop_target: false,
            },
            DocOp::Aggregate {
                database: "shop".into(),
                collection: Some("orders".into()),
                pipeline: vec![Json::parse(r#"{"$out":"copy"}"#).expect("json")],
                allow_disk_use: None,
                batch_size: None,
                options: Default::default(),
            },
            DocOp::RunCommand {
                database: "shop".into(),
                command: Json::parse(r#"{"insert":"orders","documents":[{}]}"#).expect("json"),
            },
        ]
    }

    #[tokio::test]
    async fn read_only_refuses_every_write_before_sending_it() {
        let conn = FakeDocs::default();
        let (ctx, _) = ctx(true);
        for op in every_write() {
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            let err = run(&ctx, &conn, request(&op, Origin::User, true), tx)
                .await
                .expect_err("refused");
            assert_eq!(
                err.code,
                crate::db::errors::ErrorCode::ReadOnlyViolation,
                "{}",
                op.display()
            );
        }
        assert!(
            conn.sent.lock().expect("lock").is_empty(),
            "nothing reached the driver"
        );
        let find = DocOp::Find {
            ns: ns(),
            filter: Json::empty(),
            options: Default::default(),
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        assert!(
            run(&ctx, &conn, request(&find, Origin::User, false), tx)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn dangerous_operations_wait_for_a_confirmation_with_their_effect() {
        let conn = FakeDocs::default();
        let (ctx, log) = ctx(false);
        let op = DocOp::Delete {
            ns: ns(),
            filter: Json::empty(),
            many: true,
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let outcome = run(&ctx, &conn, request(&op, Origin::User, false), tx)
            .await
            .expect("ok");
        let GateOutcome::Confirm(report) = outcome else {
            panic!("a confirmation");
        };
        assert_eq!(report.kind, DangerKind::DeleteAll);
        assert_eq!(report.command, "deleteMany");
        assert_eq!(report.documents, Some(1234.0));
        // Only the count was sent (and logged, as yadbe's own).
        assert_eq!(conn.sent.lock().expect("lock").len(), 1);
        assert_eq!(log.0.lock().expect("lock").len(), 1);
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        assert!(matches!(
            run(&ctx, &conn, request(&op, Origin::User, true), tx).await,
            Ok(GateOutcome::Done(_))
        ));
        assert_eq!(conn.sent.lock().expect("lock").len(), 2);
        assert_eq!(
            log.0.lock().expect("lock").len(),
            1,
            "user operations go to the history"
        );

        let drop = DocOp::DropDatabase {
            database: "shop".into(),
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let Ok(GateOutcome::Confirm(report)) =
            run(&ctx, &conn, request(&drop, Origin::User, false), tx).await
        else {
            panic!("a confirmation");
        };
        assert_eq!(report.collections, Some(2.0));
    }

    #[tokio::test]
    async fn a_timeout_kills_the_operation() {
        let conn = FakeDocs {
            slow: true,
            ..FakeDocs::default()
        };
        let (ctx, _) = ctx(false);
        let op = DocOp::Find {
            ns: ns(),
            filter: Json::empty(),
            options: Default::default(),
        };
        let mut req = request(&op, Origin::User, false);
        req.max_time = Some(Duration::from_millis(1));
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let err = run(&ctx, &conn, req, tx).await.expect_err("timed out");
        assert_eq!(err.code, crate::db::errors::ErrorCode::StatementTimeout);
        assert_eq!(*conn.killed.lock().expect("lock"), vec!["t1".to_owned()]);
    }
}
