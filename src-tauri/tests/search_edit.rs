//! Document edits of the search family (M4-8), against Elasticsearch and OpenSearch: every
//! request yadbe generates (replace, create with and without id, delete) checked against the
//! resulting index state, optimistic concurrency (a concurrent change, a create on an existing
//! id), routing kept, numbers past 64 bits and long decimals written back digit for digit, an
//! apply that stops at its first failure with the list of what it applied, the journal entry
//! and an exact revert, a revert that meets a newer change, the read-only refusal, data streams
//! and write-blocked indices refused, statements in the log.
//!
//! `YADBE_TEST_ES_URL` (+ `YADBE_TEST_ES_CA`) and `YADBE_TEST_OPENSEARCH_URL`; unset: SKIPPED.
//! Each test works on its own indices (`yadbe-edit-<test>*`), deleted first.

mod common;

use std::sync::Arc;

use common::{driver, from_url, skip};
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::driver::{ConnectRequest, NoRecorder, SearchConnection};
use yadbe_lib::db::engine::{Engine, EngineFamily};
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::search::edit::{SearchChangeSet, SearchEdit, SearchEditBlock, SeqGuard};
use yadbe_lib::db::search::request::{HttpMethod, RequestBody, SearchRequest, SearchResponse};
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::history_hook::NoHistory;
use yadbe_lib::session::journal::ChangeJournal;
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::search::SearchService;
use yadbe_lib::session::search::edit::{
    SearchApplyOutcome, SearchConflictKind, SearchDocVersion, SearchStopReason,
};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::{JournalTargetKind, Store};

#[derive(Clone)]
struct Server {
    label: &'static str,
    url: String,
    ca: Option<String>,
}

fn servers(test: &str) -> Vec<Server> {
    let mut found = Vec::new();
    for (label, env, ca) in [
        (
            "elasticsearch",
            "YADBE_TEST_ES_URL",
            Some("YADBE_TEST_ES_CA"),
        ),
        ("opensearch", "YADBE_TEST_OPENSEARCH_URL", None),
    ] {
        match std::env::var(env) {
            Ok(url) if !url.trim().is_empty() => found.push(Server {
                label,
                url,
                ca: ca.and_then(|ca| std::env::var(ca).ok()),
            }),
            _ => skip(&format!("{test} ({label})"), &format!("{env} is not set")),
        }
    }
    found
}

struct Bench {
    label: &'static str,
    log: Arc<StatementLog>,
    store: Arc<Store>,
    search: SearchService,
    id: String,
    admin: Arc<dyn SearchConnection>,
}

impl Bench {
    async fn new(server: &Server, read_only: bool) -> Bench {
        let store = Arc::new(Store::open_in_memory().expect("store"));
        let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
        let sink = Arc::new(RecordingSink::default());
        let log = Arc::new(StatementLog::new(sink.clone()));
        let manager = Arc::new(ConnectionManager::new(
            Arc::clone(&store),
            secrets,
            Arc::clone(&log),
            sink.clone(),
        ));
        let (mut def, password) = from_url(&server.url);
        def.ca_cert_path = server.ca.clone();
        let admin_target = def.clone().normalized().expect("valid").target();
        def.read_only = read_only;
        let saved = store
            .create_connection(&def.normalized().expect("valid"))
            .expect("save");
        manager.connect(&saved.id, password).await.expect("connect");
        let (_, password) = from_url(&server.url);
        let journal = Arc::new(ChangeJournal::new(Arc::clone(&store), sink));
        let search = SearchService::new(
            Arc::clone(&manager),
            Arc::new(ResultStore::default()),
            Arc::new(NoHistory),
        )
        .with_journal(journal);
        let admin = driver(Engine::Elasticsearch)
            .connect(ConnectRequest {
                target: &admin_target,
                password: password.as_ref(),
                recorder: Arc::new(NoRecorder),
            })
            .await
            .expect("admin connection")
            .into_search()
            .expect("search");
        Bench {
            label: server.label,
            log,
            store,
            search,
            id: saved.id,
            admin,
        }
    }

    async fn call(&self, method: HttpMethod, path: &str, body: Option<&str>) -> SearchResponse {
        let mut request = SearchRequest::new(method, path);
        request.body = body.map(|text| RequestBody {
            text: text.to_owned(),
            ndjson: false,
        });
        self.admin.send(&request, None).await.expect("sent")
    }

