//! `SearchService`: what the search family's commands do on an open session. The explorer
//! (indices, data streams, aliases, index templates, an index's fields and settings), the
//! index tab (pages on a point in time or by `from` / `size`, counts) and the console. Every
//! request goes through the gate.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::db::document::json::Json;
use crate::db::driver::SearchConnection;
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::search::console::{ConsoleRequest, parse_console, pick};
use crate::db::search::meta::{
    SearchAlias, SearchDataStream, SearchIndexDetails, SearchIndexInfo, SearchTemplate, number_of,
    parse_aliases, parse_data_streams, parse_indices, parse_mapping, parse_settings,
    parse_templates,
};
use crate::db::search::request::{HttpMethod, SearchRequest, SearchResponse, segment};
use crate::db::search::server::PitApi;
use crate::session::ConnectionManager;
use crate::session::ConnectionSession;
use crate::session::history_hook::HistoryRecorder;
use crate::session::journal::ChangeJournal;
use crate::session::result_store::ResultStore;
use crate::session::search::gate::{Gate, Origin, Send, UserContext, new_opaque_id};
use crate::session::search::model::{
    ConsoleBody, ConsoleFailure, ConsolePosition, ConsoleResponse, DocumentResult, IndexPage,
    IndexPaging, IndexQuery, IndexQueryMode, IndexTabInfo, LineRange, SearchConsoleOutcome,
    SearchTotal, ShardsInfo,
};
use crate::session::search::results::{ids_of, store_document, store_hits, store_table};

pub const MAX_PAGE_SIZE: u32 = 1_000;
/// Read from a single window at most.
const MAX_DOCUMENTS_WINDOW: u32 = 500;
/// Raw text of a console response sent to the front, at most.
const MAX_RAW_CHARS: usize = 1024 * 1024;
/// How long a point in time lives between two pages.
const PIT_KEEP_ALIVE: &str = "5m";
/// `track_total_hits` of a first page: counted exactly up to this, a lower bound beyond.
const TRACK_TOTAL: i64 = 10_000;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What a tab is running, for a cancel: cancelled, its request stops and a console run sends
/// nothing more.
struct Running {
    stop: CancellationToken,
}

#[derive(Default)]
struct PageState {
    /// The target and query the cursors below belong to.
    key: Option<(String, IndexQuery)>,
    pit: Option<String>,
    /// The `search_after` values each page starts after (`None`: the first page).
    starts: Vec<Option<Json>>,
    total: Option<SearchTotal>,
}

struct SearchTab {
    connection_id: String,
    running: Mutex<Option<Running>>,
    /// Results the tab holds, freed when it reads again or closes.
    results: Mutex<Vec<u32>>,
    pages: tokio::sync::Mutex<PageState>,
    /// Mapping types of the open index, by path (grid column types).
    types: Mutex<HashMap<String, String>>,
    window: Mutex<u32>,
}

impl SearchTab {
    fn new(connection_id: &str) -> Self {
        Self {
            connection_id: connection_id.to_owned(),
            running: Mutex::new(None),
            results: Mutex::new(Vec::new()),
            pages: tokio::sync::Mutex::new(PageState::default()),
            types: Mutex::new(HashMap::new()),
            window: Mutex::new(10_000),
        }
    }
}

pub struct SearchService {
    manager: Arc<ConnectionManager>,
    store: Arc<ResultStore>,
    history: Arc<dyn HistoryRecorder>,
    tabs: Mutex<HashMap<String, Arc<SearchTab>>>,
    /// Records document edits (M4-8); none in tests that do not edit.
    pub(super) journal: Option<Arc<ChangeJournal>>,
}

/// Clears `running` when the tab's request ends, however it ends.
struct RunGuard<'a> {
    tab: &'a SearchTab,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.tab.running) = None;
    }
}

