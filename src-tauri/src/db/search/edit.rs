//! Document edits of the search family (M4-8): one document per request, never a bulk.
//!
//! An edit replaces, creates or deletes one document. A replace or a delete carries the
//! `_seq_no` / `_primary_term` of the version the user saw and sends them as `if_seq_no` /
//! `if_primary_term`: the server refuses (409) when the document changed since. A create sends
//! `op_type=create`: an existing `_id` is a conflict, never an overwrite. Bodies are built from
//! the parsed document ([`ExactJson`], numbers kept digit for digit), never spliced (rule 2).
//!
//! Elasticsearch has no transaction across documents, so a change set is applied one request
//! at a time, each checked, stopping at the first failure (decision 3 of `NOSQL.md`). Its
//! inverse (the journal's revert) is another change set of the same kind.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::exact::ExactJson;
use super::request::{HttpMethod, RequestBody, SearchRequest, strict};
use crate::db::document::json::Json;
use crate::db::errors::{ErrorAction, ErrorCode, YadbeError};

/// The version of a document an edit was made on (`_seq_no`, `_primary_term`), as decimal
/// text (64-bit integers cross the IPC as strings, rule 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeqGuard {
    pub seq_no: String,
    pub primary_term: String,
}

impl SeqGuard {
    /// Both numbers, checked to be non-negative integers.
    pub fn numbers(&self) -> Result<(u64, u64), YadbeError> {
        let parse = |text: &str| text.trim().parse::<u64>().ok();
        parse(&self.seq_no)
            .zip(parse(&self.primary_term))
            .ok_or_else(|| {
                YadbeError::invalid_argument(
                    "The document's version (sequence number, primary term) is not valid.",
                    "La version du document (numéro de séquence, terme primaire) n'est pas valide.",
                )
            })
    }

    /// `_seq_no` and `_primary_term` of an answer (a get, a write).
    pub fn of_answer(answer: &ExactJson) -> Option<SeqGuard> {
        Some(SeqGuard {
            seq_no: answer.get("_seq_no")?.scalar_text()?.to_owned(),
            primary_term: answer.get("_primary_term")?.scalar_text()?.to_owned(),
        })
    }
}

/// One document change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchEdit {
    /// Writes `source` as the whole `_source` of the document (the index API), if it is
    /// still at `guard`.
    Replace {
        /// The concrete index holding the document (a hit's `_index`).
        index: String,
        id: String,
        routing: Option<String>,
        guard: SeqGuard,
        /// The new `_source`: a JSON object, as text.
        source: String,
    },
    /// Creates a document; refused when its `_id` exists. `id` null: the server picks one.
    Create {
        /// An index, an alias with a write index or a data stream.
        index: String,
        id: Option<String>,
        routing: Option<String>,
        source: String,
    },
    /// Deletes the document, if it is still at `guard`.
    Delete {
        index: String,
        id: String,
        routing: Option<String>,
        guard: SeqGuard,
    },
}

impl SearchEdit {
    pub fn index(&self) -> &str {
        match self {
            SearchEdit::Replace { index, .. }
            | SearchEdit::Create { index, .. }
            | SearchEdit::Delete { index, .. } => index,
        }
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            SearchEdit::Replace { id, .. } | SearchEdit::Delete { id, .. } => Some(id),
            SearchEdit::Create { id, .. } => id.as_deref(),
        }
    }

    pub fn routing(&self) -> Option<&str> {
        match self {
            SearchEdit::Replace { routing, .. }
            | SearchEdit::Create { routing, .. }
            | SearchEdit::Delete { routing, .. } => routing.as_deref(),
        }
    }

    fn source(&self) -> Option<&str> {
        match self {
            SearchEdit::Replace { source, .. } | SearchEdit::Create { source, .. } => Some(source),
            SearchEdit::Delete { .. } => None,
        }
    }
}

/// Documents to change, applied one by one in this order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchChangeSet {
    /// What the index tab shows (an index, an alias, a data stream, a pattern): the journal
    /// entry's name.
    pub target: String,
    pub edits: Vec<SearchEdit>,
}

