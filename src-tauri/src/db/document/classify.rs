//! What a document operation does, decided before it reaches the driver: whether it only
//! reads (the read-only allow-list, NOSQL.md 4.4) and whether it is dangerous (drops, deletes
//! or updates of a whole collection: confirmed with their concrete effect).
//!
//! The allow-list is a list of what reads: an unknown command is a write. `runCommand` is
//! judged by its command name (the first key) and, for `aggregate`, by its stages.

use serde::Serialize;
use specta::Type;

use crate::db::document::json::Json;
use crate::db::document::ops::{DocOp, Namespace};

/// Commands that only read, lower case. `aggregate` is here too, but checked for
/// `$out` / `$merge`.
const READ_COMMANDS: &[&str] = &[
    "aggregate",
    "buildinfo",
    "collstats",
    "connectionstatus",
    "count",
    "currentop",
    "datasize",
    "dbstats",
    "distinct",
    "endsessions",
    "explain",
    "features",
    "find",
    "getcmdlineopts",
    "getdefaultrwconcern",
    "getlog",
    "getmore",
    "getparameter",
    "hello",
    "hostinfo",
    "ismaster",
    "killcursors",
    "listcollections",
    "listcommands",
    "listdatabases",
    "listindexes",
    "listsearchindexes",
    "lockinfo",
    "ping",
    "replsetgetconfig",
    "replsetgetstatus",
    "rolesinfo",
    "serverstatus",
    "startsession",
    "top",
    "usersinfo",
    "whatsmyuri",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// What makes an operation dangerous.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DangerKind {
    /// Drops a collection (or the target of a rename that replaces it).
    DropCollection,
    DropDatabase,
    /// Deletes every document of a collection (`deleteMany({})`).
    DeleteAll,
    /// Updates every document of a collection (`updateMany({}, …)`).
    UpdateAll,
    /// Drops every index of a collection but `_id`'s.
    DropAllIndexes,
}

/// A dangerous operation and what it targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Danger {
    pub kind: DangerKind,
    pub database: String,
    pub collection: Option<String>,
}

/// The verdict on one operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    /// The command name, as the user would know it (`find`, `deleteMany`, `dropDatabase`).
    pub name: String,
    pub access: Access,
    pub danger: Option<Danger>,
}

fn has_write_stage(pipeline: &[Json]) -> bool {
    pipeline.iter().any(|stage| {
        stage
            .as_object()
            .and_then(|entries| entries.first())
            .is_some_and(|(key, _)| key == "$out" || key == "$merge")
    })
}

fn danger(kind: DangerKind, database: &str, collection: Option<&str>) -> Option<Danger> {
    Some(Danger {
        kind,
        database: database.to_owned(),
        collection: collection.map(str::to_owned),
    })
}

fn is_all(filter: Option<&Json>) -> bool {
    filter.is_none_or(Json::is_empty_object)
}

