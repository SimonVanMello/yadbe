//! Document edits (M4-4), against the MongoDB replica set (one transaction per apply) and the
//! standalone server (one operation at a time): every generated operation checked against the
//! resulting documents, type-exact guards (Int32 vs Double, an array that contains the value,
//! an embedded document in another order, missing vs null, NaN), conflicts per kind, a
//! transaction that aborts leaving nothing, the standalone stop at the first failure and what
//! it says was applied, the journal entry and an exact revert, read-only refusal.
//!
//! `YADBE_TEST_MONGO_URL` / `YADBE_TEST_MONGO_STANDALONE_URL` (`dev/compose.yml`); unset:
//! SKIPPED. Each test works in a database of its own, dropped at the end.

mod common;

use common::mongo::{Mongo, json, servers};
use yadbe_lib::db::document::edit::{DocChangeSet, DocConflictKind, DocEdit, FieldEdit, PathSeg};
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::document::ops::{DocOp, DocTopology};
use yadbe_lib::db::engine::EngineFamily;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::session::document::edit::{DocApplyOutcome, DocApplyStatus};
use yadbe_lib::store::{JournalQuery, JournalTargetKind};

const COLL: &str = "items";

fn f(name: &str) -> PathSeg {
    PathSeg::Field(name.to_owned())
}

fn field(path: Vec<PathSeg>, original: Option<&str>, value: Option<&str>) -> FieldEdit {
    FieldEdit {
        path,
        original: original.map(str::to_owned),
        value: value.map(str::to_owned),
    }
}

fn update(id: &str, fields: Vec<FieldEdit>) -> DocEdit {
    DocEdit::Update {
        id: id.to_owned(),
        fields,
    }
}

fn set(mongo: &Mongo, edits: Vec<DocEdit>) -> DocChangeSet {
    DocChangeSet {
        database: mongo.database.clone(),
        collection: COLL.to_owned(),
        edits,
    }
}

async fn apply(mongo: &Mongo, edits: Vec<DocEdit>) -> DocApplyOutcome {
    mongo
        .service
        .apply_changes(&mongo.id, &set(mongo, edits))
        .await
        .expect("apply answers")
}

