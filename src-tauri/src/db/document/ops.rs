//! The typed operations of the document family: what yadbe, and later a mongosh script
//! (M4-3), asks of a document server. Documents are canonical or relaxed Extended JSON in an
//! order-keeping [`Json`]; values never travel inside command text (rule 2).

use std::time::Duration;

use crate::db::document::json::Json;

/// A collection (or view) of a database.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Namespace {
    pub database: String,
    pub collection: String,
}

impl Namespace {
    pub fn new(database: impl Into<String>, collection: impl Into<String>) -> Self {
        Self {
            database: database.into(),
            collection: collection.into(),
        }
    }
}

/// `find`, with its cursor options.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FindOptions {
    pub projection: Option<Json>,
    pub sort: Option<Json>,
    pub skip: Option<u64>,
    /// At most this many documents; `None`: all.
    pub limit: Option<i64>,
    pub hint: Option<Json>,
    pub collation: Option<Json>,
    /// Documents per round trip; `None`: the driver's default.
    pub batch_size: Option<u32>,
}

/// One operation sent to a document server. Every variant names what it touches so the
/// gate can classify it without the driver.
#[derive(Debug, Clone, PartialEq)]
pub enum DocOp {
    Find {
        ns: Namespace,
        filter: Json,
        options: FindOptions,
    },
    /// On a collection, or on the database with `collection: None` (`$currentOp`,
    /// `$documents`).
    Aggregate {
        database: String,
        collection: Option<String>,
        pipeline: Vec<Json>,
        allow_disk_use: Option<bool>,
        batch_size: Option<u32>,
    },
    /// `countDocuments` (exact, runs the filter).
    Count {
        ns: Namespace,
        filter: Json,
        limit: Option<u64>,
    },
    /// `estimatedDocumentCount` (collection metadata, instant).
    EstimatedCount {
        ns: Namespace,
    },
    Distinct {
        ns: Namespace,
        key: String,
        filter: Json,
    },
    Insert {
        ns: Namespace,
        documents: Vec<Json>,
        ordered: bool,
    },
    /// `updateOne` / `updateMany`; `update` is an update document or a pipeline (array).
    Update {
        ns: Namespace,
        filter: Json,
        update: Json,
        many: bool,
        upsert: bool,
        array_filters: Option<Vec<Json>>,
    },
    Replace {
        ns: Namespace,
        filter: Json,
        replacement: Json,
        upsert: bool,
    },
    /// `deleteOne` / `deleteMany`.
    Delete {
        ns: Namespace,
        filter: Json,
        many: bool,
    },
    ListDatabases {
        filter: Option<Json>,
    },
    ListCollections {
        database: String,
        filter: Option<Json>,
    },
    ListIndexes {
        ns: Namespace,
    },
    CreateIndexes {
        ns: Namespace,
        /// Index models: `{ "key": {…}, "name": …, … }`.
        indexes: Vec<Json>,
    },
    /// `name`: one index, or `*` for every index but `_id`'s.
    DropIndexes {
        ns: Namespace,
        name: String,
    },
    CreateCollection {
        database: String,
        name: String,
        options: Json,
    },
    DropCollection {
        ns: Namespace,
    },
    DropDatabase {
        database: String,
    },
    RenameCollection {
        from: Namespace,
        to: Namespace,
        drop_target: bool,
    },
    /// Any command, sent as written: `db.runCommand` / `db.adminCommand`, the console.
    RunCommand {
        database: String,
        command: Json,
    },
}

impl DocOp {
    /// The database the operation runs on.
    pub fn database(&self) -> &str {
        match self {
            DocOp::Find { ns, .. }
            | DocOp::Count { ns, .. }
            | DocOp::EstimatedCount { ns }
            | DocOp::Distinct { ns, .. }
            | DocOp::Insert { ns, .. }
            | DocOp::Update { ns, .. }
            | DocOp::Replace { ns, .. }
            | DocOp::Delete { ns, .. }
            | DocOp::ListIndexes { ns }
            | DocOp::CreateIndexes { ns, .. }
            | DocOp::DropIndexes { ns, .. }
            | DocOp::DropCollection { ns } => &ns.database,
            DocOp::RenameCollection { from, .. } => &from.database,
            DocOp::Aggregate { database, .. }
            | DocOp::ListCollections { database, .. }
            | DocOp::CreateCollection { database, .. }
            | DocOp::DropDatabase { database }
            | DocOp::RunCommand { database, .. } => database,
            DocOp::ListDatabases { .. } => "admin",
        }
    }