    async fn ok(&self, method: HttpMethod, path: &str, body: Option<&str>) -> Json {
        let response = self.call(method, path, body).await;
        assert!(
            response.is_success(),
            "{}: {} {path}: {} {}",
            self.label,
            method.as_str(),
            response.status,
            response.text()
        );
        response.json().unwrap_or(Json::Null)
    }

    async fn clean(&self, prefix: &str) {
        let _ = self
            .call(
                HttpMethod::Delete,
                &format!("/_data_stream/{prefix}*"),
                None,
            )
            .await;
        let _ = self
            .call(
                HttpMethod::Delete,
                &format!("/_index_template/{prefix}-template"),
                None,
            )
            .await;
        let list = self
            .call(
                HttpMethod::Get,
                &format!("/_cat/indices/{prefix}*?format=json&h=index&expand_wildcards=all"),
                None,
            )
            .await
            .json()
            .unwrap_or(Json::Null);
        for index in list.as_array().unwrap_or(&[]) {
            if let Some(name) = index.get("index").and_then(Json::as_str) {
                let _ = self
                    .call(HttpMethod::Delete, &format!("/{name}"), None)
                    .await;
            }
        }
    }

    /// A fresh index with documents `d0 … d{n-1}` `{"n": i, "tag": "t{i}"}`, refreshed.
    async fn index(&self, index: &str, n: usize) {
        self.ok(
            HttpMethod::Put,
            &format!("/{index}"),
            // Only `tag` is indexed: the tests write numbers of every size into the other fields.
            Some(
                r#"{"settings":{"number_of_shards":2,"number_of_replicas":0},"mappings":{"dynamic":false,"properties":{"tag":{"type":"keyword"}}}}"#,
            ),
        )
        .await;
        for i in 0..n {
            self.ok(
                HttpMethod::Put,
                &format!("/{index}/_doc/d{i}"),
                Some(&format!(r#"{{"n":{i},"tag":"t{i}"}}"#)),
            )
            .await;
        }
        self.ok(HttpMethod::Post, &format!("/{index}/_refresh"), None)
            .await;
    }

    /// The raw `_source` text of a document as the server stores it; `None` when absent.
    async fn raw_source(&self, index: &str, id: &str, routing: Option<&str>) -> Option<String> {
        let path = match routing {
            Some(r) => format!("/{index}/_source/{id}?routing={r}"),
            None => format!("/{index}/_source/{id}"),
        };
        let response = self.call(HttpMethod::Get, &path, None).await;
        (response.status == 200).then(|| response.text())
    }

    /// Hits of a search sent right after an apply, without asking for a refresh.
    async fn searched(&self, index: &str, query: &str) -> usize {
        let json = self
            .ok(
                HttpMethod::Post,
                &format!("/{index}/_search"),
                Some(&format!(r#"{{"query":{query},"size":100}}"#)),
            )
            .await;
        json.get("hits")
            .and_then(|h| h.get("hits"))
            .and_then(Json::as_array)
            .map_or(0, <[Json]>::len)
    }

    async fn get(&self, index: &str, id: &str, routing: Option<&str>) -> SearchDocVersion {
        self.search
            .get_document(&self.id, index, id, routing)
            .await
            .expect("get")
    }

    async fn apply(&self, target: &str, edits: Vec<SearchEdit>) -> SearchApplyOutcome {
        self.search
            .apply_changes(
                &self.id,
                &SearchChangeSet {
                    target: target.to_owned(),
                    edits,
                },
            )
            .await
            .expect("apply")
    }
}

fn guard_of(version: &SearchDocVersion) -> SeqGuard {
    version.guard.clone().expect("a version")
}

fn replace(index: &str, id: &str, version: &SearchDocVersion, source: &str) -> SearchEdit {
    SearchEdit::Replace {
        index: index.into(),
        id: id.into(),
        routing: version.routing.clone(),
        guard: guard_of(version),
        source: source.into(),
    }
}

fn delete(index: &str, id: &str, version: &SearchDocVersion) -> SearchEdit {
    SearchEdit::Delete {
        index: index.into(),
        id: id.into(),
        routing: version.routing.clone(),
        guard: guard_of(version),
    }
}

fn create(index: &str, id: Option<&str>, source: &str) -> SearchEdit {
    SearchEdit::Create {
        index: index.into(),
        id: id.map(str::to_owned),
        routing: None,
        source: source.into(),
    }
}

fn assert_complete(label: &str, outcome: &SearchApplyOutcome) {
    assert!(
        outcome.stopped.is_none(),
        "{label}: stopped: {:?}",
        outcome.stopped
    );
    assert_eq!(outcome.applied.len() as u32, outcome.total, "{label}");
}

#[tokio::test]
async fn replace_create_and_delete_change_the_index_and_are_searchable_at_once() {
    for server in servers("replace_create_and_delete") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let index = "yadbe-edit-basic";
        bench.clean(index).await;
        bench.index(index, 3).await;

        let d0 = bench.get(index, "d0", None).await;
        assert!(d0.found, "{label}");
        assert_eq!(
            d0.source.as_deref(),
            Some("{\n  \"n\": 0,\n  \"tag\": \"t0\"\n}")
        );
        let outcome = bench
            .apply(
                index,
                vec![
                    replace(
                        index,
                        "d0",
                        &d0,
                        r#"{"n": 100, "tag": "edited", "added": true}"#,
                    ),
                    create(index, Some("new-1"), r#"{"n": 7, "tag": "created"}"#),
                    create(index, None, r#"{"n": 8, "tag": "auto"}"#),
                    delete(index, "d1", &bench.get(index, "d1", None).await),
                ],
            )
            .await;
        assert_complete(label, &outcome);
        let results: Vec<&str> = outcome.applied.iter().map(|a| a.result.as_str()).collect();
        assert_eq!(
            results,
            ["updated", "created", "created", "deleted"],
            "{label}"
        );
        assert!(outcome.not_visible.is_empty(), "{label}");
        let auto_id = outcome.applied[2].id.clone();
        assert!(!auto_id.is_empty(), "{label}: the server picked an id");

        assert_eq!(
            bench.raw_source(index, "d0", None).await.as_deref(),
            Some(r#"{"n":100,"tag":"edited","added":true}"#),
            "{label}"
        );
        assert_eq!(
            bench.raw_source(index, "new-1", None).await.as_deref(),
            Some(r#"{"n":7,"tag":"created"}"#),
            "{label}"
        );
        assert!(
            bench.raw_source(index, &auto_id, None).await.is_some(),
            "{label}"
        );
        assert_eq!(bench.raw_source(index, "d1", None).await, None, "{label}");
        // `refresh=wait_for`: a search right after the apply sees every change.
        assert_eq!(
            bench.searched(index, r#"{"term":{"tag":"edited"}}"#).await,
            1,
            "{label}"
        );
        assert_eq!(
            bench
                .searched(index, r#"{"terms":{"tag":["created","auto"]}}"#)
                .await,
            2,
            "{label}"
        );
        assert_eq!(
            bench.searched(index, r#"{"term":{"tag":"t1"}}"#).await,
            0,
            "{label}"
        );
        // yadbe's requests are in the statement log, guarded.
        let logged: Vec<String> = bench.log.entries().into_iter().map(|e| e.sql).collect();
        assert!(
            logged.iter().any(|s| s.starts_with(&format!(
                "PUT /{index}/_doc/d0?if_seq_no={}&if_primary_term={}&refresh=wait_for",
                d0.guard.as_ref().expect("guard").seq_no,
                d0.guard.as_ref().expect("guard").primary_term
            ))),
            "{label}: {logged:?}"
        );
        assert!(
            logged
                .iter()
                .any(|s| s.starts_with(&format!("PUT /{index}/_doc/new-1?op_type=create"))),
            "{label}"
        );
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn a_concurrent_change_and_an_existing_id_are_conflicts() {
    for server in servers("conflicts") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let index = "yadbe-edit-conflict";
        bench.clean(index).await;
        bench.index(index, 2).await;

        let seen = bench.get(index, "d0", None).await;
        // Someone else writes the document after the user read it.
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}/_doc/d0"),
                Some(r#"{"n":0,"tag":"theirs"}"#),
            )
            .await;
        let outcome = bench
            .apply(
                index,
                vec![replace(index, "d0", &seen, r#"{"n":0,"tag":"mine"}"#)],
            )
            .await;
        assert!(outcome.applied.is_empty(), "{label}");
        assert_eq!(outcome.journal_id, None, "{label}: nothing to journal");
        let stop = outcome.stopped.expect("stopped");
        let SearchStopReason::Conflict { conflict } = stop.reason else {
            panic!("{label}: a conflict expected");
        };
        assert_eq!(conflict.kind, SearchConflictKind::Changed, "{label}");
        let current = conflict.current.expect("current version");
        assert!(
            current
                .source
                .as_deref()
                .is_some_and(|s| s.contains("theirs")),
            "{label}: {current:?}"
        );
        assert_eq!(
            bench.raw_source(index, "d0", None).await.as_deref(),
            Some(r#"{"n":0,"tag":"theirs"}"#),
            "{label}: theirs kept"
        );

        // A delete with a stale version is refused the same way.
        let outcome = bench.apply(index, vec![delete(index, "d0", &seen)]).await;
        assert!(
            matches!(
                outcome.stopped.map(|s| s.reason),
                Some(SearchStopReason::Conflict { .. })
            ),
            "{label}"
        );
        assert!(
            bench.raw_source(index, "d0", None).await.is_some(),
            "{label}"
        );

        // A create on an id that exists is a conflict, never an overwrite.
        let outcome = bench
            .apply(index, vec![create(index, Some("d1"), r#"{"n":-1}"#)])
            .await;
        let Some(SearchStopReason::Conflict { conflict }) = outcome.stopped.map(|s| s.reason)
        else {
            panic!("{label}: a conflict expected");
        };
        assert_eq!(conflict.kind, SearchConflictKind::Exists, "{label}");
        assert!(conflict.current.is_some_and(|c| c.found), "{label}");
        assert_eq!(
            bench.raw_source(index, "d1", None).await.as_deref(),
            Some(r#"{"n":1,"tag":"t1"}"#),
            "{label}"
        );

        // A document deleted meanwhile is missing.
        let d1 = bench.get(index, "d1", None).await;
        bench
            .ok(HttpMethod::Delete, &format!("/{index}/_doc/d1"), None)
            .await;
        let outcome = bench
            .apply(index, vec![replace(index, "d1", &d1, "{}")])
            .await;
        let Some(SearchStopReason::Conflict { conflict }) = outcome.stopped.map(|s| s.reason)
        else {
            panic!("{label}: a conflict expected");
        };
        assert_eq!(conflict.kind, SearchConflictKind::Missing, "{label}");
        assert_eq!(bench.raw_source(index, "d1", None).await, None, "{label}");
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn routing_is_kept_and_numbers_stay_exact() {
    for server in servers("routing_and_numbers") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let index = "yadbe-edit-routing";
        bench.clean(index).await;
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}"),
                Some(
                    r#"{"settings":{"number_of_shards":3,"number_of_replicas":0},"mappings":{"_routing":{"required":true},"dynamic":false,"properties":{"tag":{"type":"keyword"}}}}"#,
                ),
            )
            .await;
        let exact = r#"{"big":123456789012345678901234567890,"long":9223372036854775807,"dec":0.1000000000000000055511151231257827021181583404541015625,"neg":-1.5E+300,"tag":"x","z":{"b":1,"a":2}}"#;
        let outcome = bench
            .apply(
                index,
                vec![SearchEdit::Create {
                    index: index.into(),
                    id: Some("r1".into()),
                    routing: Some("tenant-7".into()),
                    source: exact.into(),
                }],
            )
            .await;
        assert_complete(label, &outcome);
        assert_eq!(
            bench
                .raw_source(index, "r1", Some("tenant-7"))
                .await
                .as_deref(),
            Some(exact),
            "{label}: written digit for digit, keys in order"
        );
        let version = bench.get(index, "r1", Some("tenant-7")).await;
        assert_eq!(version.routing.as_deref(), Some("tenant-7"), "{label}");
        assert!(
            version
                .source
                .as_deref()
                .is_some_and(|s| s.contains("123456789012345678901234567890")
                    && s.contains("0.1000000000000000055511151231257827021181583404541015625")),
            "{label}: read back exact: {:?}",
            version.source
        );
        // An edit of the text the editor got writes it back unchanged but for the edit.
        let edited = version
            .source
            .as_deref()
            .expect("source")
            .replace("\"x\"", "\"y\"");
        let outcome = bench
            .apply(index, vec![replace(index, "r1", &version, &edited)])
            .await;
        assert_complete(label, &outcome);
        assert_eq!(
            bench
                .raw_source(index, "r1", Some("tenant-7"))
                .await
                .as_deref(),
            Some(exact.replace("\"x\"", "\"y\"").as_str()),
            "{label}"
        );
        // The routing went with the write: the document is where the routing puts it.
        let routed = bench
            .ok(
                HttpMethod::Get,
                &format!("/{index}/_doc/r1?routing=tenant-7"),
                None,
            )
            .await;
        assert_eq!(
            routed.get("_routing").and_then(Json::as_str),
            Some("tenant-7"),
            "{label}"
        );
        let outcome = bench
            .apply(
                index,
                vec![delete(
                    index,
                    "r1",
                    &bench.get(index, "r1", Some("tenant-7")).await,
                )],
            )
            .await;
        assert_complete(label, &outcome);
        assert_eq!(bench.raw_source(index, "r1", Some("tenant-7")).await, None);
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn an_apply_stops_at_its_first_failure_and_journals_what_it_applied() {
    for server in servers("stop_at_first_failure") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let index = "yadbe-edit-stop";
        bench.clean(index).await;
        bench.index(index, 3).await;
        let d0 = bench.get(index, "d0", None).await;
        let d1 = bench.get(index, "d1", None).await;
        let d2 = bench.get(index, "d2", None).await;
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}/_doc/d1"),
                Some(r#"{"n":1,"tag":"theirs"}"#),
            )
            .await;
        let outcome = bench
            .apply(
                index,
                vec![
                    replace(index, "d0", &d0, r#"{"n":0,"tag":"first"}"#),
                    replace(index, "d1", &d1, r#"{"n":1,"tag":"second"}"#),
                    delete(index, "d2", &d2),
                ],
            )
            .await;
        assert_eq!(outcome.total, 3, "{label}");
        assert_eq!(outcome.applied.len(), 1, "{label}");
        assert_eq!(outcome.applied[0].edit, 0, "{label}");
        assert_eq!(outcome.stopped.as_ref().map(|s| s.edit), Some(1), "{label}");
        assert!(
            bench
                .raw_source(index, "d0", None)
                .await
                .is_some_and(|s| s.contains("first"))
        );
        assert!(
            bench
                .raw_source(index, "d1", None)
                .await
                .is_some_and(|s| s.contains("theirs"))
        );
        assert!(
            bench.raw_source(index, "d2", None).await.is_some(),
            "{label}: the edit after the failure was not sent"
        );
        let entry = outcome.journal_id.expect("journaled");
        assert!(outcome.revertible, "{label}");
        let detail = bench
            .store
            .journal_entry(entry)
            .expect("journal")
            .expect("entry");
        assert_eq!(detail.entry.family, EngineFamily::Search, "{label}");
        assert_eq!(
            detail.entry.target_kind,
            JournalTargetKind::Index,
            "{label}"
        );
        assert_eq!(detail.entry.table.name, index, "{label}");
        assert_eq!(detail.entry.updated, 1, "{label}");
        assert_eq!(detail.statements.len(), 1, "{label}");
        assert!(detail.statements[0].sql.contains("first"), "{label}");
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn a_revert_restores_exactly_and_meets_newer_changes_as_conflicts() {
    for server in servers("revert") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let index = "yadbe-edit-revert";
        bench.clean(index).await;
        bench.index(index, 3).await;
        let exact = r#"{"n":0.1000000000000000055511151231257827,"tag":"t0","big":123456789012345678901234567890}"#;
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}/_doc/d0?refresh=true"),
                Some(exact),
            )
            .await;
        let before: Vec<Option<String>> = {
            let mut list = Vec::new();
            for id in ["d0", "d1", "d2", "c1"] {
                list.push(bench.raw_source(index, id, None).await);
            }
            list
        };
        let outcome = bench
            .apply(
                index,
                vec![
                    replace(
                        index,
                        "d0",
                        &bench.get(index, "d0", None).await,
                        r#"{"n":1,"tag":"changed"}"#,
                    ),
                    delete(index, "d1", &bench.get(index, "d1", None).await),
                    create(index, Some("c1"), r#"{"n":9,"tag":"created"}"#),
                ],
            )
            .await;
        assert_complete(label, &outcome);
        let entry = outcome.journal_id.expect("journaled");
        assert!(outcome.revertible, "{label}");

        let preview = bench
            .search
            .preview_revert(&bench.id, entry)
            .await
            .expect("revert preview");
        assert!(preview.preview.refused.is_empty(), "{label}");
        let lines: Vec<&str> = preview
            .preview
            .requests
            .iter()
            .map(|r| r.text.lines().next().unwrap_or_default())
            .collect();
        assert!(
            lines[0].starts_with(&format!("DELETE /{index}/_doc/c1?if_seq_no=")),
            "{label}: {lines:?}"
        );
        assert!(
            lines[1].starts_with(&format!("PUT /{index}/_doc/d1?op_type=create")),
            "{label}"
        );
        assert!(
            lines[2].starts_with(&format!("PUT /{index}/_doc/d0?if_seq_no=")),
            "{label}"
        );

        let reverted = bench
            .search
            .apply_revert(&bench.id, entry)
            .await
            .expect("revert");
        assert_complete(label, &reverted);
        let mut after = Vec::new();
        for id in ["d0", "d1", "d2", "c1"] {
            after.push(bench.raw_source(index, id, None).await);
        }
        assert_eq!(after, before, "{label}: back to the exact previous state");
        let detail = bench
            .store
            .journal_entry(entry)
            .expect("journal")
            .expect("entry");
        assert_eq!(detail.entry.reverted_by, reverted.journal_id, "{label}");
        let again = bench.search.apply_revert(&bench.id, entry).await;
        assert_eq!(
            again.map(|_| ()).map_err(|e| e.code),
            Err(ErrorCode::InvalidArgument),
            "{label}: reverted once"
        );

        // A change made after the apply makes its revert a conflict.
        let d2 = bench.get(index, "d2", None).await;
        let outcome = bench
            .apply(
                index,
                vec![replace(index, "d2", &d2, r#"{"n":2,"tag":"mine"}"#)],
            )
            .await;
        let entry = outcome.journal_id.expect("journaled");
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}/_doc/d2"),
                Some(r#"{"n":2,"tag":"theirs"}"#),
            )
            .await;
        let revert = bench
            .search
            .apply_revert(&bench.id, entry)
            .await
            .expect("revert ran");
        assert!(revert.applied.is_empty(), "{label}");
        assert!(
            matches!(
                revert.stopped.map(|s| s.reason),
                Some(SearchStopReason::Conflict { conflict }) if conflict.kind == SearchConflictKind::Changed
            ),
            "{label}"
        );
        assert!(
            bench
                .raw_source(index, "d2", None)
                .await
                .is_some_and(|s| s.contains("theirs"))
        );
        let detail = bench
            .store
            .journal_entry(entry)
            .expect("journal")
            .expect("entry");
        assert_eq!(
            detail.entry.reverted_by, None,
            "{label}: still revertible later"
        );
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn read_only_connections_and_blocked_indices_refuse_edits() {
    for server in servers("refusals") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let index = "yadbe-edit-refuse";
        bench.clean(index).await;
        bench.index(index, 2).await;

        let read_only = Bench::new(&server, true).await;
        let d0 = read_only.get(index, "d0", None).await;
        assert!(d0.found, "{label}: reads still work");
        let refused = read_only
            .search
            .apply_changes(
                &read_only.id,
                &SearchChangeSet {
                    target: index.into(),
                    edits: vec![delete(index, "d0", &d0)],
                },
            )
            .await;
        assert_eq!(
            refused.map(|_| ()).map_err(|e| e.code),
            Err(ErrorCode::ReadOnlyViolation),
            "{label}"
        );
        assert!(
            bench.raw_source(index, "d0", None).await.is_some(),
            "{label}"
        );
        let info = read_only
            .search
            .edit_info(&read_only.id, index)
            .await
            .expect("info");
        assert!(info.read_only && info.create_targets.is_empty(), "{label}");
        let preview = read_only
            .search
            .preview_changes(
                &read_only.id,
                &SearchChangeSet {
                    target: index.into(),
                    edits: vec![delete(index, "d0", &d0)],
                },
            )
            .await
            .expect("preview");
        assert_eq!(
            preview.refused.first().map(|r| r.reason.clone()),
            Some(SearchEditBlock::ReadOnlyConnection),
            "{label}"
        );

        // A write block refuses before anything is sent.
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}/_settings"),
                Some(r#"{"index.blocks.write":true}"#),
            )
            .await;
        let info = bench
            .search
            .edit_info(&bench.id, index)
            .await
            .expect("info");
        assert_eq!(
            info.indices[0].write_block.as_deref(),
            Some("index.blocks.write"),
            "{label}"
        );
        let d1 = bench.get(index, "d1", None).await;
        let refused = bench
            .search
            .apply_changes(
                &bench.id,
                &SearchChangeSet {
                    target: index.into(),
                    edits: vec![delete(index, "d1", &d1)],
                },
            )
            .await;
        assert_eq!(
            refused.map(|_| ()).map_err(|e| e.code),
            Err(ErrorCode::InvalidArgument),
            "{label}"
        );
        assert!(
            bench.raw_source(index, "d1", None).await.is_some(),
            "{label}"
        );
        bench
            .ok(
                HttpMethod::Put,
                &format!("/{index}/_settings"),
                Some(r#"{"index.blocks.write":null}"#),
            )
            .await;

        // Invalid JSON is refused before anything is sent.
        let refused = bench
            .search
            .apply_changes(
                &bench.id,
                &SearchChangeSet {
                    target: index.into(),
                    edits: vec![
                        delete(index, "d1", &d1),
                        create(index, Some("bad"), "{\"a\": }"),
                    ],
                },
            )
            .await;
        assert_eq!(
            refused.map(|_| ()).map_err(|e| e.code),
            Err(ErrorCode::InvalidArgument),
            "{label}"
        );
        assert!(
            bench.raw_source(index, "d1", None).await.is_some(),
            "{label}"
        );
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn data_streams_take_new_documents_only() {
    for server in servers("data_streams") {
        let bench = Bench::new(&server, false).await;
        let label = bench.label;
        let prefix = "yadbe-edit-ds";
        bench.clean(prefix).await;
        bench
            .ok(
                HttpMethod::Put,
                &format!("/_index_template/{prefix}-template"),
                Some(&format!(
                    r#"{{"index_patterns":["{prefix}*"],"data_stream":{{}},"priority":500,"template":{{"settings":{{"number_of_replicas":0}}}}}}"#
                )),
            )
            .await;
        let stream = format!("{prefix}-web");
        let info = {
            bench
                .ok(
                    HttpMethod::Post,
                    &format!("/{stream}/_doc?refresh=true"),
                    Some(r#"{"@timestamp":"2025-11-12T10:00:00Z","m":"first"}"#),
                )
                .await;
            bench
                .search
                .edit_info(&bench.id, &stream)
                .await
                .expect("info")
        };
        assert_eq!(info.data_streams, std::slice::from_ref(&stream), "{label}");
        assert_eq!(
            info.create_targets,
            std::slice::from_ref(&stream),
            "{label}"
        );
        let backing = info.indices[0].index.clone();
        assert_eq!(
            info.indices[0].data_stream.as_deref(),
            Some(stream.as_str())
        );

        let hit = bench
            .ok(HttpMethod::Post, &format!("/{stream}/_search"), None)
            .await;
        let id = hit
            .get("hits")
            .and_then(|h| h.get("hits"))
            .and_then(Json::as_array)
            .and_then(|h| h.first())
            .and_then(|h| h.get("_id"))
            .and_then(Json::as_str)
            .expect("a hit")
            .to_owned();
        let version = bench.get(&backing, &id, None).await;
        let refused = bench
            .search
            .apply_changes(
                &bench.id,
                &SearchChangeSet {
                    target: stream.clone(),
                    edits: vec![delete(&backing, &id, &version)],
                },
            )
            .await;
        let err = refused.map(|_| ()).expect_err("refused");
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{label}");
        assert!(err.message.en.contains("data stream"), "{label}: {err:?}");
        assert!(bench.get(&backing, &id, None).await.found, "{label}");

        // Appending works, journaled but not revertible (no delete in a data stream here).
        let outcome = bench
            .apply(
                &stream,
                vec![create(
                    &stream,
                    None,
                    r#"{"@timestamp":"2025-11-12T11:00:00Z","m":"second"}"#,
                )],
            )
            .await;
        assert_complete(label, &outcome);
        assert_eq!(outcome.applied[0].index, backing, "{label}");
        assert!(
            outcome.journal_id.is_some() && !outcome.revertible,
            "{label}"
        );
        assert_eq!(
            bench.searched(&stream, r#"{"match_all":{}}"#).await,
            2,
            "{label}"
        );
        bench.clean(prefix).await;
    }
}
