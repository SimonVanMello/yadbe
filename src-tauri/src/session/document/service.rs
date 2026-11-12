//! `DocumentService`: what the document family's commands do on an open session. The
//! explorer (databases, collections, indexes, sampled fields), the collection tab (pages,
//! counts) and the console (one JSON command). Every operation goes through the gate.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::Notify;

use crate::db::document::ejson::type_of;
use crate::db::document::json::Json;
use crate::db::document::meta::{
    CollectionKind, DEFAULT_SAMPLE_SIZE, DocCollection, DocDatabase, DocIndex, FieldSample,
    MAX_SAMPLE_SIZE, sample_fields,
};
use crate::db::document::ops::{DocEvent, DocOp, DocReply, FindOptions, Namespace};
use crate::db::driver::DocumentConnection;
use crate::db::errors::YadbeError;
use crate::session::ConnectionManager;
use crate::session::ConnectionSession;
use crate::session::document::gate::{
    self, GateContext, GateOutcome, GateRequest, Origin, reply_number,
};
use crate::session::document::model::{
    CollectionInfo, CollectionPage, CollectionQuery, CommandOutcome, DocumentResult,
};
use crate::session::document::results::{documents_window, store_documents};
use crate::session::history_hook::{HistoryEntry, HistoryRecorder};
use crate::session::result_store::ResultStore;

/// A console keeps at most this many documents of a cursor.
pub const CONSOLE_MAX_DOCUMENTS: u64 = 5_000;
pub const MAX_PAGE_SIZE: u32 = 1_000;
/// Read from a single window at most.
const MAX_DOCUMENTS_WINDOW: u32 = 500;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The operation a tab is running, for a cancel.
struct Running {
    token: String,
    conn: Arc<dyn DocumentConnection>,
    stop: Arc<Notify>,
}

/// How a collection tab pages: by `_id` (ascending or descending), or by skipping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Paging {
    Keyset { descending: bool },
    Skip,
}

#[derive(Default)]
struct PageState {
    /// The query the boundaries below belong to.
    query: Option<CollectionQuery>,
    paging: Option<Paging>,
    /// The `_id` each page starts after (`None` for the first page), as far as known.
    starts: Vec<Option<Json>>,
}

struct DocTab {
    connection_id: String,
    running: Mutex<Option<Running>>,
    /// Results the tab holds, freed when it reads again or closes.
    results: Mutex<Vec<u32>>,
    pages: Mutex<PageState>,
}

pub struct DocumentService {
    manager: Arc<ConnectionManager>,
    store: Arc<ResultStore>,
    history: Arc<dyn HistoryRecorder>,
    tabs: Mutex<HashMap<String, Arc<DocTab>>>,
}

/// A JSON text field of a form: empty is `default`.
fn parse_document(text: &str, what_en: &str, what_fr: &str) -> Result<Option<Json>, YadbeError> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let json = Json::parse(text).map_err(|err| {
        YadbeError::invalid_argument(
            format!("The {what_en} is not valid JSON."),
            format!("{what_fr} n'est pas du JSON valide."),
        )
        .with_detail(err.detail.unwrap_or_default())
    })?;
    if json.as_object().is_none() {
        return Err(YadbeError::invalid_argument(
            format!("The {what_en} must be a JSON object ({{ … }})."),
            format!("{what_fr} doit être un objet JSON ({{ … }})."),
        ));
    }
    Ok(Some(json))
}

fn int_of(json: Option<&Json>) -> Option<f64> {
    match json? {
        Json::Number(n) => n.as_f64(),
        wrapped => ["$numberInt", "$numberLong", "$numberDouble"]
            .iter()
            .find_map(|k| wrapped.get(k))
            .and_then(Json::as_str)
            .and_then(|t| t.parse().ok()),
    }
}

fn bool_of(json: Option<&Json>) -> bool {
    match json {
        Some(Json::Bool(b)) => *b,
        other => int_of(other).is_some_and(|n| n != 0.0),
    }
}

/// `{"_id": 1}` / `{"_id": -1}`: the only sorts `_id` pages can follow.
fn id_direction(sort: &Json) -> Option<bool> {
    match sort.as_object()? {
        [(key, value)] if key == "_id" => match int_of(Some(value))? {
            n if n > 0.0 => Some(false),
            n if n < 0.0 => Some(true),
            _ => None,
        },
        _ => None,
    }
}

