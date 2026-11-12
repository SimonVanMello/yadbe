//! What a request does, from its method and path alone: whether it only reads (the read-only
//! allow-list of F-008) and whether it is one of the dangerous requests that are confirmed
//! with their effect. Anything not provably a read is a write: an unknown endpoint, a `PUT`, a
//! `POST` outside the list.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::request::{HttpMethod, SearchRequest};

/// Endpoints a `POST` reaches without writing: searches, counts, multi-gets, analysis, the
/// point-in-time and scroll contexts of a search, SQL / ES|QL / EQL queries.
const READ_POST: &[&str] = &[
    "_search",
    "_msearch",
    "_count",
    "_mget",
    "_explain",
    "_field_caps",
    "_validate",
    "_analyze",
    "_termvectors",
    "_mtermvectors",
    "_rank_eval",
    "_render",
    "_search_shards",
    "_query",
    "_sql",
    "_pit",
    "_eql",
    "_knn_search",
    "_terms_enum",
    "_async_search",
];

/// What may follow a read endpoint (`_search/template`, `_sql/translate`, `_query/async`…).
const READ_SUFFIXES: &[&str] = &[
    "template",
    "scroll",
    "point_in_time",
    "translate",
    "close",
    "async",
    "search",
    "query",
];

/// Endpoints that take one id after them (`_explain/<id>`, `_termvectors/<id>`).
const READ_WITH_ID: &[&str] = &["_explain", "_termvectors", "_async_search", "_eql"];

/// `GET` endpoints that act on the cluster rather than read it (`_flush`, `_refresh`… accept
/// `GET` too).
const ACTING_GET: &[&str] = &[
    "_flush",
    "_refresh",
    "_forcemerge",
    "_cancel",
    "_cache",
    "_close",
    "_open",
];

/// The index of the first segment that names an API (`_search`), not an index or an id.
fn first_api(segments: &[String]) -> Option<usize> {
    segments.iter().position(|s| s.starts_with('_'))
}

/// Whether the request only reads (search, get, cat, mappings, settings, cluster state…).
pub fn is_read(request: &SearchRequest) -> bool {
    let segments = request.segments();
    match request.method {
        HttpMethod::Get | HttpMethod::Head => {
            !segments.iter().any(|s| ACTING_GET.contains(&s.as_str()))
        }
        HttpMethod::Post => {
            let Some(at) = first_api(&segments) else {
                // `POST /index` indexes a document.
                return false;
            };
            let api = segments[at].as_str();
            if !READ_POST.contains(&api) {
                return false;
            }
            let rest = &segments[at + 1..];
            match rest {
                [] => true,
                [one] if READ_WITH_ID.contains(&api) && !one.starts_with('_') => true,
                [suffix] => READ_SUFFIXES.contains(&suffix.as_str()),
                _ => false,
            }
        }
        // Closing a search context (point in time, scroll, async search) frees no data.
        HttpMethod::Delete => match segments.as_slice() {
            [api] => api == "_pit",
            [api, sub] => match api.as_str() {
                "_search" => matches!(sub.as_str(), "scroll" | "point_in_time"),
                "_async_search" => !sub.starts_with('_'),
                _ => false,
            },
            _ => false,
        },
        HttpMethod::Put | HttpMethod::Patch => false,
    }
}

/// The dangerous requests: they delete or rewrite much at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchDangerKind {
    /// `DELETE /<index>`, wildcards and lists included.
    DeleteIndex,
    /// `DELETE /_data_stream/<name>`: the stream and every backing index.
    DeleteDataStream,
    /// `POST /<target>/_delete_by_query`.
    DeleteByQuery,
    /// `POST /<target>/_update_by_query`.
    UpdateByQuery,
    /// `POST /_reindex` into an index that exists (its documents with the same ids are
    /// overwritten); into a new index it is not dangerous.
    Reindex,
    /// `POST /<index>/_close`: the index cannot be searched or written until reopened.
    CloseIndex,
}

/// A dangerous request and what it targets (`logs-*`, the destination of a reindex).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DangerCandidate {
    pub kind: SearchDangerKind,
    pub target: String,
}