/// A `_source` as yadbe sends it: a JSON object, parsed exactly.
pub fn parse_source(text: &str) -> Result<ExactJson, YadbeError> {
    let json = ExactJson::parse(text).map_err(super::exact::ExactJsonError::into_error)?;
    if !json.is_object() {
        return Err(YadbeError::invalid_argument(
            "A document is a JSON object ({ … }).",
            "Un document est un objet JSON ({ … }).",
        ));
    }
    Ok(json)
}

/// One write, ready to send, and its body for the preview.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub request: SearchRequest,
    pub body: Option<ExactJson>,
}

impl Planned {
    /// The request as the console writes it, the body indented.
    pub fn preview(&self) -> String {
        match &self.body {
            Some(body) => format!("{}\n{}", self.request.line(), body.to_pretty()),
            None => self.request.line(),
        }
    }
}

/// The query string of a write: its parameters in a fixed order, values encoded.
fn query(params: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter_map(|(key, value)| value.as_ref().map(|v| format!("{key}={}", strict(v))))
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// The request that makes `edit`. `wait_for`: the request returns once a refresh made the
/// change visible to searches (`refresh=wait_for`), without forcing one.
pub fn plan(edit: &SearchEdit, wait_for: bool) -> Result<Planned, YadbeError> {
    let refresh = wait_for.then(|| "wait_for".to_owned());
    let routing = edit.routing().map(str::to_owned);
    let body = edit.source().map(parse_source).transpose()?;
    let index = strict(edit.index());
    let (method, path) = match edit {
        SearchEdit::Replace { id, guard, .. } | SearchEdit::Delete { id, guard, .. } => {
            let (seq_no, term) = guard.numbers()?;
            let method = if matches!(edit, SearchEdit::Delete { .. }) {
                HttpMethod::Delete
            } else {
                HttpMethod::Put
            };
            let params = query(&[
                ("if_seq_no", Some(seq_no.to_string())),
                ("if_primary_term", Some(term.to_string())),
                ("routing", routing),
                ("refresh", refresh),
            ]);
            (method, format!("/{index}/_doc/{}{params}", strict(id)))
        }
        SearchEdit::Create { id, .. } => {
            let params = query(&[
                ("op_type", Some("create".to_owned())),
                ("routing", routing),
                ("refresh", refresh),
            ]);
            match id.as_deref().filter(|id| !id.is_empty()) {
                Some(id) => (
                    HttpMethod::Put,
                    format!("/{index}/_doc/{}{params}", strict(id)),
                ),
                None => (HttpMethod::Post, format!("/{index}/_doc{params}")),
            }
        }
    };
    let mut request = SearchRequest::new(method, path);
    request.body = body.as_ref().map(|json| RequestBody {
        text: json.to_text(),
        ndjson: false,
    });
    Ok(Planned { request, body })
}

/// The read of one document (real time: it sees a write before any refresh).
pub fn get_request(index: &str, id: &str, routing: Option<&str>) -> SearchRequest {
    SearchRequest::new(
        HttpMethod::Get,
        format!(
            "/{}/_doc/{}{}",
            strict(index),
            strict(id),
            query(&[("routing", routing.map(str::to_owned))])
        ),
    )
}

/// How an index takes writes, as yadbe's edits need to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexWriteState {
    pub index: String,
    /// The data stream it backs: append-only, its documents are not edited here.
    pub data_stream: Option<String>,
    pub closed: bool,
    /// The block setting that refuses writes (`index.blocks.write`, `index.blocks.read_only`,
    /// `index.blocks.read_only_allow_delete`).
    pub write_block: Option<String>,
    /// `index.refresh_interval` is `-1`: a write is visible to searches only after a refresh
    /// someone asks for, so yadbe does not wait for one.
    pub refresh_disabled: bool,
}

impl SearchIndexWriteState {
    fn named(index: &str) -> Self {
        Self {
            index: index.to_owned(),
            data_stream: None,
            closed: false,
            write_block: None,
            refresh_disabled: false,
        }
    }
}

