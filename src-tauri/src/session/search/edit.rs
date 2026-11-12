//! Document edits of an index tab (M4-8): read one document exactly, preview a change set as
//! the requests it sends, apply it one document at a time (each guarded, stopping at the first
//! failure), journal what was applied and revert it.
//!
//! Every request goes through the gate: a read-only connection is refused there too, each is
//! recorded in the statement log and bound by the statement timeout. Writes wait for the
//! refresh that makes them searchable (`refresh=wait_for`) instead of forcing one
//! (`refresh=true` makes a tiny segment per edit and refreshes every shard of the index): the
//! tab can search again right after the apply and see the change. Where the index has no
//! periodic refresh (`refresh_interval: -1`) waiting would block until someone refreshes, so
//! the write does not wait and the outcome says the change is not searchable yet.

use std::collections::BTreeSet;
use std::time::{Instant, SystemTime};

use serde::Serialize;
use specta::Type;

use crate::db::engine::EngineFamily;
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::meta::ObjectRef;
use crate::db::search::edit::{
    Resolved, SearchChangeSet, SearchEdit, SearchEditBlock, SearchEditInfo, SeqGuard,
    apply_settings, counts, get_request, parse_resolve, plan,
};
use crate::db::search::exact::ExactJson;
use crate::db::search::request::{HttpMethod, SearchRequest, SearchResponse, segment};
use crate::session::search::gate::{Gate, Send};
use crate::store::{JournalStatement, JournalTargetKind, NewJournalEntry, RevertBlocker};

/// `_source` bytes a journal entry keeps to revert a change set (the documents it replaced or
/// deleted); above it the entry is journaled but cannot be reverted.
pub const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

/// A document as the server holds it now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocVersion {
    pub index: String,
    pub id: String,
    pub routing: Option<String>,
    pub found: bool,
    /// Its version, when found.
    pub guard: Option<SeqGuard>,
    /// Its `_source` indented, numbers as the server holds them; `null` when not found or
    /// without `_source`.
    pub source: Option<String>,
}

/// One request of a preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchPlannedRequest {
    /// Index of the edit in the change set.
    pub edit: u32,
    /// The request in console syntax, its body indented.
    pub text: String,
    /// It waits for the refresh that makes it searchable.
    pub waits: bool,
}

/// An edit the server would refuse here, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchEditRefusal {
    pub edit: u32,
    pub reason: SearchEditBlock,
}

/// What Apply would send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchEditPreview {
    pub requests: Vec<SearchPlannedRequest>,
    /// Edits that cannot be applied; Apply sends nothing while there is one.
    pub refused: Vec<SearchEditRefusal>,
}

