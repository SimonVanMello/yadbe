//! Conformance suite of the search family (M4-7), run against Elasticsearch and OpenSearch:
//! connect (product and version, authentication kinds, TLS), JSON values as cells, pages past
//! the 10 000-document window (point in time) or stopping at it (`from` / `size`), sort,
//! `_source` filtering, query string and Query DSL, counts, the explorer, the console (hits,
//! text answers, ES|QL, error positions), the request gate (read-only, dangers and their
//! effect), cancel of a slow search, the statement timeout, history and statement log.
//!
//! `YADBE_TEST_ES_URL` (+ `YADBE_TEST_ES_CA` for its HTTPS) and `YADBE_TEST_OPENSEARCH_URL`
//! (`dev/compose.yml`, `search` profile); unset: SKIPPED. Each test works on its own indices
//! (`yadbe-<test>-*`), deleted first.

mod common;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{driver, from_url, skip};
use yadbe_lib::db::config::TlsMode;
use yadbe_lib::db::document::json::Json;
use yadbe_lib::db::driver::{ConnectRequest, NoRecorder, SearchConnection};
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::search::classify::SearchDangerKind;
use yadbe_lib::db::search::request::{HttpMethod, RequestBody, SearchRequest, SearchResponse};
use yadbe_lib::db::search::server::SearchProduct;
use yadbe_lib::db::search::settings::{SearchAuth, SearchSettings};
use yadbe_lib::db::value::{Value, ValueKind};
use yadbe_lib::events::RecordingSink;
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::history_hook::{HistoryEntry, HistoryRecorder};
use yadbe_lib::session::result_store::ResultStore;
use yadbe_lib::session::search::SearchService;
use yadbe_lib::session::search::model::{
    ConsoleBody, ConsoleResponse, IndexPaging, IndexQuery, IndexQueryMode, IndexSort, LineRange,
    SearchConsoleOutcome,
};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::session::{ConnectionManager, ConnectionSession};
use yadbe_lib::store::Store;

const ES_URL_ENV: &str = "YADBE_TEST_ES_URL";
const ES_CA_ENV: &str = "YADBE_TEST_ES_CA";
const OPENSEARCH_URL_ENV: &str = "YADBE_TEST_OPENSEARCH_URL";
const PASSWORD: &str = "yadbe-test-pw";

/// A configured server: its label, URL and CA file.
#[derive(Clone)]
struct Server {
    label: &'static str,
    url: String,
    ca: Option<String>,
}