/// What the edits of an index tab can do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchEditInfo {
    /// The connection is read-only: nothing can be changed.
    pub read_only: bool,
    /// The concrete indices the tab's target resolves to.
    pub indices: Vec<SearchIndexWriteState>,
    /// Data streams among them: documents can be added there (appended), not changed.
    pub data_streams: Vec<String>,
    /// Where "Add a document" can write: the target itself when it names one index, alias or
    /// data stream, else each writable index and data stream it resolves to.
    pub create_targets: Vec<String>,
}

/// Why a document cannot be changed here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchEditBlock {
    ReadOnlyConnection,
    /// A backing index of a data stream: append-only.
    DataStream {
        name: String,
    },
    Closed {
        index: String,
    },
    WriteBlock {
        index: String,
        setting: String,
    },
    /// The document has no `_source` (disabled in the mapping): there is nothing to edit nor
    /// to restore.
    NoSource,
    /// The index does not exist (any more).
    UnknownIndex {
        index: String,
    },
}

impl SearchEditBlock {
    pub fn into_error(self) -> YadbeError {
        let (en, fr) = match &self {
            SearchEditBlock::ReadOnlyConnection => {
                return YadbeError::new(
                    ErrorCode::ReadOnlyViolation,
                    "This connection is read-only: documents cannot be changed. Nothing was sent.",
                    "Cette connexion est en lecture seule : les documents ne peuvent pas être modifiés. Rien n'a été envoyé.",
                )
                .with_action(ErrorAction::EditConnection);
            }
            SearchEditBlock::DataStream { name } => (
                format!(
                    "This document belongs to the data stream {name}: a data stream is append-only, its documents are not changed here (use the console)."
                ),
                format!(
                    "Ce document appartient au flux de données {name} : un flux de données n'accepte que des ajouts, ses documents ne sont pas modifiés ici (utilisez la console)."
                ),
            ),
            SearchEditBlock::Closed { index } => (
                format!("The index {index} is closed: it can be neither read nor written."),
                format!("L'index {index} est fermé : il ne peut être ni lu ni écrit."),
            ),
            SearchEditBlock::WriteBlock { index, setting } => (
                format!("The index {index} refuses writes ({setting} is set)."),
                format!("L'index {index} refuse les écritures ({setting} est activé)."),
            ),
            SearchEditBlock::NoSource => (
                "This document has no _source (disabled in the mapping): it cannot be edited or restored.".to_owned(),
                "Ce document n'a pas de _source (désactivé dans le mapping) : il ne peut être ni modifié ni restauré.".to_owned(),
            ),
            SearchEditBlock::UnknownIndex { index } => (
                format!("The index {index} does not exist."),
                format!("L'index {index} n'existe pas."),
            ),
        };
        YadbeError::invalid_argument(
            format!("{en} Nothing was sent."),
            format!("{fr} Rien n'a été envoyé."),
        )
    }
}

/// The write states and data streams of a `_resolve/index` answer, completed by a
/// `_settings` answer (blocks, refresh interval).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    pub indices: HashMap<String, SearchIndexWriteState>,
    /// Data stream → its backing indices.
    pub data_streams: HashMap<String, Vec<String>>,
    /// Alias → its indices.
    pub aliases: HashMap<String, Vec<String>>,
    /// The concrete indices in the order the server listed them.
    pub order: Vec<String>,
}