fn duration_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// The query of an index tab as Query DSL.
fn query_json(query: &IndexQuery) -> Result<Json, YadbeError> {
    let text = query.text.trim();
    let match_all = || Json::object([("match_all", Json::empty())]);
    if text.is_empty() {
        return Ok(match_all());
    }
    match query.mode {
        IndexQueryMode::QueryString => Ok(Json::object([(
            "query_string",
            Json::object([("query", Json::string(text))]),
        )])),
        IndexQueryMode::Dsl => {
            let json = Json::parse(text).map_err(|err| {
                YadbeError::invalid_argument(
                    "The query is not valid JSON.",
                    "La requête n'est pas du JSON valide.",
                )
                .with_detail(err.detail.unwrap_or_default())
            })?;
            match json.as_object() {
                // A whole body pasted: its query.
                Some([(key, inner)]) if key == "query" => Ok(inner.clone()),
                Some(entries) if !entries.is_empty() => Ok(json),
                _ => Err(YadbeError::invalid_argument(
                    "The query is a JSON object of the Query DSL, like {\"match\": {\"title\": \"yadbe\"}}.",
                    "La requête est un objet JSON du Query DSL, comme {\"match\": {\"title\": \"yadbe\"}}.",
                )),
            }
        }
    }
}

fn is_match_all(query: &Json) -> bool {
    matches!(query.as_object(), Some([(key, _)]) if key == "match_all")
}

/// `_source` filtering from `a, b.*, -c`.
fn source_json(source: &str) -> Option<Json> {
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    for field in source.split(',').map(str::trim).filter(|f| !f.is_empty()) {
        match field.strip_prefix('-') {
            Some(excluded) => excludes.push(Json::string(excluded.trim())),
            None => includes.push(Json::string(field)),
        }
    }
    if includes.is_empty() && excludes.is_empty() {
        return None;
    }
    let mut entries = Vec::new();
    if !includes.is_empty() {
        entries.push(("includes", Json::Array(includes)));
    }
    if !excludes.is_empty() {
        entries.push(("excludes", Json::Array(excludes)));
    }
    Some(Json::object(entries))
}

fn sort_entry(field: &str, descending: bool) -> Json {
    Json::object([(
        field,
        Json::object([(
            "order",
            Json::string(if descending { "desc" } else { "asc" }),
        )]),
    )])
}

fn total_of(response: &Json) -> Option<SearchTotal> {
    let total = response.get("hits")?.get("total")?;
    match total {
        Json::Number(n) => n.as_f64().map(|value| SearchTotal { value, exact: true }),
        object => Some(SearchTotal {
            value: number_of(object.get("value"))?,
            exact: object.get("relation").and_then(Json::as_str) != Some("gte"),
        }),
    }
}

fn hits_of(response: &Json) -> Vec<Json> {
    response
        .get("hits")
        .and_then(|h| h.get("hits"))
        .and_then(Json::as_array)
        .map(<[Json]>::to_vec)
        .unwrap_or_default()
}

fn took_of(response: &Json) -> Option<f64> {
    number_of(response.get("took"))
}

/// The point in time has expired, or the cluster lost it.
fn pit_lost(error: &YadbeError) -> bool {
    let detail = error.detail.as_deref().unwrap_or_default();
    detail.contains("search_context_missing")
        || detail.contains("No search context found")
        || detail.contains("point in time")
}

impl SearchService {
    pub fn new(
        manager: Arc<ConnectionManager>,
        store: Arc<ResultStore>,
        history: Arc<dyn HistoryRecorder>,
    ) -> Self {
        Self {
            manager,
            store,
            history,
            tabs: Mutex::new(HashMap::new()),
            journal: None,
        }
    }

    pub fn with_journal(mut self, journal: Arc<ChangeJournal>) -> Self {
        self.journal = Some(journal);
        self
    }

    pub(super) fn open(
        &self,
        connection_id: &str,
    ) -> Result<(Arc<ConnectionSession>, Arc<dyn SearchConnection>), YadbeError> {
        let session = self.manager.session(connection_id)?;
        let conn = session.backend()?.into_search()?;
        Ok((session, conn))
    }

