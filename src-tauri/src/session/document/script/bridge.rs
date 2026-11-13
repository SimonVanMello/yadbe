//! What a script's native calls do, on the script's thread: a request from the prelude
//! (JSON, values in canonical Extended JSON) becomes a typed [`DocOp`] that goes through the
//! gate, and the thread blocks until it answers, is cancelled or runs out of time. A
//! dangerous operation pauses the script on the user's confirmation. The runtime never calls
//! the driver.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::db::document::json::Json;
use crate::db::document::ops::{
    AggregateOptions, BulkOperation, DocEvent, DocOp, DocReply, FindAndModify, FindAndModifyAction,
    FindOptions, Namespace,
};
use crate::db::driver::DocumentConnection;
use crate::db::errors::{ErrorCode, YadbeError};
use crate::session::ConnectionSession;
use crate::session::document::gate::{
    self, DangerReport, GateContext, GateOutcome, GateRequest, Origin,
};
use crate::session::document::model::{ScriptMessage, ScriptMessageKind};

use super::ScriptControl;

/// Documents a command answering with a cursor (`db.runCommand({ find: … })`, the indexes,
/// the collections) keeps; a `find` read through a cursor object has no such cap.
const MAX_COMMAND_DOCUMENTS: u64 = 100_000;
/// Batches a cursor reads ahead of the script.
const CURSOR_AHEAD: usize = 2;
/// The messages pane keeps this many lines…
const MAX_MESSAGES: usize = 10_000;
/// …and this much text.
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
/// The gate's own timeout fires first (it kills the operation); this is the backstop.
const WAIT_GRACE: Duration = Duration::from_secs(3);
/// Printed lines go to the front at most this often while the script computes; a script
/// about to wait on the server or the user hands them over first.
const OUTPUT_EVERY: Duration = Duration::from_millis(100);

/// Asks the front for a confirmation (an event); the answer comes back through
/// [`ScriptControl::answer`].
pub type ConfirmHook = Arc<dyn Fn(u32, DangerReport) + Send + Sync>;

/// Hands the lines printed since the last call to the front while the script runs (an
/// event); the outcome still carries every line.
pub type OutputHook = Arc<dyn Fn(Vec<ScriptMessage>) + Send + Sync>;

/// A cursor open on the server, read batch by batch. Dropping it closes the cursor: the
/// driver's next batch finds no reader, stops (closing the server cursor) and the gate
/// records the operation as it ended.
pub struct OpenCursor {
    pub rx: mpsc::Receiver<DocEvent>,
    pub task: JoinHandle<Result<GateOutcome, YadbeError>>,
    pub token: String,
}

pub struct Bridge {
    pub handle: Handle,
    pub session: Arc<ConnectionSession>,
    pub conn: Arc<dyn DocumentConnection>,
    pub control: Arc<ScriptControl>,
    pub confirm: ConfirmHook,
    output: OutputHook,
    pub started: Instant,
    errors: RefCell<Vec<YadbeError>>,
    cursors: RefCell<HashMap<u32, OpenCursor>>,
    next_cursor: Cell<u32>,
    messages: RefCell<Vec<ScriptMessage>>,
    message_bytes: Cell<usize>,
    messages_truncated: Cell<bool>,
    /// Messages already handed to [`Self::output`], and when.
    streamed: Cell<usize>,
    streamed_at: Cell<Instant>,
}

fn invalid(what: &str) -> YadbeError {
    YadbeError::invalid_argument(
        format!("The script's request is not valid: {what}."),
        format!("La requête du script n'est pas valide : {what}."),
    )
}

fn field<'a>(request: &'a Json, key: &str) -> Result<&'a Json, YadbeError> {
    request
        .get(key)
        .ok_or_else(|| invalid(&format!("{key} is missing")))
}

fn text(request: &Json, key: &str) -> Result<String, YadbeError> {
    field(request, key)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid(&format!("{key} is not a string")))
}

fn flag(request: &Json, key: &str) -> bool {
    matches!(request.get(key), Some(Json::Bool(true)))
}

/// An integer in any Extended JSON form.
fn integer(json: &Json) -> Option<i64> {
    match json {
        Json::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Json::Object(_) => ["$numberInt", "$numberLong", "$numberDouble"]
            .iter()
            .find_map(|k| json.get(k))
            .and_then(Json::as_str)
            .and_then(|t| t.parse::<f64>().ok())
            .map(|f| f as i64),
        _ => None,
    }
}