fn servers(test: &str) -> Vec<Server> {
    let mut found = Vec::new();
    for (label, env, ca) in [
        ("elasticsearch", ES_URL_ENV, Some(ES_CA_ENV)),
        ("opensearch", OPENSEARCH_URL_ENV, None),
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

#[derive(Default)]
struct RecordingHistory(Mutex<Vec<HistoryEntry>>);

impl HistoryRecorder for RecordingHistory {
    fn record(&self, entry: HistoryEntry) {
        self.0.lock().expect("history").push(entry);
    }
}

fn definition(server: &Server) -> (yadbe_lib::db::config::ConnectionDefinition, Option<Secret>) {
    let (mut def, password) = from_url(&server.url);
    def.ca_cert_path = server.ca.clone();
    (def, password)
}

/// A connection outside yadbe's gate, to set data up and check it.
async fn admin(server: &Server) -> Arc<dyn SearchConnection> {
    let (def, password) = definition(server);
    let target = def.normalized().expect("valid").target();
    driver(Engine::Elasticsearch)
        .connect(ConnectRequest {
            target: &target,
            password: password.as_ref(),
            recorder: Arc::new(NoRecorder),
        })
        .await
        .expect("admin connection")
        .into_search()
        .expect("search")
}

fn request(method: HttpMethod, path: &str, body: Option<&str>) -> SearchRequest {
    let mut request = SearchRequest::new(method, path);
    request.body = body.map(|text| RequestBody {
        text: text.to_owned(),
        ndjson: path.contains("_bulk"),
    });
    request
}

async fn call(
    conn: &dyn SearchConnection,
    method: HttpMethod,
    path: &str,
    body: Option<&str>,
) -> SearchResponse {
    conn.send(&request(method, path, body), None)
        .await
        .expect("request sent")
}

async fn ok(
    conn: &dyn SearchConnection,
    method: HttpMethod,
    path: &str,
    body: Option<&str>,
) -> Json {
    let response = call(conn, method, path, body).await;
    assert!(
        response.is_success(),
        "{} {path}: {} {}",
        method.as_str(),
        response.status,
        response.text()
    );
    response.json().unwrap_or(Json::Null)
}

struct Bench {
    log: Arc<StatementLog>,
    history: Arc<RecordingHistory>,
    manager: Arc<ConnectionManager>,
    search: SearchService,
    results: Arc<ResultStore>,
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
            sink,
        ));
        let (mut def, password) = definition(server);
        def.read_only = read_only;
        let saved = store
            .create_connection(&def.normalized().expect("valid"))
            .expect("save");
        manager.connect(&saved.id, password).await.expect("connect");
        let history = Arc::new(RecordingHistory::default());
        let results = Arc::new(ResultStore::default());
        let search =
            SearchService::new(Arc::clone(&manager), Arc::clone(&results), history.clone());
        Bench {
            log,
            history,
            manager,
            search,
            results,
            id: saved.id,
            admin: admin(server).await,
        }
    }

    fn session(&self) -> Arc<ConnectionSession> {
        self.manager.session(&self.id).expect("session")
    }

    /// Deletes the data streams and indices of `prefix*`, outside the gate, by name
    /// (Elasticsearch refuses wildcard deletes by default).
    async fn clean(&self, prefix: &str) {
        let streams = call(
            &*self.admin,
            HttpMethod::Get,
            &format!("/_data_stream/{prefix}*"),
            None,
        )
        .await
        .json()
        .unwrap_or(Json::Null);
        for stream in streams
            .get("data_streams")
            .and_then(Json::as_array)
            .unwrap_or(&[])
        {
            if let Some(name) = stream.get("name").and_then(Json::as_str) {
                let _ = call(
                    &*self.admin,
                    HttpMethod::Delete,
                    &format!("/_data_stream/{name}"),
                    None,
                )
                .await;
            }
        }
        let indices = call(
            &*self.admin,
            HttpMethod::Get,
            &format!("/_cat/indices/{prefix}*?format=json&h=index&expand_wildcards=all"),
            None,
        )
        .await
        .json()
        .unwrap_or(Json::Null);
        for index in indices.as_array().unwrap_or(&[]) {
            if let Some(name) = index.get("index").and_then(Json::as_str) {
                let _ = call(&*self.admin, HttpMethod::Delete, &format!("/{name}"), None).await;
            }
        }
    }

    /// Creates `index` with `n` documents `{n, tag, even}` (bulk, refreshed).
    async fn fill(&self, index: &str, n: usize) {
        ok(
            &*self.admin,
            HttpMethod::Put,
            &format!("/{index}"),
            Some(
                r#"{"settings":{"number_of_shards":2,"number_of_replicas":0},"mappings":{"properties":{"n":{"type":"long"},"tag":{"type":"keyword"},"even":{"type":"boolean"}}}}"#,
            ),
        )
        .await;
        for chunk in (0..n).collect::<Vec<_>>().chunks(5000) {
            let mut body = String::new();
            for i in chunk {
                body.push_str(&format!("{{\"index\":{{\"_id\":\"d{i}\"}}}}\n"));
                body.push_str(&format!(
                    "{{\"n\":{i},\"tag\":\"t{}\",\"even\":{}}}\n",
                    i % 7,
                    i % 2 == 0
                ));
            }
            let json = ok(
                &*self.admin,
                HttpMethod::Post,
                &format!("/{index}/_bulk"),
                Some(&body),
            )
            .await;
            assert_eq!(json.get("errors"), Some(&Json::Bool(false)), "bulk");
        }
        ok(
            &*self.admin,
            HttpMethod::Post,
            &format!("/{index}/_refresh"),
            None,
        )
        .await;
    }

    async fn console(&self, tab: &str, text: &str, confirmed: bool) -> SearchConsoleOutcome {
        self.search
            .console_run(tab, &self.id, text, None, confirmed)
            .await
            .expect("console run")
    }

    async fn ran(&self, tab: &str, text: &str) -> Vec<ConsoleResponse> {
        match self.console(tab, text, false).await {
            SearchConsoleOutcome::Ran {
                responses, failure, ..
            } => {
                assert!(failure.is_none(), "{failure:?}");
                responses
            }
            other => panic!("expected a run: {other:?}"),
        }
    }

    async fn exists(&self, index: &str) -> bool {
        call(&*self.admin, HttpMethod::Head, &format!("/{index}"), None)
            .await
            .status
            == 200
    }
}

fn query(text: &str) -> IndexQuery {
    IndexQuery {
        mode: IndexQueryMode::Dsl,
        text: text.into(),
        source: String::new(),
        sort: Vec::new(),
        page_size: 100,
    }
}

fn column(store: &ResultStore, result_id: u32, name: &str) -> Vec<Value> {
    let result = store.get(result_id).expect("result");
    let at = result
        .columns()
        .iter()
        .position(|c| c.name == name)
        .unwrap_or_else(|| panic!("column {name}"));
    result
        .rows(0, result.row_count())
        .into_iter()
        .map(|row| row[at].clone())
        .collect()
}