    pub(super) fn gate<'a>(
        &'a self,
        session: &'a ConnectionSession,
        conn: &'a dyn SearchConnection,
    ) -> Gate<'a> {
        Gate {
            session,
            conn,
            history: &*self.history,
        }
    }

    /// yadbe's own read on the connection's link, as JSON.
    async fn own(&self, connection_id: &str, path: String) -> Result<Json, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        self.gate(&session, &*conn)
            .own_json(&SearchRequest::new(HttpMethod::Get, path))
            .await
    }

    // --- Explorer ---------------------------------------------------------------------------

    pub async fn indices(&self, connection_id: &str) -> Result<Vec<SearchIndexInfo>, YadbeError> {
        let cat = self
            .own(
                connection_id,
                "/_cat/indices?format=json&bytes=b&expand_wildcards=all&h=index,health,status,docs.count,store.size,pri,rep".to_owned(),
            )
            .await?;
        Ok(parse_indices(&cat))
    }

    pub async fn data_streams(
        &self,
        connection_id: &str,
    ) -> Result<Vec<SearchDataStream>, YadbeError> {
        let (_, conn) = self.open(connection_id)?;
        if !conn.server().features.data_streams {
            return Ok(Vec::new());
        }
        let reply = self.own(connection_id, "/_data_stream".to_owned()).await?;
        Ok(parse_data_streams(&reply))
    }

    pub async fn aliases(&self, connection_id: &str) -> Result<Vec<SearchAlias>, YadbeError> {
        let reply = self.own(connection_id, "/_alias".to_owned()).await?;
        Ok(parse_aliases(&reply))
    }

    pub async fn templates(&self, connection_id: &str) -> Result<Vec<SearchTemplate>, YadbeError> {
        let (_, conn) = self.open(connection_id)?;
        if !conn.server().features.index_templates {
            return Ok(Vec::new());
        }
        let reply = self
            .own(connection_id, "/_index_template".to_owned())
            .await?;
        Ok(parse_templates(&reply))
    }

    /// The fields of an index (or of every index a pattern, alias or data stream resolves
    /// to) and a summary of its settings.
    pub async fn index_details(
        &self,
        connection_id: &str,
        target: &str,
    ) -> Result<SearchIndexDetails, YadbeError> {
        let target = segment(target);
        let mapping = self
            .own(connection_id, format!("/{target}/_mapping"))
            .await?;
        let settings = self
            .own(
                connection_id,
                format!("/{target}/_settings?flat_settings=true"),
            )
            .await?;
        let (settings, max_result_window) = parse_settings(&settings);
        Ok(SearchIndexDetails {
            fields: parse_mapping(&mapping),
            settings,
            max_result_window,
        })
    }

    // --- Tabs -------------------------------------------------------------------------------

    fn tab(&self, tab_id: &str, connection_id: &str) -> Arc<SearchTab> {
        let mut tabs = lock(&self.tabs);
        let tab = tabs
            .entry(tab_id.to_owned())
            .or_insert_with(|| Arc::new(SearchTab::new(connection_id)));
        if tab.connection_id != connection_id {
            // The tab moved to another connection: start over.
            *tab = Arc::new(SearchTab::new(connection_id));
        }
        Arc::clone(tab)
    }

    /// Marks the tab busy; refuses a second request while one runs.
    fn start<'a>(
        &self,
        tab: &'a SearchTab,
    ) -> Result<(RunGuard<'a>, CancellationToken), YadbeError> {
        let mut running = lock(&tab.running);
        if running.is_some() {
            return Err(YadbeError::execution_running());
        }
        let stop = CancellationToken::new();
        *running = Some(Running { stop: stop.clone() });
        Ok((RunGuard { tab }, stop))
    }

    fn replace_results(&self, tab: &SearchTab, ids: Vec<u32>) {
        let old = std::mem::replace(&mut *lock(&tab.results), ids);
        self.store.remove(old);
    }

    /// Opens an index tab: the target's fields and settings, and how its pages will go.
    pub async fn open_index(
        &self,
        tab_id: &str,
        connection_id: &str,
        target: &str,
    ) -> Result<IndexTabInfo, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        self.close_pit(&tab, &session, &*conn).await;
        *tab.pages.lock().await = PageState::default();
        let details = self.index_details(connection_id, target).await?;
        *lock(&tab.types) = details
            .fields
            .iter()
            .map(|f| (f.path.clone(), f.type_name.clone()))
            .collect();
        *lock(&tab.window) = details.max_result_window;
        let server = conn.server().clone();
        Ok(IndexTabInfo {
            target: target.to_owned(),
            paging: paging_of(&*conn),
            details,
            server,
        })
    }

    async fn close_pit(
        &self,
        tab: &SearchTab,
        session: &ConnectionSession,
        conn: &dyn SearchConnection,
    ) {
        let pit = tab.pages.lock().await.pit.take();
        let Some(id) = pit else { return };
        let request = match conn.server().features.point_in_time {
            Some(PitApi::Pit) => SearchRequest::json(
                HttpMethod::Delete,
                "/_pit",
                &Json::object([("id", Json::string(id))]),
            ),
            Some(PitApi::SearchPointInTime) => SearchRequest::json(
                HttpMethod::Delete,
                "/_search/point_in_time",
                &Json::object([("pit_id", Json::Array(vec![Json::string(id)]))]),
            ),
            None => return,
        };
        if let Err(err) = self.gate(session, conn).send(&request, Send::own()).await {
            tracing::debug!(error = %err, "could not close a point in time");
        }
    }

    async fn open_pit(
        &self,
        gate: &Gate<'_>,
        target: &str,
        api: PitApi,
        stop: &CancellationToken,
    ) -> Result<String, YadbeError> {
        let path = match api {
            PitApi::Pit => format!("/{}/_pit?keep_alive={PIT_KEEP_ALIVE}", segment(target)),
            PitApi::SearchPointInTime => format!(
                "/{}/_search/point_in_time?keep_alive={PIT_KEEP_ALIVE}",
                segment(target)
            ),
        };
        let request = SearchRequest::new(HttpMethod::Post, path);
        let json = gate
            .send(
                &request,
                Send {
                    stop: Some(stop),
                    ..Send::own()
                },
            )
            .await?
            .into_result()?
            .json()
            .unwrap_or(Json::Null);
        json.get("id")
            .or_else(|| json.get("pit_id"))
            .and_then(Json::as_str)
            .map(str::to_owned)
            .ok_or_else(|| YadbeError::query_failed("the point in time has no id"))
    }

    /// Reads page `page` (0-based) of `query` on `target`.
    pub async fn fetch_page(
        &self,
        tab_id: &str,
        connection_id: &str,
        target: &str,
        query: IndexQuery,
        page: u32,
    ) -> Result<IndexPage, YadbeError> {
        if !(1..=MAX_PAGE_SIZE).contains(&query.page_size) {
            return Err(YadbeError::invalid_argument(
                format!("A page holds 1 to {MAX_PAGE_SIZE} documents."),
                format!("Une page contient de 1 à {MAX_PAGE_SIZE} documents."),
            ));
        }
        let (session, conn) = self.open(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        let (_guard, stop) = self.start(&tab)?;
        let start = Instant::now();
        let paging = paging_of(&*conn);
        let key = (target.to_owned(), query.clone());
        // A new query, or its first page again: a fresh snapshot.
        let fresh = page == 0 || tab.pages.lock().await.key.as_ref() != Some(&key);
        if fresh {
            self.close_pit(&tab, &session, &*conn).await;
            *tab.pages.lock().await = PageState {
                key: Some(key),
                starts: vec![None],
                ..PageState::default()
            };
        }
        let gate = self.gate(&session, &*conn);
        let filter = query_json(&query)?;
        let window = *lock(&tab.window);
        let types = lock(&tab.types).clone();
        let size = query.page_size;
        let (response, request, has_more) = match paging {
            IndexPaging::FromSize => {
                let from = page.saturating_mul(size);
                if from >= window {
                    return Err(beyond_window(window));
                }
                // One more than the page, to know whether another follows.
                let ask = (size + 1).min(window - from);
                let mut body = vec![
                    ("from", Json::int(i64::from(from))),
                    ("size", Json::int(i64::from(ask))),
                    ("query", filter),
                    ("track_total_hits", Json::int(TRACK_TOTAL)),
                    // The version of each hit, for the edits' optimistic concurrency.
                    ("seq_no_primary_term", Json::Bool(true)),
                ];
                if !query.sort.is_empty() {
                    body.push((
                        "sort",
                        Json::Array(
                            query
                                .sort
                                .iter()
                                .map(|s| sort_entry(&s.field, s.descending))
                                .collect(),
                        ),
                    ));
                }
                if let Some(source) = source_json(&query.source) {
                    body.push(("_source", source));
                }
                let request = SearchRequest::json(
                    HttpMethod::Post,
                    format!("/{}/_search", segment(target)),
                    &Json::object(body),
                );
                let response = gate
                    .send(
                        &request,
                        Send {
                            stop: Some(&stop),
                            ..Send::own()
                        },
                    )
                    .await?
                    .into_result()?;
                let json = response.json().unwrap_or(Json::Null);
                let count = hits_of(&json).len();
                let has_more = count > size as usize;
                (json, request, has_more)
            }
            IndexPaging::PointInTime => {
                let api = conn
                    .server()
                    .features
                    .point_in_time
                    .ok_or_else(|| YadbeError::internal("point in time without an API"))?;
                // Pages not read yet (a jump): read the ones before first.
                loop {
                    let known = tab.pages.lock().await.starts.len();
                    if known > page as usize {
                        break;
                    }
                    let previous = u32::try_from(known - 1).unwrap_or(u32::MAX);
                    self.pit_page(&tab, &gate, target, &query, &filter, api, previous, &stop)
                        .await?;
                    if tab.pages.lock().await.starts.len() == known {
                        return Err(YadbeError::invalid_argument(
                            "There is no such page: the documents end before it.",
                            "Cette page n'existe pas : les documents s'arrêtent avant.",
                        ));
                    }
                }
                self.pit_page(&tab, &gate, target, &query, &filter, api, page, &stop)
                    .await?
            }
        };
        let mut hits = hits_of(&response);
        hits.truncate(size as usize);
        let total = {
            let mut pages = tab.pages.lock().await;
            if let Some(total) = total_of(&response) {
                pages.total = Some(total);
            }
            pages.total
        };
        let documents = store_hits(&self.store, &hits, &types);
        self.replace_results(&tab, ids_of(&documents).to_vec());
        Ok(IndexPage {
            documents,
            page,
            has_more,
            total,
            paging,
            window: (paging == IndexPaging::FromSize).then_some(window),
            request: request.display(),
            took_ms: took_of(&response),
            duration_ms: duration_ms(start),
        })
    }

    /// One page on the tab's point in time (opened on the first page, opened again once if
    /// it expired): its answer, the request sent, whether another page follows. Records where
    /// the next page starts.
    #[allow(clippy::too_many_arguments)]
    async fn pit_page(
        &self,
        tab: &SearchTab,
        gate: &Gate<'_>,
        target: &str,
        query: &IndexQuery,
        filter: &Json,
        api: PitApi,
        page: u32,
        stop: &CancellationToken,
    ) -> Result<(Json, SearchRequest, bool), YadbeError> {
        let size = query.page_size;
        let mut sort: Vec<Json> = query
            .sort
            .iter()
            .map(|s| sort_entry(&s.field, s.descending))
            .collect();
        if sort.is_empty() {
            sort.push(if is_match_all(filter) {
                sort_entry("_shard_doc", false)
            } else {
                sort_entry("_score", true)
            });
        }
        let mut retried = false;
        loop {
            let (pit, after) = {
                let pages = tab.pages.lock().await;
                (
                    pages.pit.clone(),
                    pages.starts.get(page as usize).cloned().flatten(),
                )
            };
            let pit = match pit {
                Some(pit) => pit,
                None => {
                    let pit = self.open_pit(gate, target, api, stop).await?;
                    tab.pages.lock().await.pit = Some(pit.clone());
                    pit
                }
            };
            let mut body = vec![
                ("size", Json::int(i64::from(size + 1))),
                ("query", filter.clone()),
                ("sort", Json::Array(sort.clone())),
                (
                    "track_total_hits",
                    if page == 0 {
                        Json::int(TRACK_TOTAL)
                    } else {
                        Json::Bool(false)
                    },
                ),
                ("seq_no_primary_term", Json::Bool(true)),
                (
                    "pit",
                    Json::object([
                        ("id", Json::string(pit)),
                        ("keep_alive", Json::string(PIT_KEEP_ALIVE)),
                    ]),
                ),
            ];
            if let Some(source) = source_json(&query.source) {
                body.push(("_source", source));
            }
            if let Some(after) = after {
                body.push(("search_after", after));
            }
            let request = SearchRequest::json(HttpMethod::Post, "/_search", &Json::object(body));
            let result = gate
                .send(
                    &request,
                    Send {
                        stop: Some(stop),
                        ..Send::own()
                    },
                )
                .await
                .and_then(SearchResponse::into_result);
            let response = match result {
                Ok(response) => response,
                Err(err) if !retried && pit_lost(&err) => {
                    retried = true;
                    tab.pages.lock().await.pit = None;
                    continue;
                }
                Err(err) => return Err(err),
            };
            let json = response.json().unwrap_or(Json::Null);
            let hits = hits_of(&json);
            let has_more = hits.len() > size as usize;
            // The PIT id may change between pages: the newest one is the one to use.
            let next_pit = json.get("pit_id").and_then(Json::as_str).map(str::to_owned);
            let mut pages = tab.pages.lock().await;
            if let Some(next) = next_pit {
                pages.pit = Some(next);
            }
            if has_more && let Some(last) = hits.get(size as usize - 1).and_then(|h| h.get("sort"))
            {
                let next = page as usize + 1;
                if pages.starts.len() <= next {
                    pages.starts.resize(next + 1, None);
                }
                pages.starts[next] = Some(last.clone());
            }
            return Ok((json, request, has_more));
        }
    }

    /// Counts exactly the documents of `query` on `target` (`_count`).
    pub async fn count(
        &self,
        tab_id: &str,
        connection_id: &str,
        target: &str,
        query: IndexQuery,
    ) -> Result<f64, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        let (_guard, stop) = self.start(&tab)?;
        let request = SearchRequest::json(
            HttpMethod::Post,
            format!("/{}/_count", segment(target)),
            &Json::object([("query", query_json(&query)?)]),
        );
        let json = self
            .gate(&session, &*conn)
            .send(
                &request,
                Send {
                    stop: Some(&stop),
                    ..Send::own()
                },
            )
            .await?
            .into_result()?
            .json()
            .unwrap_or(Json::Null);
        number_of(json.get("count"))
            .ok_or_else(|| YadbeError::query_failed("the count is missing from the answer"))
    }

    /// Stops what the tab runs: the request on the server and, for a console, what follows.
    pub fn cancel(&self, tab_id: &str) {
        let Some(tab) = lock(&self.tabs).get(tab_id).cloned() else {
            return;
        };
        if let Some(running) = lock(&tab.running).as_ref() {
            running.stop.cancel();
        }
    }

    /// Frees what a closed tab holds: its results, its point in time.
    pub async fn close_tab(&self, tab_id: &str) {
        self.cancel(tab_id);
        let Some(tab) = lock(&self.tabs).remove(tab_id) else {
            return;
        };
        let ids = std::mem::take(&mut *lock(&tab.results));
        self.store.remove(ids);
        if let Ok((session, conn)) = self.open(&tab.connection_id) {
            self.close_pit(&tab, &session, &*conn).await;
        }
    }

    /// Whole documents of a result, plain JSON (`documentsId` of a [`DocumentResult`], or the
    /// `documentId` of a console answer).
    pub fn documents(
        &self,
        documents_id: u32,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<String>, YadbeError> {
        if limit > MAX_DOCUMENTS_WINDOW {
            return Err(YadbeError::invalid_argument(
                format!("A window has at most {MAX_DOCUMENTS_WINDOW} documents."),
                format!("Une fenêtre compte au plus {MAX_DOCUMENTS_WINDOW} documents."),
            ));
        }
        crate::session::document::results::documents_window(
            &self.store,
            documents_id,
            offset,
            limit,
        )
    }

    // --- Console ----------------------------------------------------------------------------

    /// Runs the requests of a console text: those on `lines` (the cursor's or the
    /// selection's), else all. Without `confirmed`, a dangerous request among them stops the
    /// run before anything is sent, with what each would do.
    pub async fn console_run(
        &self,
        tab_id: &str,
        connection_id: &str,
        text: &str,
        lines: Option<LineRange>,
        confirmed: bool,
    ) -> Result<SearchConsoleOutcome, YadbeError> {
        let requests = match parse_console(text) {
            Ok(requests) => requests,
            Err(failure) => {
                return Ok(SearchConsoleOutcome::Ran {
                    responses: Vec::new(),
                    skipped: 0,
                    failure: Some(ConsoleFailure {
                        error: failure.error,
                        line: failure.line,
                    }),
                });
            }
        };
        let picked = pick(requests, lines.map(|r| (r.from, r.to)));
        let (session, conn) = self.open(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        let (_guard, stop) = self.start(&tab)?;
        let gate = self.gate(&session, &*conn);
        if !confirmed {
            let list: Vec<(u32, &SearchRequest)> =
                picked.iter().map(|r| (r.line, &r.request)).collect();
            let dangers = gate.dangers(&list).await;
            if !dangers.is_empty() {
                return Ok(SearchConsoleOutcome::NeedsConfirmation { dangers });
            }
        }
        self.replace_results(&tab, Vec::new());
        let user = UserContext {
            tab_id: tab_id.to_owned(),
            connection_id: connection_id.to_owned(),
        };
        let mut responses = Vec::new();
        let mut held = Vec::new();
        let mut skipped = 0;
        for (index, request) in picked.iter().enumerate() {
            if stop.is_cancelled() {
                skipped = picked.len() - index;
                break;
            }
            let start = Instant::now();
            let result = gate
                .send(
                    &request.request,
                    Send {
                        origin: Origin::User(&user),
                        confirmed,
                        opaque_id: Some(new_opaque_id()),
                        stop: Some(&stop),
                    },
                )
                .await;
            let failed = result.is_err();
            responses.push(self.console_response(request, result, start, &mut held));
            if failed {
                skipped = picked.len() - index - 1;
                break;
            }
        }
        self.replace_results(&tab, held);
        Ok(SearchConsoleOutcome::Ran {
            responses,
            skipped: u32::try_from(skipped).unwrap_or(u32::MAX),
            failure: None,
        })
    }

    fn console_response(
        &self,
        request: &ConsoleRequest,
        result: Result<SearchResponse, YadbeError>,
        start: Instant,
        held: &mut Vec<u32>,
    ) -> ConsoleResponse {
        let mut out = ConsoleResponse {
            line: request.line,
            method: request.request.method,
            path: request.request.path.clone(),
            status: None,
            duration_ms: duration_ms(start),
            took_ms: None,
            shards: None,
            timed_out: false,
            error: None,
            error_position: None,
            body: ConsoleBody::Empty,
        };
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                out.error = Some(error);
                return out;
            }
        };
        out.status = Some(response.status);
        if let Some(server) = response.server_error() {
            out.error_position = server.position.and_then(|(line, column)| {
                // The server counts in the body it got; the editor shows the console text.
                let editor_line = request
                    .body_lines
                    .get(line.checked_sub(1)? as usize)
                    .copied()?;
                Some(ConsolePosition {
                    line: editor_line + 1,
                    column,
                })
            });
            out.error = Some(server.into_error(response.status));
        }
        if response.body.is_empty() {
            return out;
        }
        let Some(json) = response.json() else {
            let text = response.text();
            let truncated = text.chars().count() > MAX_RAW_CHARS;
            out.body = ConsoleBody::Text {
                text: text.chars().take(MAX_RAW_CHARS).collect(),
                truncated,
            };
            return out;
        };
        out.took_ms = took_of(&json);
        out.timed_out = matches!(json.get("timed_out"), Some(Json::Bool(true)));
        out.shards = json.get("_shards").map(|s| ShardsInfo {
            total: number_of(s.get("total")).unwrap_or(0.0),
            successful: number_of(s.get("successful")).unwrap_or(0.0),
            skipped: number_of(s.get("skipped")).unwrap_or(0.0),
            failed: number_of(s.get("failed")).unwrap_or(0.0),
        });
        let has_hits = json
            .get("hits")
            .and_then(|h| h.get("hits"))
            .and_then(Json::as_array)
            .is_some();
        let hits: Option<DocumentResult> = has_hits.then(|| {
            let documents = store_hits(&self.store, &hits_of(&json), &HashMap::new());
            held.extend(ids_of(&documents));
            documents
        });
        let table = store_table(&self.store, &json);
        if let Some(table) = &table {
            held.push(table.result_id);
        }
        let document_id = store_document(&self.store, &json);
        held.push(document_id);
        let raw = response.text();
        let truncated = raw.len() > MAX_RAW_CHARS;
        let raw = if truncated {
            let mut end = MAX_RAW_CHARS;
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            raw[..end].to_owned()
        } else {
            raw
        };
        out.body = ConsoleBody::Json {
            raw,
            truncated,
            document_id,
            total: total_of(&json),
            hits,
            table,
        };
        out
    }
}

