//! What the explorer of a search connection shows, read from the server's own APIs: indices
//! (`_cat/indices`), data streams, aliases, index templates, and per index its mapping
//! flattened to field paths and a summary of its settings.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::json::Json;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexHealth {
    Green,
    Yellow,
    Red,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexInfo {
    pub name: String,
    pub health: IndexHealth,
    /// `open` or `close`.
    pub open: bool,
    /// Documents of the primary shards (`null` for a closed index).
    pub docs: Option<f64>,
    /// Store size of all shards, in bytes.
    pub size_bytes: Option<f64>,
    pub primaries: Option<u32>,
    pub replicas: Option<u32>,
    /// A dot index (`.kibana`, `.ds-…` backing indices, `.security`): hidden or system.
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchDataStream {
    pub name: String,
    pub health: IndexHealth,
    /// Backing indices, oldest first.
    pub indices: Vec<String>,
    pub template: Option<String>,
    pub timestamp_field: Option<String>,
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchAlias {
    pub name: String,
    pub indices: Vec<String>,
    /// The index writes go to, when one is marked.
    pub write_index: Option<String>,
    /// At least one of its indices sees it through a filter.
    pub filtered: bool,
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchTemplate {
    pub name: String,
    pub patterns: Vec<String>,
    pub priority: Option<f64>,
    /// It creates data streams.
    pub data_stream: bool,
    /// Managed by the server or a product (`.`-prefixed or `_meta.managed`).
    pub system: bool,
}

/// A field of a mapping, by its full path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchField {
    /// `customer.name`, `title.keyword` (a multi-field).
    pub path: String,
    /// The mapping type (`keyword`, `long`, `date`, `object`, `nested`…).
    pub type_name: String,
    /// A search can sort on it (doc values: keywords, numbers, dates, booleans, IPs…).
    pub sortable: bool,
    /// A sub-field of another (`title.keyword`), not in `_source` by itself.
    pub multi_field: bool,
}

/// The settings shown under an index, as the server wrote them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchSetting {
    pub key: String,
    pub value: String,
}

/// An index (or a data stream, an alias: the union of their indices) as its explorer node
/// and its tab show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexDetails {
    pub fields: Vec<SearchField>,
    pub settings: Vec<SearchSetting>,
    /// `index.max_result_window` (10 000 unless set): the deepest `from` + `size`.
    pub max_result_window: u32,
}

fn health_of(text: Option<&str>) -> IndexHealth {
    match text {
        Some("green" | "GREEN") => IndexHealth::Green,
        Some("yellow" | "YELLOW") => IndexHealth::Yellow,
        Some("red" | "RED") => IndexHealth::Red,
        _ => IndexHealth::Unknown,
    }
}

