//! MongoDB driver (M4-2), on the official `mongodb` crate (tokio, rustls + ring).
//!
//! - **Connecting**: the definition's fields become a connection string without credentials
//!   (hosts, database, pass-through options); the password, TLS files, replica set, direct
//!   connection and timeouts are then set on the parsed options, so a secret never sits in a
//!   string. `mongodb+srv://` resolves through DNS. Through an SSH tunnel the client goes
//!   straight to the tunnel's loopback end (`directConnection`).
//! - **Operations**: every [`DocOp`] becomes the server command it stands for and runs in an
//!   explicit session, whose id is the handle a cancel uses: `$currentOp` finds the
//!   operations of that session and `killOp` stops them, whatever the command was.
//! - **Values**: documents leave as canonical Extended JSON (`convert.rs`).

mod convert;
mod errors;

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use mongodb::bson::{Bson, Document, doc};
use mongodb::options::{AuthMechanism, ClientOptions, Credential, Tls, TlsOptions};
use mongodb::{Client, ClientSession};
use zeroize::Zeroizing;

use crate::db::config::{AuthMethod, ConnectTarget, TlsMode};
use crate::db::document::json::Json;
use crate::db::document::ops::{
    DocEvent, DocOp, DocReply, DocSender, DocTopology, ExecOptions, FindOptions,
};
use crate::db::document::settings::{
    MongoAuthMechanism, MongoSettings, percent_encode, seed_hosts,
};
use crate::db::driver::{
    Backend, BoxFuture, CancelHandle, ConnectRequest, DocumentConnection, Driver, Link, LinkSignal,
    LinkWatch, StatementRecorder, recorded,
};
use crate::db::engine::Engine;
use crate::db::errors::YadbeError;
use crate::db::tls_identity::TlsIdentity;

use convert::{document_to_json, json_to_bson, json_to_document};

const APP_NAME: &str = "yadbe";
/// Documents sent to the receiver at a time.
const EVENT_BATCH: usize = 100;

pub struct MongoDriver;

impl Driver for MongoDriver {
    fn engine(&self) -> Engine {
        Engine::Mongodb
    }

    fn connect<'a>(
        &'a self,
        request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Backend, YadbeError>> {
        Box::pin(async move {
            let target = request.target;
            match tokio::time::timeout(target.connect_timeout, connect(request)).await {
                Ok(result) => result,
                Err(_) => Err(YadbeError::connection_timeout(
                    &target.host,
                    timeout_secs(target),
                )),
            }
        })
    }
}

fn timeout_secs(target: &ConnectTarget) -> u32 {
    u32::try_from(target.connect_timeout.as_secs()).unwrap_or(u32::MAX)
}

fn endpoint(target: &ConnectTarget) -> errors::Endpoint<'_> {
    errors::Endpoint {
        host: &target.host,
        port: target.port,
        user: &target.username,
        timeout_secs: timeout_secs(target),
    }
}

/// The connection string of a target, without credentials or TLS files.
fn connection_uri(target: &ConnectTarget, settings: &MongoSettings) -> Result<String, YadbeError> {
    let hosts = match target.dial {
        Some(addr) => addr.to_string(),
        None if settings.srv => target.host.trim().to_owned(),
        None => seed_hosts(&target.host)
            .ok_or_else(|| {
                YadbeError::invalid_argument(
                    "The hosts must be written host[:port], separated by commas.",
                    "Les hôtes s'écrivent hôte[:port], séparés par des virgules.",
                )
            })?
            .into_iter()
            .map(|seed| {
                let host = if seed.host.contains(':') {
                    format!("[{}]", seed.host)
                } else {
                    seed.host
                };
                format!("{host}:{}", seed.port.unwrap_or(target.port))
            })
            .collect::<Vec<_>>()
            .join(","),
    };
    let scheme = if settings.srv && target.dial.is_none() {
        "mongodb+srv"
    } else {
        "mongodb"
    };
    let mut uri = format!("{scheme}://{hosts}/");
    if !target.database.is_empty() {
        uri.push_str(&percent_encode(&target.database));
    }
    let query: Vec<String> = target
        .options
        .iter()
        .map(|o| format!("{}={}", percent_encode(&o.key), percent_encode(&o.value)))
        .collect();
    if !query.is_empty() {
        uri.push('?');
        uri.push_str(&query.join("&"));
    }
    Ok(uri)
}