fn opt_integer(request: &Json, key: &str) -> Result<Option<i64>, YadbeError> {
    match request.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(json) => integer(json)
            .map(Some)
            .ok_or_else(|| invalid(&format!("{key} is not a number"))),
    }
}

fn opt(request: &Json, key: &str) -> Option<Json> {
    request
        .get(key)
        .filter(|j| !matches!(j, Json::Null))
        .cloned()
}

fn list(request: &Json, key: &str) -> Result<Vec<Json>, YadbeError> {
    field(request, key)?
        .as_array()
        .map(<[Json]>::to_vec)
        .ok_or_else(|| invalid(&format!("{key} is not an array")))
}

fn opt_list(request: &Json, key: &str) -> Result<Option<Vec<Json>>, YadbeError> {
    match request.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(_) => list(request, key).map(Some),
    }
}

fn ns(request: &Json) -> Result<Namespace, YadbeError> {
    Ok(Namespace::new(text(request, "db")?, text(request, "coll")?))
}

fn to_u32(n: Option<i64>) -> Option<u32> {
    n.map(|n| u32::try_from(n.max(0)).unwrap_or(u32::MAX))
}

fn to_u64(n: Option<i64>) -> Option<u64> {
    n.map(|n| u64::try_from(n.max(0)).unwrap_or(0))
}

/// How the bridge sends a request: through a cursor read lazily, or as one operation whose
/// cursor documents (if any) are collected up to a cap.
pub enum Planned {
    Cursor(DocOp),
    Once(DocOp),
}

fn aggregate_options(
    options: &Json,
) -> Result<(AggregateOptions, Option<bool>, Option<u32>), YadbeError> {
    for (key, _) in options.as_object().unwrap_or(&[]) {
        if !matches!(
            key.as_str(),
            "allowDiskUse" | "batchSize" | "hint" | "collation" | "maxTimeMS" | "comment" | "let"
        ) {
            return Err(invalid(&format!("unknown aggregate option {key}")));
        }
    }
    Ok((
        AggregateOptions {
            hint: opt(options, "hint"),
            collation: opt(options, "collation"),
            max_time_ms: to_u64(opt_integer(options, "maxTimeMS")?),
            comment: opt(options, "comment"),
            variables: opt(options, "let"),
        },
        match options.get("allowDiskUse") {
            Some(Json::Bool(b)) => Some(*b),
            _ => None,
        },
        to_u32(opt_integer(options, "batchSize")?),
    ))
}