fn excludes_id(projection: Option<&Json>) -> bool {
    projection
        .and_then(|p| p.get("_id"))
        .is_some_and(|v| matches!(v, Json::Bool(false)) || int_of(Some(v)) == Some(0.0))
}

impl DocumentService {
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
        }
    }

    fn session(&self, connection_id: &str) -> Result<Arc<ConnectionSession>, YadbeError> {
        self.manager.session(connection_id)
    }

    fn connection(session: &ConnectionSession) -> Result<Arc<dyn DocumentConnection>, YadbeError> {
        session.backend()?.into_document()
    }

    /// Runs an operation yadbe authors on the connection's main link and gathers what it
    /// returns.
    async fn own(
        &self,
        connection_id: &str,
        op: DocOp,
    ) -> Result<(DocReply, Vec<Json>), YadbeError> {
        let session = self.session(connection_id)?;
        let conn = Self::connection(&session)?;
        let ctx = GateContext::of(&session);
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let collect = async {
            let mut docs = Vec::new();
            while let Some(DocEvent::Documents(batch)) = rx.recv().await {
                docs.extend(batch);
            }
            docs
        };
        let (reply, docs) = tokio::join!(gate::run_own(&ctx, &*conn, &op, tx), collect);
        Ok((reply?, docs))
    }

    // --- Explorer ---------------------------------------------------------------------------

    pub async fn databases(&self, connection_id: &str) -> Result<Vec<DocDatabase>, YadbeError> {
        let (reply, _) = self
            .own(connection_id, DocOp::ListDatabases { filter: None })
            .await?;
        let DocReply::Document(reply) = reply else {
            return Ok(Vec::new());
        };
        let mut databases: Vec<DocDatabase> = reply
            .get("databases")
            .and_then(Json::as_array)
            .unwrap_or(&[])
            .iter()
            .filter_map(|db| {
                let name = db.get("name")?.as_str()?.to_owned();
                Some(DocDatabase {
                    system: matches!(name.as_str(), "admin" | "local" | "config"),
                    size_on_disk: int_of(db.get("sizeOnDisk")),
                    empty: bool_of(db.get("empty")),
                    name,
                })
            })
            .collect();
        databases.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(databases)
    }

    pub async fn collections(
        &self,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<DocCollection>, YadbeError> {
        let op = DocOp::ListCollections {
            database: database.to_owned(),
            filter: None,
        };
        let (_, docs) = self.own(connection_id, op).await?;
        let mut collections: Vec<DocCollection> = docs
            .iter()
            .filter_map(|info| {
                let name = info.get("name")?.as_str()?.to_owned();
                let kind = match info.get("type").and_then(Json::as_str) {
                    Some("view") => CollectionKind::View,
                    Some("timeseries") => CollectionKind::Timeseries,
                    _ => CollectionKind::Collection,
                };
                let options = info.get("options");
                Some(DocCollection {
                    system: name.starts_with("system."),
                    capped: bool_of(options.and_then(|o| o.get("capped"))),
                    view_on: options
                        .and_then(|o| o.get("viewOn"))
                        .and_then(Json::as_str)
                        .map(str::to_owned),
                    kind,
                    name,
                })
            })
            .collect();
        collections.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(collections)
    }

    pub async fn indexes(
        &self,
        connection_id: &str,
        database: &str,
        collection: &str,
    ) -> Result<Vec<DocIndex>, YadbeError> {
        let op = DocOp::ListIndexes {
            ns: Namespace::new(database, collection),
        };
        let (_, docs) = self.own(connection_id, op).await?;
        Ok(docs
            .iter()
            .filter_map(|index| {
                Some(DocIndex {
                    name: index.get("name")?.as_str()?.to_owned(),
                    keys: index.get("key").map(relaxed).unwrap_or_default(),
                    unique: bool_of(index.get("unique")),
                    sparse: bool_of(index.get("sparse")),
                    partial: index.get("partialFilterExpression").is_some(),
                    hidden: bool_of(index.get("hidden")),
                    expire_after_secs: int_of(index.get("expireAfterSeconds")),
                })
            })
            .collect())
    }

    /// The fields of a collection from a random sample of its documents (`$sample`).
    pub async fn sample(
        &self,
        connection_id: &str,
        database: &str,
        collection: &str,
        size: Option<u32>,
    ) -> Result<FieldSample, YadbeError> {
        let size = size
            .unwrap_or(DEFAULT_SAMPLE_SIZE)
            .clamp(1, MAX_SAMPLE_SIZE);
        let op = DocOp::Aggregate {
            database: database.to_owned(),
            collection: Some(collection.to_owned()),
            pipeline: vec![Json::object([(
                "$sample",
                Json::object([("size", Json::int(i64::from(size)))]),
            )])],
            allow_disk_use: None,
            batch_size: None,
        };
        let (_, docs) = self.own(connection_id, op).await?;
        Ok(sample_fields(&docs))
    }

    // --- Tabs -------------------------------------------------------------------------------

    fn tab(&self, tab_id: &str, connection_id: &str) -> Arc<DocTab> {
        let mut tabs = lock(&self.tabs);
        let tab = tabs.entry(tab_id.to_owned()).or_insert_with(|| {
            Arc::new(DocTab {
                connection_id: connection_id.to_owned(),
                running: Mutex::new(None),
                results: Mutex::new(Vec::new()),
                pages: Mutex::new(PageState::default()),
            })
        });
        if tab.connection_id != connection_id {
            // The tab moved to another connection: start over.
            *tab = Arc::new(DocTab {
                connection_id: connection_id.to_owned(),
                running: Mutex::new(None),
                results: Mutex::new(Vec::new()),
                pages: Mutex::new(PageState::default()),
            });
        }
        Arc::clone(tab)
    }

    fn known_tab(&self, tab_id: &str) -> Result<Arc<DocTab>, YadbeError> {
        lock(&self.tabs)
            .get(tab_id)
            .cloned()
            .ok_or_else(YadbeError::not_connected)
    }

    /// Runs one gated operation for a tab: cancellable with [`Self::cancel`], one at a time.
    async fn run_in_tab(
        &self,
        tab: &DocTab,
        session: &ConnectionSession,
        op: &DocOp,
        origin: Origin,
        confirmed: bool,
        max_documents: Option<u64>,
    ) -> Result<(GateOutcome, Vec<Json>), YadbeError> {
        let conn = Self::connection(session)?;
        let token = uuid::Uuid::new_v4().to_string();
        let stop = Arc::new(Notify::new());
        {
            let mut running = lock(&tab.running);
            if running.is_some() {
                return Err(YadbeError::execution_running());
            }
            *running = Some(Running {
                token: token.clone(),
                conn: Arc::clone(&conn),
                stop: Arc::clone(&stop),
            });
        }
        let ctx = GateContext::of(session);
        let request = GateRequest {
            op,
            origin,
            confirmed,
            max_time: session.statement_timeout(),
            token: token.clone(),
            max_documents,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let collect = async {
            let mut docs = Vec::new();
            while let Some(DocEvent::Documents(batch)) = rx.recv().await {
                docs.extend(batch);
            }
            docs
        };
        let work = async { tokio::join!(gate::run(&ctx, &*conn, request, tx), collect) };
        let result = tokio::select! {
            (outcome, docs) = work => outcome.map(|outcome| (outcome, docs)),
            () = stop.notified() => Err(YadbeError::cancelled()),
        };
        let mut running = lock(&tab.running);
        if running.as_ref().is_some_and(|r| r.token == token) {
            *running = None;
        }
        result
    }

    fn replace_results(&self, tab: &DocTab, result: &DocumentResult) {
        let old = std::mem::replace(
            &mut *lock(&tab.results),
            vec![result.result.result_id, result.documents_id],
        );
        self.store.remove(old);
    }

    /// Opens a collection tab: what the collection is and its estimated size.
    pub async fn open_collection(
        &self,
        tab_id: &str,
        connection_id: &str,
        ns: Namespace,
    ) -> Result<CollectionInfo, YadbeError> {
        let session = self.session(connection_id)?;
        let conn = Self::connection(&session)?;
        let tab = self.tab(tab_id, connection_id);
        *lock(&tab.pages) = PageState::default();
        let listed = self
            .own(
                connection_id,
                DocOp::ListCollections {
                    database: ns.database.clone(),
                    filter: Some(Json::object([(
                        "name",
                        Json::string(ns.collection.clone()),
                    )])),
                },
            )
            .await?
            .1;
        let kind = match listed.first() {
            None => {
                return Err(YadbeError::object_not_found(&format!(
                    "{}.{}",
                    ns.database, ns.collection
                )));
            }
            Some(info) => match info.get("type").and_then(Json::as_str) {
                Some("view") => CollectionKind::View,
                Some("timeseries") => CollectionKind::Timeseries,
                _ => CollectionKind::Collection,
            },
        };
        let estimated_count = if kind == CollectionKind::Collection {
            match self
                .own(connection_id, DocOp::EstimatedCount { ns: ns.clone() })
                .await
            {
                Ok((DocReply::Document(reply), _)) => reply_number(&reply, "count"),
                _ => None,
            }
        } else {
            None
        };
        Ok(CollectionInfo {
            database: ns.database,
            collection: ns.collection,
            kind: Some(kind),
            estimated_count,
            topology: conn.topology(),
        })
    }

    /// The first `_id` of the collection in one direction (index only, no filter).
    async fn edge_id(
        &self,
        connection_id: &str,
        ns: &Namespace,
        descending: bool,
    ) -> Result<Option<Json>, YadbeError> {
        let op = DocOp::Find {
            ns: ns.clone(),
            filter: Json::empty(),
            options: FindOptions {
                projection: Some(Json::object([("_id", Json::int(1))])),
                sort: Some(Json::object([(
                    "_id",
                    Json::int(if descending { -1 } else { 1 }),
                )])),
                limit: Some(1),
                ..FindOptions::default()
            },
        };
        let (_, docs) = self.own(connection_id, op).await?;
        Ok(docs.first().and_then(|d| d.get("_id")).cloned())
    }

    /// One page of a collection tab (`page` 0-based). Pages follow `_id` when the sort is
    /// none or `_id` alone and every `_id` of the collection has one type; otherwise they
    /// skip.
    pub async fn page(
        &self,
        tab_id: &str,
        connection_id: &str,
        ns: Namespace,
        query: CollectionQuery,
        page: u32,
    ) -> Result<CollectionPage, YadbeError> {
        if !(1..=MAX_PAGE_SIZE).contains(&query.page_size) {
            return Err(YadbeError::invalid_argument(
                format!("A page holds 1 to {MAX_PAGE_SIZE} documents."),
                format!("Une page contient de 1 à {MAX_PAGE_SIZE} documents."),
            ));
        }
        let filter =
            parse_document(&query.filter, "filter", "Le filtre")?.unwrap_or_else(Json::empty);
        let projection = parse_document(&query.projection, "projection", "La projection")?;
        let sort = parse_document(&query.sort, "sort", "Le tri")?.filter(|s| !s.is_empty_object());
        let session = self.session(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        let fresh = lock(&tab.pages).query.as_ref() != Some(&query);
        if fresh {
            let wanted = match &sort {
                None => Some(false),
                Some(sort) => id_direction(sort),
            };
            let paging = match wanted {
                Some(descending) if !excludes_id(projection.as_ref()) => {
                    let first = self.edge_id(connection_id, &ns, false).await?;
                    let last = self.edge_id(connection_id, &ns, true).await?;
                    let one_type = match (&first, &last) {
                        (Some(a), Some(b)) => type_of(a) == type_of(b),
                        _ => true,
                    };
                    if one_type {
                        Paging::Keyset { descending }
                    } else {
                        Paging::Skip
                    }
                }
                _ => Paging::Skip,
            };
            *lock(&tab.pages) = PageState {
                query: Some(query.clone()),
                paging: Some(paging),
                starts: vec![None],
            };
        }
        let (paging, start) = {
            let state = lock(&tab.pages);
            (
                state.paging.unwrap_or(Paging::Skip),
                state.starts.get(page as usize).cloned(),
            )
        };
        let size = query.page_size;
        let mut options = FindOptions {
            projection: projection.clone(),
            limit: Some(i64::from(size) + 1),
            ..FindOptions::default()
        };
        let mut find_filter = filter.clone();
        let keyset = match (paging, start) {
            (Paging::Keyset { descending }, Some(after)) => {
                options.sort = Some(Json::object([(
                    "_id",
                    Json::int(if descending { -1 } else { 1 }),
                )]));
                if let Some(after) = after {
                    let bound = Json::object([(
                        "_id",
                        Json::object([(if descending { "$lt" } else { "$gt" }, after)]),
                    )]);
                    find_filter = if filter.is_empty_object() {
                        bound
                    } else {
                        Json::object([("$and", Json::Array(vec![filter.clone(), bound]))])
                    };
                }
                true
            }
            _ => {
                // A sort without `_id` gets it as a tie-breaker, so pages do not overlap.
                let mut sort = sort.clone().unwrap_or_else(Json::empty);
                if let Json::Object(entries) = &mut sort
                    && !entries.iter().any(|(k, _)| k == "_id")
                {
                    entries.push(("_id".to_owned(), Json::int(1)));
                }
                options.sort = Some(sort);
                options.skip = Some(u64::from(page) * u64::from(size));
                false
            }
        };
        let op = DocOp::Find {
            ns,
            filter: find_filter,
            options,
        };
        let started = Instant::now();
        let (_, mut docs) = self
            .run_in_tab(&tab, &session, &op, Origin::Yadbe, false, None)
            .await?;
        let has_more = docs.len() > size as usize;
        docs.truncate(size as usize);
        if keyset {
            let mut state = lock(&tab.pages);
            let next = page as usize + 1;
            let last = docs.last().and_then(|d| d.get("_id")).cloned();
            if state.starts.len() == next {
                state.starts.push(last);
            } else if let Some(slot) = state.starts.get_mut(next) {
                *slot = last;
            }
        }
        let documents = store_documents(&self.store, &docs);
        self.replace_results(&tab, &documents);
        Ok(CollectionPage {
            documents,
            page,
            has_more,
            keyset,
            command: op.display(),
            duration_ms: (started.elapsed().as_secs_f64() * 1000.0).round(),
        })
    }

    /// Exact count of the documents matching `filter` (`countDocuments`): can take a while,
    /// cancellable.
    pub async fn count(
        &self,
        tab_id: &str,
        connection_id: &str,
        ns: Namespace,
        filter: &str,
    ) -> Result<f64, YadbeError> {
        let filter = parse_document(filter, "filter", "Le filtre")?.unwrap_or_else(Json::empty);
        let session = self.session(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        let op = DocOp::Count {
            ns,
            filter,
            limit: None,
        };
        match self
            .run_in_tab(&tab, &session, &op, Origin::Yadbe, false, None)
            .await?
        {
            (GateOutcome::Done(DocReply::Document(reply)), _) => reply_number(&reply, "count")
                .ok_or_else(|| YadbeError::internal("count without a number")),
            _ => Err(YadbeError::internal("unexpected count reply")),
        }
    }

    /// Runs one command typed in the console (`runCommand`), as written. Recorded in the
    /// history, unless it is dangerous and waits for a confirmation.
    pub async fn run_command(
        &self,
        tab_id: &str,
        connection_id: &str,
        database: &str,
        text: &str,
        confirmed: bool,
    ) -> Result<CommandOutcome, YadbeError> {
        let started_at = std::time::SystemTime::now();
        let started = Instant::now();
        let record = |rows: Option<u64>, outcome: Result<(), YadbeError>| {
            self.history.record(HistoryEntry {
                tab_id: tab_id.to_owned(),
                connection_id: connection_id.to_owned(),
                database: Some(database.to_owned()),
                sql: text.to_owned(),
                started_at,
                duration: started.elapsed(),
                rows,
                outcome,
            });
        };
        let command = match Json::parse(text) {
            Ok(json) if json.as_object().is_some_and(|e| !e.is_empty()) => json,
            Ok(_) => {
                return Err(YadbeError::invalid_argument(
                    "A command is a JSON object whose first key names it: { \"find\": \"orders\" }.",
                    "Une commande est un objet JSON dont la première clé la nomme : { \"find\": \"orders\" }.",
                ));
            }
            Err(err) => return Err(err),
        };
        let session = self.session(connection_id)?;
        let tab = self.tab(tab_id, connection_id);
        let op = DocOp::RunCommand {
            database: database.to_owned(),
            command,
        };
        let result = self
            .run_in_tab(
                &tab,
                &session,
                &op,
                Origin::User,
                confirmed,
                Some(CONSOLE_MAX_DOCUMENTS),
            )
            .await;
        let duration_ms = (started.elapsed().as_secs_f64() * 1000.0).round();
        match result {
            Ok((GateOutcome::Confirm(danger), _)) => Ok(CommandOutcome::Confirm { danger }),
            Ok((GateOutcome::Done(reply), docs)) => {
                let (documents, cursor, truncated) = match reply {
                    DocReply::Cursor { more, .. } => (docs, true, more),
                    DocReply::Document(reply) => (vec![reply], false, false),
                };
                record(
                    u64::try_from(documents.len()).ok().filter(|_| cursor),
                    Ok(()),
                );
                let documents = store_documents(&self.store, &documents);
                self.replace_results(&tab, &documents);
                Ok(CommandOutcome::Done {
                    documents,
                    cursor,
                    truncated,
                    duration_ms,
                })
            }
            Err(err) => {
                record(None, Err(err.clone()));
                Err(err)
            }
        }
    }

    /// Stops what the tab runs (`killOp` on the server); nothing when it runs nothing.
    pub async fn cancel(&self, tab_id: &str) -> Result<(), YadbeError> {
        let Ok(tab) = self.known_tab(tab_id) else {
            return Ok(());
        };
        let running = lock(&tab.running).take();
        if let Some(running) = running {
            running.stop.notify_one();
            running.conn.kill(&running.token).await?;
        }
        Ok(())
    }

    /// Forgets a tab: cancels what it runs and frees its results.
    pub async fn close_tab(&self, tab_id: &str) {
        if let Err(err) = self.cancel(tab_id).await {
            tracing::debug!(error = %err, "could not cancel a closing tab's operation");
        }
        if let Some(tab) = lock(&self.tabs).remove(tab_id) {
            let ids = std::mem::take(&mut *lock(&tab.results));
            self.store.remove(ids);
        }
    }

    /// Whole documents of a result, canonical Extended JSON (`documentsId` of a
    /// [`DocumentResult`]).
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
        documents_window(&self.store, documents_id, offset, limit)
    }
}

/// A key document in relaxed Extended JSON (`{"a":1}` rather than `{"a":{"$numberInt":"1"}}`).
fn relaxed(json: &Json) -> String {
    fn walk(json: &Json) -> Json {
        match json {
            Json::Object(entries) => {
                if let [(key, Json::String(n))] = entries.as_slice()
                    && matches!(key.as_str(), "$numberInt" | "$numberLong")
                    && let Ok(i) = n.parse::<i64>()
                {
                    return Json::int(i);
                }
                if let [(key, Json::String(n))] = entries.as_slice()
                    && key == "$numberDouble"
                    && let Some(f) = n.parse::<f64>().ok().and_then(serde_json::Number::from_f64)
                {
                    return Json::Number(f);
                }
                Json::Object(entries.iter().map(|(k, v)| (k.clone(), walk(v))).collect())
            }
            Json::Array(items) => Json::Array(items.iter().map(walk).collect()),
            other => other.clone(),
        }
    }
    walk(json).to_text()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_that_pages_can_follow() {
        let j = |t: &str| Json::parse(t).expect("json");
        assert_eq!(id_direction(&j(r#"{"_id":1}"#)), Some(false));
        assert_eq!(id_direction(&j(r#"{"_id":-1}"#)), Some(true));
        assert_eq!(
            id_direction(&j(r#"{"_id":{"$numberInt":"-1"}}"#)),
            Some(true)
        );
        assert_eq!(id_direction(&j(r#"{"a":1}"#)), None);
        assert_eq!(id_direction(&j(r#"{"_id":1,"a":1}"#)), None);
        assert!(excludes_id(Some(&j(r#"{"_id":0,"a":1}"#))));
        assert!(excludes_id(Some(&j(r#"{"_id":false}"#))));
        assert!(!excludes_id(Some(&j(r#"{"a":1}"#))));
        assert_eq!(
            relaxed(&j(
                r#"{"a":{"$numberInt":"1"},"b":{"$numberInt":"-1"},"c":"text"}"#
            )),
            r#"{"a":1,"b":-1,"c":"text"}"#
        );
    }

    #[test]
    fn form_fields_must_be_objects() {
        assert_eq!(
            parse_document("  ", "filter", "Le filtre").expect("ok"),
            None
        );
        assert!(parse_document("[1]", "filter", "Le filtre").is_err());
        assert!(parse_document("{ a: 1", "filter", "Le filtre").is_err());
        assert!(
            parse_document(r#"{"a":{"$gt":1}}"#, "filter", "Le filtre")
                .expect("ok")
                .is_some()
        );
    }
}
