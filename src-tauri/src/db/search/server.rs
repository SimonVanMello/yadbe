//! What a search server is, read from `GET /` at connect time: Elasticsearch or OpenSearch,
//! its version, and the features yadbe uses that depend on them. Services branch on these
//! features, never on the product.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::json::Json;
use crate::db::errors::YadbeError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchProduct {
    Elasticsearch,
    Opensearch,
}

/// How a point in time is opened and closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PitApi {
    /// `POST /<target>/_pit` → `{"id"}`; `DELETE /_pit` with `{"id"}`.
    Pit,
    /// `POST /<target>/_search/point_in_time` → `{"pit_id"}`; `DELETE /_search/point_in_time`
    /// with `{"pit_id": [...]}`.
    SearchPointInTime,
}

/// What the server can do that yadbe uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchFeatures {
    /// Point in time for consistent pages with `search_after`; `null`: pages use
    /// `from` / `size` (and stop at the result window).
    pub point_in_time: Option<PitApi>,
    /// A search on a point in time sorts by `_shard_doc` last by itself (a unique tiebreaker
    /// for `search_after`) and `_shard_doc` can be asked for.
    pub shard_doc_sort: bool,
    /// Data streams (`GET /_data_stream`).
    pub data_streams: bool,
    /// Composable index templates (`GET /_index_template`).
    pub index_templates: bool,
    /// ES|QL (`POST /_query`).
    pub esql: bool,
}

/// The server a search connection talks to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchServer {
    pub product: SearchProduct,
    /// `8.15.1`, `2.17.0`.
    pub version: String,
    pub cluster_name: Option<String>,
    pub features: SearchFeatures,
}

fn version_parts(version: &str) -> (u32, u32) {
    let mut parts = version
        .split(['.', '-'])
        .map(|p| p.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// Whether `(major, minor)` is at least `(at_major, at_minor)`.
fn at_least((major, minor): (u32, u32), at_major: u32, at_minor: u32) -> bool {
    major > at_major || (major == at_major && minor >= at_minor)
}

impl SearchServer {
    /// Reads the answer of `GET /`.
    pub fn detect(root: &Json) -> Result<SearchServer, YadbeError> {
        let version = root.get("version");
        let number = version
            .and_then(|v| v.get("number"))
            .and_then(Json::as_str)
            .ok_or_else(not_a_search_server)?
            .to_owned();
        let distribution = version
            .and_then(|v| v.get("distribution"))
            .and_then(Json::as_str)
            .unwrap_or_default();
        let product = if distribution.eq_ignore_ascii_case("opensearch") {
            SearchProduct::Opensearch
        } else if root.get("tagline").is_some() || root.get("cluster_name").is_some() {
            SearchProduct::Elasticsearch
        } else {
            return Err(not_a_search_server());
        };
        let parts = version_parts(&number);
        let features = match product {
            SearchProduct::Elasticsearch => SearchFeatures {
                point_in_time: at_least(parts, 7, 10).then_some(PitApi::Pit),
                shard_doc_sort: at_least(parts, 7, 12),
                data_streams: at_least(parts, 7, 9),
                index_templates: at_least(parts, 7, 8),
                esql: at_least(parts, 8, 11),
            },
            SearchProduct::Opensearch => SearchFeatures {
                point_in_time: at_least(parts, 2, 4).then_some(PitApi::SearchPointInTime),
                shard_doc_sort: false,
                data_streams: true,
                index_templates: true,
                esql: false,
            },
        };
        Ok(SearchServer {
            product,
            version: number,
            cluster_name: root
                .get("cluster_name")
                .and_then(Json::as_str)
                .map(str::to_owned),
            features,
        })
    }

    /// `Elasticsearch 9.1.0`, `OpenSearch 2.17.0`.
    pub fn label(&self) -> String {
        match self.product {
            SearchProduct::Elasticsearch => format!("Elasticsearch {}", self.version),
            SearchProduct::Opensearch => format!("OpenSearch {}", self.version),
        }
    }
}

fn not_a_search_server() -> YadbeError {
    YadbeError::new(
        crate::db::errors::ErrorCode::ConnectionLost,
        "The server at this URL is not Elasticsearch or OpenSearch: its root does not say a version.",
        "Le serveur de cette URL n'est ni Elasticsearch ni OpenSearch : sa racine n'indique pas de version.",
    )
    .with_action(crate::db::errors::ErrorAction::EditConnection)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<SearchServer, YadbeError> {
        SearchServer::detect(&Json::parse(text).expect("json"))
    }

    #[test]
    fn products_and_features_from_the_root() {
        let es = parse(
            r#"{"name":"n","cluster_name":"docker","version":{"number":"9.1.0","build_flavor":"default"},"tagline":"You Know, for Search"}"#,
        )
        .expect("es");
        assert_eq!(es.product, SearchProduct::Elasticsearch);
        assert_eq!(es.label(), "Elasticsearch 9.1.0");
        assert_eq!(es.features.point_in_time, Some(PitApi::Pit));
        assert!(es.features.esql && es.features.shard_doc_sort);
        let old = parse(r#"{"version":{"number":"7.9.3"},"tagline":"You Know, for Search"}"#)
            .expect("es 7");
        assert_eq!(old.features.point_in_time, None);
        assert!(old.features.data_streams && !old.features.esql);
        let os = parse(
            r#"{"cluster_name":"c","version":{"distribution":"opensearch","number":"2.17.1"},"tagline":"The OpenSearch Project: https://opensearch.org/"}"#,
        )
        .expect("os");
        assert_eq!(os.product, SearchProduct::Opensearch);
        assert_eq!(os.features.point_in_time, Some(PitApi::SearchPointInTime));
        let os1 =
            parse(r#"{"version":{"distribution":"opensearch","number":"1.3.19"}}"#).expect("os 1");
        assert_eq!(os1.features.point_in_time, None);
        assert!(parse(r#"{"hello":"world"}"#).is_err());
    }
}
