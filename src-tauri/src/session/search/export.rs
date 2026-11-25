//! A whole index for an export (M4-11): every hit of an index tab's query, `_source` filter and
//! sort, not only the page shown. On a point in time with `search_after`, as the index tab
//! pages past its result window, where the server can (Elasticsearch 7.12 and later); else on
//! a scroll (OpenSearch, older Elasticsearch), which has no depth limit either. Each request
//! is one of yadbe's own through the gate (read-only, the statement timeout, the statement
//! log); the point in time or the scroll is closed at the end, and when the export fails or is
//! cancelled.

use std::collections::HashMap;
use std::sync::Arc;

use crate::db::document::json::Json;
use crate::db::driver::SearchConnection;
use crate::db::errors::YadbeError;
use crate::db::search::hits::{hit_row, hit_rows};
use crate::db::search::request::{HttpMethod, SearchRequest, SearchResponse, segment};
use crate::db::search::server::PitApi;
use crate::db::value::{ColumnMeta, Value};
use crate::session::ConnectionSession;
use crate::session::document::results::document_column;
use crate::session::history_hook::HistoryRecorder;
use crate::session::search::gate::{Gate, Send as How, new_opaque_id};
use crate::session::search::model::{IndexPaging, IndexQuery, IndexQueryMode, IndexSort};
use crate::session::search::service::{
    SearchService, hits_of, is_match_all, paging_of, pit_close_request, pit_id_of, pit_open_path,
    pit_sort, query_json, sort_entry, source_json,
};

/// Hits per page of an export.
pub const EXPORT_PAGE: u32 = 1_000;
/// How long a scroll lives between two pages.
const SCROLL_KEEP_ALIVE: &str = "5m";

/// What an index export reads: the query of an index tab, as typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexExport {
    pub connection_id: String,
    /// An index, data stream, alias or pattern.
    pub target: String,
    pub mode: IndexQueryMode,
    pub text: String,
    /// `_source` filtering (`a, b.*, -c`).
    pub source: String,
    pub sort: Vec<IndexSort>,
    /// Each hit whole (one `document` column: what JSON Lines writes), rather than grid rows.
    pub documents: bool,
}

/// How the pages of an export follow each other.
#[derive(Debug, Clone, PartialEq)]
enum Pages {
    /// `search_after` on a point in time; `id: None` once it is closed.
    Pit {
        api: PitApi,
        id: Option<String>,
        sort: Vec<Json>,
        after: Option<Json>,
    },
    /// A scroll; `id: None` before its first page and once it is closed.
    Scroll { id: Option<String>, started: bool },
}

/// The body of a page on a point in time.
fn pit_body(
    filter: &Json,
    source: Option<Json>,
    sort: &[Json],
    pit: &str,
    after: Option<&Json>,
    size: u32,
) -> Json {
    let mut body = vec![
        ("size", Json::int(i64::from(size))),
        ("query", filter.clone()),
        ("sort", Json::Array(sort.to_vec())),
        ("track_total_hits", Json::Bool(false)),
        (
            "pit",
            Json::object([
                ("id", Json::string(pit)),
                (
                    "keep_alive",
                    Json::string(crate::session::search::service::PIT_KEEP_ALIVE),
                ),
            ]),
        ),
    ];
    if let Some(source) = source {
        body.push(("_source", source));
    }
    if let Some(after) = after {
        body.push(("search_after", after.clone()));
    }
    Json::object(body)
}

/// The body of a scroll's first page: the tab's sort, else index order (`_doc`, the cheapest)
/// for every document and the score for a query.
fn scroll_body(filter: &Json, source: Option<Json>, sort: &[IndexSort], size: u32) -> Json {
    let mut body = vec![
        ("size", Json::int(i64::from(size))),
        ("query", filter.clone()),
    ];
    if !sort.is_empty() {
        body.push((
            "sort",
            Json::Array(
                sort.iter()
                    .map(|s| sort_entry(&s.field, s.descending))
                    .collect(),
            ),
        ));
    } else if is_match_all(filter) {
        body.push(("sort", Json::Array(vec![Json::string("_doc")])));
    }
    if let Some(source) = source {
        body.push(("_source", source));
    }
    Json::object(body)
}