/// The typed operation a prelude request stands for.
pub fn plan(request: &Json) -> Result<Planned, YadbeError> {
    let kind = text(request, "op")?;
    let empty = Json::empty();
    Ok(match kind.as_str() {
        "find" => {
            let options = request.get("options").unwrap_or(&empty);
            Planned::Cursor(DocOp::Find {
                ns: ns(request)?,
                filter: field(request, "filter")?.clone(),
                options: FindOptions {
                    projection: opt(options, "projection"),
                    sort: opt(options, "sort"),
                    skip: to_u64(opt_integer(options, "skip")?),
                    limit: opt_integer(options, "limit")?,
                    hint: opt(options, "hint"),
                    collation: opt(options, "collation"),
                    batch_size: to_u32(opt_integer(options, "batchSize")?),
                    max_time_ms: to_u64(opt_integer(options, "maxTimeMS")?),
                    comment: opt(options, "comment"),
                    allow_disk_use: match options.get("allowDiskUse") {
                        Some(Json::Bool(b)) => Some(*b),
                        _ => None,
                    },
                },
            })
        }
        "aggregate" | "aggregateAll" => {
            let (options, allow_disk_use, batch_size) =
                aggregate_options(request.get("options").unwrap_or(&empty))?;
            let op = DocOp::Aggregate {
                database: text(request, "db")?,
                collection: request
                    .get("coll")
                    .and_then(Json::as_str)
                    .map(str::to_owned),
                pipeline: list(request, "pipeline")?,
                allow_disk_use,
                batch_size,
                options,
            };
            if kind == "aggregate" {
                Planned::Cursor(op)
            } else {
                Planned::Once(op)
            }
        }
        "count" => Planned::Once(DocOp::Count {
            ns: ns(request)?,
            filter: field(request, "filter")?.clone(),
            limit: None,
        }),
        "estimatedCount" => Planned::Once(DocOp::EstimatedCount { ns: ns(request)? }),
        "distinct" => Planned::Once(DocOp::Distinct {
            ns: ns(request)?,
            key: text(request, "key")?,
            filter: field(request, "filter")?.clone(),
        }),
        "insert" => Planned::Once(DocOp::Insert {
            ns: ns(request)?,
            documents: list(request, "documents")?,
            ordered: flag(request, "ordered"),
        }),
        "update" => Planned::Once(DocOp::Update {
            ns: ns(request)?,
            filter: field(request, "filter")?.clone(),
            update: field(request, "update")?.clone(),
            many: flag(request, "many"),
            upsert: flag(request, "upsert"),
            array_filters: opt_list(request, "arrayFilters")?,
        }),
        "replace" => Planned::Once(DocOp::Replace {
            ns: ns(request)?,
            filter: field(request, "filter")?.clone(),
            replacement: field(request, "replacement")?.clone(),
            upsert: flag(request, "upsert"),
        }),
        "delete" => Planned::Once(DocOp::Delete {
            ns: ns(request)?,
            filter: field(request, "filter")?.clone(),
            many: flag(request, "many"),
        }),
        "findAndModify" => {
            let action = match text(request, "action")?.as_str() {
                "update" => FindAndModifyAction::Update(field(request, "update")?.clone()),
                "replace" => FindAndModifyAction::Replace(field(request, "update")?.clone()),
                "remove" => FindAndModifyAction::Remove,
                other => return Err(invalid(&format!("unknown findAndModify action {other}"))),
            };
            Planned::Once(DocOp::FindAndModify(Box::new(FindAndModify {
                ns: ns(request)?,
                filter: field(request, "filter")?.clone(),
                action,
                sort: opt(request, "sort"),
                projection: opt(request, "projection"),
                upsert: flag(request, "upsert"),
                return_new: flag(request, "returnNew"),
                array_filters: opt_list(request, "arrayFilters")?,
            })))
        }
        "bulkWrite" => {
            let operations = list(request, "operations")?
                .iter()
                .map(|entry| {
                    Ok(match text(entry, "kind")?.as_str() {
                        "insertOne" => BulkOperation::InsertOne {
                            document: field(entry, "document")?.clone(),
                        },
                        "update" => BulkOperation::Update {
                            filter: field(entry, "filter")?.clone(),
                            update: field(entry, "update")?.clone(),
                            many: flag(entry, "many"),
                            upsert: flag(entry, "upsert"),
                            array_filters: opt_list(entry, "arrayFilters")?,
                        },
                        "replaceOne" => BulkOperation::ReplaceOne {
                            filter: field(entry, "filter")?.clone(),
                            replacement: field(entry, "replacement")?.clone(),
                            upsert: flag(entry, "upsert"),
                        },
                        "delete" => BulkOperation::Delete {
                            filter: field(entry, "filter")?.clone(),
                            many: flag(entry, "many"),
                        },
                        other => return Err(invalid(&format!("unknown bulk operation {other}"))),
                    })
                })
                .collect::<Result<Vec<_>, YadbeError>>()?;
            Planned::Once(DocOp::BulkWrite {
                ns: ns(request)?,
                operations,
                ordered: flag(request, "ordered"),
            })
        }
        "listDatabases" => Planned::Once(DocOp::ListDatabases {
            filter: opt(request, "filter"),
        }),
        "listCollections" => Planned::Once(DocOp::ListCollections {
            database: text(request, "db")?,
            filter: opt(request, "filter"),
        }),
        "listIndexes" => Planned::Once(DocOp::ListIndexes { ns: ns(request)? }),
        "createIndexes" => Planned::Once(DocOp::CreateIndexes {
            ns: ns(request)?,
            indexes: list(request, "indexes")?,
        }),
        "dropIndexes" => Planned::Once(DocOp::DropIndexes {
            ns: ns(request)?,
            name: text(request, "name")?,
        }),
        "createCollection" => Planned::Once(DocOp::CreateCollection {
            database: text(request, "db")?,
            name: text(request, "name")?,
            options: opt(request, "options").unwrap_or_else(Json::empty),
        }),
        "dropCollection" => Planned::Once(DocOp::DropCollection { ns: ns(request)? }),
        "dropDatabase" => Planned::Once(DocOp::DropDatabase {
            database: text(request, "db")?,
        }),
        "renameCollection" => Planned::Once(DocOp::RenameCollection {
            from: ns(request)?,
            to: Namespace::new(text(request, "toDb")?, text(request, "to")?),
            drop_target: flag(request, "dropTarget"),
        }),
        "explain" => Planned::Once(DocOp::Explain {
            database: text(request, "db")?,
            command: field(request, "command")?.clone(),
            verbosity: text(request, "verbosity")?,
        }),
        "runCommand" => Planned::Once(DocOp::RunCommand {
            database: text(request, "db")?,
            command: field(request, "command")?.clone(),
        }),
        other => return Err(invalid(&format!("unknown operation {other}"))),
    })
}