fn strings(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// Reads `GET /_resolve/index/<names>`.
pub fn parse_resolve(answer: &Json) -> Resolved {
    let mut resolved = Resolved::default();
    for index in answer
        .get("indices")
        .and_then(Json::as_array)
        .unwrap_or(&[])
    {
        let Some(name) = index.get("name").and_then(Json::as_str) else {
            continue;
        };
        let attributes = strings(index.get("attributes"));
        let mut state = SearchIndexWriteState::named(name);
        state.closed = attributes.iter().any(|a| a == "closed");
        state.data_stream = index
            .get("data_stream")
            .and_then(Json::as_str)
            .map(str::to_owned);
        resolved.order.push(name.to_owned());
        resolved.indices.insert(name.to_owned(), state);
    }
    for stream in answer
        .get("data_streams")
        .and_then(Json::as_array)
        .unwrap_or(&[])
    {
        if let Some(name) = stream.get("name").and_then(Json::as_str) {
            let backing = strings(stream.get("backing_indices"));
            for index in &backing {
                if let Some(state) = resolved.indices.get_mut(index) {
                    state.data_stream = Some(name.to_owned());
                }
            }
            resolved.data_streams.insert(name.to_owned(), backing);
        }
    }
    for alias in answer
        .get("aliases")
        .and_then(Json::as_array)
        .unwrap_or(&[])
    {
        if let Some(name) = alias.get("name").and_then(Json::as_str) {
            resolved
                .aliases
                .insert(name.to_owned(), strings(alias.get("indices")));
        }
    }
    // A data stream or an alias named directly resolves to itself, not to its indices: they
    // are known from it (open; the settings read fills in their blocks).
    let behind: Vec<(String, Option<String>)> = resolved
        .data_streams
        .iter()
        .flat_map(|(stream, backing)| {
            backing
                .iter()
                .map(move |i| (i.clone(), Some(stream.clone())))
        })
        .chain(
            resolved
                .aliases
                .values()
                .flat_map(|indices| indices.iter().map(|i| (i.clone(), None))),
        )
        .collect();
    for (index, stream) in behind {
        if !resolved.indices.contains_key(&index) {
            let mut state = SearchIndexWriteState::named(&index);
            state.data_stream = stream;
            resolved.order.push(index.clone());
            resolved.indices.insert(index, state);
        }
    }
    resolved
}

/// The write blocks that refuse a change, in the order they are named.
const BLOCKS: [&str; 3] = [
    "index.blocks.read_only",
    "index.blocks.write",
    "index.blocks.read_only_allow_delete",
];

fn setting_text<'a>(settings: &'a Json, key: &str) -> Option<&'a str> {
    settings.get(key).and_then(Json::as_str).or_else(|| {
        // Without `flat_settings`, `{"index": {"blocks": {"write": "true"}}}`.
        let mut current = settings;
        for part in key.split('.') {
            current = current.get(part)?;
        }
        current.as_str()
    })
}

/// Completes `resolved` with a `GET /<indices>/_settings?flat_settings=true` answer.
pub fn apply_settings(resolved: &mut Resolved, answer: &Json) {
    for (index, entry) in answer.as_object().unwrap_or(&[]) {
        let Some(state) = resolved.indices.get_mut(index) else {
            continue;
        };
        let Some(settings) = entry.get("settings") else {
            continue;
        };
        state.write_block = BLOCKS
            .iter()
            .find(|key| setting_text(settings, key) == Some("true"))
            .map(|key| (*key).to_owned());
        state.refresh_disabled = setting_text(settings, "index.refresh_interval") == Some("-1");
    }
}

impl Resolved {
    /// Why `edit` cannot be made, if it cannot (`read_only`: the connection's).
    pub fn block_of(&self, edit: &SearchEdit, read_only: bool) -> Option<SearchEditBlock> {
        if read_only {
            return Some(SearchEditBlock::ReadOnlyConnection);
        }
        let name = edit.index();
        if let SearchEdit::Create { .. } = edit {
            // A data stream or an alias takes a create; the server picks the index.
            if self.data_streams.contains_key(name) || self.aliases.contains_key(name) {
                return None;
            }
        }
        let Some(state) = self.indices.get(name) else {
            return Some(SearchEditBlock::UnknownIndex {
                index: name.to_owned(),
            });
        };
        if let (Some(stream), false) = (
            &state.data_stream,
            matches!(edit, SearchEdit::Create { .. }),
        ) {
            return Some(SearchEditBlock::DataStream {
                name: stream.clone(),
            });
        }
        if state.closed {
            return Some(SearchEditBlock::Closed {
                index: name.to_owned(),
            });
        }
        match state.write_block.as_deref() {
            // That block still lets documents be deleted (it frees disk space).
            Some("index.blocks.read_only_allow_delete")
                if matches!(edit, SearchEdit::Delete { .. }) =>
            {
                None
            }
            Some(setting) => Some(SearchEditBlock::WriteBlock {
                index: name.to_owned(),
                setting: setting.to_owned(),
            }),
            None => None,
        }
    }