impl Pages {
    /// The request of the next page.
    fn request(
        &self,
        target: &str,
        filter: &Json,
        source: Option<Json>,
        sort: &[IndexSort],
        size: u32,
    ) -> Result<SearchRequest, YadbeError> {
        match self {
            Pages::Pit {
                id: Some(id),
                sort,
                after,
                ..
            } => Ok(SearchRequest::json(
                HttpMethod::Post,
                "/_search",
                &pit_body(filter, source, sort, id, after.as_ref(), size),
            )),
            Pages::Scroll { started: false, .. } => Ok(SearchRequest::json(
                HttpMethod::Post,
                format!("/{}/_search?scroll={SCROLL_KEEP_ALIVE}", segment(target)),
                &scroll_body(filter, source, sort, size),
            )),
            Pages::Scroll { id: Some(id), .. } => Ok(SearchRequest::json(
                HttpMethod::Post,
                "/_search/scroll",
                &Json::object([
                    ("scroll", Json::string(SCROLL_KEEP_ALIVE)),
                    ("scroll_id", Json::string(id.clone())),
                ]),
            )),
            Pages::Pit { id: None, .. } | Pages::Scroll { id: None, .. } => Err(
                YadbeError::internal("an export page after its search context closed"),
            ),
        }
    }

    /// Moves past a page just read; whether it was the last.
    fn advance(&mut self, response: &Json, hits: &[Json], size: u32) -> bool {
        match self {
            Pages::Pit { id, after, .. } => {
                // The id may change between pages: the newest one is the one to use.
                if let Some(next) = response.get("pit_id").and_then(Json::as_str) {
                    *id = Some(next.to_owned());
                }
                *after = hits.last().and_then(|hit| hit.get("sort")).cloned();
                hits.len() < size as usize || after.is_none()
            }
            Pages::Scroll { id, started } => {
                *started = true;
                if let Some(next) = response.get("_scroll_id").and_then(Json::as_str) {
                    *id = Some(next.to_owned());
                }
                // A scroll ends on an empty page.
                hits.is_empty() || id.is_none()
            }
        }
    }

    /// What closes the point in time or the scroll, once; `None` when nothing is open.
    fn take_close(&mut self) -> Option<SearchRequest> {
        match self {
            Pages::Pit { api, id, .. } => id.take().map(|id| pit_close_request(*api, id)),
            Pages::Scroll { id, .. } => id.take().map(|id| {
                SearchRequest::json(
                    HttpMethod::Delete,
                    "/_search/scroll",
                    &Json::object([("scroll_id", Json::Array(vec![Json::string(id)]))]),
                )
            }),
        }
    }
}

/// The rows of an index export: grid rows under the columns of the first page (a field that
/// only appears later is left out of them), or whole hits.
pub struct IndexExportRows {
    session: Arc<ConnectionSession>,
    conn: Arc<dyn SearchConnection>,
    history: Arc<dyn HistoryRecorder>,
    target: String,
    filter: Json,
    source: Option<Json>,
    sort: Vec<IndexSort>,
    pages: Pages,
    page_size: u32,
    /// Names of the grid columns; `None`: whole hits.
    names: Option<Vec<String>>,
    columns: Vec<ColumnMeta>,
    /// The rows of the first page, read when the export opened.
    first: Option<Vec<Vec<Value>>>,
    done: bool,
    /// The `X-Opaque-Id` of the request in flight, to cancel its task when the export is
    /// dropped.
    running: Option<String>,
}

impl IndexExportRows {
    pub fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    fn gate(&self) -> Gate<'_> {
        Gate {
            session: &self.session,
            conn: &*self.conn,
            history: &*self.history,
        }
    }

    /// One request of yadbe's own, its error status as an error, its body as JSON.
    async fn send(&mut self, request: &SearchRequest) -> Result<Json, YadbeError> {
        let opaque_id = new_opaque_id();
        self.running = Some(opaque_id.clone());
        let result = self
            .gate()
            .send(
                request,
                How {
                    opaque_id: Some(opaque_id),
                    ..How::own()
                },
            )
            .await
            .and_then(SearchResponse::into_result);
        self.running = None;
        Ok(result?.json().unwrap_or(Json::Null))
    }

    async fn read_page(&mut self) -> Result<Vec<Json>, YadbeError> {
        let request = self.pages.request(
            &self.target,
            &self.filter,
            self.source.clone(),
            &self.sort,
            self.page_size,
        )?;
        let response = self.send(&request).await?;
        let hits = hits_of(&response);
        if self.pages.advance(&response, &hits, self.page_size) {
            self.done = true;
            self.close().await;
        }
        Ok(hits)
    }

    fn rows(&self, hits: &[Json]) -> Vec<Vec<Value>> {
        match &self.names {
            Some(names) => hits.iter().map(|hit| hit_row(hit, names)).collect(),
            None => hits
                .iter()
                .map(|hit| vec![Value::Json(hit.to_text())])
                .collect(),
        }
    }

    /// Closes the point in time or the scroll (at the end, or when a preview has its rows).
    async fn close(&mut self) {
        if let Some(request) = self.pages.take_close()
            && let Err(err) = self.gate().send(&request, How::own()).await
        {
            tracing::debug!(error = %err, "could not close an export's search context");
        }
    }

    /// The next page, `None` at the end. Dropping the call mid-page ends the export (a
    /// cancel): the drop closes what is open.
    pub async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        if let Some(first) = self.first.take() {
            return Ok((!first.is_empty()).then_some(first));
        }
        if self.done {
            return Ok(None);
        }
        let hits = self.read_page().await?;
        Ok((!hits.is_empty()).then(|| self.rows(&hits)))
    }
}