/// The danger of a request, before any measure: a reindex is only a candidate (dangerous when
/// its destination exists, which the gate checks).
pub fn danger_of(request: &SearchRequest) -> Option<DangerCandidate> {
    let segments = request.segments();
    let api = first_api(&segments);
    let candidate = |kind, target: &str| {
        Some(DangerCandidate {
            kind,
            target: target.to_owned(),
        })
    };
    match (request.method, segments.as_slice()) {
        (HttpMethod::Delete, [index]) if !index.starts_with('_') => {
            candidate(SearchDangerKind::DeleteIndex, index)
        }
        (HttpMethod::Delete, [api, name]) if api == "_data_stream" => {
            candidate(SearchDangerKind::DeleteDataStream, name)
        }
        (HttpMethod::Post, [target, op]) if op == "_delete_by_query" => {
            candidate(SearchDangerKind::DeleteByQuery, target)
        }
        (HttpMethod::Post, [op]) if op == "_delete_by_query" => {
            candidate(SearchDangerKind::DeleteByQuery, "_all")
        }
        (HttpMethod::Post, [target, op]) if op == "_update_by_query" => {
            candidate(SearchDangerKind::UpdateByQuery, target)
        }
        (HttpMethod::Post, [op]) if op == "_update_by_query" => {
            candidate(SearchDangerKind::UpdateByQuery, "_all")
        }
        (HttpMethod::Post, [op]) if op == "_reindex" => {
            let dest = request
                .body_json()
                .and_then(|body| body.get("dest")?.get("index")?.as_str().map(str::to_owned))
                .unwrap_or_default();
            candidate(SearchDangerKind::Reindex, &dest)
        }
        (HttpMethod::Post, [target, op]) if op == "_close" && api == Some(1) => {
            candidate(SearchDangerKind::CloseIndex, target)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: HttpMethod, path: &str) -> SearchRequest {
        SearchRequest::new(method, path)
    }

    #[test]
    fn reads_are_an_allow_list() {
        use HttpMethod::*;
        for (method, path) in [
            (Get, "/"),
            (Get, "/_cat/indices?v"),
            (Get, "/orders/_mapping"),
            (Get, "/orders/_doc/1"),
            (Head, "/orders"),
            (Post, "/orders/_search"),
            (Post, "/_search?size=0"),
            (Post, "/orders,logs-*/_count"),
            (Post, "/_msearch"),
            (Post, "/_mget"),
            (Post, "/orders/_explain/42"),
            (Post, "/_search/template"),
            (Post, "/_search/scroll"),
            (Post, "/orders/_search/point_in_time?keep_alive=1m"),
            (Post, "/orders/_pit?keep_alive=1m"),
            (Post, "/_query"),
            (Post, "/_query/async"),
            (Post, "/_sql?format=txt"),
            (Post, "/_sql/translate"),
            (Post, "/orders/_field_caps?fields=*"),
            (Post, "/orders/_validate/query"),
            (Post, "/_analyze"),
            (Post, "/orders/_eql/search"),
            (Delete, "/_pit"),
            (Delete, "/_search/scroll"),
            (Delete, "/_search/point_in_time"),
        ] {
            assert!(is_read(&req(method, path)), "{method:?} {path}");
        }
        for (method, path) in [
            (Put, "/orders"),
            (Put, "/orders/_doc/1"),
            (Post, "/orders/_doc"),
            (Post, "/orders/_doc/_search"),
            (Post, "/orders"),
            (Post, "/_bulk"),
            (Post, "/orders/_update/1"),
            (Post, "/orders/_delete_by_query"),
            (Post, "/orders/_update_by_query"),
            (Post, "/_reindex"),
            (Post, "/orders/_close"),
            (Post, "/orders/_mapping"),
            (Post, "/_tasks/_cancel"),
            (Post, "/orders/_search/other"),
            (Get, "/orders/_flush"),
            (Get, "/_refresh"),
            (Delete, "/orders"),
            (Delete, "/orders/_doc/1"),
            (Delete, "/_search"),
            (Delete, "/_data_stream/logs"),
            (Patch, "/orders"),
        ] {
            assert!(!is_read(&req(method, path)), "{method:?} {path}");
        }
    }

    #[test]
    fn dangers_are_found_by_endpoint() {
        use HttpMethod::*;
        let kind = |method, path| danger_of(&req(method, path)).map(|d| (d.kind, d.target));
        assert_eq!(
            kind(Delete, "/logs-*"),
            Some((SearchDangerKind::DeleteIndex, "logs-*".into()))
        );
        assert_eq!(
            kind(Delete, "/_data_stream/logs"),
            Some((SearchDangerKind::DeleteDataStream, "logs".into()))
        );
        assert_eq!(
            kind(Post, "/a,b/_delete_by_query?conflicts=proceed"),
            Some((SearchDangerKind::DeleteByQuery, "a,b".into()))
        );
        assert_eq!(
            kind(Post, "/orders/_update_by_query"),
            Some((SearchDangerKind::UpdateByQuery, "orders".into()))
        );
        assert_eq!(
            kind(Post, "/orders/_close"),
            Some((SearchDangerKind::CloseIndex, "orders".into()))
        );
        assert_eq!(kind(Delete, "/orders/_doc/1"), None);
        assert_eq!(kind(Post, "/orders/_search"), None);
        assert_eq!(kind(Delete, "/_pit"), None);
        let mut reindex = req(Post, "/_reindex");
        reindex.body = Some(super::super::request::RequestBody {
            text: r#"{"source":{"index":"a"},"dest":{"index":"b"}}"#.into(),
            ndjson: false,
        });
        assert_eq!(
            danger_of(&reindex).map(|d| (d.kind, d.target)),
            Some((SearchDangerKind::Reindex, "b".into()))
        );
    }
}