#[tokio::test]
async fn connects_and_says_what_it_talks_to() {
    for server in servers("connects_and_says_what_it_talks_to") {
        let bench = Bench::new(&server, false).await;
        let info = bench.session().info();
        let version = bench.admin.server();
        let expected = match server.label {
            "elasticsearch" => SearchProduct::Elasticsearch,
            _ => SearchProduct::Opensearch,
        };
        assert_eq!(version.product, expected, "{}", server.label);
        assert!(
            bench
                .session()
                .backend()
                .expect("backend")
                .as_link()
                .server_version()
                .contains(&version.version),
            "{info:?}"
        );
        // A SQL feature on a search connection: refused with the family's code.
        let err = bench
            .session()
            .backend()
            .expect("backend")
            .into_sql()
            .err()
            .expect("sqlOnly");
        assert_eq!(err.code, ErrorCode::SqlOnly);
        let ping = bench.session().ping().await;
        assert!(ping.is_ok(), "{ping:?}");
        assert!(
            bench.log.entries().iter().any(|e| e.sql == "GET /"),
            "the connect probe is in the statement log"
        );
    }
}

#[tokio::test]
async fn authentication_kinds_and_tls() {
    for server in servers("authentication_kinds_and_tls") {
        if server.label != "elasticsearch" {
            skip(
                "authentication_kinds_and_tls (opensearch)",
                "security is off on the test OpenSearch",
            );
            continue;
        }
        let admin = admin(&server).await;
        let (def, _) = definition(&server);
        let connect = |def: yadbe_lib::db::config::ConnectionDefinition, secret: Option<Secret>| async move {
            let target = def.normalized().expect("valid").target();
            driver(Engine::Elasticsearch)
                .connect(ConnectRequest {
                    target: &target,
                    password: secret.as_ref(),
                    recorder: Arc::new(NoRecorder),
                })
                .await
                .map(|_| ())
        };
        // Basic: a wrong password, then none.
        let wrong = connect(def.clone(), Some(Secret::new("not-the-password"))).await;
        assert_eq!(wrong.map_err(|e| e.code), Err(ErrorCode::AuthFailed));
        let none = connect(def.clone(), None).await;
        assert_eq!(none.map_err(|e| e.code), Err(ErrorCode::PasswordRequired));
        // API key.
        let key = ok(
            &*admin,
            HttpMethod::Post,
            "/_security/api_key",
            Some(r#"{"name":"yadbe-test","expiration":"1h"}"#),
        )
        .await;
        let encoded = key
            .get("encoded")
            .and_then(Json::as_str)
            .expect("encoded key")
            .to_owned();
        let mut api_key = def.clone();
        api_key.username = String::new();
        api_key.search = Some(SearchSettings {
            auth: SearchAuth::ApiKey,
            path_prefix: None,
        });
        connect(api_key.clone(), Some(Secret::new(encoded)))
            .await
            .expect("API key");
        let bad = connect(api_key, Some(Secret::new("bm9wZTpub3Bl"))).await;
        assert_eq!(bad.map_err(|e| e.code), Err(ErrorCode::AuthFailed));
        // Bearer: a service account token (the free licence has no OAuth2 token service).
        let name = format!("yadbe-{}", std::process::id());
        let token = call(
            &*admin,
            HttpMethod::Post,
            &format!("/_security/service/elastic/fleet-server/credential/token/{name}"),
            None,
        )
        .await
        .json()
        .unwrap_or(Json::Null);
        if let Some(value) = token
            .get("token")
            .and_then(|t| t.get("value"))
            .and_then(Json::as_str)
        {
            let mut bearer = def.clone();
            bearer.username = String::new();
            bearer.search = Some(SearchSettings {
                auth: SearchAuth::Bearer,
                path_prefix: None,
            });
            connect(bearer, Some(Secret::new(value)))
                .await
                .expect("bearer token");
            let _ = call(
                &*admin,
                HttpMethod::Delete,
                &format!("/_security/service/elastic/fleet-server/credential/token/{name}"),
                None,
            )
            .await;
        } else {
            skip("authentication_kinds_and_tls (bearer)", "no service token");
        }
        // TLS: the dev CA verifies the server; without it the OS store does not.
        let mut no_ca = def.clone();
        no_ca.ca_cert_path = None;
        no_ca.tls_mode = TlsMode::VerifyFull;
        let (_, password) = definition(&server);
        let refused = connect(no_ca, password).await;
        assert_eq!(refused.map_err(|e| e.code), Err(ErrorCode::TlsFailed));
        // Plain HTTP to an HTTPS port: the server closes the link.
        let mut plain = def.clone();
        plain.tls_mode = TlsMode::Disable;
        let (_, password) = definition(&server);
        assert!(connect(plain, password).await.is_err());
    }
}

#[tokio::test]
async fn json_values_become_exact_cells() {
    for server in servers("json_values_become_exact_cells") {
        let bench = Bench::new(&server, false).await;
        let index = "yadbe-types";
        bench.clean(index).await;
        ok(
            &*bench.admin,
            HttpMethod::Put,
            &format!("/{index}"),
            Some(r#"{"mappings":{"properties":{"big":{"type":"long"},"price":{"type":"double"},"when":{"type":"date"},"title":{"type":"text","fields":{"raw":{"type":"keyword"}}},"customer":{"properties":{"name":{"type":"keyword"},"vip":{"type":"boolean"}}}}}}"#),
        )
        .await;
        ok(
            &*bench.admin,
            HttpMethod::Put,
            &format!("/{index}/_doc/1?refresh=true"),
            Some(r#"{"big":9007199254740993,"price":12.5,"when":"2025-01-06T09:30:00Z","title":"Hello","customer":{"name":"Ada","vip":true},"tags":["a","b"],"gone":null}"#),
        )
        .await;
        let info = bench
            .search
            .open_index("types", &bench.id, index)
            .await
            .expect("open");
        let paths: Vec<&str> = info
            .details
            .fields
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert!(
            paths.contains(&"customer.name") && paths.contains(&"title.raw"),
            "{paths:?}"
        );
        let raw = info
            .details
            .fields
            .iter()
            .find(|f| f.path == "title.raw")
            .expect("multi-field");
        assert!(raw.sortable && raw.multi_field);
        let page = bench
            .search
            .fetch_page("types", &bench.id, index, query(""), 0)
            .await
            .expect("page");
        let grid = page.documents.result.result_id;
        let columns = &page.documents.result.columns;
        let col = |name: &str| columns.iter().find(|c| c.name == name).expect(name);
        assert_eq!(col("big").type_name, "long");
        assert_eq!(col("big").kind, ValueKind::Int);
        assert_eq!(col("customer.vip").kind, ValueKind::Bool);
        assert_eq!(col("tags").kind, ValueKind::Json);
        assert_eq!(
            column(&bench.results, grid, "big"),
            [Value::Int("9007199254740993".into())]
        );
        assert_eq!(
            column(&bench.results, grid, "price"),
            [Value::Float("12.5".into())]
        );
        assert_eq!(
            column(&bench.results, grid, "when"),
            [Value::Text("2025-01-06T09:30:00Z".into())]
        );
        assert_eq!(
            column(&bench.results, grid, "customer.name"),
            [Value::Text("Ada".into())]
        );
        assert_eq!(
            column(&bench.results, grid, "tags"),
            [Value::Json(r#"["a","b"]"#.into())]
        );
        assert_eq!(column(&bench.results, grid, "gone"), [Value::Null]);
        assert_eq!(
            column(&bench.results, grid, "_id"),
            [Value::Text("1".into())]
        );
        let whole = bench
            .search
            .documents(page.documents.documents_id, 0, 10)
            .expect("documents");
        assert!(whole[0].contains("\"_source\"") && whole[0].contains("9007199254740993"));
        bench.search.close_tab("types").await;
        assert!(
            bench.results.get(grid).is_err(),
            "a closed tab frees its results"
        );
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn pages_go_past_the_result_window_on_a_point_in_time() {
    for server in servers("pages_go_past_the_result_window_on_a_point_in_time") {
        let bench = Bench::new(&server, false).await;
        let index = "yadbe-paging";
        bench.clean(index).await;
        bench.fill(index, 12_345).await;
        let info = bench
            .search
            .open_index("paging", &bench.id, index)
            .await
            .expect("open");
        let mut q = query("");
        q.page_size = 1000;
        let mut ids = BTreeSet::new();
        let mut page = 0;
        let mut first_total = None;
        loop {
            let result = bench
                .search
                .fetch_page("paging", &bench.id, index, q.clone(), page)
                .await;
            let result = match (info.paging, result) {
                (_, Ok(result)) => result,
                (IndexPaging::FromSize, Err(err)) => {
                    assert_eq!(err.code, ErrorCode::NotSupported, "{err:?}");
                    assert_eq!(page, 10, "stops at the window");
                    break;
                }
                (IndexPaging::PointInTime, Err(err)) => panic!("page {page}: {err:?}"),
            };
            if page == 0 {
                first_total = result.total;
            }
            for id in column(&bench.results, result.documents.result.result_id, "_id") {
                let Value::Text(id) = id else {
                    panic!("an _id is text: {id:?}")
                };
                assert!(ids.insert(id), "page {page} repeats a document");
            }
            page += 1;
            if !result.has_more {
                break;
            }
        }
        let total = first_total.expect("a total");
        assert!(!total.exact && total.value == 10_000.0, "{total:?}");
        match info.paging {
            IndexPaging::PointInTime => assert_eq!(ids.len(), 12_345, "{}", server.label),
            IndexPaging::FromSize => assert_eq!(ids.len(), 10_000, "{}", server.label),
        }
        let exact = bench
            .search
            .count("paging", &bench.id, index, query(""))
            .await
            .expect("count");
        assert_eq!(exact, 12_345.0);
        // Going back reads the same page again.
        let again = bench
            .search
            .fetch_page("paging", &bench.id, index, q.clone(), 1)
            .await
            .expect("page 1");
        let back = bench
            .search
            .fetch_page("paging", &bench.id, index, q.clone(), 0)
            .await
            .expect("page 0");
        assert_eq!(back.page, 0);
        assert_eq!(again.documents.count, 1000);
        // Sort, `_source` filtering, a query string and the Query DSL.
        let sorted = IndexQuery {
            sort: vec![IndexSort {
                field: "n".into(),
                descending: true,
            }],
            source: "n, -tag".into(),
            page_size: 5,
            ..query("")
        };
        let top = bench
            .search
            .fetch_page("paging", &bench.id, index, sorted, 0)
            .await
            .expect("sorted");
        let grid = top.documents.result.result_id;
        assert_eq!(
            column(&bench.results, grid, "n"),
            (12_340..12_345)
                .rev()
                .map(|n| Value::Int(n.to_string()))
                .collect::<Vec<_>>()
        );
        let names: Vec<&str> = top
            .documents
            .result
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert!(
            !names.contains(&"tag") && !names.contains(&"even"),
            "{names:?}"
        );
        let lucene = IndexQuery {
            mode: IndexQueryMode::QueryString,
            ..query("n:<10 AND even:true")
        };
        let small = bench
            .search
            .fetch_page("paging", &bench.id, index, lucene, 0)
            .await
            .expect("query string");
        assert_eq!(small.total.map(|t| (t.value, t.exact)), Some((5.0, true)));
        let dsl = bench
            .search
            .fetch_page(
                "paging",
                &bench.id,
                index,
                query(r#"{"query":{"range":{"n":{"lt":20}}}}"#),
                0,
            )
            .await
            .expect("dsl");
        assert_eq!(dsl.total.map(|t| t.value), Some(20.0));
        let bad = bench
            .search
            .fetch_page("paging", &bench.id, index, query("{nope"), 0)
            .await;
        assert_eq!(
            bad.map_err(|e| e.code).err(),
            Some(ErrorCode::InvalidArgument)
        );
        let unknown = bench
            .search
            .fetch_page("paging", &bench.id, index, query(r#"{"mtch":{"n":1}}"#), 0)
            .await;
        assert_eq!(
            unknown.map_err(|e| e.code).err(),
            Some(ErrorCode::QueryFailed)
        );
        bench.search.close_tab("paging").await;
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn the_explorer_lists_indices_streams_aliases_templates() {
    for server in servers("the_explorer_lists_indices_streams_aliases_templates") {
        let bench = Bench::new(&server, false).await;
        bench.clean("yadbe-explorer").await;
        let _ = call(
            &*bench.admin,
            HttpMethod::Delete,
            "/_index_template/yadbe-explorer-tpl",
            None,
        )
        .await;
        bench.fill("yadbe-explorer-a", 3).await;
        ok(
            &*bench.admin,
            HttpMethod::Post,
            "/_aliases",
            Some(r#"{"actions":[{"add":{"index":"yadbe-explorer-a","alias":"yadbe-explorer-current","is_write_index":true}}]}"#),
        )
        .await;
        ok(
            &*bench.admin,
            HttpMethod::Put,
            "/_index_template/yadbe-explorer-tpl",
            Some(r#"{"index_patterns":["yadbe-explorer-ds*"],"data_stream":{},"priority":500,"template":{"settings":{"number_of_replicas":0}}}"#),
        )
        .await;
        ok(
            &*bench.admin,
            HttpMethod::Post,
            "/yadbe-explorer-ds/_doc?refresh=true",
            Some(r#"{"@timestamp":"2025-01-01T00:00:00Z","m":1}"#),
        )
        .await;
        let indices = bench.search.indices(&bench.id).await.expect("indices");
        let a = indices
            .iter()
            .find(|i| i.name == "yadbe-explorer-a")
            .expect("the index");
        assert_eq!(a.docs, Some(3.0));
        assert!(!a.system && a.open);
        assert!(
            indices
                .iter()
                .any(|i| i.system && i.name.starts_with(".ds-yadbe-explorer-ds"))
        );
        let streams = bench.search.data_streams(&bench.id).await.expect("streams");
        let stream = streams
            .iter()
            .find(|s| s.name == "yadbe-explorer-ds")
            .expect("the data stream");
        assert_eq!(stream.indices.len(), 1);
        assert_eq!(stream.template.as_deref(), Some("yadbe-explorer-tpl"));
        let aliases = bench.search.aliases(&bench.id).await.expect("aliases");
        let alias = aliases
            .iter()
            .find(|a| a.name == "yadbe-explorer-current")
            .expect("the alias");
        assert_eq!(alias.indices, ["yadbe-explorer-a"]);
        assert_eq!(alias.write_index.as_deref(), Some("yadbe-explorer-a"));
        let templates = bench.search.templates(&bench.id).await.expect("templates");
        let tpl = templates
            .iter()
            .find(|t| t.name == "yadbe-explorer-tpl")
            .expect("the template");
        assert!(tpl.data_stream && tpl.patterns == ["yadbe-explorer-ds*"]);
        let details = bench
            .search
            .index_details(&bench.id, "yadbe-explorer-current")
            .await
            .expect("details through the alias");
        assert_eq!(
            details
                .fields
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["even", "n", "tag"]
        );
        assert!(
            details
                .settings
                .iter()
                .any(|s| s.key == "index.number_of_shards" && s.value == "2")
        );
        assert_eq!(details.max_result_window, 10_000);
        assert!(
            bench
                .log
                .entries()
                .iter()
                .any(|e| e.sql.starts_with("GET /_cat/indices")),
            "explorer reads are in the statement log"
        );
        bench.clean("yadbe-explorer").await;
        let _ = call(
            &*bench.admin,
            HttpMethod::Delete,
            "/_index_template/yadbe-explorer-tpl",
            None,
        )
        .await;
    }
}

#[tokio::test]
async fn the_console_runs_requests_as_written() {
    for server in servers("the_console_runs_requests_as_written") {
        let bench = Bench::new(&server, false).await;
        let index = "yadbe-console";
        bench.clean(index).await;
        bench.fill(index, 30).await;
        let text = format!(
            "# three requests\nGET _cat/indices/{index}?h=index,docs.count\n\nPOST /{index}/_search\n{{\n  \"size\": 3,\n  \"query\": {{ \"range\": {{ \"n\": {{ \"lt\": 10 }} }} }},\n  \"sort\": [{{ \"n\": \"asc\" }}]\n}}\n\nGET /yadbe-console-missing/_search\n"
        );
        let responses = bench.ran("console", &text).await;
        assert_eq!(responses.len(), 3);
        let cat = &responses[0];
        assert_eq!((cat.line, cat.status), (1, Some(200)));
        match &cat.body {
            ConsoleBody::Text { text, .. } => {
                assert!(text.contains(index) && text.contains("30"), "{text}")
            }
            other => panic!("cat is text: {other:?}"),
        }
        let search = &responses[1];
        assert_eq!((search.line, search.status), (3, Some(200)));
        assert!(search.took_ms.is_some());
        assert_eq!(search.shards.map(|s| s.total), Some(2.0));
        match &search.body {
            ConsoleBody::Json {
                hits: Some(hits),
                total,
                raw,
                ..
            } => {
                assert_eq!(hits.count, 3);
                assert_eq!(total.map(|t| t.value), Some(10.0));
                assert!(raw.contains("\"hits\""));
                assert_eq!(
                    column(&bench.results, hits.result.result_id, "n"),
                    [
                        Value::Int("0".into()),
                        Value::Int("1".into()),
                        Value::Int("2".into())
                    ]
                );
            }
            other => panic!("hits: {other:?}"),
        }
        let missing = &responses[2];
        assert_eq!(missing.status, Some(404));
        assert_eq!(
            missing.error.as_ref().map(|e| e.code),
            Some(ErrorCode::ObjectNotFound)
        );
        // The cursor's request only, then an error position mapped to the editor.
        let picked = bench
            .search
            .console_run(
                "console",
                &bench.id,
                &text,
                Some(LineRange { from: 6, to: 6 }),
                false,
            )
            .await
            .expect("cursor");
        let SearchConsoleOutcome::Ran { responses, .. } = picked else {
            panic!("ran")
        };
        assert_eq!(responses.iter().map(|r| r.line).collect::<Vec<_>>(), [3]);
        let broken = format!("POST /{index}/_search\n{{\n  \"query\": {{ \"mtch\": {{}} }}\n}}\n");
        let responses = bench.ran("console", &broken).await;
        assert_eq!(responses[0].status, Some(400));
        let position = responses[0].error_position.expect("a position");
        assert_eq!(position.line, 3, "{:?}", responses[0].error);
        // NDJSON: `_bulk` with its lines as written.
        let bulk = format!(
            "POST /{index}/_bulk?refresh=true\n{{\"index\":{{\"_id\":\"x1\"}}}}\n{{\"n\":1000}}\n"
        );
        let responses = bench.ran("console", &bulk).await;
        assert_eq!(responses[0].status, Some(200), "{:?}", responses[0].body);
        // ES|QL answers are tables.
        if bench.admin.server().features.esql {
            let esql = format!(
                "POST /_query\n{{ \"query\": \"FROM {index} | WHERE n < 3 | SORT n | KEEP n, tag\" }}\n"
            );
            let responses = bench.ran("console", &esql).await;
            match &responses[0].body {
                ConsoleBody::Json {
                    table: Some(table), ..
                } => {
                    assert_eq!(table.row_count, 3);
                    assert_eq!(table.columns[0].kind, ValueKind::Int);
                }
                other => panic!("ES|QL table: {other:?}"),
            }
        }
        // A text that is not requests.
        let outcome = bench.console("console", "\n{ \"size\": 1 }\n", false).await;
        let SearchConsoleOutcome::Ran {
            failure: Some(failure),
            ..
        } = outcome
        else {
            panic!("a failure")
        };
        assert_eq!(failure.line, 1);
        // Each user request is in the history, as written.
        let history = bench.history.0.lock().expect("history").clone();
        assert!(
            history
                .iter()
                .any(|h| h.sql.starts_with(&format!("POST /{index}/_search\n{{")))
        );
        assert!(
            history
                .iter()
                .any(|h| h.outcome.is_err() && h.sql.contains("missing"))
        );
        assert!(
            !bench
                .log
                .entries()
                .iter()
                .any(|e| e.sql.contains("yadbe-console-missing")),
            "user requests are not in the statement log"
        );
        bench.search.close_tab("console").await;
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn read_only_refuses_what_is_not_a_read() {
    for server in servers("read_only_refuses_what_is_not_a_read") {
        let setup = Bench::new(&server, false).await;
        let index = "yadbe-readonly";
        setup.clean(index).await;
        setup.fill(index, 5).await;
        let bench = Bench::new(&server, true).await;
        let text = format!(
            "POST /{index}/_search\n{{\"size\":1}}\n\nPOST /{index}/_count\n\nPUT /{index}-new\n\nGET /_cat/indices\n"
        );
        let SearchConsoleOutcome::Ran {
            responses, skipped, ..
        } = bench.console("ro", &text, false).await
        else {
            panic!("ran")
        };
        assert_eq!(responses[0].status, Some(200));
        assert_eq!(responses[1].status, Some(200));
        assert_eq!(
            responses[2].error.as_ref().map(|e| e.code),
            Some(ErrorCode::ReadOnlyViolation)
        );
        assert_eq!(responses[2].status, None, "nothing was sent");
        assert_eq!(skipped, 1, "the run stops at a refusal");
        assert!(!bench.exists(&format!("{index}-new")).await);
        // A dangerous write on a read-only connection is refused, not offered to confirm.
        let outcome = bench
            .console("ro", &format!("DELETE /{index}\n"), false)
            .await;
        let SearchConsoleOutcome::Ran { responses, .. } = outcome else {
            panic!("refused, not confirmed")
        };
        assert_eq!(
            responses[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::ReadOnlyViolation)
        );
        let confirmed = bench
            .console("ro", &format!("DELETE /{index}\n"), true)
            .await;
        let SearchConsoleOutcome::Ran { responses, .. } = confirmed else {
            panic!("ran")
        };
        assert_eq!(
            responses[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::ReadOnlyViolation)
        );
        assert!(bench.exists(index).await, "still there");
        // The index tab reads on a read-only connection (its point in time included).
        bench
            .search
            .open_index("ro-tab", &bench.id, index)
            .await
            .expect("open");
        let page = bench
            .search
            .fetch_page("ro-tab", &bench.id, index, query(""), 0)
            .await
            .expect("page");
        assert_eq!(page.documents.count, 5);
        bench.search.close_tab("ro-tab").await;
        setup.clean(index).await;
    }
}

#[tokio::test]
async fn dangerous_requests_are_confirmed_with_their_effect() {
    for server in servers("dangerous_requests_are_confirmed_with_their_effect") {
        let bench = Bench::new(&server, false).await;
        bench.clean("yadbe-danger").await;
        bench.fill("yadbe-danger-a", 40).await;
        bench.fill("yadbe-danger-b", 2).await;
        let dangers = |outcome: SearchConsoleOutcome| match outcome {
            SearchConsoleOutcome::NeedsConfirmation { dangers } => dangers,
            other => panic!("expected a confirmation: {other:?}"),
        };
        // Delete by query: the documents its query matches.
        let by_query = "POST /yadbe-danger-a/_delete_by_query?refresh=true\n{\"query\":{\"range\":{\"n\":{\"lt\":10}}}}\n";
        let found = dangers(bench.console("danger", by_query, false).await);
        assert_eq!(found[0].kind, SearchDangerKind::DeleteByQuery);
        assert!(
            found[0].effect.en.contains("10 documents"),
            "{}",
            found[0].effect.en
        );
        assert_eq!(
            bench
                .search
                .count("danger", &bench.id, "yadbe-danger-a", query(""))
                .await
                .expect("count"),
            40.0,
            "nothing ran"
        );
        let responses = match bench.console("danger", by_query, true).await {
            SearchConsoleOutcome::Ran { responses, .. } => responses,
            other => panic!("{other:?}"),
        };
        assert_eq!(responses[0].status, Some(200));
        assert_eq!(
            bench
                .search
                .count("danger", &bench.id, "yadbe-danger-a", query(""))
                .await
                .expect("count"),
            30.0
        );
        // A wildcard delete: every index it matches, with their documents.
        let found = dangers(
            bench
                .console("danger", "DELETE /yadbe-danger-*\n", false)
                .await,
        );
        assert_eq!(found[0].kind, SearchDangerKind::DeleteIndex);
        assert!(
            found[0].effect.en.contains("2 index") && found[0].effect.en.contains("32 documents"),
            "{}",
            found[0].effect.en
        );
        // Reindex into a new index: not dangerous; into an existing one: confirmed.
        let reindex = |dest: &str| {
            format!(
                "POST /_reindex?refresh=true\n{{\"source\":{{\"index\":\"yadbe-danger-b\"}},\"dest\":{{\"index\":\"{dest}\"}}}}\n"
            )
        };
        let responses = bench.ran("danger", &reindex("yadbe-danger-c")).await;
        assert_eq!(responses[0].status, Some(200), "{:?}", responses[0].body);
        let found = dangers(
            bench
                .console("danger", &reindex("yadbe-danger-a"), false)
                .await,
        );
        assert_eq!(found[0].kind, SearchDangerKind::Reindex);
        assert!(
            found[0].effect.en.contains("30 documents"),
            "{}",
            found[0].effect.en
        );
        // Closing an index.
        let found = dangers(
            bench
                .console("danger", "POST /yadbe-danger-b/_close\n", false)
                .await,
        );
        assert_eq!(found[0].kind, SearchDangerKind::CloseIndex);
        // Confirmed: deleted (by name: Elasticsearch refuses wildcard deletes by default).
        let delete = "DELETE /yadbe-danger-a,yadbe-danger-b,yadbe-danger-c\n";
        let found = dangers(bench.console("danger", delete, false).await);
        assert!(
            found[0].effect.en.contains("3 index"),
            "{}",
            found[0].effect.en
        );
        match bench.console("danger", delete, true).await {
            SearchConsoleOutcome::Ran { responses, .. } => {
                assert_eq!(responses[0].status, Some(200), "{:?}", responses[0].body);
            }
            other => panic!("{other:?}"),
        }
        assert!(!bench.exists("yadbe-danger-a").await);
        assert!(
            bench
                .log
                .entries()
                .iter()
                .any(|e| e.sql.starts_with("POST /yadbe-danger-a/_count")),
            "the probes are in the statement log"
        );
        bench.search.close_tab("danger").await;
    }
}

/// A search slow enough to cancel: a script query that loops for every document.
fn slow_search(index: &str) -> String {
    format!(
        "POST /{index}/_search\n{{\"size\":1,\"query\":{{\"bool\":{{\"filter\":{{\"script\":{{\"script\":{{\"source\":\"long x = 0; for (int i = 0; i < 900000; ++i) {{ x += i; }} return x > 0;\"}}}}}}}}}}}}\n"
    )
}

async fn running_searches(admin: &dyn SearchConnection, index: &str) -> usize {
    let tasks = ok(
        admin,
        HttpMethod::Get,
        "/_tasks?actions=*search*&detailed=true&group_by=none",
        None,
    )
    .await;
    tasks
        .get("tasks")
        .and_then(Json::as_array)
        .unwrap_or(&[])
        .iter()
        .filter(|t| {
            t.get("description")
                .and_then(Json::as_str)
                .is_some_and(|d| d.contains(index))
        })
        .count()
}

#[tokio::test]
async fn a_slow_search_is_cancelled_on_the_server() {
    for server in servers("a_slow_search_is_cancelled_on_the_server") {
        let bench = Arc::new(Bench::new(&server, false).await);
        let index = "yadbe-slow";
        bench.clean(index).await;
        bench.fill(index, 20_000).await;
        let run = {
            let bench = Arc::clone(&bench);
            tokio::spawn(async move {
                let text = slow_search("yadbe-slow");
                bench.console("slow", &text, false).await
            })
        };
        let started = Instant::now();
        while running_searches(&*bench.admin, index).await == 0 {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the search never started"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        bench.search.cancel("slow");
        let outcome = run.await.expect("joined");
        let SearchConsoleOutcome::Ran { responses, .. } = outcome else {
            panic!("ran")
        };
        assert_eq!(
            responses[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::Cancelled)
        );
        let stopped = Instant::now();
        while running_searches(&*bench.admin, index).await > 0 {
            assert!(
                stopped.elapsed() < Duration::from_secs(10),
                "the search still runs on the server"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        // The statement timeout: past it, the request is dropped and its task cancelled.
        bench
            .session()
            .set_statement_timeout(Some(Duration::from_secs(1)));
        let started = Instant::now();
        let SearchConsoleOutcome::Ran { responses, .. } =
            bench.console("slow", &slow_search(index), false).await
        else {
            panic!("ran")
        };
        assert_eq!(
            responses[0].error.as_ref().map(|e| e.code),
            Some(ErrorCode::StatementTimeout)
        );
        assert!(started.elapsed() < Duration::from_secs(8));
        let stopped = Instant::now();
        while running_searches(&*bench.admin, index).await > 0 {
            assert!(
                stopped.elapsed() < Duration::from_secs(10),
                "still running after the timeout"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(
            bench
                .log
                .entries()
                .iter()
                .any(|e| e.sql.contains("/_cancel")),
            "the task cancel is in the statement log"
        );
        bench.session().set_statement_timeout(None);
        bench.clean(index).await;
    }
}

#[tokio::test]
async fn secrets_stay_out_of_logs_and_history() {
    for server in servers("secrets_stay_out_of_logs_and_history") {
        let bench = Bench::new(&server, false).await;
        let _ = bench.ran("secret", "GET /\n").await;
        let history = bench.history.0.lock().expect("history").clone();
        for text in bench
            .log
            .entries()
            .iter()
            .map(|e| e.sql.clone())
            .chain(history.iter().map(|h| h.sql.clone()))
        {
            assert!(!text.contains(PASSWORD), "{text}");
        }
    }
}