pub fn classify(op: &DocOp) -> Classified {
    let read = |name: &str| Classified {
        name: name.to_owned(),
        access: Access::Read,
        danger: None,
    };
    let write = |name: &str, danger: Option<Danger>| Classified {
        name: name.to_owned(),
        access: Access::Write,
        danger,
    };
    match op {
        DocOp::Find { .. } => read("find"),
        DocOp::Count { .. } => read("countDocuments"),
        DocOp::EstimatedCount { .. } => read("estimatedDocumentCount"),
        DocOp::Distinct { .. } => read("distinct"),
        DocOp::ListDatabases { .. } => read("listDatabases"),
        DocOp::ListCollections { .. } => read("listCollections"),
        DocOp::ListIndexes { .. } => read("listIndexes"),
        DocOp::Aggregate { pipeline, .. } => {
            if has_write_stage(pipeline) {
                write("aggregate", None)
            } else {
                read("aggregate")
            }
        }
        DocOp::Insert { documents, .. } => write(
            if documents.len() == 1 {
                "insertOne"
            } else {
                "insertMany"
            },
            None,
        ),
        DocOp::Update {
            ns, filter, many, ..
        } => {
            let all = *many && filter.is_empty_object();
            write(
                if *many { "updateMany" } else { "updateOne" },
                if all {
                    danger(DangerKind::UpdateAll, &ns.database, Some(&ns.collection))
                } else {
                    None
                },
            )
        }
        DocOp::Replace { .. } => write("replaceOne", None),
        DocOp::Delete { ns, filter, many } => {
            let all = *many && filter.is_empty_object();
            write(
                if *many { "deleteMany" } else { "deleteOne" },
                if all {
                    danger(DangerKind::DeleteAll, &ns.database, Some(&ns.collection))
                } else {
                    None
                },
            )
        }
        DocOp::CreateIndexes { .. } => write("createIndexes", None),
        DocOp::DropIndexes { ns, name } => write(
            "dropIndexes",
            if name == "*" {
                danger(
                    DangerKind::DropAllIndexes,
                    &ns.database,
                    Some(&ns.collection),
                )
            } else {
                None
            },
        ),
        DocOp::CreateCollection { .. } => write("createCollection", None),
        DocOp::DropCollection { ns } => write(
            "drop",
            danger(
                DangerKind::DropCollection,
                &ns.database,
                Some(&ns.collection),
            ),
        ),
        DocOp::DropDatabase { database } => write(
            "dropDatabase",
            danger(DangerKind::DropDatabase, database, None),
        ),
        DocOp::RenameCollection {
            to, drop_target, ..
        } => write(
            "renameCollection",
            if *drop_target {
                danger(
                    DangerKind::DropCollection,
                    &to.database,
                    Some(&to.collection),
                )
            } else {
                None
            },
        ),
        DocOp::RunCommand { database, command } => classify_command(database, command),
    }
}

/// A command document as `runCommand` sends it.
fn classify_command(database: &str, command: &Json) -> Classified {
    let Some((name, target)) = command.as_object().and_then(|entries| entries.first()) else {
        return Classified {
            name: String::new(),
            access: Access::Write,
            danger: None,
        };
    };
    let lower = name.to_ascii_lowercase();
    let target = target.as_str();
    let mut access = if READ_COMMANDS.contains(&lower.as_str()) {
        Access::Read
    } else {
        Access::Write
    };
    if lower == "aggregate"
        && command
            .get("pipeline")
            .and_then(Json::as_array)
            .is_some_and(has_write_stage)
    {
        access = Access::Write;
    }
    let danger = match lower.as_str() {
        "drop" => danger(DangerKind::DropCollection, database, target),
        "dropdatabase" => danger(DangerKind::DropDatabase, database, None),
        "delete" => statements(command, "deletes")
            .any(|d| is_all(d.get("q")) && number(d.get("limit")) == Some(0))
            .then(|| danger(DangerKind::DeleteAll, database, target))
            .flatten(),
        "update" => statements(command, "updates")
            .any(|u| is_all(u.get("q")) && u.get("multi") == Some(&Json::Bool(true)))
            .then(|| danger(DangerKind::UpdateAll, database, target))
            .flatten(),
        "dropindexes" | "deleteindexes" => (command.get("index").and_then(Json::as_str)
            == Some("*"))
        .then(|| danger(DangerKind::DropAllIndexes, database, target))
        .flatten(),
        "renamecollection" if command.get("dropTarget") == Some(&Json::Bool(true)) => {
            let to = command.get("to").and_then(Json::as_str).unwrap_or_default();
            let (db, coll) = to.split_once('.').unwrap_or((database, to));
            danger(DangerKind::DropCollection, db, Some(coll))
        }
        _ => None,
    };
    Classified {
        name: name.clone(),
        access,
        danger,
    }
}

fn statements<'a>(command: &'a Json, key: &str) -> impl Iterator<Item = &'a Json> {
    command
        .get(key)
        .and_then(Json::as_array)
        .unwrap_or(&[])
        .iter()
}

