//! Conformance suite of the mongosh runtime (M4-3), built from the mongosh documentation:
//! one case per method of the `db`, collection and cursor API, the BSON helpers and their
//! round trips, the shell commands, the sandbox, the limits, read-only and dangerous
//! operations met mid-script, error positions. Against the MongoDB servers of
//! `dev/compose.yml` (`YADBE_TEST_MONGO_URL`, `YADBE_TEST_MONGO_STANDALONE_URL`); a server
//! that is not configured prints SKIPPED.
//!
//! Most cases check themselves in JavaScript (`check(…)`, which throws) and the test asserts
//! the script ended without failure: a failing check names itself in the failure.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::mongo::{EVERY_TYPE, Mongo, RS_ENV, env, json, servers};
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::document::ops::DocOp;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::session::document::model::{
    ScriptFailure, ScriptMessageKind, ScriptOutcome, ScriptRequest, ScriptResult,
};
use yadbe_lib::session::query_model::TextRange;

/// Prepended to the scripts that check themselves.
const CHECK: &str = "function check(cond, what) { if (!cond) throw new Error('check failed: ' + what) }\n\
function eq(a, b, what) { const x = tojson(a), y = tojson(b); if (x !== y) throw new Error('check failed: ' + what + ': ' + x + ' !== ' + y) }\n";

fn ok(outcome: &ScriptOutcome) {
    assert!(outcome.failure.is_none(), "{:#?}", outcome.failure);
}

fn text(outcome: &ScriptOutcome) -> String {
    ok(outcome);
    match &outcome.result {
        Some(ScriptResult::Text { text, .. }) => text.clone(),
        other => panic!("a text result, got {other:?}"),
    }
}

fn failure(outcome: &ScriptOutcome) -> &ScriptFailure {
    outcome
        .failure
        .as_ref()
        .unwrap_or_else(|| panic!("a failure, got {:?}", outcome.result))
}

fn code(outcome: &ScriptOutcome) -> ErrorCode {
    failure(outcome).error.code
}

/// The documents of a documents result, canonical Extended JSON.
fn documents(mongo: &Mongo, outcome: &ScriptOutcome) -> (Vec<Json>, bool, bool, bool) {
    ok(outcome);
    let Some(ScriptResult::Documents {
        documents,
        cursor,
        single,
        truncated,
    }) = &outcome.result
    else {
        panic!("a documents result, got {:?}", outcome.result);
    };
    let mut out = Vec::new();
    let mut offset = 0;
    while offset < documents.count {
        let window = mongo
            .service
            .documents(documents.documents_id, offset, 500)
            .expect("window");
        offset += u32::try_from(window.len()).expect("len");
        out.extend(window.iter().map(|t| json(t)));
        if window.is_empty() {
            break;
        }
    }
    (out, *cursor, *single, *truncated)
}

fn messages(outcome: &ScriptOutcome) -> Vec<String> {
    outcome.messages.iter().map(|m| m.text.clone()).collect()
}

async fn checked(mongo: &Mongo, script: &str) -> ScriptOutcome {
    let outcome = mongo.script("t", &format!("{CHECK}{script}")).await;
    ok(&outcome);
    outcome
}

// --- db ---------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn database_methods() {
    for (label, url) in servers("database_methods") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let db = &mongo.database;
        let outcome = checked(
            &mongo,
            &format!(
                r#"
eq(db.getName(), '{db}', 'getName');
eq(String(db), '{db}', 'toString');
eq(db.getSiblingDB('other').getName(), 'other', 'getSiblingDB');
eq(db.getSiblingDB('{db}').getCollection('c').getFullName(), '{db}.c', 'getCollection');
eq(db.orders.getName(), 'orders', 'db.<name>');
eq(db['odd name'].getName(), 'odd name', 'db["name"]');
eq(db.a.b.getName(), 'a.b', 'db.a.b');
// A collection named like a method stays reachable.
db.getCollection('stats').insertOne({{ x: 1 }});
eq(db.getCollection('stats').countDocuments(), 1, 'colliding collection');
check(typeof db.stats === 'function', 'db.stats stays a method');
eq(db.createCollection('made'), {{ ok: 1 }}, 'createCollection');
db.createView('madeView', 'made', [{{ $match: {{}} }}]);
const names = db.getCollectionNames();
check(names.includes('made') && names.includes('stats') && names.includes('madeView'), 'getCollectionNames ' + names);
eq(db.getCollectionInfos({{ name: 'madeView' }})[0].type, 'view', 'getCollectionInfos');
eq(db.runCommand({{ ping: 1 }}).ok, 1, 'runCommand');
eq(db.runCommand('ping').ok, 1, 'runCommand by name');
check(db.adminCommand({{ listDatabases: 1 }}).databases.some(d => d.name === '{db}'), 'adminCommand');
eq(db.aggregate([{{ $documents: [{{ a: 1 }}, {{ a: 2 }}] }}]).toArray().length, 2, 'db.aggregate');
eq(db.stats().db, '{db}', 'db.stats');
check(/^\d+\.\d+/.test(db.version()), 'version ' + db.version());
check(db.hello().isWritablePrimary !== undefined || db.hello().ismaster !== undefined, 'hello');
check(db.serverStatus().ok === 1, 'serverStatus');
check(db.getMongo().getDBNames().includes('{db}'), 'getMongo().getDBNames');
eq(db.getMongo().getDB('{db}').getName(), '{db}', 'getMongo().getDB');
const cmd = db.runCommand({{ find: 'stats' }});
eq(cmd.cursor.firstBatch.length, 1, 'runCommand cursor reply');
db = db.getSiblingDB('{db}');
'ok'
"#
            ),
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
    }
}

// --- Collections: reads ---------------------------------------------------------------------