/// The documents of the collection by `_id` order, as canonical Extended JSON.
async fn documents(mongo: &Mongo) -> Vec<Json> {
    mongo
        .run(DocOp::Find {
            ns: mongo.ns(COLL),
            filter: Json::empty(),
            options: yadbe_lib::db::document::ops::FindOptions {
                sort: Some(json(r#"{"_id":1}"#)),
                ..Default::default()
            },
        })
        .await
        .1
}

async fn document(mongo: &Mongo, id: i32) -> Option<Json> {
    documents(mongo)
        .await
        .into_iter()
        .find(|d| d.get("_id") == Some(&int(id)))
}

fn int(n: i32) -> Json {
    json(&format!(r#"{{"$numberInt":"{n}"}}"#))
}

fn id(n: i32) -> String {
    int(n).to_text()
}

/// A document with its top-level fields sorted: a field unset then set back by a revert comes
/// back at the end of its document, the only difference a revert leaves.
fn sorted(doc: &Json) -> Json {
    let mut entries = doc.as_object().expect("a document").to_vec();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Json::Object(entries)
}

async fn seed(mongo: &Mongo, docs: &[&str]) {
    mongo
        .insert(COLL, docs.iter().map(|d| json(d)).collect())
        .await;
}

async fn raw_update(mongo: &Mongo, filter: &str, update: &str) {
    mongo
        .run(DocOp::Update {
            ns: mongo.ns(COLL),
            filter: json(filter),
            update: json(update),
            many: false,
            upsert: false,
            array_filters: None,
        })
        .await;
}

const FIXTURE: [&str; 4] = [
    r#"{"_id":1,"name":"a","qty":{"$numberInt":"5"},"price":{"$numberDouble":"2.5"},"tags":["x","y"],"dims":{"w":{"$numberInt":"1"},"h":{"$numberLong":"2"}},"old":null}"#,
    r#"{"_id":2,"name":"b","items":[{"sku":"s1","n":{"$numberInt":"1"}},{"sku":"s2","n":{"$numberInt":"2"}}]}"#,
    r#"{"_id":3,"name":"c","when":{"$date":{"$numberLong":"1700000000000"}}}"#,
    r#"{"_id":4,"name":"d"}"#,
];

#[tokio::test]
async fn every_operation_lands_and_reverts_exactly() {
    for (label, url) in servers("every_operation_lands_and_reverts_exactly") {
        let mongo = Mongo::open(&url, |_| {}).await;
        seed(&mongo, &FIXTURE).await;
        let before = documents(&mongo).await;
        let edits = vec![
            update(
                &id(1),
                vec![
                    field(vec![f("qty")], Some(r#"{"$numberInt":"5"}"#), Some("6")),
                    field(
                        vec![f("dims"), f("h")],
                        Some(r#"{"$numberLong":"2"}"#),
                        Some(r#"{"$numberLong":"3"}"#),
                    ),
                    field(
                        vec![f("tags"), PathSeg::Index(1)],
                        Some(r#""y""#),
                        Some(r#""z""#),
                    ),
                    field(vec![f("note")], None, Some(r#""new""#)),
                    field(vec![f("old")], Some("null"), None),
                ],
            ),
            update(
                &id(2),
                vec![field(
                    vec![f("items"), PathSeg::Index(0), f("n")],
                    Some(r#"{"$numberInt":"1"}"#),
                    Some(r#"{"$numberDecimal":"1.50"}"#),
                )],
            ),
            DocEdit::Replace {
                id: id(3),
                original: FIXTURE[2].into(),
                replacement: r#"{"name":"c2","flag":true}"#.into(),
            },
            DocEdit::Delete {
                id: id(4),
                original: FIXTURE[3].into(),
            },
            DocEdit::Insert {
                document: r#"{"_id":5,"name":"e"}"#.into(),
            },
            DocEdit::Insert {
                document: r#"{"name":"generated"}"#.into(),
            },
        ];
        let preview = mongo
            .service
            .preview_changes(&mongo.id, &set(&mongo, edits.clone()))
            .await
            .expect("preview");
        let replica = mongo.conn().topology() != DocTopology::Standalone;
        assert_eq!(preview.atomic, replica, "{label}");
        assert_eq!(preview.operations, 6, "{label}");
        let writes: Vec<&str> = preview
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .filter(|t| t.starts_with("coll."))
            .collect();
        assert_eq!(writes.len(), 6, "{label}");
        assert!(
            writes[0].starts_with("coll.updateOne({\"_id\": NumberInt(1), \"$expr\""),
            "{label}: {}",
            writes[0]
        );
        assert!(writes[3].starts_with("coll.deleteOne("), "{label}");

        let outcome = apply(&mongo, edits).await;
        assert_eq!(
            outcome.status,
            DocApplyStatus::Applied,
            "{label}: {outcome:?}"
        );
        assert_eq!(outcome.atomic, replica, "{label}");
        assert_eq!(outcome.applied, vec![0, 1, 2, 3, 4, 5], "{label}");
        assert!(outcome.revertible, "{label}");
        let generated = outcome
            .inserted_ids
            .iter()
            .find(|(edit, _)| *edit == 5)
            .map(|(_, id)| json(id))
            .expect("generated id");
        assert!(
            generated.get("$oid").is_some(),
            "{label}: an ObjectId was made"
        );

        let after = documents(&mongo).await;
        assert_eq!(
            after[0],
            json(
                r#"{"_id":{"$numberInt":"1"},"name":"a","qty":{"$numberInt":"6"},"price":{"$numberDouble":"2.5"},"tags":["x","z"],"dims":{"w":{"$numberInt":"1"},"h":{"$numberLong":"3"}},"note":"new"}"#
            ),
            "{label}: only the touched paths, types kept"
        );
        assert_eq!(
            after[1],
            json(
                r#"{"_id":{"$numberInt":"2"},"name":"b","items":[{"sku":"s1","n":{"$numberDecimal":"1.50"}},{"sku":"s2","n":{"$numberInt":"2"}}]}"#
            ),
            "{label}"
        );
        assert_eq!(
            after[2],
            json(r#"{"_id":{"$numberInt":"3"},"name":"c2","flag":true}"#),
            "{label}: replaced, _id kept first"
        );
        assert!(document(&mongo, 4).await.is_none(), "{label}: deleted");
        assert_eq!(
            document(&mongo, 5).await,
            Some(json(r#"{"_id":{"$numberInt":"5"},"name":"e"}"#)),
            "{label}"
        );
        assert!(
            after.iter().any(|d| d.get("_id") == Some(&generated)
                && d.get("name") == Some(&Json::string("generated"))),
            "{label}: inserted with the generated id"
        );

        // The journal holds the entry, and its revert brings the documents back.
        let entry_id = outcome.journal_id.expect("journaled");
        let page = mongo
            ._db_store
            .search_journal(&JournalQuery::default())
            .expect("journal");
        let entry = page
            .entries
            .iter()
            .find(|e| e.id == entry_id)
            .expect("entry");
        assert_eq!(entry.family, EngineFamily::Document, "{label}");
        assert_eq!(entry.target_kind, JournalTargetKind::Collection, "{label}");
        assert_eq!(entry.table.name, COLL, "{label}");
        assert_eq!(
            (entry.updated, entry.inserted, entry.deleted),
            (3, 2, 1),
            "{label}"
        );
        let detail = mongo
            ._db_store
            .journal_entry(entry_id)
            .expect("read")
            .expect("detail");
        assert_eq!(detail.statements.len(), 6, "{label}");
        assert_eq!(detail.inverse_statements.len(), 6, "{label}");

        let revert_preview = mongo
            .service
            .preview_revert(&mongo.id, entry_id)
            .await
            .expect("revert preview");
        assert_eq!(revert_preview.operations, 6, "{label}");
        let reverted = mongo
            .service
            .apply_revert(&mongo.id, entry_id)
            .await
            .expect("revert answers");
        assert_eq!(
            reverted.status,
            DocApplyStatus::Applied,
            "{label}: {reverted:?}"
        );
        let back = documents(&mongo).await;
        assert_eq!(back.len(), before.len(), "{label}");
        for (now, was) in back.iter().zip(&before) {
            assert_eq!(sorted(now), sorted(was), "{label}: reverted exactly");
        }
        // Untouched documents and untouched fields keep their order too.
        assert_eq!(
            back[2], before[2],
            "{label}: a replaced document comes back whole"
        );
        assert_eq!(
            back[3], before[3],
            "{label}: a deleted document comes back whole"
        );
        // The entry is marked reverted and cannot be reverted twice.
        let again = mongo.service.apply_revert(&mongo.id, entry_id).await;
        assert_eq!(
            again.expect_err("already reverted").code,
            ErrorCode::InvalidArgument,
            "{label}"
        );
        // Every write went to the statement log (rule 5), and the transaction lines with them.
        let log: Vec<String> = mongo.log.entries().into_iter().map(|e| e.sql).collect();
        assert!(log.iter().any(|s| s.contains(".updateOne(")), "{label}");
        assert_eq!(
            log.iter().any(|s| s == "session.commitTransaction()"),
            replica,
            "{label}"
        );
    }
}

#[tokio::test]
async fn guards_are_type_exact() {
    for (label, url) in servers("guards_are_type_exact") {
        let mongo = Mongo::open(&url, |_| {}).await;
        seed(
            &mongo,
            &[
                r#"{"_id":1,"n":{"$numberInt":"1"}}"#,
                r#"{"_id":2,"a":{"$numberInt":"1"}}"#,
                r#"{"_id":3,"e":{"x":{"$numberInt":"1"},"y":{"$numberInt":"2"}}}"#,
                r#"{"_id":4,"m":null}"#,
                r#"{"_id":5,"nan":{"$numberDouble":"NaN"}}"#,
                r#"{"_id":6,"deep":{"v":[{"$numberInt":"1"}]}}"#,
            ],
        )
        .await;
        // What other users changed meanwhile: the same values to a query predicate.
        raw_update(
            &mongo,
            r#"{"_id":1}"#,
            r#"{"$set":{"n":{"$numberDouble":"1.0"}}}"#,
        )
        .await;
        raw_update(
            &mongo,
            r#"{"_id":2}"#,
            r#"{"$set":{"a":[{"$numberInt":"1"},{"$numberInt":"2"}]}}"#,
        )
        .await;
        raw_update(
            &mongo,
            r#"{"_id":3}"#,
            r#"{"$set":{"e":{"y":{"$numberInt":"2"},"x":{"$numberInt":"1"}}}}"#,
        )
        .await;
        raw_update(&mongo, r#"{"_id":4}"#, r#"{"$unset":{"m":""}}"#).await;
        raw_update(
            &mongo,
            r#"{"_id":6}"#,
            r#"{"$set":{"deep.v.0":{"$numberLong":"1"}}}"#,
        )
        .await;
        let cases = [
            (1, "n", r#"{"$numberInt":"1"}"#),
            (2, "a", r#"{"$numberInt":"1"}"#),
            (3, "e", r#"{"x":{"$numberInt":"1"},"y":{"$numberInt":"2"}}"#),
            (4, "m", "null"),
            (6, "deep", r#"{"v":[{"$numberInt":"1"}]}"#),
        ];
        for (doc, name, seen) in cases {
            let outcome = apply(
                &mongo,
                vec![update(
                    &id(doc),
                    vec![field(vec![f(name)], Some(seen), Some(r#""mine""#))],
                )],
            )
            .await;
            assert_eq!(
                outcome.status,
                DocApplyStatus::Conflicted,
                "{label}: {name} changed on the server: {outcome:?}"
            );
            assert_eq!(
                outcome.conflicts[0].kind,
                DocConflictKind::Changed,
                "{label}"
            );
            assert!(outcome.applied.is_empty(), "{label}");
            assert!(outcome.journal_id.is_none(), "{label}: nothing journaled");
            assert_ne!(
                document(&mongo, doc)
                    .await
                    .and_then(|d| d.get(name).cloned()),
                Some(Json::string("mine")),
                "{label}: {name} left alone"
            );
        }
        let conflict = apply(
            &mongo,
            vec![update(
                &id(1),
                vec![field(
                    vec![f("n")],
                    Some(r#"{"$numberInt":"1"}"#),
                    Some("2"),
                )],
            )],
        )
        .await;
        assert_eq!(
            conflict.conflicts[0].fields[0].now.as_deref(),
            Some(r#"{"$numberDouble":"1.0"}"#),
            "{label}: the conflict says what the server holds"
        );
        // NaN equals NaN, so an unchanged NaN is not a conflict.
        let outcome = apply(
            &mongo,
            vec![update(
                &id(5),
                vec![field(
                    vec![f("nan")],
                    Some(r#"{"$numberDouble":"NaN"}"#),
                    Some("0"),
                )],
            )],
        )
        .await;
        assert_eq!(
            outcome.status,
            DocApplyStatus::Applied,
            "{label}: {outcome:?}"
        );
        assert_eq!(
            document(&mongo, 5)
                .await
                .and_then(|d| d.get("nan").cloned()),
            Some(int(0)),
            "{label}"
        );
    }
}

#[tokio::test]
async fn conflicts_per_kind_and_all_or_nothing() {
    for (label, url) in servers("conflicts_per_kind_and_all_or_nothing") {
        let mongo = Mongo::open(&url, |_| {}).await;
        seed(&mongo, &FIXTURE).await;
        let before = documents(&mongo).await;
        let replica = mongo.conn().topology() != DocTopology::Standalone;
        raw_update(&mongo, r#"{"_id":3}"#, r#"{"$set":{"name":"theirs"}}"#).await;
        mongo
            .run(DocOp::Delete {
                ns: mongo.ns(COLL),
                filter: json(r#"{"_id":4}"#),
                many: false,
            })
            .await;
        let changed_before = documents(&mongo).await;
        // A good change first, then one conflict of each kind.
        let good = update(
            &id(1),
            vec![field(vec![f("name")], Some(r#""a""#), Some(r#""mine""#))],
        );
        let kinds = [
            (
                DocEdit::Delete {
                    id: id(3),
                    original: FIXTURE[2].into(),
                },
                DocConflictKind::Changed,
            ),
            (
                DocEdit::Replace {
                    id: id(3),
                    original: FIXTURE[2].into(),
                    replacement: r#"{"name":"x"}"#.into(),
                },
                DocConflictKind::Changed,
            ),
            (
                update(
                    &id(4),
                    vec![field(vec![f("name")], Some(r#""d""#), Some(r#""x""#))],
                ),
                DocConflictKind::Deleted,
            ),
            (
                DocEdit::Insert {
                    document: r#"{"_id":2,"name":"dup"}"#.into(),
                },
                DocConflictKind::Exists,
            ),
        ];
        for (edit, kind) in kinds {
            let outcome = apply(&mongo, vec![good.clone(), edit]).await;
            assert_eq!(
                outcome.status,
                DocApplyStatus::Conflicted,
                "{label}: {kind:?}"
            );
            assert_eq!(outcome.conflicts.len(), 1, "{label}");
            let conflict = &outcome.conflicts[0];
            assert_eq!(conflict.kind, kind, "{label}");
            assert_eq!(conflict.edit, 1, "{label}");
            if kind == DocConflictKind::Changed {
                assert_eq!(conflict.fields.len(), 1, "{label}");
                assert_eq!(conflict.fields[0].path, vec![f("name")], "{label}");
                assert_eq!(
                    conflict.fields[0].now.as_deref(),
                    Some(r#""theirs""#),
                    "{label}"
                );
            }
            if replica {
                // One transaction: the good change before the conflict is not applied.
                assert!(outcome.applied.is_empty(), "{label}");
                assert_eq!(
                    documents(&mongo).await,
                    changed_before,
                    "{label}: nothing applied"
                );
            } else {
                // One by one: the good change is applied and said so, then the stop.
                assert_eq!(outcome.applied, vec![0], "{label}");
                assert!(
                    outcome.journal_id.is_some(),
                    "{label}: what was applied is journaled"
                );
                let revert = mongo
                    .service
                    .apply_revert(&mongo.id, outcome.journal_id.expect("entry"))
                    .await
                    .expect("revert");
                assert_eq!(revert.status, DocApplyStatus::Applied, "{label}");
                assert_eq!(documents(&mongo).await, changed_before, "{label}: reverted");
            }
        }
        let _ = before;
    }
}

#[tokio::test]
async fn a_failure_aborts_the_transaction_or_stops_the_standalone_apply() {
    for (label, url) in servers("a_failure_aborts_the_transaction_or_stops_the_standalone_apply") {
        let mongo = Mongo::open(&url, |_| {}).await;
        // A validator the last change breaks: a server failure, not a conflict.
        mongo
            .run(DocOp::CreateCollection {
                database: mongo.database.clone(),
                name: COLL.into(),
                options: json(
                    r#"{"validator":{"$jsonSchema":{"required":["name"]}},"validationAction":"error"}"#,
                ),
            })
            .await;
        seed(&mongo, &FIXTURE).await;
        let before = documents(&mongo).await;
        let replica = mongo.conn().topology() != DocTopology::Standalone;
        let edits = vec![
            update(
                &id(1),
                vec![field(vec![f("name")], Some(r#""a""#), Some(r#""a2""#))],
            ),
            update(
                &id(2),
                vec![field(vec![f("name")], Some(r#""b""#), Some(r#""b2""#))],
            ),
            DocEdit::Insert {
                document: r#"{"_id":9,"nameless":true}"#.into(),
            },
            update(
                &id(3),
                vec![field(vec![f("name")], Some(r#""c""#), Some(r#""c2""#))],
            ),
        ];
        let outcome = apply(&mongo, edits).await;
        assert_eq!(
            outcome.status,
            DocApplyStatus::Failed,
            "{label}: {outcome:?}"
        );
        let error = outcome.error.as_ref().expect("the server's error");
        assert!(
            format!("{error:?}").contains("121") || format!("{error:?}").contains("validation"),
            "{label}: {error:?}"
        );
        assert!(!outcome.retryable, "{label}");
        let after = documents(&mongo).await;
        if replica {
            assert!(outcome.applied.is_empty(), "{label}");
            assert!(outcome.journal_id.is_none(), "{label}");
            assert_eq!(
                after, before,
                "{label}: the aborted transaction left nothing"
            );
        } else {
            assert_eq!(
                outcome.applied,
                vec![0, 1],
                "{label}: what ran before the stop"
            );
            assert_eq!(after[0].get("name"), Some(&Json::string("a2")), "{label}");
            assert_eq!(after[1].get("name"), Some(&Json::string("b2")), "{label}");
            assert_eq!(
                after[2].get("name"),
                Some(&Json::string("c")),
                "{label}: not reached"
            );
            assert!(document(&mongo, 9).await.is_none(), "{label}");
            let entry = outcome.journal_id.expect("journaled");
            let detail = mongo
                ._db_store
                .journal_entry(entry)
                .expect("read")
                .expect("detail");
            assert_eq!(detail.entry.updated, 2, "{label}");
            let revert = mongo
                .service
                .apply_revert(&mongo.id, entry)
                .await
                .expect("revert");
            assert_eq!(revert.status, DocApplyStatus::Applied, "{label}");
            assert_eq!(documents(&mongo).await, before, "{label}: reverted");
        }
    }
}

#[tokio::test]
async fn a_revert_is_checked_like_an_apply() {
    for (label, url) in servers("a_revert_is_checked_like_an_apply") {
        let mongo = Mongo::open(&url, |_| {}).await;
        seed(&mongo, &FIXTURE).await;
        let outcome = apply(
            &mongo,
            vec![update(
                &id(1),
                vec![field(vec![f("name")], Some(r#""a""#), Some(r#""mine""#))],
            )],
        )
        .await;
        let entry = outcome.journal_id.expect("journaled");
        raw_update(&mongo, r#"{"_id":1}"#, r#"{"$set":{"name":"theirs"}}"#).await;
        let revert = mongo
            .service
            .apply_revert(&mongo.id, entry)
            .await
            .expect("answers");
        assert_eq!(revert.status, DocApplyStatus::Conflicted, "{label}");
        assert_eq!(
            revert.conflicts[0].fields[0].now.as_deref(),
            Some(r#""theirs""#),
            "{label}"
        );
        assert_eq!(
            document(&mongo, 1)
                .await
                .and_then(|d| d.get("name").cloned()),
            Some(Json::string("theirs")),
            "{label}: the revert did not overwrite their change"
        );
    }
}

#[tokio::test]
async fn read_only_connections_refuse_edits() {
    for (label, url) in servers("read_only_connections_refuse_edits") {
        let mongo = Mongo::open(&url, |def| def.read_only = true).await;
        seed(&mongo, &FIXTURE).await;
        let before = documents(&mongo).await;
        let err = mongo
            .service
            .apply_changes(
                &mongo.id,
                &set(
                    &mongo,
                    vec![DocEdit::Delete {
                        id: id(4),
                        original: FIXTURE[3].into(),
                    }],
                ),
            )
            .await
            .expect_err("refused");
        assert_eq!(err.code, ErrorCode::ReadOnlyViolation, "{label}");
        assert_eq!(documents(&mongo).await, before, "{label}");
    }
}

#[tokio::test]
async fn refused_change_sets_send_nothing() {
    for (label, url) in servers("refused_change_sets_send_nothing") {
        let mongo = Mongo::open(&url, |_| {}).await;
        seed(&mongo, &FIXTURE).await;
        let before = documents(&mongo).await;
        let bad = [
            update(&id(1), vec![field(vec![f("_id")], Some("1"), Some("2"))]),
            DocEdit::Replace {
                id: id(1),
                original: FIXTURE[0].into(),
                replacement: r#"{"_id":7}"#.into(),
            },
        ];
        for edit in bad {
            let err = mongo
                .service
                .apply_changes(
                    &mongo.id,
                    &set(
                        &mongo,
                        vec![
                            update(
                                &id(2),
                                vec![field(vec![f("name")], Some(r#""b""#), Some(r#""x""#))],
                            ),
                            edit,
                        ],
                    ),
                )
                .await
                .expect_err("refused before anything is sent");
            assert_eq!(err.code, ErrorCode::InvalidArgument, "{label}");
        }
        assert_eq!(documents(&mongo).await, before, "{label}");
    }
}

/// Another transaction holds an uncommitted write on the document: the server answers a
/// `WriteConflict` labelled `TransientTransactionError`. yadbe aborts, applies nothing, says
/// applying again may work, and does not retry by itself.
#[tokio::test]
async fn a_transient_transaction_error_is_reported_not_retried() {
    for (label, url) in servers("a_transient_transaction_error_is_reported_not_retried") {
        let mongo = Mongo::open(&url, |_| {}).await;
        if mongo.conn().topology() == DocTopology::Standalone {
            continue;
        }
        seed(&mongo, &FIXTURE).await;
        let conn = mongo.conn();
        let other = conn.begin_transaction().await.expect("their transaction");
        let theirs = DocOp::Update {
            ns: mongo.ns(COLL),
            filter: json(r#"{"_id":1}"#),
            update: json(r#"{"$set":{"qty":{"$numberInt":"99"}}}"#),
            many: false,
            upsert: false,
            array_filters: None,
        };
        let options = yadbe_lib::db::document::ops::ExecOptions {
            max_time: None,
            token: "theirs".into(),
            max_documents: None,
            transaction: Some(other.clone()),
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        conn.execute(&theirs, &options, tx)
            .await
            .expect("their uncommitted write");
        let outcome = apply(
            &mongo,
            vec![
                update(
                    &id(2),
                    vec![field(vec![f("name")], Some(r#""b""#), Some(r#""b2""#))],
                ),
                update(
                    &id(1),
                    vec![field(vec![f("name")], Some(r#""a""#), Some(r#""a2""#))],
                ),
            ],
        )
        .await;
        assert_eq!(
            outcome.status,
            DocApplyStatus::Failed,
            "{label}: {outcome:?}"
        );
        assert!(outcome.retryable, "{label}: {:?}", outcome.error);
        assert!(outcome.applied.is_empty(), "{label}");
        conn.abort_transaction(&other).await.expect("abort theirs");
        let docs = documents(&mongo).await;
        assert_eq!(docs[0].get("name"), Some(&Json::string("a")), "{label}");
        assert_eq!(
            docs[1].get("name"),
            Some(&Json::string("b")),
            "{label}: nothing applied"
        );
        assert_eq!(docs[0].get("qty"), Some(&int(5)), "{label}: theirs aborted");
    }
}
