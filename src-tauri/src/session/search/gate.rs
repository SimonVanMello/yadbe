//! The request gate: the one place every search request passes through before the driver,
//! whoever sends it (the explorer, an index tab, the console).
//!
//! In order: read-only (F-008: only the allow-list of `db::search::classify` passes on a
//! read-only connection), dangerous requests not confirmed (with their effect measured on the
//! server beforehand, `dangers`), then the request itself with an `X-Opaque-Id` under the
//! statement timeout; past it, or on a cancel, the request is dropped and its task on the
//! server cancelled (`_tasks/<id>/_cancel`). Recorded in the statement log (yadbe's requests)
//! or the history (the user's).

use std::time::{Duration, Instant, SystemTime};

use tokio_util::sync::CancellationToken;

use crate::db::document::json::Json;
use crate::db::driver::{RecordedStatement, SearchConnection};
use crate::db::errors::{LocalizedText, YadbeError};
use crate::db::search::classify::{SearchDangerKind, danger_of, is_read};
use crate::db::search::meta::number_of;
use crate::db::search::request::{HttpMethod, SearchRequest, SearchResponse, segment};
use crate::session::ConnectionSession;
use crate::session::history_hook::{HistoryEntry, HistoryRecorder};
use crate::session::search::model::SearchDanger;

/// Who sent a request, and so where it is recorded.
pub enum Origin<'a> {
    /// yadbe on its own: the statement log.
    Yadbe,
    /// The user, from a console: the history.
    User(&'a UserContext),
}

/// Where a user request comes from, for its history entry.
pub struct UserContext {
    pub tab_id: String,
    pub connection_id: String,
}

/// The gate of one request's session and connection.
pub struct Gate<'a> {
    pub session: &'a ConnectionSession,
    pub conn: &'a dyn SearchConnection,
    pub history: &'a dyn HistoryRecorder,
}

/// How to run one request.
pub struct Send<'a> {
    pub origin: Origin<'a>,
    /// The user confirmed its danger.
    pub confirmed: bool,
    /// Its `X-Opaque-Id`; a fresh one when `None`.
    pub opaque_id: Option<String>,
    /// Cancelled to stop it (at once if it already is).
    pub stop: Option<&'a CancellationToken>,
}

impl Send<'_> {
    pub fn own() -> Self {
        Send {
            origin: Origin::Yadbe,
            confirmed: false,
            opaque_id: None,
            stop: None,
        }
    }
}

pub fn new_opaque_id() -> String {
    format!("yadbe-{}", uuid::Uuid::new_v4())
}

pub fn confirmation_missing(request: &SearchRequest) -> YadbeError {
    YadbeError::invalid_argument(
        format!(
            "{} needs a confirmation of its effect before it runs. Nothing was sent.",
            request.line()
        ),
        format!(
            "{} doit être confirmée avec son effet avant de s'exécuter. Rien n'a été envoyé.",
            request.line()
        ),
    )
}

fn fmt_count(n: f64) -> String {
    let digits = format!("{:.0}", n.max(0.0));
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push('\u{202f}');
        }
        out.push(c);
    }
    out
}

/// Names cut to ten, for an effect's text.
fn names(list: &[String]) -> String {
    let mut shown = list.iter().take(10).cloned().collect::<Vec<_>>().join(", ");
    if list.len() > 10 {
        shown.push_str(", …");
    }
    shown
}