/// A PEM file holding the client certificate and its decrypted key, for as long as the client
/// is being built: the driver reads TLS files only by path, when the client is created.
struct IdentityFile(PathBuf);

impl IdentityFile {
    fn write(identity: &TlsIdentity) -> Result<Self, YadbeError> {
        let path = std::env::temp_dir().join(format!("yadbe-{}.pem", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut pem = Zeroizing::new(identity.cert_pem().to_vec());
        pem.push(b'\n');
        pem.extend_from_slice(identity.key_pem());
        let file = Self(path);
        options
            .open(&file.0)
            .and_then(|mut f| f.write_all(&pem))
            .map_err(|e| {
                YadbeError::tls_client_cert_invalid(format!(
                    "cannot prepare the client certificate: {e}"
                ))
            })?;
        Ok(file)
    }
}

impl Drop for IdentityFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn credential(
    target: &ConnectTarget,
    settings: &MongoSettings,
    password: Option<String>,
) -> Option<Credential> {
    let user = Some(target.username.clone()).filter(|u| !u.is_empty());
    if settings.auth_mechanism == MongoAuthMechanism::X509 {
        return Some(
            Credential::builder()
                .username(user)
                .source(Some("$external".to_owned()))
                .mechanism(Some(AuthMechanism::MongoDbX509))
                .build(),
        );
    }
    if user.is_none() && password.is_none() {
        return None;
    }
    let source = settings
        .auth_source
        .clone()
        .or_else(|| Some(target.database.clone()).filter(|d| !d.is_empty()))
        .unwrap_or_else(|| "admin".to_owned());
    let mechanism = match settings.auth_mechanism {
        MongoAuthMechanism::ScramSha1 => Some(AuthMechanism::ScramSha1),
        MongoAuthMechanism::ScramSha256 => Some(AuthMechanism::ScramSha256),
        MongoAuthMechanism::Default | MongoAuthMechanism::X509 => None,
    };
    Some(
        Credential::builder()
            .username(user)
            .password(password)
            .source(Some(source))
            .mechanism(mechanism)
            .build(),
    )
}

async fn connect(request: ConnectRequest<'_>) -> Result<Backend, YadbeError> {
    let target = request.target;
    let settings = target.mongo.clone().unwrap_or_default();
    let uri = connection_uri(target, &settings)?;
    let mut options = ClientOptions::parse(uri.as_str())
        .await
        .map_err(|e| errors::from_connect_error(&e, &endpoint(target)))?;
    options.app_name = Some(APP_NAME.to_owned());
    options.connect_timeout = Some(target.connect_timeout);
    options.server_selection_timeout = Some(target.connect_timeout);
    if target.dial.is_some() || settings.direct_connection {
        options.direct_connection = Some(true);
    }
    if let Some(set) = &settings.replica_set {
        options.repl_set_name = Some(set.clone());
    }
    let password = match target_auth(target) {
        AuthMethod::Password => request.password.map(|p| p.expose().to_owned()),
        AuthMethod::None => None,
    };
    options.credential = credential(target, &settings, password);
    let identity_file = match (&target.tls_identity, target.tls_mode) {
        (Some(identity), TlsMode::Require | TlsMode::VerifyFull) => {
            Some(IdentityFile::write(identity)?)
        }
        _ => None,
    };
    options.tls = Some(match target.tls_mode {
        TlsMode::Disable | TlsMode::Prefer => Tls::Disabled,
        mode => Tls::Enabled(
            TlsOptions::builder()
                .ca_file_path(target.ca_cert_path.clone())
                .cert_key_file_path(identity_file.as_ref().map(|f| f.0.clone()))
                // `require` checks the chain only against a given CA (and then, with rustls,
                // the host name too): without one it only encrypts.
                .allow_invalid_certificates(
                    (mode == TlsMode::Require && target.ca_cert_path.is_none()).then_some(true),
                )
                .build(),
        ),
    });
    let client = Client::with_options(options)
        .map_err(|e| errors::from_connect_error(&e, &endpoint(target)))?;
    // The TLS files were read when the client was built.
    drop(identity_file);
    let recorder = Arc::clone(&request.recorder);
    let admin = client.database("admin");
    let hello = recorded(
        &*recorder,
        "use admin; db.runCommand({\"hello\":1})",
        |_| None,
        async {
            admin
                .run_command(doc! { "hello": 1 })
                .await
                .map_err(|e| errors::from_connect_error(&e, &endpoint(target)))
        },
    )
    .await?;
    let topology = if hello.get_str("setName").is_ok() {
        DocTopology::ReplicaSet
    } else if hello.get_str("msg").ok() == Some("isdbgrid") {
        DocTopology::Sharded
    } else {
        DocTopology::Standalone
    };
    let info = recorded(
        &*recorder,
        "use admin; db.runCommand({\"buildInfo\":1})",
        |_| None,
        async {
            admin
                .run_command(doc! { "buildInfo": 1 })
                .await
                .map_err(|e| errors::from_connect_error(&e, &endpoint(target)))
        },
    )
    .await?;
    let version = info.get_str("version").unwrap_or("").to_owned();
    let (signal, watch) = LinkWatch::new();
    Ok(Backend::Document(Arc::new(MongoConnection {
        client,
        version,
        topology,
        recorder,
        signal: Arc::new(signal),
        watch,
        running: Arc::new(Mutex::new(HashMap::new())),
    })))
}

/// X.509 needs no password whatever the saved auth says.
fn target_auth(target: &ConnectTarget) -> AuthMethod {
    match target.mongo.as_ref().map(|m| m.auth_mechanism) {
        Some(MongoAuthMechanism::X509) => AuthMethod::None,
        _ => AuthMethod::Password,
    }
}

type Running = Arc<Mutex<HashMap<String, Document>>>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct MongoConnection {
    client: Client,
    version: String,
    topology: DocTopology,
    recorder: Arc<dyn StatementRecorder>,
    signal: Arc<LinkSignal>,
    watch: LinkWatch,
    /// Session id (`lsid`) of each running operation, by the gate's token.
    running: Running,
}

/// Forgets a running operation when it ends, however it ends.
struct RunningGuard {
    running: Running,
    token: String,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        lock(&self.running).remove(&self.token);
    }
}

/// How an operation is sent.
enum Plan {
    /// A command that answers with a cursor (`find`, `aggregate`, `list*`).
    Cursor { database: String, command: Document },
    /// A command with one reply document; `write`: check its write errors.
    Command {
        database: String,
        command: Document,
        write: bool,
    },
    /// `countDocuments`: an aggregation whose one document holds the count.
    Count { database: String, command: Document },
    /// `estimatedDocumentCount`: the `count` command's `n`.
    Estimated { database: String, command: Document },
}

fn max_time(command: &mut Document, options: &ExecOptions) {
    if let Some(limit) = options.max_time {
        let ms = i64::try_from(limit.as_millis()).unwrap_or(i64::MAX).max(1);
        command.insert("maxTimeMS", ms);
    }
}

fn plan(op: &DocOp, options: &ExecOptions) -> Result<Plan, YadbeError> {
    let doc = json_to_document;
    let docs = |items: &[Json]| -> Result<Vec<Bson>, YadbeError> {
        items.iter().map(|d| doc(d).map(Bson::Document)).collect()
    };
    Ok(match op {
        DocOp::Find {
            ns,
            filter,
            options: find,
        } => {
            let FindOptions {
                projection,
                sort,
                skip,
                limit,
                hint,
                collation,
                batch_size,
            } = find;
            let mut command = doc! { "find": &ns.collection, "filter": doc(filter)? };
            if let Some(projection) = projection {
                command.insert("projection", doc(projection)?);
            }
            if let Some(sort) = sort {
                command.insert("sort", doc(sort)?);
            }
            if let Some(skip) = skip {
                command.insert("skip", i64::try_from(*skip).unwrap_or(i64::MAX));
            }
            if let Some(limit) = limit {
                command.insert("limit", limit.abs());
                if *limit < 0 {
                    command.insert("singleBatch", true);
                }
            }
            if let Some(hint) = hint {
                command.insert("hint", json_to_bson(hint)?);
            }
            if let Some(collation) = collation {
                command.insert("collation", doc(collation)?);
            }
            if let Some(size) = batch_size {
                command.insert("batchSize", i64::from(*size));
            }
            max_time(&mut command, options);
            Plan::Cursor {
                database: ns.database.clone(),
                command,
            }
        }
        DocOp::Aggregate {
            database,
            collection,
            pipeline,
            allow_disk_use,
            batch_size,
        } => {
            let target = collection
                .as_ref()
                .map_or(Bson::Int32(1), |c| Bson::String(c.clone()));
            let mut cursor = Document::new();
            if let Some(size) = batch_size {
                cursor.insert("batchSize", i64::from(*size));
            }
            let mut command =
                doc! { "aggregate": target, "pipeline": docs(pipeline)?, "cursor": cursor };
            if let Some(allow) = allow_disk_use {
                command.insert("allowDiskUse", *allow);
            }
            max_time(&mut command, options);
            Plan::Cursor {
                database: database.clone(),
                command,
            }
        }
        DocOp::Count { ns, filter, limit } => {
            let mut pipeline = vec![Bson::Document(doc! { "$match": doc(filter)? })];
            if let Some(limit) = limit {
                pipeline.push(Bson::Document(
                    doc! { "$limit": i64::try_from(*limit).unwrap_or(i64::MAX) },
                ));
            }
            pipeline.push(Bson::Document(
                doc! { "$group": { "_id": 1, "n": { "$sum": 1 } } },
            ));
            let mut command =
                doc! { "aggregate": &ns.collection, "pipeline": pipeline, "cursor": {} };
            max_time(&mut command, options);
            Plan::Count {
                database: ns.database.clone(),
                command,
            }
        }
        DocOp::EstimatedCount { ns } => {
            let mut command = doc! { "count": &ns.collection };
            max_time(&mut command, options);
            Plan::Estimated {
                database: ns.database.clone(),
                command,
            }
        }
        DocOp::Distinct { ns, key, filter } => {
            let mut command =
                doc! { "distinct": &ns.collection, "key": key, "query": doc(filter)? };
            max_time(&mut command, options);
            Plan::Command {
                database: ns.database.clone(),
                command,
                write: false,
            }
        }
        DocOp::Insert {
            ns,
            documents,
            ordered,
        } => Plan::Command {
            database: ns.database.clone(),
            command: doc! { "insert": &ns.collection, "documents": docs(documents)?, "ordered": *ordered },
            write: true,
        },
        DocOp::Update {
            ns,
            filter,
            update,
            many,
            upsert,
            array_filters,
        } => {
            let mut statement = doc! {
                "q": doc(filter)?,
                "u": json_to_bson(update)?,
                "multi": *many,
                "upsert": *upsert,
            };
            if let Some(filters) = array_filters {
                statement.insert("arrayFilters", docs(filters)?);
            }
            Plan::Command {
                database: ns.database.clone(),
                command: doc! { "update": &ns.collection, "updates": [statement] },
                write: true,
            }
        }
        DocOp::Replace {
            ns,
            filter,
            replacement,
            upsert,
        } => Plan::Command {
            database: ns.database.clone(),
            command: doc! {
                "update": &ns.collection,
                "updates": [{ "q": doc(filter)?, "u": doc(replacement)?, "multi": false, "upsert": *upsert }],
            },
            write: true,
        },
        DocOp::Delete { ns, filter, many } => Plan::Command {
            database: ns.database.clone(),
            command: doc! {
                "delete": &ns.collection,
                "deletes": [{ "q": doc(filter)?, "limit": if *many { 0 } else { 1 } }],
            },
            write: true,
        },
        DocOp::ListDatabases { filter } => {
            let mut command = doc! { "listDatabases": 1 };
            if let Some(filter) = filter {
                command.insert("filter", doc(filter)?);
            }
            Plan::Command {
                database: "admin".to_owned(),
                command,
                write: false,
            }
        }
        DocOp::ListCollections { database, filter } => {
            let mut command = doc! { "listCollections": 1, "cursor": {} };
            if let Some(filter) = filter {
                command.insert("filter", doc(filter)?);
            }
            Plan::Cursor {
                database: database.clone(),
                command,
            }
        }
        DocOp::ListIndexes { ns } => Plan::Cursor {
            database: ns.database.clone(),
            command: doc! { "listIndexes": &ns.collection, "cursor": {} },
        },
        DocOp::CreateIndexes { ns, indexes } => Plan::Command {
            database: ns.database.clone(),
            command: doc! { "createIndexes": &ns.collection, "indexes": docs(indexes)? },
            write: true,
        },
        DocOp::DropIndexes { ns, name } => Plan::Command {
            database: ns.database.clone(),
            command: doc! { "dropIndexes": &ns.collection, "index": name },
            write: true,
        },
        DocOp::CreateCollection {
            database,
            name,
            options,
        } => {
            let mut command = doc! { "create": name };
            command.extend(doc(options)?);
            Plan::Command {
                database: database.clone(),
                command,
                write: true,
            }
        }
        DocOp::DropCollection { ns } => Plan::Command {
            database: ns.database.clone(),
            command: doc! { "drop": &ns.collection },
            write: true,
        },
        DocOp::DropDatabase { database } => Plan::Command {
            database: database.clone(),
            command: doc! { "dropDatabase": 1 },
            write: true,
        },
        DocOp::RenameCollection {
            from,
            to,
            drop_target,
        } => Plan::Command {
            database: "admin".to_owned(),
            command: doc! {
                "renameCollection": format!("{}.{}", from.database, from.collection),
                "to": format!("{}.{}", to.database, to.collection),
                "dropTarget": *drop_target,
            },
            write: true,
        },
        DocOp::RunCommand { database, command } => {
            let command = doc(command)?;
            let name = command
                .keys()
                .next()
                .map(|k| k.to_ascii_lowercase())
                .unwrap_or_default();
            let explain = command.get_bool("explain").unwrap_or(false);
            let cursor = matches!(
                name.as_str(),
                "find" | "aggregate" | "listcollections" | "listindexes"
            ) && !explain;
            if cursor {
                Plan::Cursor {
                    database: database.clone(),
                    command,
                }
            } else {
                Plan::Command {
                    database: database.clone(),
                    command,
                    write: false,
                }
            }
        }
    })
}

/// The first write error of a write command's reply, as an error.
fn write_errors(reply: &Document) -> Option<YadbeError> {
    if let Ok(errors) = reply.get_array("writeErrors")
        && let Some(Bson::Document(first)) = errors.first()
    {
        let code = first.get_i32("code").unwrap_or(0);
        let message = first.get_str("errmsg").unwrap_or("write error");
        let name = first.get_str("codeName").unwrap_or("");
        return Some(errors::from_code(code, name, message, None));
    }
    if let Ok(concern) = reply.get_document("writeConcernError") {
        return Some(YadbeError::query_failed(
            concern.get_str("errmsg").unwrap_or("write concern error"),
        ));
    }
    None
}

fn count_of(doc: &Document, key: &str) -> i64 {
    match doc.get(key) {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        Some(Bson::Double(n)) => *n as i64,
        _ => 0,
    }
}

impl MongoConnection {
    fn lost_if_network(&self, err: &mongodb::error::Error) {
        use mongodb::error::ErrorKind;
        if matches!(
            &*err.kind,
            ErrorKind::Io(_)
                | ErrorKind::ServerSelection { .. }
                | ErrorKind::ConnectionPoolCleared { .. }
        ) {
            self.signal.lost();
        }
    }