    /// Whether yadbe waits for the write to be searchable: not where the refresh is off.
    pub fn wait_for(&self, edit: &SearchEdit) -> bool {
        let name = edit.index();
        let backing = self
            .data_streams
            .get(name)
            .or_else(|| self.aliases.get(name))
            .cloned()
            .unwrap_or_else(|| vec![name.to_owned()]);
        !backing
            .iter()
            .any(|index| self.indices.get(index).is_some_and(|s| s.refresh_disabled))
    }

    /// The tab's edit info for `target`.
    pub fn info(&self, target: &str, read_only: bool) -> SearchEditInfo {
        let indices: Vec<SearchIndexWriteState> = self
            .order
            .iter()
            .filter_map(|name| self.indices.get(name).cloned())
            .collect();
        let mut data_streams: Vec<String> = self.data_streams.keys().cloned().collect();
        data_streams.sort();
        let names_one = self.indices.contains_key(target)
            || self.aliases.contains_key(target)
            || self.data_streams.contains_key(target);
        let create_targets = if read_only {
            Vec::new()
        } else if names_one && !target.contains(['*', ',']) {
            let usable = self
                .indices
                .get(target)
                .is_none_or(|s| s.data_stream.is_none() && !s.closed && s.write_block.is_none());
            if usable {
                vec![target.to_owned()]
            } else {
                Vec::new()
            }
        } else {
            let mut targets = data_streams.clone();
            targets.extend(
                indices
                    .iter()
                    .filter(|s| s.data_stream.is_none() && !s.closed && s.write_block.is_none())
                    .map(|s| s.index.clone()),
            );
            targets
        };
        SearchEditInfo {
            read_only,
            indices,
            data_streams,
            create_targets,
        }
    }
}