/// The JavaScript error class a typed error is thrown as, and the server's code when known.
fn js_error(error: &YadbeError) -> (&'static str, String, Option<(i64, String)>) {
    match error.code {
        ErrorCode::QueryFailed => {
            let detail = error
                .detail
                .clone()
                .unwrap_or_else(|| error.message.en.clone());
            // `query_failed` details end with "(CodeName, code N)".
            let code = detail.rsplit_once(" (").and_then(|(message, tail)| {
                let (name, number) = tail.strip_suffix(')')?.split_once(", code ")?;
                Some((
                    message.to_owned(),
                    number.parse::<i64>().ok()?,
                    name.to_owned(),
                ))
            });
            match code {
                Some((message, number, name)) => {
                    let name = if name.is_empty() {
                        code_name(number).to_owned()
                    } else {
                        name
                    };
                    ("MongoServerError", message, Some((number, name)))
                }
                None => ("MongoServerError", detail, None),
            }
        }
        ErrorCode::ObjectNotFound => (
            "MongoServerError",
            error
                .detail
                .clone()
                .unwrap_or_else(|| error.message.en.clone()),
            Some((26, "NamespaceNotFound".to_owned())),
        ),
        ErrorCode::StatementTimeout => (
            "MongoServerError",
            error.message.en.clone(),
            Some((50, "MaxTimeMSExpired".to_owned())),
        ),
        ErrorCode::InvalidArgument => ("MongoshInvalidInputError", describe(error), None),
        ErrorCode::Cancelled => ("MongoshInterruptedError", describe(error), None),
        ErrorCode::NotSupported => ("MongoshUnimplementedError", error.message.en.clone(), None),
        _ => ("MongoshRuntimeError", describe(error), None),
    }
}

/// The name of the server codes a write error reports without one.
fn code_name(code: i64) -> &'static str {
    match code {
        2 => "BadValue",
        9 => "FailedToParse",
        11 => "UserNotFound",
        13 => "Unauthorized",
        26 => "NamespaceNotFound",
        27 => "IndexNotFound",
        50 => "MaxTimeMSExpired",
        66 => "ImmutableField",
        121 => "DocumentValidationFailure",
        11000 => "DuplicateKey",
        _ => "",
    }
}

fn describe(error: &YadbeError) -> String {
    match &error.detail {
        Some(detail) if !detail.is_empty() => format!("{} {detail}", error.message.en),
        _ => error.message.en.clone(),
    }
}

impl Bridge {
    pub fn new(
        handle: Handle,
        session: Arc<ConnectionSession>,
        conn: Arc<dyn DocumentConnection>,
        control: Arc<ScriptControl>,
        confirm: ConfirmHook,
        output: OutputHook,
    ) -> Self {
        let started = Instant::now();
        Self {
            handle,
            session,
            conn,
            control,
            confirm,
            output,
            started,
            errors: RefCell::new(Vec::new()),
            cursors: RefCell::new(HashMap::new()),
            next_cursor: Cell::new(1),
            messages: RefCell::new(Vec::new()),
            message_bytes: Cell::new(0),
            messages_truncated: Cell::new(false),
            streamed: Cell::new(0),
            streamed_at: Cell::new(started),
        }
    }