    async fn run(
        &self,
        op: &DocOp,
        options: &ExecOptions,
        events: DocSender,
        session: &mut ClientSession,
    ) -> Result<DocReply, mongodb::error::Error> {
        let plan = match plan(op, options) {
            Ok(plan) => plan,
            Err(err) => return Err(mongodb::error::Error::custom(err)),
        };
        match plan {
            Plan::Cursor { database, command } => {
                let db = self.client.database(&database);
                let mut cursor = db
                    .run_cursor_command(command)
                    .session(&mut *session)
                    .await?;
                let mut batch = Vec::with_capacity(EVENT_BATCH);
                let mut documents = 0_u64;
                while let Some(document) = cursor.next(session).await {
                    batch.push(document_to_json(document?));
                    documents += 1;
                    let full = options.max_documents.is_some_and(|max| documents >= max);
                    if batch.len() >= EVENT_BATCH || full {
                        let sent = std::mem::replace(&mut batch, Vec::with_capacity(EVENT_BATCH));
                        if events.send(DocEvent::Documents(sent)).await.is_err() {
                            return Err(mongodb::error::Error::custom(YadbeError::cancelled()));
                        }
                    }
                    if full {
                        let more = cursor.advance(session).await.unwrap_or(false);
                        return Ok(DocReply::Cursor { documents, more });
                    }
                }
                if !batch.is_empty() && events.send(DocEvent::Documents(batch)).await.is_err() {
                    return Err(mongodb::error::Error::custom(YadbeError::cancelled()));
                }
                Ok(DocReply::Cursor {
                    documents,
                    more: false,
                })
            }
            Plan::Command {
                database,
                command,
                write,
            } => {
                let reply = self
                    .client
                    .database(&database)
                    .run_command(command)
                    .session(&mut *session)
                    .await?;
                if write && let Some(error) = write_errors(&reply) {
                    return Err(mongodb::error::Error::custom(error));
                }
                Ok(DocReply::Document(document_to_json(reply)))
            }
            Plan::Count { database, command } => {
                let db = self.client.database(&database);
                let mut cursor = db
                    .run_cursor_command(command)
                    .session(&mut *session)
                    .await?;
                let mut n = 0;
                if let Some(first) = cursor.next(session).await {
                    n = count_of(&first?, "n");
                }
                Ok(DocReply::Document(document_to_json(doc! { "count": n })))
            }
            Plan::Estimated { database, command } => {
                let reply = self
                    .client
                    .database(&database)
                    .run_command(command)
                    .session(&mut *session)
                    .await?;
                let n = count_of(&reply, "n");
                Ok(DocReply::Document(document_to_json(doc! { "count": n })))
            }
        }
    }
}

/// Kills on the server the operations of the session `lsid` (`$currentOp`, `killOp`).
async fn kill_session_ops(
    client: &Client,
    recorder: &dyn StatementRecorder,
    lsid: &Document,
) -> Result<(), YadbeError> {
    let Some(id) = lsid.get("id").cloned() else {
        return Ok(());
    };
    let admin = client.database("admin");
    let find = doc! {
        "aggregate": 1,
        "pipeline": [
            { "$currentOp": { "allUsers": false, "idleConnections": false, "idleSessions": false } },
            { "$match": { "lsid.id": id } },
            { "$project": { "opid": 1 } },
        ],
        "cursor": {},
    };
    let display = format!(
        "use admin; db.aggregate({})",
        document_to_json(find.clone()).to_text()
    );
    let opids = recorded(
        recorder,
        &display,
        |ids: &Vec<Bson>| u64::try_from(ids.len()).ok(),
        async {
            let mut cursor = admin
                .run_cursor_command(find)
                .await
                .map_err(|e| errors::from_error(&e, None))?;
            let mut ids = Vec::new();
            while cursor
                .advance()
                .await
                .map_err(|e| errors::from_error(&e, None))?
            {
                let current: Document = cursor
                    .deserialize_current()
                    .map_err(|e| errors::from_error(&e, None))?;
                if let Some(opid) = current.get("opid") {
                    ids.push(opid.clone());
                }
            }
            Ok(ids)
        },
    )
    .await?;
    for opid in opids {
        let command = doc! { "killOp": 1, "op": opid };
        let display = format!(
            "use admin; db.runCommand({})",
            document_to_json(command.clone()).to_text()
        );
        recorded(recorder, &display, |_| None, async {
            admin
                .run_command(command)
                .await
                .map(|_| ())
                .map_err(|e| errors::from_error(&e, None))
        })
        .await?;
    }
    Ok(())
}

impl Link for MongoConnection {
    fn server_version(&self) -> &str {
        &self.version
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            recorded(
                &*self.recorder,
                "use admin; db.runCommand({\"ping\":1})",
                |_| None,
                async {
                    self.client
                        .database("admin")
                        .run_command(doc! { "ping": 1 })
                        .await
                        .map(|_| ())
                        .map_err(|e| {
                            self.lost_if_network(&e);
                            errors::from_error(&e, None)
                        })
                },
            )
            .await
        })
    }

    fn keep_alive(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            self.client
                .database("admin")
                .run_command(doc! { "ping": 1 })
                .await
                .map(|_| ())
                .map_err(|e| {
                    self.lost_if_network(&e);
                    errors::from_error(&e, None)
                })
        })
    }

    fn link(&self) -> LinkWatch {
        self.watch.clone()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        Arc::new(MongoCancel {
            client: self.client.clone(),
            running: Arc::clone(&self.running),
            recorder: Arc::clone(&self.recorder),
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.client.clone().shutdown().immediate(true).await;
        })
    }
}