impl Drop for IndexExportRows {
    /// A cancelled or failed export cancels its request's task on the server, then closes the
    /// point in time or the scroll.
    fn drop(&mut self) {
        let running = self.running.take();
        let close = self.pages.take_close();
        if running.is_none() && close.is_none() {
            return;
        }
        let (session, conn, history) = (
            Arc::clone(&self.session),
            Arc::clone(&self.conn),
            Arc::clone(&self.history),
        );
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let gate = Gate {
                    session: &session,
                    conn: &*conn,
                    history: &*history,
                };
                if let Some(opaque_id) = running {
                    gate.cancel(&opaque_id).await;
                }
                if let Some(request) = close
                    && let Err(err) = gate.send(&request, How::own()).await
                {
                    tracing::debug!(error = %err, "could not close an export's search context");
                }
            });
        }
    }
}

impl SearchService {
    async fn open_export(
        &self,
        export: IndexExport,
        page_size: u32,
    ) -> Result<IndexExportRows, YadbeError> {
        let filter = query_json(&IndexQuery {
            mode: export.mode,
            text: export.text.clone(),
            source: export.source.clone(),
            sort: export.sort.clone(),
            page_size,
        })?;
        let (session, conn) = self.open(&export.connection_id)?;
        let pages = match paging_of(&*conn) {
            IndexPaging::PointInTime => Pages::Pit {
                api: conn
                    .server()
                    .features
                    .point_in_time
                    .ok_or_else(|| YadbeError::internal("point in time without an API"))?,
                id: None,
                sort: pit_sort(&export.sort, &filter),
                after: None,
            },
            IndexPaging::FromSize => Pages::Scroll {
                id: None,
                started: false,
            },
        };
        let mut rows = IndexExportRows {
            session,
            conn,
            history: Arc::clone(&self.history),
            source: source_json(&export.source),
            target: export.target,
            filter,
            sort: export.sort,
            pages,
            page_size: page_size.max(1),
            names: None,
            columns: vec![document_column()],
            first: None,
            done: false,
            running: None,
        };
        if let Pages::Pit { api, .. } = rows.pages {
            let opened = rows
                .send(&SearchRequest::new(
                    HttpMethod::Post,
                    pit_open_path(api, &rows.target),
                ))
                .await?;
            let id = pit_id_of(&opened)?;
            if let Pages::Pit { id: slot, .. } = &mut rows.pages {
                *slot = Some(id);
            }
        }
        let first = rows.read_page().await?;
        let first_rows = if export.documents {
            rows.rows(&first)
        } else {
            let (columns, grid) = hit_rows(&first, &HashMap::new());
            rows.names = Some(columns.iter().map(|c| c.name.clone()).collect());
            rows.columns = columns;
            grid
        };
        rows.first = Some(first_rows);
        Ok(rows)
    }

    /// Every hit of `export`, read in pages of [`EXPORT_PAGE`]. The first page is read here:
    /// a bad query or a missing index fails the start of the export, not its file.
    pub async fn export_rows(&self, export: IndexExport) -> Result<IndexExportRows, YadbeError> {
        self.open_export(export, EXPORT_PAGE).await
    }