    /// The collection it touches, when there is one.
    pub fn collection(&self) -> Option<&str> {
        match self {
            DocOp::Find { ns, .. }
            | DocOp::Count { ns, .. }
            | DocOp::EstimatedCount { ns }
            | DocOp::Distinct { ns, .. }
            | DocOp::Insert { ns, .. }
            | DocOp::Update { ns, .. }
            | DocOp::Replace { ns, .. }
            | DocOp::Delete { ns, .. }
            | DocOp::ListIndexes { ns }
            | DocOp::CreateIndexes { ns, .. }
            | DocOp::DropIndexes { ns, .. }
            | DocOp::DropCollection { ns } => Some(&ns.collection),
            DocOp::RenameCollection { from, .. } => Some(&from.collection),
            DocOp::Aggregate { collection, .. } => collection.as_deref(),
            DocOp::CreateCollection { name, .. } => Some(name),
            DocOp::RunCommand { command, .. } => command
                .as_object()
                .and_then(|entries| entries.first())
                .and_then(|(_, target)| target.as_str()),
            DocOp::ListDatabases { .. }
            | DocOp::ListCollections { .. }
            | DocOp::DropDatabase { .. } => None,
        }
    }

    /// The operation as the shell would write it, for the statement log and the history
    /// (never run).
    pub fn display(&self) -> String {
        let coll = |ns: &Namespace| format!("db.getCollection({})", quoted(&ns.collection));
        let args = |items: &[&Json]| {
            items
                .iter()
                .map(|j| j.to_text())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let text = match self {
            DocOp::Find {
                ns,
                filter,
                options,
            } => {
                let mut text = format!("{}.find({}", coll(ns), filter.to_text());
                if let Some(projection) = &options.projection {
                    text.push_str(&format!(", {}", projection.to_text()));
                }
                text.push(')');
                if let Some(sort) = &options.sort {
                    text.push_str(&format!(".sort({})", sort.to_text()));
                }
                if let Some(skip) = options.skip {
                    text.push_str(&format!(".skip({skip})"));
                }
                if let Some(limit) = options.limit {
                    text.push_str(&format!(".limit({limit})"));
                }
                text
            }
            DocOp::Aggregate {
                collection,
                pipeline,
                ..
            } => {
                let target = collection.as_deref().map_or_else(
                    || "db".to_owned(),
                    |c| format!("db.getCollection({})", quoted(c)),
                );
                format!(
                    "{target}.aggregate({})",
                    Json::Array(pipeline.clone()).to_text()
                )
            }
            DocOp::Count { ns, filter, .. } => {
                format!("{}.countDocuments({})", coll(ns), filter.to_text())
            }
            DocOp::EstimatedCount { ns } => format!("{}.estimatedDocumentCount()", coll(ns)),
            DocOp::Distinct { ns, key, filter } => format!(
                "{}.distinct({}, {})",
                coll(ns),
                quoted(key),
                filter.to_text()
            ),
            DocOp::Insert { ns, documents, .. } => match documents.as_slice() {
                [one] => format!("{}.insertOne({})", coll(ns), one.to_text()),
                many => format!(
                    "{}.insertMany({})",
                    coll(ns),
                    Json::Array(many.to_vec()).to_text()
                ),
            },
            DocOp::Update {
                ns,
                filter,
                update,
                many,
                ..
            } => format!(
                "{}.{}({})",
                coll(ns),
                if *many { "updateMany" } else { "updateOne" },
                args(&[filter, update])
            ),
            DocOp::Replace {
                ns,
                filter,
                replacement,
                ..
            } => format!("{}.replaceOne({})", coll(ns), args(&[filter, replacement])),
            DocOp::Delete { ns, filter, many } => format!(
                "{}.{}({})",
                coll(ns),
                if *many { "deleteMany" } else { "deleteOne" },
                filter.to_text()
            ),
            DocOp::ListDatabases { .. } => "db.adminCommand({\"listDatabases\":1})".to_owned(),
            DocOp::ListCollections { filter, .. } => format!(
                "db.getCollectionInfos({})",
                filter
                    .as_ref()
                    .map_or_else(|| "{}".to_owned(), Json::to_text)
            ),
            DocOp::ListIndexes { ns } => format!("{}.getIndexes()", coll(ns)),
            DocOp::CreateIndexes { ns, indexes } => format!(
                "{}.createIndexes({})",
                coll(ns),
                Json::Array(indexes.clone()).to_text()
            ),
            DocOp::DropIndexes { ns, name } => {
                format!("{}.dropIndex({})", coll(ns), quoted(name))
            }
            DocOp::CreateCollection { name, options, .. } => format!(
                "db.createCollection({}, {})",
                quoted(name),
                options.to_text()
            ),
            DocOp::DropCollection { ns } => format!("{}.drop()", coll(ns)),
            DocOp::DropDatabase { .. } => "db.dropDatabase()".to_owned(),
            DocOp::RenameCollection { from, to, .. } => format!(
                "{}.renameCollection({})",
                coll(from),
                quoted(&format!("{}.{}", to.database, to.collection))
            ),
            DocOp::RunCommand { command, .. } => format!("db.runCommand({})", command.to_text()),
        };
        format!("use {}; {text}", self.database())
    }
}

fn quoted(text: &str) -> String {
    Json::string(text).to_text()
}

/// How the gate runs an operation on the driver.
#[derive(Debug, Clone)]
pub struct ExecOptions {
    /// The server stops the operation after this long (`maxTimeMS`), where the operation
    /// takes it; the gate also bounds the wait itself.
    pub max_time: Option<Duration>,
    /// Identifies the operation for a cancel ([`crate::db::driver::DocumentConnection::kill`]).
    pub token: String,
    /// A cursor stops after this many documents (the first window of a console result).
    pub max_documents: Option<u64>,
}

/// What a running operation produces.
#[derive(Debug, Clone, PartialEq)]
pub enum DocEvent {
    /// The next documents of a cursor, canonical Extended JSON, in order.
    Documents(Vec<Json>),
}

/// How an operation ended.
#[derive(Debug, Clone, PartialEq)]
pub enum DocReply {
    /// A cursor: its documents went through the events. `more`: it stopped at
    /// `max_documents` with documents left.
    Cursor { documents: u64, more: bool },
    /// One reply document (`runCommand` without cursor, counts, write results), canonical.
    Document(Json),
}

/// The servers behind a connection, for what an apply can promise (decision 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DocTopology {
    /// One server without replication: no multi-document transaction.
    Standalone,
    ReplicaSet,
    Sharded,
    /// Not known yet (no server selected).
    Unknown,
}

pub type DocSender = tokio::sync::mpsc::Sender<DocEvent>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_reads_like_the_shell() {
        let ns = Namespace::new("shop", "orders");
        let op = DocOp::Find {
            ns: ns.clone(),
            filter: Json::parse(r#"{"status":"paid"}"#).expect("json"),
            options: FindOptions {
                sort: Some(Json::parse(r#"{"_id":1}"#).expect("json")),
                limit: Some(501),
                ..FindOptions::default()
            },
        };
        assert_eq!(
            op.display(),
            r#"use shop; db.getCollection("orders").find({"status":"paid"}).sort({"_id":1}).limit(501)"#
        );
        let drop = DocOp::DropCollection { ns };
        assert_eq!(
            drop.display(),
            r#"use shop; db.getCollection("orders").drop()"#
        );
        let run = DocOp::RunCommand {
            database: "shop".into(),
            command: Json::parse(r#"{"find":"orders"}"#).expect("json"),
        };
        assert_eq!(run.collection(), Some("orders"));
    }
}