    // --- Errors kept for the run's outcome ---------------------------------------------------

    /// Keeps `error` and answers the JSON the prelude throws from.
    pub fn error_json(&self, error: YadbeError) -> String {
        let (name, message, code) = js_error(&error);
        let id = self.stash(error);
        let mut info = vec![
            ("id".to_owned(), Json::int(i64::from(id))),
            ("name".to_owned(), Json::string(name)),
            ("message".to_owned(), Json::string(message)),
        ];
        if let Some((number, code_name)) = code {
            info.push(("code".to_owned(), Json::int(number)));
            info.push(("codeName".to_owned(), Json::string(code_name)));
        }
        Json::object([("error", Json::Object(info))]).to_text()
    }

    pub fn stash(&self, error: YadbeError) -> u32 {
        let mut errors = self.errors.borrow_mut();
        errors.push(error);
        u32::try_from(errors.len() - 1).unwrap_or(u32::MAX)
    }

    pub fn stashed(&self, id: i64) -> Option<YadbeError> {
        let index = usize::try_from(id).ok()?;
        self.errors.borrow().get(index).cloned()
    }

    // --- Messages ----------------------------------------------------------------------------

    pub fn print(&self, kind: ScriptMessageKind, text: String) {
        if self.messages_truncated.get() {
            return;
        }
        let bytes = self.message_bytes.get() + text.len();
        let mut messages = self.messages.borrow_mut();
        if messages.len() >= MAX_MESSAGES || bytes > MAX_MESSAGE_BYTES {
            self.messages_truncated.set(true);
            return;
        }
        self.message_bytes.set(bytes);
        messages.push(ScriptMessage {
            kind,
            text,
            at_ms: (self.started.elapsed().as_secs_f64() * 1000.0).round(),
        });
        drop(messages);
        if self.streamed_at.get().elapsed() >= OUTPUT_EVERY {
            self.stream_messages();
        }
    }

    /// Hands the lines printed since the last time to the front.
    pub fn stream_messages(&self) {
        let messages = self.messages.borrow();
        let from = self.streamed.get();
        if from < messages.len() {
            (self.output)(messages[from..].to_vec());
            self.streamed.set(messages.len());
        }
        self.streamed_at.set(Instant::now());
    }

    pub fn take_messages(&self) -> (Vec<ScriptMessage>, bool) {
        (
            std::mem::take(&mut *self.messages.borrow_mut()),
            self.messages_truncated.get(),
        )
    }

    // --- Waiting -----------------------------------------------------------------------------