async fn orders(mongo: &Mongo, n: usize) {
    mongo
        .insert(
            "orders",
            (0..n)
                .map(|i| {
                    json(&format!(
                        r#"{{"_id": {i}, "n": {i}, "status": "{}", "name": "o{i:03}", "tags": ["t{}"]}}"#,
                        if i % 3 == 0 { "paid" } else { "open" },
                        i % 2
                    ))
                })
                .collect(),
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn collection_reads_and_cursors() {
    for (label, url) in servers("collection_reads_and_cursors") {
        let mongo = Mongo::open(&url, |_| {}).await;
        orders(&mongo, 30).await;
        let outcome = checked(
            &mongo,
            r#"
const c = db.orders;
eq(c.find().toArray().length, 30, 'find');
eq(c.find({ status: 'paid' }).toArray().length, 10, 'find filter');
eq(c.find({}, { name: 1, _id: 0 }).limit(1).toArray(), [{ name: 'o000' }], 'find projection');
eq(c.find().sort({ n: -1 }).limit(2).toArray().map(d => d.n), [29, 28], 'sort limit');
eq(c.find().sort({ n: 1 }).skip(28).toArray().map(d => d.n), [28, 29], 'skip');
eq(c.find().projection({ n: 1 }).limit(1).toArray(), [{ _id: 0, n: 0 }], 'projection()');
eq(c.find().project({ n: 1 }).limit(1).toArray(), [{ _id: 0, n: 0 }], 'project()');
eq(c.find().hint({ _id: 1 }).limit(1).toArray().length, 1, 'hint');
eq(c.find({ name: 'O001' }).collation({ locale: 'en', strength: 2 }).toArray().length, 1, 'collation');
eq(c.find().batchSize(2).toArray().length, 30, 'batchSize (getMore)');
eq(c.find().maxTimeMS(10000).comment('yadbe test').limit(3).toArray().length, 3, 'maxTimeMS comment');
eq(c.find().allowDiskUse().sort({ n: 1 }).limit(1).toArray().length, 1, 'allowDiskUse');
eq(c.find().pretty().limit(1).toArray().length, 1, 'pretty');
let seen = 0; c.find().forEach(() => { seen += 1 }); eq(seen, 30, 'forEach');
eq(c.find().sort({ n: 1 }).limit(3).map(d => d.n * 2).toArray(), [0, 2, 4], 'map');
const cur = c.find().sort({ n: 1 });
check(cur.hasNext(), 'hasNext'); eq(cur.next().n, 0, 'next'); eq(cur.tryNext().n, 1, 'tryNext');
eq(cur.itcount(), 28, 'itcount');
check(cur.isExhausted(), 'isExhausted'); eq(cur.tryNext(), null, 'tryNext at the end');
eq(c.find({ status: 'open' }).count(), 20, 'cursor.count');
eq(c.find().skip(5).limit(10).count(true), 10, 'cursor.count(applySkipLimit)');
eq(c.find().limit(4).size(), 4, 'size');
const closing = c.find().batchSize(2); closing.next(); closing.close(); check(closing.isClosed(), 'close');
let n = 0; for (const d of c.find({ status: 'paid' })) n += 1; eq(n, 10, 'for of');
eq(c.find().objsLeftInBatch(), 0, 'objsLeftInBatch before reading');
eq(c.findOne({ n: 7 }).name, 'o007', 'findOne');
eq(c.findOne({ n: 7 }, { _id: 0, n: 1 }), { n: 7 }, 'findOne projection');
eq(c.findOne({ n: 1000 }), null, 'findOne none');
eq(c.countDocuments(), 30, 'countDocuments');
eq(c.countDocuments({ status: 'paid' }), 10, 'countDocuments filter');
eq(c.countDocuments({}, { skip: 5, limit: 10 }), 10, 'countDocuments options');
eq(c.estimatedDocumentCount(), 30, 'estimatedDocumentCount');
eq(c.count(), 30, 'count');
eq(c.count({ status: 'paid' }), 10, 'count filter');
eq(c.distinct('status').sort(), ['open', 'paid'], 'distinct');
eq(c.distinct('n', { n: { $lt: 3 } }).sort(), [0, 1, 2], 'distinct filter');
eq(c.aggregate([{ $match: { status: 'paid' } }, { $count: 'n' }]).toArray(), [{ n: 10 }], 'aggregate');
eq(c.aggregate({ $match: { status: 'paid' } }, { $count: 'n' }).toArray(), [{ n: 10 }], 'aggregate stages as arguments');
eq(c.aggregate([{ $sort: { n: 1 } }], { allowDiskUse: true, batchSize: 2 }).toArray().length, 30, 'aggregate options');
const agg = c.aggregate([{ $sort: { n: 1 } }, { $project: { n: 1 } }]);
check(agg.hasNext(), 'aggregate hasNext'); eq(agg.next().n, 0, 'aggregate next'); eq(agg.itcount(), 29, 'aggregate itcount');
eq(c.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).map(d => d._id).toArray(), ['open', 'paid'], 'aggregate map');
'ok'
"#,
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn async_await_and_promises() {
    for (label, url) in servers("async_await_and_promises") {
        let mongo = Mongo::open(&url, |_| {}).await;
        orders(&mongo, 12).await;
        let outcome = checked(
            &mongo,
            r#"
const docs = await db.orders.find().toArray();
eq(docs.length, 12, 'await toArray');
async function count() { return await db.orders.countDocuments({ status: 'paid' }) }
eq(await count(), 4, 'async function');
let n = 0; for await (const d of db.orders.find()) n += 1; eq(n, 12, 'for await');
let m = 0; await db.orders.find().forEach(async d => { m += await Promise.resolve(1) }); eq(m, 12, 'forEach async');
Promise.resolve(7).then(v => print('then ' + v));
await Promise.all([db.orders.findOne(), Promise.resolve(2)]).then(([d, two]) => eq(two, 2, 'Promise.all'));
'ok'
"#,
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
        assert!(
            messages(&outcome).contains(&"then 7".to_owned()),
            "{label}: the job queue was drained"
        );
        // The last expression may be a promise: its value is the result.
        let outcome = mongo
            .script("t", "Promise.resolve(41).then(x => x + 1)")
            .await;
        assert_eq!(text(&outcome), "42", "{label}");
        let outcome = mongo.script("t", "await new Promise(() => {})").await;
        assert_eq!(code(&outcome), ErrorCode::ScriptError, "{label}");
        let outcome = mongo
            .script("t", "await Promise.reject(new Error('nope'))")
            .await;
        assert_eq!(code(&outcome), ErrorCode::ScriptError, "{label}");
        assert!(
            failure(&outcome)
                .error
                .detail
                .as_deref()
                .unwrap_or("")
                .contains("nope"),
            "{label}"
        );
    }
}

// --- Collections: writes --------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn collection_writes() {
    for (label, url) in servers("collection_writes") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let outcome = checked(
            &mongo,
            r#"
const c = db.w;
const one = c.insertOne({ _id: 1, a: 1 });
eq(one, { acknowledged: true, insertedId: 1 }, 'insertOne');
const generated = c.insertOne({ a: 2 });
check(generated.insertedId instanceof ObjectId, 'insertOne generates an ObjectId');
const many = c.insertMany([{ _id: 10, a: 10 }, { _id: 11, a: 11 }]);
eq(many, { acknowledged: true, insertedIds: { '0': 10, '1': 11 } }, 'insertMany');
eq(c.insert({ _id: 20 }), { acknowledged: true, insertedIds: { '0': 20 } }, 'insert one');
eq(c.insert([{ _id: 21 }, { _id: 22 }]).insertedIds, { '0': 21, '1': 22 }, 'insert many');
eq(c.updateOne({ _id: 1 }, { $set: { b: 1 } }), { acknowledged: true, insertedId: null, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }, 'updateOne');
eq(c.updateMany({ _id: { $in: [10, 11] } }, { $inc: { a: 1 } }).modifiedCount, 2, 'updateMany');
eq(c.updateOne({ _id: 99 }, { $set: { x: 1 } }, { upsert: true }), { acknowledged: true, insertedId: 99, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }, 'upsert');
c.insertOne({ _id: 30, arr: [{ k: 1 }, { k: 2 }] });
c.updateOne({ _id: 30 }, { $set: { 'arr.$[e].hit': true } }, { arrayFilters: [{ 'e.k': 2 }] });
eq(c.findOne({ _id: 30 }).arr, [{ k: 1 }, { k: 2, hit: true }], 'arrayFilters');
eq(c.updateOne({ _id: 1 }, [{ $set: { c: { $add: ['$a', 1] } } }]).modifiedCount, 1, 'update pipeline');
eq(c.findOne({ _id: 1 }).c, 2, 'pipeline result');
eq(c.update({ _id: 1 }, { $set: { d: 1 } }).modifiedCount, 1, 'update');
eq(c.update({ _id: { $in: [10, 11] } }, { $set: { m: 1 } }, { multi: true }).modifiedCount, 2, 'update multi');
eq(c.replaceOne({ _id: 20 }, { z: 1 }).modifiedCount, 1, 'replaceOne');
eq(c.findOne({ _id: 20 }), { _id: 20, z: 1 }, 'replaced');
eq(c.findOneAndUpdate({ _id: 1 }, { $set: { e: 1 } }).e, undefined, 'findOneAndUpdate returns the old');
eq(c.findOneAndUpdate({ _id: 1 }, { $set: { e: 2 } }, { returnDocument: 'after' }).e, 2, 'returnDocument after');
eq(c.findOneAndUpdate({ _id: 1 }, { $set: { e: 3 } }, { returnNewDocument: true, projection: { e: 1 } }), { _id: 1, e: 3 }, 'returnNewDocument projection');
eq(c.findOneAndReplace({ _id: 20 }, { y: 2 }, { returnDocument: 'after' }), { _id: 20, y: 2 }, 'findOneAndReplace');
eq(c.findOneAndDelete({ _id: 20 }), { _id: 20, y: 2 }, 'findOneAndDelete');
eq(c.findOneAndDelete({ _id: 20 }), null, 'findOneAndDelete none');
eq(c.findOneAndUpdate({ _id: 77 }, { $set: { u: 1 } }, { upsert: true, returnDocument: 'after' }), { _id: 77, u: 1 }, 'findOneAndUpdate upsert');
eq(c.findOneAndUpdate({ _id: { $in: [10, 11] } }, { $inc: { a: 100 } }, { sort: { _id: -1 }, returnDocument: 'after' })._id, 11, 'findOneAndUpdate sort');
eq(c.findAndModify({ query: { _id: 10 }, update: { $set: { f: 1 } }, new: true }).f, 1, 'findAndModify update');
eq(c.findAndModify({ query: { _id: 10 }, remove: true })._id, 10, 'findAndModify remove');
const bulk = c.bulkWrite([
  { insertOne: { document: { _id: 40 } } },
  { insertOne: { document: { _id: 41 } } },
  { updateOne: { filter: { _id: 40 }, update: { $set: { b: 1 } } } },
  { updateMany: { filter: { _id: { $in: [40, 41] } }, update: { $set: { c: 1 } } } },
  { replaceOne: { filter: { _id: 41 }, replacement: { r: 1 } } },
  { updateOne: { filter: { _id: 42 }, update: { $set: { up: 1 } }, upsert: true } },
  { deleteOne: { filter: { _id: 40 } } },
  { deleteMany: { filter: { _id: { $in: [41, 42] } } } },
]);
eq(bulk, { acknowledged: true, insertedCount: 2, insertedIds: { '0': 40, '1': 41 }, matchedCount: 4, modifiedCount: 4, deletedCount: 3, upsertedCount: 1, upsertedIds: { '5': 42 } }, 'bulkWrite');
eq(c.bulkWrite([{ insertOne: { document: { _id: 50 } } }], { ordered: false }).insertedCount, 1, 'bulkWrite unordered');
eq(c.deleteOne({ _id: 50 }), { acknowledged: true, deletedCount: 1 }, 'deleteOne');
eq(c.deleteMany({ _id: { $in: [21, 22] } }), { acknowledged: true, deletedCount: 2 }, 'deleteMany');
eq(c.remove({ _id: 99 }), { acknowledged: true, deletedCount: 1 }, 'remove');
eq(c.remove({ _id: { $in: [1, 77] } }, true).deletedCount, 1, 'remove justOne');
// What mongosh refuses before sending.
let refused = 0;
for (const bad of [
  () => c.updateOne({ _id: 1 }, { plain: 1 }),
  () => c.replaceOne({ _id: 1 }, { $set: { a: 1 } }),
  () => c.insertOne([1, 2]),
  () => c.deleteMany(),
  () => c.find(5),
]) { try { bad() } catch (e) { if (e.name === 'MongoshInvalidInputError') refused += 1 } }
eq(refused, 5, 'invalid input refused');
try { c.insertOne({ _id: 30 }); check(false, 'duplicate') } catch (e) {
  eq(e.name, 'MongoServerError', 'duplicate error class'); eq(e.code, 11000, 'duplicate code'); eq(e.codeName, 'DuplicateKey', 'codeName');
}
try { c.bulkWrite([{ insertOne: { document: { _id: 60 } } }, { insertOne: { document: { _id: 30 } } }, { insertOne: { document: { _id: 61 } } }]); check(false, 'ordered bulk fails') } catch (e) { eq(e.code, 11000, 'bulk error') }
eq(c.countDocuments({ _id: { $in: [60, 61] } }), 1, 'ordered bulk stopped at the failure');
'ok'
"#,
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
        // Every operation went to the statement log, with its shell form.
        let log = mongo.log.entries();
        for method in [
            "insertOne",
            "updateMany",
            "findOneAndUpdate",
            "bulkWrite",
            "deleteMany",
            "replaceOne",
        ] {
            assert!(
                log.iter().any(|e| e.sql.contains(&format!(".{method}("))),
                "{label}: {method} logged"
            );
        }
    }
}

// --- Indexes and collection administration ---------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn indexes_and_administration() {
    for (label, url) in servers("indexes_and_administration") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo.confirms.set(Some(true));
        orders(&mongo, 5).await;
        let outcome = checked(
            &mongo,
            r#"
const c = db.orders;
eq(c.createIndex({ status: 1 }), 'status_1', 'createIndex');
eq(c.createIndex({ name: 1 }, { unique: true, name: 'by_name' }), 'by_name', 'createIndex options');
eq(c.createIndexes([{ n: -1 }, { tags: 1, n: 1 }]), ['n_-1', 'tags_1_n_1'], 'createIndexes');
eq(c.getIndexes().map(i => i.name).sort(), ['_id_', 'by_name', 'n_-1', 'status_1', 'tags_1_n_1'], 'getIndexes');
check(c.getIndexes().find(i => i.name === 'by_name').unique === true, 'unique index');
check(c.getIndexKeys().some(k => k.status === 1), 'getIndexKeys');
eq(c.getIndexSpecs().length, 5, 'getIndexSpecs');
eq(c.dropIndex('status_1').ok, 1, 'dropIndex name');
eq(c.dropIndex({ n: -1 }).ok, 1, 'dropIndex keys');
eq(c.dropIndexes(['by_name']).ok, 1, 'dropIndexes list');
eq(c.dropIndexes().ok, 1, 'dropIndexes all (confirmed)');
eq(c.getIndexes().length, 1, 'only _id left');
const s = c.stats();
eq(s.count, 5, 'stats count'); check(s.ns.endsWith('.orders'), 'stats ns');
check(c.dataSize() > 0 && c.storageSize() >= 0 && c.totalIndexSize() > 0 && c.totalSize() > 0, 'sizes');
eq(c.isCapped(), false, 'isCapped');
eq(c.exists().name, 'orders', 'exists'); eq(db.nope.exists(), null, 'exists none');
eq(c.validate().valid, true, 'validate');
eq(c.getDB().getName(), db.getName(), 'getDB');
eq(c.renameCollection('renamed').ok, 1, 'renameCollection');
eq(db.renamed.countDocuments(), 5, 'renamed');
db.target.insertOne({ t: 1 });
eq(db.renamed.renameCollection('target', true).ok, 1, 'renameCollection dropTarget (confirmed)');
eq(db.target.countDocuments(), 5, 'target replaced');
eq(db.target.drop(), true, 'drop (confirmed)');
check(typeof db.target.drop() === 'boolean', 'drop missing');
'ok'
"#,
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
        let kinds: Vec<_> = mongo
            .confirms
            .asked()
            .iter()
            .map(|c| c.danger.command.clone())
            .collect();
        assert_eq!(
            kinds,
            ["dropIndexes", "renameCollection", "drop", "drop"],
            "{label}: what was confirmed"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn explain_forms() {
    for (label, url) in servers("explain_forms") {
        let mongo = Mongo::open(&url, |_| {}).await;
        orders(&mongo, 10).await;
        let outcome = checked(
            &mongo,
            r#"
const planned = (e) => e.queryPlanner !== undefined || (e.stages !== undefined);
check(planned(db.orders.find({ n: 1 }).explain()), 'cursor.explain()');
const stats = db.orders.find({ status: 'paid' }).sort({ n: 1 }).explain('executionStats');
eq(stats.executionStats.nReturned, 4, 'executionStats');
check(planned(db.orders.explain().find({ n: 1 }).next()), 'explain().find()');
check(planned(db.orders.explain('allPlansExecution').find({ n: 1 }).toArray()[0]), 'allPlansExecution');
check(planned(db.orders.explain().aggregate([{ $match: { n: 1 } }])), 'explain().aggregate()');
check(planned(db.orders.aggregate([{ $match: { n: 1 } }]).explain()), 'aggregation cursor explain');
check(db.orders.explain().count({ n: 1 }).queryPlanner !== undefined, 'explain().count()');
check(db.orders.explain().distinct('status').queryPlanner !== undefined, 'explain().distinct()');
check(db.orders.explain('executionStats').deleteMany({}).queryPlanner !== undefined, 'explain().deleteMany()');
check(db.orders.explain().updateMany({}, { $set: { x: 1 } }).queryPlanner !== undefined, 'explain().updateMany()');
eq(db.orders.countDocuments(), 10, 'explaining a delete deletes nothing');
eq(db.orders.countDocuments({ x: 1 }), 0, 'explaining an update updates nothing');
try { db.orders.find().explain('everything'); check(false, 'bad verbosity') } catch (e) { eq(e.name, 'MongoshInvalidInputError', 'verbosity') }
'ok'
"#,
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
        // An explain whose result is the last expression shows as a document.
        let outcome = mongo
            .script("t", "db.orders.find({ n: 2 }).explain()")
            .await;
        let (docs, cursor, single, _) = documents(&mongo, &outcome);
        assert!(!cursor && single && docs.len() == 1, "{label}");
        let outcome = mongo
            .script("t", "db.orders.explain().find({ n: 2 })")
            .await;
        let (docs, ..) = documents(&mongo, &outcome);
        assert!(docs[0].get("queryPlanner").is_some(), "{label}");
    }
}

// --- BSON -------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn bson_helpers_and_printing() {
    for (label, url) in servers("bson_helpers_and_printing") {
        let mongo = Mongo::open(&url, |_| {}).await;
        let outcome = checked(
            &mongo,
            r#"
const id = ObjectId('5f2b8c9e1c9d440000a1b2c3');
eq(tojson(id), "ObjectId('5f2b8c9e1c9d440000a1b2c3')", 'ObjectId print');
eq(id.getTimestamp().toISOString(), '2020-08-06T04:52:46.000Z', 'getTimestamp');
check(ObjectId().toHexString().length === 24 && new ObjectId().equals(new ObjectId()) === false, 'ObjectId()');
check(ObjectId.isValid('5f2b8c9e1c9d440000a1b2c3') && !ObjectId.isValid('zz'), 'isValid');
eq(tojson(NumberLong('9223372036854775807')), "Long('9223372036854775807')", 'NumberLong');
eq(tojson(Long.fromNumber(5).add(2)), "Long('7')", 'Long arithmetic');
eq(NumberLong(5) + 1, 6, 'Long valueOf');
eq(tojson(NumberInt(42)), 'Int32(42)', 'NumberInt'); eq(tojson(Int32('7')), 'Int32(7)', 'Int32');
eq(tojson(Double(3)), 'Double(3)', 'Double');
eq(tojson(NumberDecimal('1.10')), "Decimal128('1.10')", 'NumberDecimal'); eq(tojson(Decimal128('2')), "Decimal128('2')", 'Decimal128');
eq(tojson(UUID('12345678-9012-3456-7890-123456789012')), "UUID('12345678-9012-3456-7890-123456789012')", 'UUID');
check(UUID().toString('hex').length === 32, 'UUID()');
eq(BinData(0, 'AP8Q').hex(), '00ff10', 'BinData'); eq(HexData(0, '00ff10').base64(), 'AP8Q', 'HexData');
eq(MD5('d41d8cd98f00b204e9800998ecf8427e').sub_type, 5, 'MD5');
eq(tojson(Timestamp({ t: 1, i: 2 })), 'Timestamp({ t: 1, i: 2 })', 'Timestamp'); eq(Timestamp(3, 4).i, 4, 'Timestamp(t, i)');
eq(tojson(MinKey()), 'MinKey()', 'MinKey'); eq(tojson(MaxKey()), 'MaxKey()', 'MaxKey');
eq(tojson(BSONRegExp('^a', 'ix')), "BSONRegExp('^a', 'ix')", 'BSONRegExp');
eq(tojson(ISODate('2024-01-02T03:04:05Z')), "ISODate('2024-01-02T03:04:05.000Z')", 'ISODate');
check(ISODate() instanceof Date, 'ISODate()');
eq(tojson({ a: 1, 'b c': 'x', d: [1, 2], e: null, f: true }), "{ a: 1, 'b c': 'x', d: [ 1, 2 ], e: null, f: true }", 'document print');
eq(tojson(Code('x = 1')), "Code('x = 1')", 'Code');
eq(DBRef('c', 1).$ref, 'c', 'DBRef');
eq(EJSON.stringify({ a: 1, b: NumberLong(2), d: ISODate('2024-01-01T00:00:00Z') }), '{"a":1,"b":2,"d":{"$date":"2024-01-01T00:00:00Z"}}', 'EJSON relaxed');
eq(EJSON.stringify({ a: 1 }, { relaxed: false }), '{"a":{"$numberInt":"1"}}', 'EJSON canonical');
eq(EJSON.parse('{"a":{"$numberLong":"5"},"o":{"$oid":"5f2b8c9e1c9d440000a1b2c3"}}').o.toHexString(), '5f2b8c9e1c9d440000a1b2c3', 'EJSON.parse');
eq(tojson(EJSON.deserialize({ n: { $numberLong: '5' } }).n), "Long('5')", 'EJSON.deserialize');
eq(EJSON.serialize({ n: NumberInt(1) }, { relaxed: false }), { n: { $numberInt: '1' } }, 'EJSON.serialize');
// Values the server stores and gives back with their types.
db.types.insertOne({ _id: 1, oid: id, long: NumberLong('-9223372036854775808'), int: NumberInt(5), dbl: Double(3), dec: NumberDecimal('0.1'),
  uuid: UUID('12345678-9012-3456-7890-123456789012'), bin: BinData(128, 'AQI='), ts: Timestamp({ t: 7, i: 8 }), min: MinKey(), max: MaxKey(),
  re: /^a\/b/i, bre: BSONRegExp('a', 'x'), date: ISODate('1969-12-31T23:59:59.999Z'), code: Code('f()'), n: 1, big: 2 ** 40, frac: 1.5 });
const t = db.types.findOne({ _id: 1 });
eq(db.types.countDocuments({ long: { $type: 'long' }, int: { $type: 'int' }, dbl: { $type: 'double' }, dec: { $type: 'decimal' }, n: { $type: 'int' }, big: { $type: 'double' }, frac: { $type: 'double' } }), 1, 'types on the server');
eq(tojson(t.long), "Long('-9223372036854775808')", 'Long read back'); eq(t.int, 5, 'Int32 read as a number'); eq(t.dbl, 3, 'Double read as a number');
check(t.re instanceof RegExp && t.re.test('A/b'), 'regex read back');
eq(db.types.countDocuments({ oid: { $type: 'objectId' }, uuid: { $type: 'binData' }, ts: { $type: 'timestamp' }, min: { $type: 'minKey' }, max: { $type: 'maxKey' }, re: { $type: 'regex' }, date: { $type: 'date' }, code: { $type: 'javascript' } }), 1, 'other types on the server');
eq(db.types.countDocuments({ name: /^O0/i }), 0, 'regex literal in a query');
'ok'
"#,
        )
        .await;
        assert_eq!(text(&outcome), "ok", "{label}");
    }
}

/// A document of every BSON type, read by a script and written back: everything keeps its
/// type and value, but what mongosh itself changes (documented): a Double holding a whole
/// number is read as a JavaScript number and written as an Int32, and `undefined` (a
/// deprecated type) is written as null.
#[tokio::test(flavor = "multi_thread")]
async fn values_round_trip_through_a_script() {
    for (label, url) in servers("values_round_trip_through_a_script") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo.insert("every", vec![json(EVERY_TYPE)]).await;
        let outcome = mongo
            .script(
                "t",
                "const d = db.every.findOne(); d._id = 'copy'; db.copies.insertOne(d); db.every.replaceOne({ _id: d._id }, d, { upsert: true }); 'ok'",
            )
            .await;
        assert_eq!(text(&outcome), "ok", "{label}");
        let original = mongo.find_all("every").await;
        let copy = mongo.find_all("copies").await;
        let (Some(Json::Object(original)), Some(Json::Object(copy))) =
            (original.first(), copy.first())
        else {
            panic!("{label}: documents");
        };
        assert_eq!(
            original.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            copy.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            "{label}: field order"
        );
        for ((key, before), (_, after)) in original.iter().zip(copy) {
            match key.as_str() {
                "_id" => assert_eq!(after, &Json::string("copy")),
                "double_whole" => assert_eq!(
                    after,
                    &json(r#"{"$numberInt":"3"}"#),
                    "{label}: mongosh rule"
                ),
                "undefined" => assert_eq!(after, &Json::Null, "{label}: mongosh rule"),
                _ => assert_eq!(after, before, "{label}: {key}"),
            }
        }
        // Read and printed as mongosh prints them.
        let outcome = mongo
            .script("t", "const d = db.every.findOne(); [d.int64_max, d.decimal, d.uuid, d.timestamp, d.date].map(tojson).join(' ')")
            .await;
        assert_eq!(
            text(&outcome),
            "Long('9223372036854775807') Decimal128('12345678901234567890.123') UUID('12345678-9012-3456-7890-123456789012') Timestamp({ t: 1, i: 2 }) ISODate('2023-11-14T22:13:20.123Z')",
            "{label}"
        );
    }
}

// --- Shell commands ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn shell_commands() {
    for (label, url) in servers("shell_commands") {
        let mongo = Mongo::open(&url, |_| {}).await;
        mongo.insert("listed", vec![json(r#"{"a": 1}"#)]).await;
        let other = format!("{}_other", mongo.database);
        let outcome = mongo
            .script(
                "t",
                &format!("show collections\nshow dbs\nuse {other}\ndb.getName()"),
            )
            .await;
        assert_eq!(text(&outcome), other, "{label}");
        assert_eq!(outcome.database, other, "{label}: the tab follows `use`");
        let shell: Vec<_> = outcome
            .messages
            .iter()
            .filter(|m| m.kind == ScriptMessageKind::Shell)
            .map(|m| m.text.clone())
            .collect();
        assert_eq!(shell[0], "listed", "{label}");
        assert!(shell[1].contains(&mongo.database), "{label}: {}", shell[1]);
        assert_eq!(shell[2], format!("switched to db {other}"), "{label}");
        let outcome = mongo.script("t", "show tables").await;
        assert_eq!(text(&outcome), "listed", "{label}");
        let outcome = mongo.script("t", "db.listed.find()\nit").await;
        assert_eq!(code(&outcome), ErrorCode::NotSupported, "{label}");
        assert_eq!(
            failure(&outcome).position.map(|p| p.line),
            Some(2),
            "{label}"
        );
        let outcome = mongo.script("t", "show nonsense").await;
        assert_eq!(code(&outcome), ErrorCode::NotSupported, "{label}");
        let outcome = mongo.script("t", "show users").await;
        ok(&outcome);
    }
}

// --- Printing and results -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn printing_and_results() {
    for (label, url) in servers("printing_and_results") {
        let mongo = Mongo::open(&url, |_| {}).await;
        orders(&mongo, 1200).await;
        let outcome = mongo
            .script(
                "t",
                "print('a', 1, { b: 2 }); printjson({ c: 'x' }); printjson('s'); console.log('log'); console.warn('w'); console.error('e'); print(ObjectId('5f2b8c9e1c9d440000a1b2c3'))\ndb.orders.find().sort({ n: 1 })",
            )
            .await;
        assert_eq!(
            messages(&outcome),
            [
                "a 1 { b: 2 }",
                "{ c: 'x' }",
                "'s'",
                "log",
                "w",
                "e",
                "ObjectId('5f2b8c9e1c9d440000a1b2c3')"
            ],
            "{label}"
        );
        assert_eq!(outcome.messages[4].kind, ScriptMessageKind::Warn);
        assert_eq!(outcome.messages[5].kind, ScriptMessageKind::Error);
        // An unread cursor is drained by the backend, past the first batches.
        let (docs, cursor, single, truncated) = documents(&mongo, &outcome);
        assert!(cursor && !single && !truncated, "{label}");
        assert_eq!(docs.len(), 1200, "{label}");
        assert_eq!(docs[1199].get("n"), Some(&json(r#"{"$numberInt":"1199"}"#)));
        // A cursor read in part: the rest.
        let outcome = mongo
            .script(
                "t",
                "const c = db.orders.find().sort({ n: 1 }).batchSize(10); c.next(); c.next(); c",
            )
            .await;
        let (docs, ..) = documents(&mongo, &outcome);
        assert_eq!(docs.len(), 1198, "{label}");
        // A document, documents, a write result, scalars, nothing.
        let outcome = mongo.script("t", "db.orders.findOne({ n: 3 })").await;
        let (docs, cursor, single, _) = documents(&mongo, &outcome);
        assert!(!cursor && single && docs.len() == 1, "{label}");
        let outcome = mongo
            .script("t", "db.orders.find({ n: { $lt: 3 } }).toArray()")
            .await;
        let (docs, cursor, single, _) = documents(&mongo, &outcome);
        assert!(!cursor && !single && docs.len() == 3, "{label}");
        let outcome = mongo
            .script("t", "db.orders.updateOne({ n: 1 }, { $set: { x: 1 } })")
            .await;
        let (docs, ..) = documents(&mongo, &outcome);
        assert_eq!(
            docs[0].get("matchedCount"),
            Some(&json(r#"{"$numberInt":"1"}"#)),
            "{label}"
        );
        assert_eq!(
            text(&mongo.script("t", "db.orders.distinct('status')").await),
            "[ 'open', 'paid' ]",
            "{label}"
        );
        assert_eq!(
            text(&mongo.script("t", "'plain'").await),
            "plain",
            "{label}"
        );
        assert_eq!(text(&mongo.script("t", "null").await), "null", "{label}");
        let outcome = mongo.script("t", "let unused = 1").await;
        assert!(
            outcome.result.is_none() && outcome.failure.is_none(),
            "{label}"
        );
        // Messages printed before a failure are kept.
        let outcome = mongo
            .script("t", "print('before'); throw new Error('stop')")
            .await;
        assert_eq!(messages(&outcome), ["before"], "{label}");
        assert_eq!(code(&outcome), ErrorCode::ScriptError);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_keeps_at_most_its_cap() {
    let Some(url) = env(RS_ENV, "a_result_keeps_at_most_its_cap") else {
        return;
    };
    let mongo = Mongo::open(&url, |_| {}).await;
    let outcome = mongo
        .script(
            "t",
            "const docs = []; for (let i = 0; i < 50010; i += 1) docs.push({ i }); db.big.insertMany(docs).acknowledged",
        )
        .await;
    assert_eq!(text(&outcome), "true");
    let outcome = mongo.script("t", "db.big.find()").await;
    let (docs, cursor, _, truncated) = documents(&mongo, &outcome);
    assert!(cursor && truncated);
    assert_eq!(
        docs.len(),
        yadbe_lib::session::document::script::RESULT_MAX_DOCUMENTS
    );
}

// --- Sandbox ------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_sandbox_holds() {
    let Some(url) = env(RS_ENV, "the_sandbox_holds") else {
        return;
    };
    let mongo = Mongo::open(&url, |_| {}).await;
    // Nothing of the outside world is defined.
    let outcome = mongo
        .script(
            "t",
            "[typeof process, typeof fs, typeof setTimeout, typeof setInterval, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof WebAssembly, typeof std, typeof os, typeof Deno, typeof Bun, typeof module, typeof exports, typeof __filename, typeof Atomics.wait].join(',')",
        )
        .await;
    assert_eq!(text(&outcome), ["undefined"; 16].join(","));
    // The mongosh helpers that would reach files, modules or other connections fail by name.
    for (script, method) in [
        ("require('fs')", "require()"),
        ("load('/etc/passwd')", "load()"),
        ("Mongo('mongodb://elsewhere')", "Mongo()"),
        ("connect('elsewhere/db')", "connect()"),
        ("rs.status()", "rs.status()"),
        ("sh.status()", "sh.status()"),
        (
            "db.createUser({ user: 'x', pwd: 'y', roles: [] })",
            "db.createUser()",
        ),
        ("db.orders.watch()", "collection.watch()"),
        ("db.watch()", "db.watch()"),
        ("db.getMongo().startSession()", "Mongo.startSession()"),
        ("db.orders.mapReduce()", "collection.mapReduce()"),
        ("quit()", "quit()"),
    ] {
        let outcome = mongo.script("t", script).await;
        let failure = failure(&outcome);
        assert_eq!(failure.error.code, ErrorCode::NotSupported, "{script}");
        assert!(
            failure.error.message.en.starts_with(method),
            "{script}: {}",
            failure.error.message.en
        );
        // At the call: the method name of a member call (`status` of `rs.status()`).
        assert_eq!(failure.position.map(|p| p.line), Some(1), "{script}");
    }
    // No module loader: a dynamic import rejects, a static one does not parse.
    let outcome = mongo.script("t", "await import('fs')").await;
    assert_eq!(code(&outcome), ErrorCode::ScriptError);
    let outcome = mongo.script("t", "import fs from 'fs'").await;
    assert_eq!(code(&outcome), ErrorCode::ScriptError);
    // eval and Function of local strings stay: they can do what the script can.
    assert_eq!(
        text(
            &mongo
                .script("t", "eval('1 + 1') + new Function('return 3')()")
                .await
        ),
        "5"
    );
    // A catch does not swallow a refusal into a silent success.
    let outcome = mongo
        .script("t", "try { rs.status() } catch (e) { e.name }")
        .await;
    assert_eq!(text(&outcome), "MongoshUnimplementedError");
}

#[tokio::test(flavor = "multi_thread")]
async fn limits_stop_runaway_scripts() {
    let Some(url) = env(RS_ENV, "limits_stop_runaway_scripts") else {
        return;
    };
    let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
    // An infinite loop, cancelled.
    for script in [
        "for (;;) {}",
        "while (true) { try { db.orders.findOne() } catch (e) {} }",
    ] {
        let runner = Arc::clone(&mongo);
        let started = Instant::now();
        let task = tokio::spawn(async move { runner.script("loop", script).await });
        tokio::time::sleep(Duration::from_millis(400)).await;
        mongo.service.cancel("loop").await.expect("cancel");
        let outcome = task.await.expect("task");
        assert_eq!(code(&outcome), ErrorCode::Cancelled, "{script}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{script}: {:?}",
            started.elapsed()
        );
    }
    // Memory and stack.
    let outcome = mongo
        .script(
            "t",
            "const a = []; for (;;) a.push('x'.repeat(1000000) + a.length)",
        )
        .await;
    assert_eq!(code(&outcome), ErrorCode::ScriptError);
    assert!(
        failure(&outcome)
            .error
            .detail
            .as_deref()
            .unwrap_or("")
            .contains("out of memory"),
        "{:?}",
        failure(&outcome)
    );
    let outcome = mongo
        .script("t", "function f(n) { return f(n + 1) + 1 }\nf(0)")
        .await;
    assert_eq!(code(&outcome), ErrorCode::ScriptError);
    assert!(
        failure(&outcome)
            .error
            .detail
            .as_deref()
            .unwrap_or("")
            .contains("stack"),
        "{:?}",
        failure(&outcome)
    );
    // The engine is usable again after either.
    assert_eq!(text(&mongo.script("t", "1 + 1").await), "2");
    // The statement timeout stops a loop.
    let limited = Mongo::open(&url, |def| def.statement_timeout_secs = Some(1)).await;
    let started = Instant::now();
    let outcome = limited.script("t", "let i = 0; for (;;) { i += 1 }").await;
    assert_eq!(code(&outcome), ErrorCode::StatementTimeout);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    let outcome = limited.script("t", "sleep(5000)").await;
    assert_eq!(code(&outcome), ErrorCode::StatementTimeout);
    assert!(text(&limited.script("t", "sleep(10); 'slept'").await) == "slept");
}

async fn slow_fixture(mongo: &Mongo) {
    mongo
        .insert(
            "slow",
            (0..50).map(|i| json(&format!(r#"{{"i": {i}}}"#))).collect(),
        )
        .await;
}

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
async fn a_long_find_is_cancelled_on_the_server() {
    for (label, url) in servers("a_long_find_is_cancelled_on_the_server") {
        let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
        slow_fixture(&mongo).await;
        let runner = Arc::clone(&mongo);
        let task = tokio::spawn(async move {
            runner
                .script(
                    "slow",
                    "print('started'); db.slow.find({ $where: 'sleep(200) || true' }).toArray()",
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(active_on(&mongo, "slow").await, 1, "{label}: it runs");
        let started = Instant::now();
        mongo.service.cancel("slow").await.expect("cancel");
        let outcome = task.await.expect("task");
        assert_eq!(code(&outcome), ErrorCode::Cancelled, "{label}");
        assert_eq!(messages(&outcome), ["started"], "{label}");
        assert!(started.elapsed() < Duration::from_secs(3), "{label}");
        let deadline = Instant::now() + Duration::from_secs(3);
        while active_on(&mongo, "slow").await > 0 {
            assert!(
                Instant::now() < deadline,
                "{label}: still running on the server"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            mongo.log.entries().iter().any(|e| e.sql.contains("killOp")),
            "{label}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn printed_lines_reach_the_front_while_the_script_runs() {
    let Some(url) = env(
        RS_ENV,
        "printed_lines_reach_the_front_while_the_script_runs",
    ) else {
        return;
    };
    let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
    let runner = Arc::clone(&mongo);
    // A line printed before a wait, then lines printed in a busy loop past the stream's pace.
    let task = tokio::spawn(async move {
        runner
            .script(
                "out",
                "print('first'); sleep(1500);\nconst until = Date.now() + 400; let n = 0;\nwhile (Date.now() < until) { if (n++ % 1000 === 0) print('tick'); }\nsleep(1500); print('last')",
            )
            .await
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while mongo.confirms.streamed("out").is_empty() {
        assert!(
            Instant::now() < deadline,
            "nothing streamed before the wait"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!task.is_finished(), "streamed while the script runs");
    assert_eq!(mongo.confirms.streamed("out"), ["first"]);
    // The busy loop's lines arrive before the script's last wait ends.
    let deadline = Instant::now() + Duration::from_secs(3);
    while !mongo
        .confirms
        .streamed("out")
        .iter()
        .any(|line| line == "tick")
    {
        assert!(
            Instant::now() < deadline,
            "the loop's lines were not streamed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!task.is_finished(), "streamed while the script runs");
    let outcome = task.await.expect("task");
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    // The outcome carries every line again; the stream held a prefix of them, once each, in
    // order (lines printed just before the end may come with the outcome only).
    let all = messages(&outcome);
    assert_eq!(all.first().map(String::as_str), Some("first"));
    assert_eq!(all.last().map(String::as_str), Some("last"));
    let streamed = mongo.confirms.streamed("out");
    assert_eq!(streamed[..], all[..streamed.len()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_cursor_is_cancelled_while_drained() {
    let Some(url) = env(RS_ENV, "a_result_cursor_is_cancelled_while_drained") else {
        return;
    };
    let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
    slow_fixture(&mongo).await;
    let runner = Arc::clone(&mongo);
    let task = tokio::spawn(async move {
        runner
            .script(
                "drain",
                "db.slow.find({ $where: 'sleep(200) || true' }).batchSize(1)",
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(1200)).await;
    mongo.service.cancel("drain").await.expect("cancel");
    let outcome = task.await.expect("task");
    assert_eq!(code(&outcome), ErrorCode::Cancelled);
}

// --- Read-only and dangerous operations --------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn read_only_stops_at_the_first_write() {
    for (label, url) in servers("read_only_stops_at_the_first_write") {
        let mongo = Mongo::open(&url, |_| {}).await;
        orders(&mongo, 3).await;
        mongo
            .manager
            .session(&mongo.id)
            .expect("session")
            .set_read_only(true)
            .await
            .expect("read-only");
        let outcome = mongo
            .script(
                "t",
                "print(db.orders.countDocuments());\nprint(db.orders.find().toArray().length);\ndb.orders.insertOne({ x: 1 });\nprint('after')",
            )
            .await;
        let failure = failure(&outcome);
        assert_eq!(failure.error.code, ErrorCode::ReadOnlyViolation, "{label}");
        assert_eq!(
            messages(&outcome),
            ["3", "3"],
            "{label}: the reads ran, nothing after"
        );
        assert_eq!(
            failure.position.map(|p| (p.line, p.column)),
            Some((3, 11)),
            "{label}"
        );
        // A writing aggregation is refused when it is called, even if never read.
        for script in [
            "db.orders.aggregate([{ $out: 'copy' }]); 'unreached'",
            "db.orders.updateMany({}, { $set: { a: 1 } })",
            "db.dropDatabase()",
            "db.runCommand({ insert: 'orders', documents: [{}] })",
            "db.orders.bulkWrite([{ insertOne: { document: {} } }])",
            "db.orders.findOneAndDelete({})",
            "db.orders.createIndex({ a: 1 })",
        ] {
            let outcome = mongo.script("t", script).await;
            assert_eq!(
                code(&outcome),
                ErrorCode::ReadOnlyViolation,
                "{label}: {script}"
            );
        }
        assert_eq!(mongo.count("orders").await, 3.0, "{label}");
        let copy = mongo.find_all("copy").await;
        assert!(copy.is_empty(), "{label}");
        // Reads still run.
        assert_eq!(
            text(
                &mongo
                    .script(
                        "t",
                        "db.orders.find().explain() && db.orders.countDocuments()"
                    )
                    .await
            ),
            "3"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dangerous_operations_pause_for_a_confirmation() {
    for (label, url) in servers("dangerous_operations_pause_for_a_confirmation") {
        let mongo = Arc::new(Mongo::open(&url, |_| {}).await);
        orders(&mongo, 7).await;
        // Confirmed: the script goes on.
        mongo.confirms.set(Some(true));
        let outcome = mongo
            .script("t", "print('before');\nconst r = db.orders.deleteMany({});\nprint('deleted ' + r.deletedCount);\ndb.orders.countDocuments()")
            .await;
        assert_eq!(text(&outcome), "0", "{label}");
        assert_eq!(messages(&outcome), ["before", "deleted 7"], "{label}");
        let asked = mongo.confirms.asked();
        assert_eq!(asked.len(), 1, "{label}");
        assert_eq!(asked[0].tab_id, "t");
        assert_eq!(
            (asked[0].danger.command.as_str(), asked[0].danger.documents),
            ("deleteMany", Some(7.0))
        );
        // Declined: the script stops there, nothing sent.
        orders(&mongo, 7).await;
        mongo.confirms.set(Some(false));
        let outcome = mongo
            .script(
                "t",
                "db.orders.updateMany({}, { $set: { x: 1 } });\nprint('after')",
            )
            .await;
        let failure = failure(&outcome);
        assert_eq!(failure.error.code, ErrorCode::Cancelled, "{label}");
        assert!(
            failure
                .error
                .message
                .en
                .starts_with("updateMany was not run"),
            "{label}"
        );
        assert_eq!(failure.position.map(|p| p.line), Some(1));
        assert!(outcome.messages.is_empty(), "{label}");
        assert_eq!(mongo.count("orders").await, 7.0, "{label}");
        // A dangerous bulk write and a database drop ask too.
        let outcome = mongo
            .script("t", "db.orders.bulkWrite([{ deleteMany: { filter: {} } }])")
            .await;
        assert_eq!(code(&outcome), ErrorCode::Cancelled, "{label}");
        assert_eq!(mongo.count("orders").await, 7.0, "{label}");
        // Unanswered: cancel still stops the wait.
        mongo.confirms.set(None);
        let runner = Arc::clone(&mongo);
        let task = tokio::spawn(async move { runner.script("wait", "db.dropDatabase()").await });
        let deadline = Instant::now() + Duration::from_secs(5);
        while mongo.confirms.asked().iter().all(|c| c.tab_id != "wait") {
            assert!(Instant::now() < deadline, "{label}: asked");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        mongo.service.cancel("wait").await.expect("cancel");
        let outcome = task.await.expect("task");
        assert_eq!(code(&outcome), ErrorCode::Cancelled, "{label}");
        assert_eq!(mongo.count("orders").await, 7.0, "{label}");
        // A late answer finds nothing waiting.
        let request = mongo
            .confirms
            .asked()
            .last()
            .map(|c| c.request_id)
            .expect("asked");
        assert!(!mongo.service.script_confirm("wait", request, true));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_timeout_runs_during_a_confirmation() {
    let Some(url) = env(RS_ENV, "the_timeout_runs_during_a_confirmation") else {
        return;
    };
    let mongo = Mongo::open(&url, |def| def.statement_timeout_secs = Some(1)).await;
    orders(&mongo, 2).await;
    mongo.confirms.set(None);
    let started = Instant::now();
    let outcome = mongo.script("t", "db.orders.deleteMany({})").await;
    assert_eq!(code(&outcome), ErrorCode::StatementTimeout);
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(mongo.count("orders").await, 2.0);
}

// --- Errors -----------------------------------------------------------------------------------

fn position(outcome: &ScriptOutcome) -> (u32, u32, u32) {
    let at = failure(outcome)
        .position
        .unwrap_or_else(|| panic!("a position: {:?}", outcome.failure));
    (at.line, at.column, at.offset)
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_are_placed_in_the_editor_text() {
    let Some(url) = env(RS_ENV, "errors_are_placed_in_the_editor_text") else {
        return;
    };
    let mongo = Mongo::open(&url, |_| {}).await;
    // A syntax error.
    let outcome = mongo.script("t", "const a = 1;\n\nconst b = ;").await;
    assert_eq!(code(&outcome), ErrorCode::ScriptError);
    assert!(
        failure(&outcome)
            .error
            .detail
            .as_deref()
            .unwrap_or("")
            .starts_with("SyntaxError")
    );
    assert_eq!(position(&outcome), (3, 11, 24));
    // A runtime error, after non-ASCII text (columns in UTF-16 units).
    let outcome = mongo
        .script("t", "print('é😀')\n  const é = '😀'; null.x")
        .await;
    assert!(
        failure(&outcome)
            .error
            .detail
            .as_deref()
            .unwrap_or("")
            .starts_with("TypeError")
    );
    assert_eq!(position(&outcome).0, 2);
    assert_eq!(position(&outcome).1, 19);
    // A server error, at the call that sent it.
    let outcome = mongo
        .script("t", "print(1)\ndb.orders.find({ $bad: 1 }).toArray()")
        .await;
    assert_eq!(code(&outcome), ErrorCode::QueryFailed);
    assert_eq!(position(&outcome).0, 2);
    // A thrown value that is not an Error.
    let outcome = mongo.script("t", "throw 'plain'").await;
    assert_eq!(
        failure(&outcome).error.detail.as_deref(),
        Some("Uncaught 'plain'")
    );
    // Inside a function, the user's frame is the one shown.
    let outcome = mongo
        .script(
            "t",
            "function f() {\n  return db.orders.insertOne(5)\n}\nf()",
        )
        .await;
    assert_eq!(code(&outcome), ErrorCode::ScriptError);
    assert_eq!(position(&outcome).0, 2);
    // A selection runs alone, and its errors are placed in the whole text.
    let text = "db.orders.insertOne({ a: 1 })\nconst x = 1; null.y\nprint('not run')";
    let outcome = mongo
        .service
        .run_script(
            "t",
            &mongo.id,
            ScriptRequest {
                database: mongo.database.clone(),
                text: text.to_owned(),
                range: Some(TextRange { from: 43, to: 49 }),
            },
        )
        .await
        .expect("ran");
    assert_eq!(position(&outcome), (2, 14, 43));
    assert!(outcome.messages.is_empty());
    assert_eq!(
        mongo.count("orders").await,
        0.0,
        "the first line was not selected"
    );
}

/// The script ran with its typed error and nothing reached the server for a request the
/// bridge refused.
#[tokio::test(flavor = "multi_thread")]
async fn options_yadbe_does_not_send_are_refused_by_name() {
    let Some(url) = env(RS_ENV, "options_yadbe_does_not_send_are_refused_by_name") else {
        return;
    };
    let mongo = Mongo::open(&url, |_| {}).await;
    for (script, method) in [
        (
            "db.orders.find().readPref('secondary')",
            "cursor.readPref()",
        ),
        ("db.orders.find().min({ a: 1 })", "cursor.min()"),
        (
            "db.orders.find().noCursorTimeout()",
            "cursor.noCursorTimeout()",
        ),
        (
            "db.orders.find({}, {}, { tailable: true })",
            "the option tailable of find()",
        ),
        (
            "db.orders.insertOne({}, { bypassDocumentValidation: true })",
            "the option bypassDocumentValidation of insertOne()",
        ),
        (
            "db.orders.initializeOrderedBulkOp()",
            "collection.initializeOrderedBulkOp()",
        ),
        // Options yadbe does not send are refused rather than silently ignored.
        (
            "db.orders.deleteOne({}, { writeConcern: { w: 'majority' } })",
            "the option writeConcern of deleteOne()",
        ),
        (
            "db.orders.estimatedDocumentCount({ maxTimeMS: 5 })",
            "the option maxTimeMS of estimatedDocumentCount()",
        ),
    ] {
        let outcome = mongo.script("t", script).await;
        let failure: &ScriptFailure = failure(&outcome);
        assert_eq!(failure.error.code, ErrorCode::NotSupported, "{script}");
        assert!(
            failure.error.message.en.starts_with(method),
            "{script}: {}",
            failure.error.message.en
        );
    }
    assert!(mongo.find_all("orders").await.is_empty());
}