impl Gate<'_> {
    /// Whether `request` may run now: allowed by read-only, confirmed if dangerous.
    pub async fn check(&self, request: &SearchRequest, confirmed: bool) -> Result<(), YadbeError> {
        if self.session.read_only() && !is_read(request) {
            return Err(YadbeError::read_only_violation(&request.line()));
        }
        if confirmed {
            return Ok(());
        }
        if let Some(candidate) = danger_of(request) {
            // A reindex into an index that does not exist yet only creates it.
            let dangerous = candidate.kind != SearchDangerKind::Reindex
                || self
                    .indices(&candidate.target)
                    .await
                    .is_some_and(|i| !i.is_empty());
            if dangerous {
                return Err(confirmation_missing(request));
            }
        }
        Ok(())
    }

    /// Sends `request` under the statement timeout; `stop` cancels it. Past the limit or on a
    /// cancel, the request is dropped and its server task cancelled.
    async fn send_timed(
        &self,
        request: &SearchRequest,
        opaque_id: &str,
        stop: Option<&CancellationToken>,
    ) -> Result<SearchResponse, YadbeError> {
        let limit = self.session.statement_timeout();
        let send = self.conn.send(request, Some(opaque_id));
        let timeout = async {
            match limit {
                Some(limit) => tokio::time::sleep(limit).await,
                None => std::future::pending().await,
            }
        };
        let stopped = async {
            match stop {
                Some(stop) => stop.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let failure = tokio::select! {
            result = send => return result,
            () = timeout => YadbeError::statement_timeout(limit.map_or(1, |l| l.as_secs().max(1))),
            () = stopped => YadbeError::cancelled(),
        };
        self.cancel(opaque_id).await;
        Err(failure)
    }

    fn record(
        &self,
        request: &SearchRequest,
        origin: &Origin<'_>,
        started_at: SystemTime,
        duration: Duration,
        result: &Result<SearchResponse, YadbeError>,
    ) {
        let outcome = match result {
            Ok(response) => match response.server_error() {
                Some(error) => Err(error.into_error(response.status)),
                None => Ok(()),
            },
            Err(err) => Err(err.clone()),
        };
        match origin {
            Origin::Yadbe => self.session.recorder().record(RecordedStatement {
                sql: request.display_short(4096),
                started_at,
                duration,
                outcome: outcome.map(|()| None),
            }),
            Origin::User(user) => self.history.record(HistoryEntry {
                tab_id: user.tab_id.clone(),
                connection_id: user.connection_id.clone(),
                database: None,
                sql: request.display(),
                started_at,
                duration,
                rows: result.as_ref().ok().and_then(hits_count),
                outcome,
            }),
        }
    }

    /// Runs one request through the gate. A 4xx / 5xx answer is `Ok`: the caller decides
    /// (the console shows it, yadbe's own reads turn it into an error with `into_result`).
    pub async fn send(
        &self,
        request: &SearchRequest,
        how: Send<'_>,
    ) -> Result<SearchResponse, YadbeError> {
        let started_at = SystemTime::now();
        let start = Instant::now();
        let opaque_id = how.opaque_id.unwrap_or_else(new_opaque_id);
        let result = match self.check(request, how.confirmed).await {
            Ok(()) => self.send_timed(request, &opaque_id, how.stop).await,
            Err(refused) => Err(refused),
        };
        self.record(request, &how.origin, started_at, start.elapsed(), &result);
        result
    }

    /// yadbe's own read, its error status as an error, its body as JSON.
    pub async fn own_json(&self, request: &SearchRequest) -> Result<Json, YadbeError> {
        let response = self.send(request, Send::own()).await?.into_result()?;
        response.json().ok_or_else(|| {
            YadbeError::query_failed(format!("{}: the answer is not JSON", request.line()))
        })
    }

    /// Cancels on the server the tasks started by the request with this `X-Opaque-Id`
    /// (`GET /_tasks`, then `_cancel` each). A control request of yadbe's own: not subject to
    /// read-only (it stops what yadbe started), recorded in the statement log.
    pub async fn cancel(&self, opaque_id: &str) -> u32 {
        let list = SearchRequest::new(HttpMethod::Get, "/_tasks?detailed=false&group_by=none");
        let Ok(tasks) = self.raw_own(&list).await else {
            return 0;
        };
        let mut cancelled = 0;
        let mine: Vec<&Json> = tasks
            .get("tasks")
            .and_then(Json::as_array)
            .unwrap_or(&[])
            .iter()
            .filter(|task| {
                task.get("headers")
                    .and_then(|h| h.get("X-Opaque-Id"))
                    .and_then(Json::as_str)
                    == Some(opaque_id)
                    && task.get("parent_task_id").is_none()
            })
            .collect();
        for task in mine {
            let (Some(node), Some(id)) = (
                task.get("node").and_then(Json::as_str),
                task.get("id").map(Json::to_text),
            ) else {
                continue;
            };
            let path = format!("/_tasks/{}/_cancel", segment(&format!("{node}:{id}")));
            if self
                .raw_own(&SearchRequest::new(HttpMethod::Post, path))
                .await
                .is_ok()
            {
                cancelled += 1;
            }
        }
        cancelled
    }

    /// A read of yadbe's that measures a danger (`_cat/indices`): an allow-listed read, sent
    /// under the timeout without going through `check` again, recorded.
    async fn probe(&self, request: &SearchRequest) -> Result<SearchResponse, YadbeError> {
        debug_assert!(is_read(request));
        let started_at = SystemTime::now();
        let start = Instant::now();
        let result = self.send_timed(request, &new_opaque_id(), None).await;
        self.record(
            request,
            &Origin::Yadbe,
            started_at,
            start.elapsed(),
            &result,
        );
        result
    }

    /// A request of yadbe's that bypasses the read-only check (task control), recorded.
    async fn raw_own(&self, request: &SearchRequest) -> Result<Json, YadbeError> {
        let started_at = SystemTime::now();
        let start = Instant::now();
        let result = self.conn.send(request, None).await;
        self.record(
            request,
            &Origin::Yadbe,
            started_at,
            start.elapsed(),
            &result,
        );
        let response = result?.into_result()?;
        response
            .json()
            .ok_or_else(|| YadbeError::query_failed("the answer is not JSON"))
    }

    /// The indices `target` resolves to and their documents; `None` when it could not be
    /// read, empty when it matches none.
    async fn indices(&self, target: &str) -> Option<Vec<(String, f64)>> {
        if target.is_empty() {
            return Some(Vec::new());
        }
        let request = SearchRequest::new(
            HttpMethod::Get,
            format!(
                "/_cat/indices/{}?format=json&h=index,docs.count&expand_wildcards=all",
                segment(target)
            ),
        );
        let response = self.probe(&request).await.ok()?;
        if response.status == 404 {
            return Some(Vec::new());
        }
        let json = response.into_result().ok()?.json()?;
        Some(
            json.as_array()
                .unwrap_or(&[])
                .iter()
                .filter_map(|row| {
                    let name = row.get("index")?.as_str()?.to_owned();
                    Some((name, number_of(row.get("docs.count")).unwrap_or(0.0)))
                })
                .collect(),
        )
    }

    /// Documents a by-query request touches (`_count` with its query).
    async fn query_count(&self, target: &str, request: &SearchRequest) -> Option<f64> {
        let body = request.body_json();
        let query = body
            .as_ref()
            .and_then(|b| b.get("query").cloned())
            .unwrap_or_else(|| Json::object([("match_all", Json::empty())]));
        let count = SearchRequest::json(
            HttpMethod::Post,
            format!("/{}/_count", segment(target)),
            &Json::object([("query", query)]),
        );
        let json = self.own_json(&count).await.ok()?;
        number_of(json.get("count"))
    }

    /// The dangerous requests among `requests` (line, request) and their effect, measured
    /// with read-only probes. Requests the gate refuses anyway (read-only) are left out.
    pub async fn dangers(&self, requests: &[(u32, &SearchRequest)]) -> Vec<SearchDanger> {
        let mut found = Vec::new();
        for (line, request) in requests {
            let Some(candidate) = danger_of(request) else {
                continue;
            };
            if self.session.read_only() && !is_read(request) {
                continue;
            }
            let target = candidate.target.clone();
            let unmeasured = || {
                LocalizedText::new(
                    format!("Its effect on {target} could not be measured."),
                    format!("Son effet sur {target} n'a pas pu être mesuré."),
                )
            };
            let effect = match candidate.kind {
                SearchDangerKind::DeleteIndex
                | SearchDangerKind::DeleteDataStream
                | SearchDangerKind::CloseIndex => match self.indices(&target).await {
                    None => unmeasured(),
                    Some(list) if list.is_empty() => LocalizedText::new(
                        format!("No index matches {target} now."),
                        format!("Aucun index ne correspond à {target} actuellement."),
                    ),
                    Some(list) => {
                        let docs: f64 = list.iter().map(|(_, n)| n).sum();
                        let names: Vec<String> = list.iter().map(|(n, _)| n.clone()).collect();
                        let (count, docs, names) =
                            (list.len(), fmt_count(docs), self::names(&names));
                        if candidate.kind == SearchDangerKind::CloseIndex {
                            LocalizedText::new(
                                format!(
                                    "Closes {count} index(es) holding {docs} documents ({names}): they can be neither searched nor written until reopened."
                                ),
                                format!(
                                    "Ferme {count} index contenant {docs} documents ({names}) : ils ne peuvent plus être ni lus ni écrits avant d'être rouverts."
                                ),
                            )
                        } else {
                            LocalizedText::new(
                                format!(
                                    "Deletes {count} index(es) and their {docs} documents for good: {names}."
                                ),
                                format!(
                                    "Supprime définitivement {count} index et leurs {docs} documents : {names}."
                                ),
                            )
                        }
                    }
                },
                SearchDangerKind::DeleteByQuery | SearchDangerKind::UpdateByQuery => {
                    match self.query_count(&target, request).await {
                        None => unmeasured(),
                        Some(n) if candidate.kind == SearchDangerKind::DeleteByQuery => {
                            LocalizedText::new(
                                format!(
                                    "Deletes the {} documents of {target} that match its query.",
                                    fmt_count(n)
                                ),
                                format!(
                                    "Supprime les {} documents de {target} qui correspondent à sa requête.",
                                    fmt_count(n)
                                ),
                            )
                        }
                        Some(n) => LocalizedText::new(
                            format!(
                                "Rewrites the {} documents of {target} that match its query.",
                                fmt_count(n)
                            ),
                            format!(
                                "Réécrit les {} documents de {target} qui correspondent à sa requête.",
                                fmt_count(n)
                            ),
                        ),
                    }
                }
                SearchDangerKind::Reindex => match self.indices(&target).await {
                    Some(list) if list.is_empty() => continue,
                    None => unmeasured(),
                    Some(list) => {
                        let docs: f64 = list.iter().map(|(_, n)| n).sum();
                        LocalizedText::new(
                            format!(
                                "Writes into {target}, which exists and holds {} documents: those with the same ids are overwritten.",
                                fmt_count(docs)
                            ),
                            format!(
                                "Écrit dans {target}, qui existe et contient {} documents : ceux de même identifiant sont écrasés.",
                                fmt_count(docs)
                            ),
                        )
                    }
                },
            };
            found.push(SearchDanger {
                line: *line,
                request: request.line(),
                kind: candidate.kind,
                effect,
            });
        }
        found
    }
}

/// Hits returned by a search response, for the history's row count.
fn hits_count(response: &SearchResponse) -> Option<u64> {
    let json = response.json()?;
    let hits = json.get("hits")?.get("hits")?.as_array()?;
    u64::try_from(hits.len()).ok()
}