/// A number the cat APIs write as text (`"1234"`), or as a JSON number.
pub fn number_of(value: Option<&Json>) -> Option<f64> {
    match value? {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn texts(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// `GET /_cat/indices?format=json&bytes=b&expand_wildcards=all&h=…`.
pub fn parse_indices(cat: &Json) -> Vec<SearchIndexInfo> {
    let mut indices: Vec<SearchIndexInfo> = cat
        .as_array()
        .unwrap_or(&[])
        .iter()
        .filter_map(|row| {
            let name = row.get("index")?.as_str()?.to_owned();
            Some(SearchIndexInfo {
                health: health_of(row.get("health").and_then(Json::as_str)),
                open: row.get("status").and_then(Json::as_str) != Some("close"),
                docs: number_of(row.get("docs.count")),
                size_bytes: number_of(row.get("store.size")),
                primaries: number_of(row.get("pri")).map(|n| n as u32),
                replicas: number_of(row.get("rep")).map(|n| n as u32),
                system: name.starts_with('.'),
                name,
            })
        })
        .collect();
    indices.sort_by(|a, b| a.name.cmp(&b.name));
    indices
}

/// `GET /_data_stream?expand_wildcards=all`.
pub fn parse_data_streams(reply: &Json) -> Vec<SearchDataStream> {
    let mut streams: Vec<SearchDataStream> = reply
        .get("data_streams")
        .and_then(Json::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|stream| {
            let name = stream.get("name")?.as_str()?.to_owned();
            let flag = |key: &str| matches!(stream.get(key), Some(Json::Bool(true)));
            Some(SearchDataStream {
                health: health_of(stream.get("status").and_then(Json::as_str)),
                indices: stream
                    .get("indices")
                    .and_then(Json::as_array)
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|i| i.get("index_name")?.as_str().map(str::to_owned))
                    .collect(),
                template: stream
                    .get("template")
                    .and_then(Json::as_str)
                    .map(str::to_owned),
                timestamp_field: stream
                    .get("timestamp_field")
                    .and_then(|t| t.get("name"))
                    .and_then(Json::as_str)
                    .map(str::to_owned),
                system: flag("hidden") || flag("system") || name.starts_with('.'),
                name,
            })
        })
        .collect();
    streams.sort_by(|a, b| a.name.cmp(&b.name));
    streams
}

/// `GET /_alias?expand_wildcards=all`: `{index: {aliases: {name: {is_write_index, filter}}}}`.
pub fn parse_aliases(reply: &Json) -> Vec<SearchAlias> {
    let mut by_name: BTreeMap<String, SearchAlias> = BTreeMap::new();
    for (index, body) in reply.as_object().unwrap_or(&[]) {
        for (alias, spec) in body.get("aliases").and_then(Json::as_object).unwrap_or(&[]) {
            let entry = by_name.entry(alias.clone()).or_insert_with(|| SearchAlias {
                name: alias.clone(),
                indices: Vec::new(),
                write_index: None,
                filtered: false,
                system: alias.starts_with('.'),
            });
            entry.indices.push(index.clone());
            if matches!(spec.get("is_write_index"), Some(Json::Bool(true))) {
                entry.write_index = Some(index.clone());
            }
            entry.filtered |= spec.get("filter").is_some();
            if matches!(spec.get("is_hidden"), Some(Json::Bool(true))) {
                entry.system = true;
            }
        }
    }
    by_name
        .into_values()
        .map(|mut alias| {
            alias.indices.sort();
            alias
        })
        .collect()
}

/// `GET /_index_template`.
pub fn parse_templates(reply: &Json) -> Vec<SearchTemplate> {
    let mut templates: Vec<SearchTemplate> = reply
        .get("index_templates")
        .and_then(Json::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.to_owned();
            let template = entry.get("index_template");
            let managed = template
                .and_then(|t| t.get("_meta"))
                .and_then(|m| m.get("managed"))
                .is_some_and(|m| matches!(m, Json::Bool(true)));
            Some(SearchTemplate {
                patterns: texts(template.and_then(|t| t.get("index_patterns"))),
                priority: number_of(template.and_then(|t| t.get("priority"))),
                data_stream: template.and_then(|t| t.get("data_stream")).is_some(),
                system: managed || name.starts_with('.'),
                name,
            })
        })
        .collect();
    templates.sort_by(|a, b| a.name.cmp(&b.name));
    templates
}

/// Types whose values have doc values by default: what a search can sort on.
fn sortable_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "keyword"
            | "constant_keyword"
            | "wildcard"
            | "long"
            | "integer"
            | "short"
            | "byte"
            | "double"
            | "float"
            | "half_float"
            | "scaled_float"
            | "unsigned_long"
            | "date"
            | "date_nanos"
            | "boolean"
            | "ip"
            | "version"
    )
}

fn walk_properties(prefix: &str, properties: &Json, out: &mut BTreeMap<String, SearchField>) {
    for (name, spec) in properties.as_object().unwrap_or(&[]) {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        let children = spec.get("properties");
        let type_name = spec.get("type").and_then(Json::as_str).map_or_else(
            || {
                if children.is_some() {
                    "object".to_owned()
                } else {
                    String::new()
                }
            },
            str::to_owned,
        );
        let doc_values_off = matches!(spec.get("doc_values"), Some(Json::Bool(false)));
        out.entry(path.clone()).or_insert_with(|| SearchField {
            path: path.clone(),
            sortable: sortable_type(&type_name) && !doc_values_off,
            type_name,
            multi_field: false,
        });
        if let Some(children) = children {
            walk_properties(&path, children, out);
        }
        for (sub, sub_spec) in spec.get("fields").and_then(Json::as_object).unwrap_or(&[]) {
            let sub_path = format!("{path}.{sub}");
            let sub_type = sub_spec
                .get("type")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned();
            out.entry(sub_path.clone()).or_insert_with(|| SearchField {
                path: sub_path,
                sortable: sortable_type(&sub_type),
                type_name: sub_type,
                multi_field: true,
            });
        }
    }
}