/// An integer in any Extended JSON form (`0`, `{"$numberInt": "0"}`…).
fn number(json: Option<&Json>) -> Option<i64> {
    match json? {
        Json::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Json::Object(_) => {
            let json = json?;
            ["$numberInt", "$numberLong", "$numberDouble"]
                .iter()
                .find_map(|key| json.get(key))
                .and_then(Json::as_str)
                .and_then(|text| text.parse::<f64>().ok())
                .map(|f| f as i64)
        }
        _ => None,
    }
}

/// The namespace a danger is about, when it is a collection.
pub fn danger_namespace(danger: &Danger) -> Option<Namespace> {
    danger
        .collection
        .as_ref()
        .map(|c| Namespace::new(danger.database.clone(), c.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::document::ops::FindOptions;

    fn json(text: &str) -> Json {
        Json::parse(text).expect("json")
    }

    fn run(text: &str) -> Classified {
        classify(&DocOp::RunCommand {
            database: "shop".into(),
            command: json(text),
        })
    }

    #[test]
    fn reads_are_allowed_and_everything_else_writes() {
        for text in [
            r#"{"find":"orders","filter":{}}"#,
            r#"{"aggregate":"orders","pipeline":[{"$match":{}}],"cursor":{}}"#,
            r#"{"count":"orders"}"#,
            r#"{"listCollections":1}"#,
            r#"{"explain":{"delete":"orders","deletes":[]}}"#,
            r#"{"ping":1}"#,
            r#"{"dbStats":1}"#,
        ] {
            assert_eq!(run(text).access, Access::Read, "{text}");
        }
        for text in [
            r#"{"insert":"orders","documents":[{}]}"#,
            r#"{"aggregate":"orders","pipeline":[{"$out":"copy"}],"cursor":{}}"#,
            r#"{"aggregate":"orders","pipeline":[{"$merge":{"into":"x"}}],"cursor":{}}"#,
            r#"{"findAndModify":"orders","query":{},"remove":true}"#,
            r#"{"createIndexes":"orders","indexes":[]}"#,
            r#"{"shutdown":1}"#,
            r#"{"eval":"1"}"#,
            r#"{"mapReduce":"orders"}"#,
            r#"[]"#,
            r#"{}"#,
        ] {
            assert_eq!(run(text).access, Access::Write, "{text}");
        }
    }

    #[test]
    fn whole_collection_operations_are_dangerous() {
        let kind = |c: Classified| c.danger.map(|d| d.kind);
        assert_eq!(
            kind(run(r#"{"drop":"orders"}"#)),
            Some(DangerKind::DropCollection)
        );
        assert_eq!(
            kind(run(r#"{"dropDatabase":1}"#)),
            Some(DangerKind::DropDatabase)
        );
        assert_eq!(
            kind(run(r#"{"delete":"orders","deletes":[{"q":{},"limit":0}]}"#)),
            Some(DangerKind::DeleteAll)
        );
        assert_eq!(
            kind(run(r#"{"delete":"orders","deletes":[{"q":{},"limit":1}]}"#)),
            None,
            "one document"
        );
        assert_eq!(
            kind(run(
                r#"{"delete":"orders","deletes":[{"q":{"a":1},"limit":0}]}"#
            )),
            None
        );
        assert_eq!(
            kind(run(
                r#"{"update":"orders","updates":[{"q":{},"u":{"$set":{"a":1}},"multi":true}]}"#
            )),
            Some(DangerKind::UpdateAll)
        );
        assert_eq!(
            kind(run(r#"{"dropIndexes":"orders","index":"*"}"#)),
            Some(DangerKind::DropAllIndexes)
        );
        let ns = Namespace::new("shop", "orders");
        let typed = classify(&DocOp::Delete {
            ns: ns.clone(),
            filter: Json::empty(),
            many: true,
        });
        assert_eq!(typed.name, "deleteMany");
        assert_eq!(typed.danger.map(|d| d.kind), Some(DangerKind::DeleteAll));
        assert_eq!(
            classify(&DocOp::Find {
                ns,
                filter: Json::empty(),
                options: FindOptions::default()
            })
            .access,
            Access::Read
        );
    }
}