/// What reverting a journal entry would send.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchRevertPreview {
    /// The inverse change set (which documents it touches).
    pub changes: SearchChangeSet,
    pub preview: SearchEditPreview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchConflictKind {
    /// The document changed since the version the edit was made on.
    Changed,
    /// The document is gone.
    Missing,
    /// A create's `_id` exists already.
    Exists,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchConflict {
    pub kind: SearchConflictKind,
    /// The server's version now (`found: false` when gone); `null` when it could not be read.
    pub current: Option<SearchDocVersion>,
}

/// One document changed by an apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchApplied {
    pub edit: u32,
    /// The concrete index written (a data stream's backing index, an alias's write index).
    pub index: String,
    pub id: String,
    /// `created`, `updated`, `deleted`, as the server says.
    pub result: String,
    /// The version the write made.
    pub guard: Option<SeqGuard>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchStopReason {
    Conflict {
        conflict: SearchConflict,
    },
    /// The request failed (refused by the server, timed out, link down): when it timed out or
    /// the link dropped, whether the server applied it is not known.
    Failed {
        error: YadbeError,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchStop {
    /// The edit that stopped the apply; it and the ones after it were not applied.
    pub edit: u32,
    pub reason: SearchStopReason,
}

/// What an apply (or a revert) did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchApplyOutcome {
    /// Edits in the change set.
    pub total: u32,
    /// In order; the first `applied.len()` edits.
    pub applied: Vec<SearchApplied>,
    pub stopped: Option<SearchStop>,
    /// The journal entry of what was applied; `null` when nothing was, or the journal could
    /// not be written.
    pub journal_id: Option<u32>,
    pub revertible: bool,
    /// Indices written without waiting for a refresh (`refresh_interval: -1`): the change is
    /// not searchable until the next refresh.
    pub not_visible: Vec<String>,
}

fn now_ms(at: SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn as_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn same_version(a: &SeqGuard, b: &SeqGuard) -> bool {
    match (a.numbers(), b.numbers()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// A document read: its version for the front, and its exact `_source` for a snapshot.
struct Read {
    version: SearchDocVersion,
    source: Option<ExactJson>,
}

fn exact_answer(response: &SearchResponse) -> Option<ExactJson> {
    std::str::from_utf8(&response.body)
        .ok()
        .and_then(|text| ExactJson::parse(text).ok())
}

fn read_of(
    index: &str,
    id: &str,
    routing: Option<&str>,
    response: SearchResponse,
) -> Result<Read, YadbeError> {
    let answer = exact_answer(&response);
    let found = matches!(
        answer.as_ref().and_then(|a| a.get("found")),
        Some(ExactJson::Bool(true))
    );
    // 404 with `found: false` is an absent document; any other error is an error.
    if !found
        && !(response.status == 404 && answer.as_ref().is_some_and(|a| a.get("found").is_some()))
    {
        response.into_result()?;
    }
    let source = answer
        .as_ref()
        .filter(|_| found)
        .and_then(|a| a.get("_source"))
        .cloned();
    Ok(Read {
        version: SearchDocVersion {
            index: answer
                .as_ref()
                .and_then(|a| a.get("_index"))
                .and_then(ExactJson::as_str)
                .unwrap_or(index)
                .to_owned(),
            id: id.to_owned(),
            routing: answer
                .as_ref()
                .and_then(|a| a.get("_routing"))
                .and_then(ExactJson::scalar_text)
                .map(str::to_owned)
                .or_else(|| routing.map(str::to_owned)),
            found,
            guard: answer
                .as_ref()
                .filter(|_| found)
                .and_then(SeqGuard::of_answer),
            source: source.as_ref().map(ExactJson::to_pretty),
        },
        source,
    })
}

/// The edit an applied one is undone by, when it can be.
fn inverse_of(
    edit: &SearchEdit,
    applied: &SearchApplied,
    previous: Option<&ExactJson>,
    into_stream: bool,
) -> Result<SearchEdit, RevertBlocker> {
    let routing = edit.routing().map(str::to_owned);
    match edit {
        SearchEdit::Replace { .. } => Ok(SearchEdit::Replace {
            index: applied.index.clone(),
            id: applied.id.clone(),
            routing,
            guard: applied
                .guard
                .clone()
                .ok_or(RevertBlocker::UpdatedRowUnknown)?,
            source: previous
                .ok_or(RevertBlocker::OriginalUnknown {
                    column: "_source".into(),
                })?
                .to_text(),
        }),
        SearchEdit::Delete { .. } => Ok(SearchEdit::Create {
            index: applied.index.clone(),
            id: Some(applied.id.clone()),
            routing,
            source: previous.ok_or(RevertBlocker::DeletedRowUnknown)?.to_text(),
        }),
        // A document appended to a data stream is not deleted here: data streams are
        // append-only in yadbe's edits.
        SearchEdit::Create { .. } if into_stream => Err(RevertBlocker::NotPlannable),
        SearchEdit::Create { .. } => Ok(SearchEdit::Delete {
            index: applied.index.clone(),
            id: applied.id.clone(),
            routing,
            guard: applied
                .guard
                .clone()
                .ok_or(RevertBlocker::InsertedRowUnknown)?,
        }),
    }
}

fn source_bytes(edit: &SearchEdit) -> usize {
    match edit {
        SearchEdit::Replace { source, .. } | SearchEdit::Create { source, .. } => source.len(),
        SearchEdit::Delete { .. } => 0,
    }
}

impl super::SearchService {
    /// The concrete indices, aliases and data streams `names` resolve to, with their write
    /// blocks and refresh setting.
    async fn resolve(&self, gate: &Gate<'_>, names: &[String]) -> Result<Resolved, YadbeError> {
        let list = names
            .iter()
            .map(|n| segment(n))
            .collect::<Vec<_>>()
            .join(",");
        let answer = gate
            .own_json(&SearchRequest::new(
                HttpMethod::Get,
                format!("/_resolve/index/{list}?expand_wildcards=all"),
            ))
            .await;
        let mut resolved = match answer {
            Ok(answer) => parse_resolve(&answer),
            // One name missing fails the whole resolve: each one alone, then.
            Err(err) if err.code == ErrorCode::ObjectNotFound && names.len() > 1 => {
                let mut all = Resolved::default();
                for name in names {
                    let one = Box::pin(self.resolve(gate, std::slice::from_ref(name))).await?;
                    all.order.extend(one.order);
                    all.indices.extend(one.indices);
                    all.data_streams.extend(one.data_streams);
                    all.aliases.extend(one.aliases);
                }
                return Ok(all);
            }
            Err(err) if err.code == ErrorCode::ObjectNotFound => return Ok(Resolved::default()),
            Err(err) => return Err(err),
        };
        if !resolved.indices.is_empty() {
            let settings = gate
                .own_json(&SearchRequest::new(
                    HttpMethod::Get,
                    format!(
                        "/{list}/_settings/index.blocks.*,index.refresh_interval?flat_settings=true&expand_wildcards=all&ignore_unavailable=true"
                    ),
                ))
                .await?;
            apply_settings(&mut resolved, &settings);
        }
        Ok(resolved)
    }

    /// What the edits of an index tab on `target` can do (F-008 read-only, data streams,
    /// closed and blocked indices, where a new document can go).
    pub async fn edit_info(
        &self,
        connection_id: &str,
        target: &str,
    ) -> Result<SearchEditInfo, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        let gate = self.gate(&session, &*conn);
        let resolved = self.resolve(&gate, &[target.to_owned()]).await?;
        Ok(resolved.info(target, session.read_only()))
    }

    async fn read(
        &self,
        gate: &Gate<'_>,
        index: &str,
        id: &str,
        routing: Option<&str>,
    ) -> Result<Read, YadbeError> {
        let response = gate
            .send(&get_request(index, id, routing), Send::own())
            .await?;
        read_of(index, id, routing, response)
    }

    /// One document as the server holds it now (a real-time get: it sees a write before any
    /// refresh), its `_source` exact.
    pub async fn get_document(
        &self,
        connection_id: &str,
        index: &str,
        id: &str,
        routing: Option<&str>,
    ) -> Result<SearchDocVersion, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        let gate = self.gate(&session, &*conn);
        Ok(self.read(&gate, index, id, routing).await?.version)
    }

    /// The requests Apply would send, and the edits that cannot be applied here.
    pub async fn preview_changes(
        &self,
        connection_id: &str,
        set: &SearchChangeSet,
    ) -> Result<SearchEditPreview, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        let gate = self.gate(&session, &*conn);
        let resolved = self.resolve(&gate, &indices_of(set)).await?;
        let mut requests = Vec::new();
        let mut refused = Vec::new();
        for (i, edit) in set.edits.iter().enumerate() {
            let waits = resolved.wait_for(edit);
            requests.push(SearchPlannedRequest {
                edit: as_u32(i),
                text: plan(edit, waits)?.preview(),
                waits,
            });
            if let Some(reason) = resolved.block_of(edit, session.read_only()) {
                refused.push(SearchEditRefusal {
                    edit: as_u32(i),
                    reason,
                });
            }
        }
        Ok(SearchEditPreview { requests, refused })
    }

    /// Applies a change set one document at a time and journals what was applied.
    pub async fn apply_changes(
        &self,
        connection_id: &str,
        set: &SearchChangeSet,
    ) -> Result<SearchApplyOutcome, YadbeError> {
        self.apply_inner(connection_id, set, None).await
    }

    async fn apply_inner(
        &self,
        connection_id: &str,
        set: &SearchChangeSet,
        reverts: Option<u32>,
    ) -> Result<SearchApplyOutcome, YadbeError> {
        let (session, conn) = self.open(connection_id)?;
        if session.read_only() {
            return Err(SearchEditBlock::ReadOnlyConnection.into_error());
        }
        if set.edits.is_empty() {
            return Err(YadbeError::invalid_argument(
                "There is no change to apply.",
                "Il n'y a aucune modification à appliquer.",
            ));
        }
        // Every document is checked to be valid JSON before anything is sent.
        for edit in &set.edits {
            plan(edit, false)?;
        }
        let gate = self.gate(&session, &*conn);
        let resolved = self.resolve(&gate, &indices_of(set)).await?;
        if let Some(block) = set.edits.iter().find_map(|e| resolved.block_of(e, false)) {
            return Err(block.into_error());
        }
        let started_at = SystemTime::now();
        let start = Instant::now();
        let mut applied: Vec<SearchApplied> = Vec::new();
        let mut statements = Vec::new();
        let mut inverse: Result<Vec<SearchEdit>, RevertBlocker> = Ok(Vec::new());
        let mut not_visible = BTreeSet::new();
        let mut stopped = None;
        for (i, edit) in set.edits.iter().enumerate() {
            let stop = |reason| SearchStop {
                edit: as_u32(i),
                reason,
            };
            match self.apply_one(&gate, edit, &resolved, as_u32(i)).await {
                Ok(done) => {
                    if !done.waited {
                        not_visible.insert(done.applied.index.clone());
                    }
                    statements.push(JournalStatement {
                        sql: crate::store::kept_statement(&done.statement),
                        rows_affected: Some(1.0),
                    });
                    let into_stream = resolved.data_streams.contains_key(edit.index());
                    inverse = inverse.and_then(|mut list| {
                        list.push(inverse_of(
                            edit,
                            &done.applied,
                            done.previous.as_ref(),
                            into_stream,
                        )?);
                        Ok(list)
                    });
                    applied.push(done.applied);
                }
                Err(Stopped::Conflict(conflict)) => {
                    stopped = Some(stop(SearchStopReason::Conflict { conflict }));
                    break;
                }
                Err(Stopped::Failed(error)) => {
                    stopped = Some(stop(SearchStopReason::Failed { error }));
                    break;
                }
            }
        }
        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
        let complete = stopped.is_none();
        let inverse = inverse.and_then(|mut list| {
            list.reverse();
            if list.iter().map(source_bytes).sum::<usize>() > MAX_SNAPSHOT_BYTES {
                return Err(RevertBlocker::TooLarge);
            }
            Ok(SearchChangeSet {
                target: set.target.clone(),
                edits: list,
            })
        });
        let revertible = !applied.is_empty() && inverse.is_ok();
        let journal_id = match (&self.journal, applied.is_empty()) {
            (Some(journal), false) => {
                let done = &set.edits[..applied.len()];
                let (updated, inserted, deleted) = counts(done);
                let (inverse_json, inverse_statements, blocker) = match inverse {
                    Ok(back) => {
                        let lines = back
                            .edits
                            .iter()
                            .filter_map(|e| plan(e, true).ok())
                            .map(|p| crate::store::kept_statement(&p.request.display()))
                            .collect();
                        match serde_json::to_string(&back) {
                            Ok(json) if json.len() <= crate::store::MAX_INVERSE_BYTES => {
                                (Some(json), lines, None)
                            }
                            _ => (None, Vec::new(), Some(RevertBlocker::TooLarge)),
                        }
                    }
                    Err(blocker) => (None, Vec::new(), Some(blocker)),
                };
                journal
                    .record(NewJournalEntry {
                        connection_id: connection_id.to_owned(),
                        connection_name: journal.connection_name(connection_id),
                        engine: session.target().engine,
                        target_kind: JournalTargetKind::Index,
                        table: ObjectRef {
                            database: String::new(),
                            schema: None,
                            name: set.target.clone(),
                        },
                        applied_at_ms: now_ms(started_at),
                        duration_ms,
                        updated,
                        inserted,
                        deleted,
                        statements,
                        inverse: inverse_json,
                        inverse_statements,
                        blocker,
                        // A revert stopped half-way does not mark the entry reverted.
                        reverts: reverts.filter(|_| complete).map(i64::from),
                    })
                    .await
                    .and_then(|id| u32::try_from(id).ok())
            }
            _ => None,
        };
        Ok(SearchApplyOutcome {
            total: as_u32(set.edits.len()),
            applied,
            stopped,
            journal_id,
            revertible: revertible && journal_id.is_some(),
            not_visible: not_visible.into_iter().collect(),
        })
    }

    /// One edit: its document checked at the version the edit was made on, then written.
    async fn apply_one(
        &self,
        gate: &Gate<'_>,
        edit: &SearchEdit,
        resolved: &Resolved,
        number: u32,
    ) -> Result<Done, Stopped> {
        let waited = resolved.wait_for(edit);
        let routing = edit.routing();
        let previous = match edit {
            SearchEdit::Replace {
                index, id, guard, ..
            }
            | SearchEdit::Delete {
                index, id, guard, ..
            } => {
                let read = self
                    .read(gate, index, id, routing)
                    .await
                    .map_err(Stopped::Failed)?;
                let conflict = |kind| {
                    Stopped::Conflict(SearchConflict {
                        kind,
                        current: Some(read.version.clone()),
                    })
                };
                if !read.version.found {
                    return Err(conflict(SearchConflictKind::Missing));
                }
                if !read
                    .version
                    .guard
                    .as_ref()
                    .is_some_and(|now| same_version(now, guard))
                {
                    return Err(conflict(SearchConflictKind::Changed));
                }
                if read.source.is_none() {
                    return Err(Stopped::Failed(SearchEditBlock::NoSource.into_error()));
                }
                read.source
            }
            SearchEdit::Create { .. } => None,
        };
        let planned = plan(edit, waited).map_err(Stopped::Failed)?;
        let response = gate
            .send(&planned.request, Send::own())
            .await
            .map_err(Stopped::Failed)?;
        if response.status == 409 || (response.status == 404 && edit_is_delete(edit)) {
            let kind = match (edit, response.status) {
                (SearchEdit::Create { .. }, _) => SearchConflictKind::Exists,
                (_, 404) => SearchConflictKind::Missing,
                _ => SearchConflictKind::Changed,
            };
            // The server's version now, to show against the edit.
            let current = match edit.id() {
                Some(id) => self
                    .read(gate, edit.index(), id, routing)
                    .await
                    .ok()
                    .map(|r| r.version),
                None => None,
            };
            return Err(Stopped::Conflict(SearchConflict { kind, current }));
        }
        let response = response.into_result().map_err(Stopped::Failed)?;
        let answer = exact_answer(&response).unwrap_or(ExactJson::Null);
        let text = |key: &str| {
            answer
                .get(key)
                .and_then(ExactJson::scalar_text)
                .map(str::to_owned)
        };
        let applied = SearchApplied {
            edit: number,
            index: text("_index").unwrap_or_else(|| edit.index().to_owned()),
            id: text("_id")
                .or_else(|| edit.id().map(str::to_owned))
                .unwrap_or_default(),
            result: text("result").unwrap_or_default(),
            guard: SeqGuard::of_answer(&answer),
        };
        Ok(Done {
            applied,
            previous,
            statement: planned.request.display(),
            waited,
        })
    }

    fn revert_set(
        &self,
        connection_id: &str,
        entry_id: u32,
    ) -> Result<SearchChangeSet, YadbeError> {
        let journal = self
            .journal
            .as_ref()
            .ok_or_else(|| YadbeError::internal("no change journal"))?;
        let (_, inverse) = journal.revertible(entry_id, connection_id, EngineFamily::Search)?;
        serde_json::from_str(&inverse).map_err(|e| {
            YadbeError::invalid_argument(
                "This change set cannot be reverted: its journal entry is unreadable.",
                "Cet ensemble de modifications ne peut pas être annulé : son entrée de journal est illisible.",
            )
            .with_detail(e.to_string())
        })
    }

    /// What reverting journal entry `entry_id` would send, and the change set it is (for the
    /// front to show which documents it touches).
    pub async fn preview_revert(
        &self,
        connection_id: &str,
        entry_id: u32,
    ) -> Result<SearchRevertPreview, YadbeError> {
        let changes = self.revert_set(connection_id, entry_id)?;
        let preview = self.preview_changes(connection_id, &changes).await?;
        Ok(SearchRevertPreview { changes, preview })
    }

    /// Reverts journal entry `entry_id`: its inverse, applied with the same checks.
    pub async fn apply_revert(
        &self,
        connection_id: &str,
        entry_id: u32,
    ) -> Result<SearchApplyOutcome, YadbeError> {
        let set = self.revert_set(connection_id, entry_id)?;
        self.apply_inner(connection_id, &set, Some(entry_id)).await
    }
}

fn edit_is_delete(edit: &SearchEdit) -> bool {
    matches!(edit, SearchEdit::Delete { .. })
}

/// The distinct indices a change set writes to.
fn indices_of(set: &SearchChangeSet) -> Vec<String> {
    let mut seen = BTreeSet::new();
    set.edits
        .iter()
        .map(|e| e.index().to_owned())
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

struct Done {
    applied: SearchApplied,
    /// The `_source` replaced or deleted.
    previous: Option<ExactJson>,
    statement: String,
    waited: bool,
}

enum Stopped {
    Conflict(SearchConflict),
    Failed(YadbeError),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, body: &str) -> SearchResponse {
        SearchResponse {
            status,
            content_type: Some("application/json".into()),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn a_read_keeps_the_source_exact() {
        let read = read_of(
            "orders",
            "1",
            None,
            response(
                200,
                r#"{"_index":"orders","_id":"1","_version":3,"_seq_no":12,"_primary_term":1,"_routing":"eu","found":true,"_source":{"n":123456789012345678901234567890,"d":1.10}}"#,
            ),
        )
        .expect("read");
        assert!(read.version.found);
        assert_eq!(read.version.routing.as_deref(), Some("eu"));
        assert_eq!(
            read.version.guard,
            Some(SeqGuard {
                seq_no: "12".into(),
                primary_term: "1".into()
            })
        );
        assert_eq!(
            read.source.map(|s| s.to_text()).as_deref(),
            Some(r#"{"n":123456789012345678901234567890,"d":1.10}"#)
        );
        let gone = read_of(
            "orders",
            "2",
            None,
            response(404, r#"{"_index":"orders","_id":"2","found":false}"#),
        )
        .expect("absent");
        assert!(!gone.version.found);
        assert!(gone.version.guard.is_none());
        let missing_index = read_of(
            "nope",
            "1",
            None,
            response(
                404,
                r#"{"error":{"type":"index_not_found_exception","reason":"no such index [nope]"},"status":404}"#,
            ),
        );
        assert!(missing_index.is_err());
    }

    #[test]
    fn inverses_restore_what_was_there() {
        let applied = SearchApplied {
            edit: 0,
            index: "orders".into(),
            id: "1".into(),
            result: "updated".into(),
            guard: Some(SeqGuard {
                seq_no: "13".into(),
                primary_term: "1".into(),
            }),
        };
        let previous = ExactJson::parse(r#"{"a":1.50}"#).expect("json");
        let replace = SearchEdit::Replace {
            index: "orders".into(),
            id: "1".into(),
            routing: Some("eu".into()),
            guard: SeqGuard {
                seq_no: "12".into(),
                primary_term: "1".into(),
            },
            source: "{}".into(),
        };
        assert_eq!(
            inverse_of(&replace, &applied, Some(&previous), false),
            Ok(SearchEdit::Replace {
                index: "orders".into(),
                id: "1".into(),
                routing: Some("eu".into()),
                guard: SeqGuard {
                    seq_no: "13".into(),
                    primary_term: "1".into()
                },
                source: r#"{"a":1.50}"#.into(),
            })
        );
        let create = SearchEdit::Create {
            index: "logs".into(),
            id: None,
            routing: None,
            source: "{}".into(),
        };
        assert!(matches!(
            inverse_of(&create, &applied, None, false),
            Ok(SearchEdit::Delete { .. })
        ));
        assert_eq!(
            inverse_of(&create, &applied, None, true),
            Err(RevertBlocker::NotPlannable)
        );
    }
}