    /// The first `limit` rows of an export, for the preview; what it opened is closed.
    pub async fn export_preview(
        &self,
        export: IndexExport,
        limit: u32,
    ) -> Result<(Vec<ColumnMeta>, Vec<Vec<Value>>), YadbeError> {
        let page = if export.documents {
            limit.clamp(1, EXPORT_PAGE)
        } else {
            EXPORT_PAGE
        };
        let mut rows = self.open_export(export, page).await?;
        rows.close().await;
        let columns = rows.columns().to_vec();
        let mut first = rows.first.take().unwrap_or_default();
        first.truncate(limit as usize);
        Ok((columns, first))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(text: &str) -> Json {
        Json::parse(text).expect("json")
    }

    fn body(request: &SearchRequest) -> Json {
        Json::parse(&request.body.as_ref().expect("a body").text).expect("json body")
    }

    fn hit(id: &str, sort: &str) -> Json {
        j(&format!(r#"{{"_id":"{id}","_source":{{}},"sort":{sort}}}"#))
    }

    #[test]
    fn point_in_time_pages_follow_the_last_sort_values() {
        let filter = j(r#"{"match_all":{}}"#);
        let mut pages = Pages::Pit {
            api: PitApi::Pit,
            id: Some("pit-1".into()),
            sort: pit_sort(&[], &filter),
            after: None,
        };
        let first = pages
            .request("orders", &filter, None, &[], 2)
            .expect("request");
        assert_eq!(first.path, "/_search");
        let sent = body(&first);
        assert_eq!(
            sent.get("sort"),
            Some(&j(r#"[{"_shard_doc":{"order":"asc"}}]"#))
        );
        assert_eq!(sent.get("search_after"), None);
        assert_eq!(
            sent.get("pit").and_then(|p| p.get("id")),
            Some(&j(r#""pit-1""#))
        );

        let last = pages.advance(
            &j(r#"{"pit_id":"pit-2"}"#),
            &[hit("a", "[1]"), hit("b", "[2]")],
            2,
        );
        assert!(!last, "a full page: more may follow");
        let second = body(
            &pages
                .request("orders", &filter, Some(j(r#"{"includes":["a"]}"#)), &[], 2)
                .expect("request"),
        );
        assert_eq!(second.get("search_after"), Some(&j("[2]")));
        assert_eq!(
            second.get("pit").and_then(|p| p.get("id")),
            Some(&j(r#""pit-2""#)),
            "the newest id"
        );
        assert_eq!(second.get("_source"), Some(&j(r#"{"includes":["a"]}"#)));

        assert!(
            pages.advance(&Json::Null, &[hit("c", "[3]")], 2),
            "a short page is the last"
        );
        let close = pages.take_close().expect("something to close");
        assert_eq!(close.method, HttpMethod::Delete);
        assert_eq!(close.path, "/_pit");
        assert_eq!(body(&close), j(r#"{"id":"pit-2"}"#));
        assert!(pages.take_close().is_none(), "closed once");
    }

    #[test]
    fn scrolls_start_on_the_target_then_follow_their_id() {
        let filter = j(r#"{"query_string":{"query":"paid"}}"#);
        let sort = [IndexSort {
            field: "total".into(),
            descending: true,
        }];
        let mut pages = Pages::Scroll {
            id: None,
            started: false,
        };
        assert!(pages.take_close().is_none(), "nothing open yet");
        let first = pages
            .request("m4-orders", &filter, None, &sort, 500)
            .expect("request");
        assert_eq!(first.path, "/m4-orders/_search?scroll=5m");
        assert_eq!(
            body(&first),
            j(
                r#"{"size":500,"query":{"query_string":{"query":"paid"}},"sort":[{"total":{"order":"desc"}}]}"#
            )
        );
        assert!(!pages.advance(&j(r#"{"_scroll_id":"s1"}"#), &[hit("a", "[1]")], 500));
        let next = pages
            .request("m4-orders", &filter, None, &sort, 500)
            .expect("request");
        assert_eq!(next.path, "/_search/scroll");
        assert_eq!(body(&next), j(r#"{"scroll":"5m","scroll_id":"s1"}"#));
        assert!(
            pages.advance(&j(r#"{"_scroll_id":"s2"}"#), &[], 500),
            "a scroll ends on an empty page"
        );
        let close = pages.take_close().expect("the scroll");
        assert_eq!(close.path, "/_search/scroll");
        assert_eq!(body(&close), j(r#"{"scroll_id":["s2"]}"#));
    }

    #[test]
    fn every_document_scrolls_in_index_order() {
        let sent = scroll_body(&j(r#"{"match_all":{}}"#), None, &[], 10);
        assert_eq!(sent.get("sort"), Some(&j(r#"["_doc"]"#)));
        let scored = scroll_body(&j(r#"{"match":{"a":"b"}}"#), None, &[], 10);
        assert_eq!(scored.get("sort"), None, "a query keeps its score order");
    }

    #[test]
    fn grid_rows_keep_the_columns_of_the_first_page() {
        let first = [j(r#"{"_index":"i","_id":"1","_source":{"a":{"b":1}}}"#)];
        let (columns, _) = hit_rows(&first, &HashMap::new());
        let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, ["_index", "_id", "_score", "a.b"]);
        let later = j(r#"{"_index":"i","_id":"2","_source":{"c":true}}"#);
        assert_eq!(
            hit_row(&later, &names),
            vec![
                Value::Text("i".into()),
                Value::Text("2".into()),
                Value::Missing,
                Value::Missing
            ]
        );
    }
}