/// How the pages of a connection's index tabs go: a point in time where the server can sort
/// on its tiebreaker, else `from` / `size`.
fn paging_of(conn: &dyn SearchConnection) -> IndexPaging {
    let features = conn.server().features;
    if features.point_in_time.is_some() && features.shard_doc_sort {
        IndexPaging::PointInTime
    } else {
        IndexPaging::FromSize
    }
}

fn beyond_window(window: u32) -> YadbeError {
    YadbeError::new(
        ErrorCode::NotSupported,
        format!(
            "Pages stop at document {window}: the index's result window (index.max_result_window). Narrow the query or change the sort to reach the documents after it."
        ),
        format!(
            "Les pages s'arrêtent au document {window} : la fenêtre de résultats de l'index (index.max_result_window). Restreignez la requête ou changez le tri pour atteindre les documents suivants."
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(mode: IndexQueryMode, text: &str) -> IndexQuery {
        IndexQuery {
            mode,
            text: text.into(),
            source: String::new(),
            sort: Vec::new(),
            page_size: 10,
        }
    }

    #[test]
    fn queries_become_query_dsl() {
        let dsl = |text| query_json(&query(IndexQueryMode::Dsl, text)).map(|j| j.to_text());
        assert_eq!(dsl("").expect("empty"), r#"{"match_all":{}}"#);
        assert_eq!(
            dsl(r#"{"query":{"term":{"a":1}}}"#).expect("whole body"),
            r#"{"term":{"a":1}}"#
        );
        assert_eq!(
            dsl(r#"{"match":{"t":"x"}}"#).expect("query"),
            r#"{"match":{"t":"x"}}"#
        );
        assert!(dsl("{}").is_err());
        assert!(dsl("[1]").is_err());
        assert!(dsl("{nope").is_err());
        let qs = query_json(&query(IndexQueryMode::QueryString, "status:paid")).expect("qs");
        assert_eq!(qs.to_text(), r#"{"query_string":{"query":"status:paid"}}"#);
        assert_eq!(
            source_json(" a, b.*, -c ").map(|j| j.to_text()).as_deref(),
            Some(r#"{"includes":["a","b.*"],"excludes":["c"]}"#)
        );
        assert_eq!(source_json(" , "), None);
    }

    #[test]
    fn totals_say_whether_they_are_exact() {
        let json =
            Json::parse(r#"{"hits":{"total":{"value":10000,"relation":"gte"}}}"#).expect("json");
        assert_eq!(
            total_of(&json),
            Some(SearchTotal {
                value: 10_000.0,
                exact: false
            })
        );
        let old = Json::parse(r#"{"hits":{"total":42}}"#).expect("json");
        assert_eq!(total_of(&old).map(|t| t.exact), Some(true));
    }
}