    /// Blocks the script's thread on `work`, until it ends, the run is cancelled or its time
    /// is up.
    pub fn wait<F: std::future::Future>(&self, work: F) -> Result<F::Output, YadbeError> {
        self.stream_messages();
        let control = &self.control;
        self.handle.block_on(async {
            let deadline = async {
                match control.deadline {
                    Some(at) => tokio::time::sleep_until((at + WAIT_GRACE).into()).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                () = control.cancel.cancelled() => Err(YadbeError::cancelled()),
                () = deadline => Err(control.timeout_error()),
                out = work => Ok(out),
            }
        })
    }

    pub fn sleep(&self, ms: f64) -> String {
        let ms = if ms.is_finite() { ms.max(0.0) } else { 0.0 };
        let until = Duration::from_secs_f64(ms / 1000.0);
        let stop = self
            .control
            .deadline
            .map(|at| at.saturating_duration_since(Instant::now()));
        if stop.is_some_and(|left| left < until) {
            // The timeout falls inside the sleep: wait until then and stop.
            let left = stop.unwrap_or_default();
            let _ = self.wait(async move { tokio::time::sleep(left).await });
            return self.error_json(self.control.timeout_error());
        }
        match self.wait(async move { tokio::time::sleep(until).await }) {
            Ok(()) => r#"{"ok":true}"#.to_owned(),
            Err(err) => self.error_json(err),
        }
    }

    // --- Operations --------------------------------------------------------------------------

    /// One request of the prelude, through the gate; the JSON answer or error.
    pub fn op(&self, request: &str) -> String {
        match self.op_inner(request) {
            Ok(reply) => reply,
            Err(err) => self.error_json(err),
        }
    }

    fn op_inner(&self, request: &str) -> Result<String, YadbeError> {
        let request = Json::parse(request)?;
        let op = match plan(&request)? {
            Planned::Once(op) | Planned::Cursor(op) => op,
        };
        let (reply, documents) = self.gated(&op, Some(MAX_COMMAND_DOCUMENTS))?;
        Ok(match reply {
            DocReply::Document(reply) => Json::object([("reply", reply)]).to_text(),
            DocReply::Cursor { more, .. } => Json::object([
                ("documents", Json::Array(documents)),
                ("more", Json::Bool(more)),
            ])
            .to_text(),
        })
    }

    /// Runs `op` through the gate, asking for a confirmation when it is dangerous.
    fn gated(
        &self,
        op: &DocOp,
        max_documents: Option<u64>,
    ) -> Result<(DocReply, Vec<Json>), YadbeError> {
        let mut confirmed = false;
        loop {
            if let Some(stop) = self.control.stop_reason() {
                return Err(stop);
            }
            let token = uuid::Uuid::new_v4().to_string();
            self.control.track(&token);
            let ctx = GateContext::of(&self.session);
            let request = GateRequest {
                op,
                origin: Origin::Script,
                confirmed,
                max_time: self.control.remaining(),
                token: token.clone(),
                max_documents,
            };
            let conn = &*self.conn;
            let result = self.wait(async {
                let (tx, mut rx) = mpsc::channel(8);
                let collect = async {
                    let mut documents = Vec::new();
                    while let Some(DocEvent::Documents(batch)) = rx.recv().await {
                        documents.extend(batch);
                    }
                    documents
                };
                let (outcome, documents) =
                    tokio::join!(gate::run(&ctx, conn, request, tx), collect);
                outcome.map(|outcome| (outcome, documents))
            });
            self.control.untrack(&token);
            match result?? {
                (GateOutcome::Done(reply), documents) => return Ok((reply, documents)),
                (GateOutcome::Confirm(report), _) => {
                    if confirmed {
                        return Err(YadbeError::internal("a confirmed operation asked again"));
                    }
                    let command = report.command.clone();
                    if !self.ask(report)? {
                        return Err(YadbeError::danger_declined(&command));
                    }
                    confirmed = true;
                }
            }
        }
    }

    /// Asks the user about a dangerous operation and waits for the answer.
    fn ask(&self, danger: DangerReport) -> Result<bool, YadbeError> {
        let (tx, rx) = oneshot::channel();
        let id = self.control.pending(tx);
        (self.confirm)(id, danger);
        let answer = self.wait(rx);
        self.control.forget_pending(id);
        Ok(answer?.unwrap_or(false))
    }

    // --- Cursors -----------------------------------------------------------------------------

    /// Opens a cursor (`find`, `aggregate`) and reads its first batch, so that an error (a
    /// write refused, a bad pipeline) stops the script where mongosh would.
    pub fn cursor_open(&self, request: &str) -> String {
        match self.cursor_open_inner(request) {
            Ok(reply) => reply,
            Err(err) => self.error_json(err),
        }
    }

    fn cursor_open_inner(&self, request: &str) -> Result<String, YadbeError> {
        let request = Json::parse(request)?;
        let Planned::Cursor(op) = plan(&request)? else {
            return Err(invalid("not a cursor operation"));
        };
        if let Some(stop) = self.control.stop_reason() {
            return Err(stop);
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.control.track(&token);
        let (tx, rx) = mpsc::channel(CURSOR_AHEAD);
        let ctx = GateContext::of(&self.session);
        let conn = Arc::clone(&self.conn);
        let max_time = self.control.remaining();
        let task_token = token.clone();
        let task = self.handle.spawn(async move {
            let request = GateRequest {
                op: &op,
                origin: Origin::Script,
                confirmed: false,
                max_time,
                token: task_token,
                max_documents: None,
            };
            gate::run(&ctx, &*conn, request, tx).await
        });
        let id = self.next_cursor.get();
        self.next_cursor.set(id + 1);
        self.cursors
            .borrow_mut()
            .insert(id, OpenCursor { rx, task, token });
        let first = self.cursor_read(id)?;
        let mut reply = vec![("id".to_owned(), Json::int(i64::from(id)))];
        reply.extend(first.as_object().unwrap_or(&[]).iter().cloned());
        Ok(Json::Object(reply).to_text())
    }

    /// The next batch of a cursor: `{"documents": […]}` or `{"done": true}`.
    pub fn cursor_next(&self, id: f64) -> String {
        let id = id as u32;
        match self.cursor_read(id) {
            Ok(reply) => reply.to_text(),
            Err(err) => self.error_json(err),
        }
    }

    fn cursor_read(&self, id: u32) -> Result<Json, YadbeError> {
        let Some(mut cursor) = self.cursors.borrow_mut().remove(&id) else {
            return Ok(Json::object([("done", Json::Bool(true))]));
        };
        let next = match self.wait(cursor.rx.recv()) {
            Ok(next) => next,
            Err(stop) => {
                self.end(cursor);
                return Err(stop);
            }
        };
        match next {
            Some(DocEvent::Documents(batch)) => {
                self.cursors.borrow_mut().insert(id, cursor);
                Ok(Json::object([("documents", Json::Array(batch))]))
            }
            None => {
                let outcome = self.wait(&mut cursor.task);
                self.end(cursor);
                match outcome? {
                    Ok(Ok(GateOutcome::Done(_))) => Ok(Json::object([("done", Json::Bool(true))])),
                    Ok(Ok(GateOutcome::Confirm(_))) => Err(YadbeError::internal(
                        "a cursor operation asked for a confirmation",
                    )),
                    Ok(Err(err)) => Err(err),
                    Err(join) => Err(YadbeError::internal(format!("cursor task: {join}"))),
                }
            }
        }
    }

    fn end(&self, cursor: OpenCursor) {
        self.control.untrack(&cursor.token);
    }

    pub fn cursor_close(&self, id: f64) {
        let cursor = self.cursors.borrow_mut().remove(&(id as u32));
        if let Some(cursor) = cursor {
            self.end(cursor);
        }
    }

    /// The cursor a script's result is: it leaves the script's thread to be drained.
    pub fn take_cursor(&self, id: u32) -> Option<OpenCursor> {
        self.cursors.borrow_mut().remove(&id)
    }

    /// Closes every cursor the script left open.
    pub fn close_all(&self) {
        let cursors: Vec<OpenCursor> = self.cursors.borrow_mut().drain().map(|(_, c)| c).collect();
        for cursor in cursors {
            self.end(cursor);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Json {
        Json::parse(text).expect("json")
    }

    #[test]
    fn requests_become_typed_operations() {
        let find = plan(&json(
            r#"{"op":"find","db":"shop","coll":"orders","filter":{"a":{"$numberInt":"1"}},
               "options":{"limit":{"$numberInt":"-1"},"sort":{"_id":{"$numberInt":"1"}},"maxTimeMS":{"$numberInt":"50"}}}"#,
        ))
        .expect("plan");
        let Planned::Cursor(DocOp::Find { ns, options, .. }) = find else {
            panic!("a find cursor");
        };
        assert_eq!(ns, Namespace::new("shop", "orders"));
        assert_eq!(options.limit, Some(-1));
        assert_eq!(options.max_time_ms, Some(50));
        let bulk = plan(&json(
            r#"{"op":"bulkWrite","db":"shop","coll":"orders","ordered":true,"operations":[
                {"kind":"insertOne","document":{"_id":{"$numberInt":"1"}}},
                {"kind":"delete","filter":{},"many":true}]}"#,
        ))
        .expect("plan");
        let Planned::Once(DocOp::BulkWrite { operations, .. }) = bulk else {
            panic!("a bulk write");
        };
        assert_eq!(operations.len(), 2);
        assert!(plan(&json(r#"{"op":"eval","db":"x"}"#)).is_err());
        assert!(
            plan(&json(
                r#"{"op":"aggregate","db":"x","pipeline":[],"options":{"out":1}}"#
            ))
            .is_err()
        );
    }

    #[test]
    fn server_errors_keep_their_code() {
        let err = YadbeError::query_failed("E11000 duplicate key error (DuplicateKey, code 11000)");
        let (name, message, code) = js_error(&err);
        assert_eq!(name, "MongoServerError");
        assert_eq!(message, "E11000 duplicate key error");
        assert_eq!(code, Some((11000, "DuplicateKey".to_owned())));
    }
}