/// Changes of a change set by kind: (updated, inserted, deleted).
pub fn counts(edits: &[SearchEdit]) -> (u32, u32, u32) {
    let mut counts = (0, 0, 0);
    for edit in edits {
        match edit {
            SearchEdit::Replace { .. } => counts.0 += 1,
            SearchEdit::Create { .. } => counts.1 += 1,
            SearchEdit::Delete { .. } => counts.2 += 1,
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(seq: &str, term: &str) -> SeqGuard {
        SeqGuard {
            seq_no: seq.into(),
            primary_term: term.into(),
        }
    }

    #[test]
    fn writes_are_guarded_and_bodies_exact() {
        let replace = SearchEdit::Replace {
            index: "orders".into(),
            id: "a/b c+1".into(),
            routing: Some("eu&1".into()),
            guard: guard("41", "2"),
            source: "{\n \"big\": 123456789012345678901234567890, \"d\": 0.30000000000000000001 }"
                .into(),
        };
        let planned = plan(&replace, true).expect("planned");
        assert_eq!(
            planned.request.line(),
            "PUT /orders/_doc/a%2Fb%20c%2B1?if_seq_no=41&if_primary_term=2&routing=eu%261&refresh=wait_for"
        );
        assert_eq!(
            planned.request.body.as_ref().map(|b| b.text.as_str()),
            Some(r#"{"big":123456789012345678901234567890,"d":0.30000000000000000001}"#)
        );
        assert!(planned.preview().starts_with("PUT /orders/_doc/"));
        assert!(
            planned
                .preview()
                .contains("\n  \"big\": 123456789012345678901234567890,")
        );

        let delete = SearchEdit::Delete {
            index: "orders".into(),
            id: "1".into(),
            routing: None,
            guard: guard("7", "1"),
        };
        let planned = plan(&delete, false).expect("planned");
        assert_eq!(
            planned.request.line(),
            "DELETE /orders/_doc/1?if_seq_no=7&if_primary_term=1"
        );
        assert!(planned.request.body.is_none());

        let create = |id: Option<&str>| SearchEdit::Create {
            index: "logs-web".into(),
            id: id.map(str::to_owned),
            routing: None,
            source: "{}".into(),
        };
        assert_eq!(
            plan(&create(Some("x")), true).expect("p").request.line(),
            "PUT /logs-web/_doc/x?op_type=create&refresh=wait_for"
        );
        assert_eq!(
            plan(&create(None), true).expect("p").request.line(),
            "POST /logs-web/_doc?op_type=create&refresh=wait_for"
        );
        assert_eq!(
            plan(&create(Some("")), false).expect("p").request.line(),
            "POST /logs-web/_doc?op_type=create"
        );
    }

    #[test]
    fn invalid_documents_and_versions_are_refused() {
        let replace = |source: &str, seq: &str| SearchEdit::Replace {
            index: "o".into(),
            id: "1".into(),
            routing: None,
            guard: guard(seq, "1"),
            source: source.into(),
        };
        assert!(plan(&replace("[1]", "1"), true).is_err());
        assert!(plan(&replace("{\"a\":}", "1"), true).is_err());
        assert!(plan(&replace("{}", "-1"), true).is_err());
        assert!(plan(&replace("{}", "1&x=2"), true).is_err());
    }

    #[test]
    fn data_streams_closed_and_blocked_indices_refuse_edits() {
        let resolve = Json::parse(
            r#"{"indices":[
                {"name":"orders","aliases":["cur"],"attributes":["open"]},
                {"name":"old","attributes":["closed"]},
                {"name":"frozen","attributes":["open"]},
                {"name":"full","attributes":["open"]},
                {"name":".ds-logs-1","attributes":["hidden","open"],"data_stream":"logs"}],
              "aliases":[{"name":"cur","indices":["orders"]}],
              "data_streams":[{"name":"logs","backing_indices":[".ds-logs-1"],"timestamp_field":"@timestamp"}]}"#,
        )
        .expect("json");
        let mut resolved = parse_resolve(&resolve);
        apply_settings(
            &mut resolved,
            &Json::parse(
                r#"{"frozen":{"settings":{"index.blocks.write":"true"}},
                    "full":{"settings":{"index.blocks.read_only_allow_delete":"true"}},
                    "orders":{"settings":{"index.refresh_interval":"-1"}}}"#,
            )
            .expect("json"),
        );
        let delete = |index: &str| SearchEdit::Delete {
            index: index.into(),
            id: "1".into(),
            routing: None,
            guard: guard("1", "1"),
        };
        let create = |index: &str| SearchEdit::Create {
            index: index.into(),
            id: None,
            routing: None,
            source: "{}".into(),
        };
        assert_eq!(resolved.block_of(&delete("orders"), false), None);
        assert_eq!(
            resolved.block_of(&delete("orders"), true),
            Some(SearchEditBlock::ReadOnlyConnection)
        );
        assert_eq!(
            resolved.block_of(&delete(".ds-logs-1"), false),
            Some(SearchEditBlock::DataStream {
                name: "logs".into()
            })
        );
        assert_eq!(resolved.block_of(&create("logs"), false), None);
        assert_eq!(resolved.block_of(&create("cur"), false), None);
        assert!(matches!(
            resolved.block_of(&delete("old"), false),
            Some(SearchEditBlock::Closed { .. })
        ));
        assert!(matches!(
            resolved.block_of(&create("frozen"), false),
            Some(SearchEditBlock::WriteBlock { .. })
        ));
        assert_eq!(resolved.block_of(&delete("full"), false), None);
        assert!(resolved.block_of(&create("full"), false).is_some());
        assert!(matches!(
            resolved.block_of(&delete("nope"), false),
            Some(SearchEditBlock::UnknownIndex { .. })
        ));
        assert!(!resolved.wait_for(&delete("orders")));
        assert!(!resolved.wait_for(&create("cur")));
        assert!(resolved.wait_for(&create("logs")));

        let info = resolved.info("*", false);
        assert_eq!(info.data_streams, ["logs"]);
        assert_eq!(info.create_targets, ["logs", "orders"]);
        assert_eq!(resolved.info("cur", false).create_targets, ["cur"]);
        assert!(resolved.info("frozen", false).create_targets.is_empty());
        assert!(resolved.info("orders", true).create_targets.is_empty());
    }
}