/// Cancels every operation running on the connection (the gate cancels one by its token).
struct MongoCancel {
    client: Client,
    running: Running,
    recorder: Arc<dyn StatementRecorder>,
}

impl CancelHandle for MongoCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async move {
            let sessions: Vec<Document> = lock(&self.running).values().cloned().collect();
            for lsid in sessions {
                kill_session_ops(&self.client, &*self.recorder, &lsid).await?;
            }
            Ok(())
        })
    }
}

impl DocumentConnection for MongoConnection {
    fn execute<'a>(
        &'a self,
        op: &'a DocOp,
        options: &'a ExecOptions,
        events: DocSender,
    ) -> BoxFuture<'a, Result<DocReply, YadbeError>> {
        Box::pin(async move {
            let timeout = options.max_time.map(|t| t.as_secs());
            let mut session = self.client.start_session().await.map_err(|e| {
                self.lost_if_network(&e);
                errors::from_error(&e, timeout)
            })?;
            lock(&self.running).insert(options.token.clone(), session.id().clone());
            let _guard = RunningGuard {
                running: Arc::clone(&self.running),
                token: options.token.clone(),
            };
            self.run(op, options, events, &mut session)
                .await
                .map_err(|e| {
                    if let mongodb::error::ErrorKind::Custom(custom) = &*e.kind
                        && let Some(error) = custom.downcast_ref::<YadbeError>()
                    {
                        return error.clone();
                    }
                    self.lost_if_network(&e);
                    errors::from_error(&e, timeout)
                })
        })
    }

    fn kill<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), YadbeError>> {
        Box::pin(async move {
            let lsid = lock(&self.running).get(token).cloned();
            match lsid {
                Some(lsid) => kill_session_ops(&self.client, &*self.recorder, &lsid).await,
                None => Ok(()),
            }
        })
    }

    fn topology(&self) -> DocTopology {
        self.topology
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::db::config::sample_definition;
    use crate::db::document::ops::Namespace;

    fn target(host: &str, settings: MongoSettings) -> ConnectTarget {
        let mut def = sample_definition(Engine::Mongodb);
        def.host = host.into();
        def.mongo = Some(settings);
        def.options = vec![crate::db::config::ConnectionOption {
            key: "readPreference".into(),
            value: "secondary preferred".into(),
        }];
        def.target()
    }

    #[test]
    fn connection_uris_hold_no_credentials() {
        let t = target("a, b:27018", MongoSettings::default());
        assert_eq!(
            connection_uri(&t, &MongoSettings::default()).expect("uri"),
            "mongodb://a:27017,b:27018/app?readPreference=secondary%20preferred"
        );
        let srv = MongoSettings {
            srv: true,
            ..MongoSettings::default()
        };
        let t = target("cluster.example.net", srv.clone());
        assert!(
            connection_uri(&t, &srv)
                .expect("uri")
                .starts_with("mongodb+srv://cluster.example.net/app")
        );
        let mut tunneled = target("db.internal", MongoSettings::default());
        tunneled.dial = Some("127.0.0.1:40000".parse().expect("addr"));
        assert!(
            connection_uri(&tunneled, &MongoSettings::default())
                .expect("uri")
                .starts_with("mongodb://127.0.0.1:40000/")
        );
    }

    #[test]
    fn plans_carry_the_statement_timeout() {
        let options = ExecOptions {
            max_time: Some(Duration::from_millis(1500)),
            token: "t".into(),
            max_documents: None,
        };
        let op = DocOp::Find {
            ns: Namespace::new("shop", "orders"),
            filter: Json::parse(r#"{"a":{"$gt":1}}"#).expect("json"),
            options: FindOptions {
                limit: Some(-5),
                ..FindOptions::default()
            },
        };
        let Plan::Cursor { command, .. } = plan(&op, &options).expect("plan") else {
            panic!("a cursor");
        };
        assert_eq!(command.get_i64("maxTimeMS").ok(), Some(1500));
        assert_eq!(command.get_i64("limit").ok(), Some(5));
        assert_eq!(command.get_bool("singleBatch").ok(), Some(true));
        // A command typed by the user is sent as written: no maxTimeMS added.
        let run = DocOp::RunCommand {
            database: "shop".into(),
            command: Json::parse(r#"{"find":"orders"}"#).expect("json"),
        };
        let Plan::Cursor { command, .. } = plan(&run, &options).expect("plan") else {
            panic!("a cursor");
        };
        assert_eq!(command, doc! { "find": "orders" });
    }
}