/// `GET /<target>/_mapping`: the fields of every index it resolves to, by path (the first
/// mapping seen wins when two indices disagree).
pub fn parse_mapping(reply: &Json) -> Vec<SearchField> {
    let mut fields = BTreeMap::new();
    for (_, index) in reply.as_object().unwrap_or(&[]) {
        if let Some(properties) = index.get("mappings").and_then(|m| m.get("properties")) {
            walk_properties("", properties, &mut fields);
        }
    }
    fields.into_values().collect()
}

/// The settings worth a line under an index, from `GET /<index>/_settings?flat_settings=true`
/// (its first index), and its result window.
pub fn parse_settings(reply: &Json) -> (Vec<SearchSetting>, u32) {
    let first = reply
        .as_object()
        .and_then(|indices| indices.first())
        .and_then(|(_, index)| index.get("settings"));
    let value = |key: &str| {
        first
            .and_then(|s| s.get(key))
            .map(|v| v.as_str().map_or_else(|| v.to_text(), str::to_owned))
    };
    let shown = [
        "index.number_of_shards",
        "index.number_of_replicas",
        "index.refresh_interval",
        "index.max_result_window",
        "index.hidden",
        "index.mode",
        "index.lifecycle.name",
        "index.creation_date",
        "index.uuid",
        "index.version.created",
    ];
    let settings = shown
        .iter()
        .filter_map(|key| {
            value(key).map(|v| SearchSetting {
                key: (*key).to_owned(),
                value: v,
            })
        })
        .collect();
    let window = value("index.max_result_window")
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    (settings, window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Json {
        Json::parse(text).expect("json")
    }

    #[test]
    fn mappings_flatten_with_multi_fields() {
        let fields = parse_mapping(&json(
            r#"{"orders":{"mappings":{"properties":{"title":{"type":"text","fields":{"keyword":{"type":"keyword"}}},"customer":{"properties":{"id":{"type":"long"},"tags":{"type":"keyword","doc_values":false}}},"lines":{"type":"nested","properties":{"sku":{"type":"keyword"}}}}}}}"#,
        ));
        let summary: Vec<(&str, &str, bool, bool)> = fields
            .iter()
            .map(|f| {
                (
                    f.path.as_str(),
                    f.type_name.as_str(),
                    f.sortable,
                    f.multi_field,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("customer", "object", false, false),
                ("customer.id", "long", true, false),
                ("customer.tags", "keyword", false, false),
                ("lines", "nested", false, false),
                ("lines.sku", "keyword", true, false),
                ("title", "text", false, false),
                ("title.keyword", "keyword", true, true),
            ]
        );
    }

    #[test]
    fn cat_rows_and_aliases() {
        let indices = parse_indices(&json(
            r#"[{"index":"orders","health":"yellow","status":"open","docs.count":"12","store.size":"2048","pri":"1","rep":"1"},{"index":".kibana_1","health":"green","status":"close","docs.count":null}]"#,
        ));
        assert_eq!(indices[0].name, ".kibana_1");
        assert!(indices[0].system && !indices[0].open);
        assert_eq!(indices[1].docs, Some(12.0));
        assert_eq!(indices[1].health, IndexHealth::Yellow);
        let aliases = parse_aliases(&json(
            r#"{"a1":{"aliases":{"current":{"is_write_index":true}}},"a2":{"aliases":{"current":{"filter":{"term":{"x":1}}}}},"b":{"aliases":{}}}"#,
        ));
        assert_eq!(aliases.len(), 1);
        assert_eq!(aliases[0].indices, ["a1", "a2"]);
        assert_eq!(aliases[0].write_index.as_deref(), Some("a1"));
        assert!(aliases[0].filtered);
        let (settings, window) = parse_settings(&json(
            r#"{"orders":{"settings":{"index.number_of_shards":"1","index.max_result_window":"500"}}}"#,
        ));
        assert_eq!(window, 500);
        assert_eq!(settings[0].value, "1");
    }
}
