//! Applying document edits (M4-4, rule 10). The change set is planned by
//! [`crate::db::document::edit`] (one guarded operation per document) and every operation
//! goes through the gate (read-only, statement log, timeout):
//!
//! - **Replica set or sharded cluster**: one multi-document transaction. An operation that
//!   matches no document is a conflict; the others still run inside the doomed transaction so
//!   that every conflict is reported at once, then the transaction is aborted: nothing is
//!   applied. Any error aborts at once. A `TransientTransactionError` is reported as such
//!   (nothing applied, applying again may succeed) and never retried by yadbe; a commit whose
//!   result the server could not confirm (`UnknownTransactionCommitResult`) is reported as
//!   uncertain and not journaled.
//! - **Standalone server** (no multi-document transaction, decision 3): one operation at a
//!   time, each checked, stopping at the first conflict or failure; the outcome says which
//!   changes were applied and the journal records exactly those.
//!
//! The journal entry's inverse is another change set, guarded by what the apply left; a
//! revert is a normal checked apply of it.

use std::time::{Instant, SystemTime};

use serde::Serialize;
use specta::Type;

use crate::db::document::edit::{
    self, DocChangeSet, DocConflict, DocPreviewLine, MAX_INVERSE_BYTES, Planned, new_object_id,
    preview_lines, shell_op,
};
use crate::db::document::json::Json;
use crate::db::document::ops::{
    DocEvent, DocOp, DocReply, DocTopology, FindOptions, Namespace, is_transient,
};
use crate::db::driver::DocumentConnection;
use crate::db::engine::EngineFamily;
use crate::db::errors::{ErrorAction, ErrorCode, YadbeError};
use crate::db::meta::ObjectRef;
use crate::session::ConnectionSession;
use crate::session::document::gate::{self, GateContext, GateOutcome, GateRequest, Origin};
use crate::store::{JournalStatement, JournalTargetKind, NewJournalEntry, RevertBlocker};

/// Preview lines sent at most; the rest are counted.
const MAX_PREVIEW_LINES: usize = 2_000;
/// Characters of one preview line at most (a large document).
const MAX_LINE_CHARS: usize = 20_000;

/// What Apply would run.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocPreview {
    /// The mongosh lines, in order (session and transaction lines included).
    pub lines: Vec<DocPreviewLine>,
    /// Writes it sends.
    pub operations: u32,
    /// All in one transaction (replica set, sharded cluster); otherwise one by one.
    pub atomic: bool,
    pub topology: DocTopology,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DocApplyStatus {
    /// Every change is on the server.
    Applied,
    /// A document no longer holds what the change was planned on (see `conflicts`).
    Conflicted,
    /// An operation or the commit failed (see `error`).
    Failed,
    /// The server could not confirm the commit: the changes may or may not be applied.
    Uncertain,
}

/// What an apply did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocApplyOutcome {
    pub status: DocApplyStatus,
    /// It ran in one transaction.
    pub atomic: bool,
    /// Indices (in the change set) of the changes now on the server: all of them when
    /// applied, none for a transaction that did not commit, those before the stop on a
    /// standalone server.
    pub applied: Vec<u32>,
    pub conflicts: Vec<DocConflict>,
    pub error: Option<YadbeError>,
    /// The failure is transient: nothing was applied and applying again may succeed.
    pub retryable: bool,
    /// The journal entry of what was applied; `null` when nothing was or the journal could
    /// not be written.
    pub journal_id: Option<u32>,
    /// That entry can be reverted.
    pub revertible: bool,
    /// The `_id` of each inserted document, by change index, canonical Extended JSON.
    pub inserted_ids: Vec<(u32, String)>,
}

impl DocApplyOutcome {
    fn new(status: DocApplyStatus, atomic: bool) -> Self {
        Self {
            status,
            atomic,
            applied: Vec::new(),
            conflicts: Vec::new(),
            error: None,
            retryable: false,
            journal_id: None,
            revertible: false,
            inserted_ids: Vec::new(),
        }
    }
}

pub fn read_only_refusal() -> YadbeError {
    YadbeError::new(
        ErrorCode::ReadOnlyViolation,
        "This connection is read-only: documents cannot be changed. Nothing was run.",
        "Cette connexion est en lecture seule : les documents ne peuvent pas être modifiés. Rien n'a été exécuté.",
    )
    .with_action(ErrorAction::EditConnection)
}

fn now_ms(at: SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn index(i: usize) -> u32 {
    u32::try_from(i).unwrap_or(u32::MAX)
}

fn cut(mut text: String) -> String {
    if let Some((at, _)) = text.char_indices().nth(MAX_LINE_CHARS) {
        text.truncate(at);
        text.push_str(" …");
    }
    text
}

/// Whether an apply on this topology runs in one transaction.
pub fn atomic(topology: DocTopology) -> bool {
    matches!(topology, DocTopology::ReplicaSet | DocTopology::Sharded)
}

/// A duplicate `_id` refused an insert.
fn duplicate_key(error: &YadbeError) -> bool {
    let text = format!(
        "{} {}",
        error.message.en,
        error.detail.as_deref().unwrap_or_default()
    );
    text.contains("E11000") || text.contains("code 11000")
}

/// How one operation went.
enum Ran {
    /// It touched its one document.
    Done,
    /// It matched no document (or its insert met an existing `_id`).
    Conflict,
    Failed(YadbeError),
}

fn plan(set: &DocChangeSet) -> Result<Vec<Planned>, YadbeError> {
    let mut ids = new_object_id;
    let planned = edit::plan(set, &mut ids)?;
    if planned.is_empty() {
        return Err(YadbeError::invalid_argument(
            "There is nothing to apply.",
            "Il n'y a rien à appliquer.",
        ));
    }
    Ok(planned)
}

impl super::DocumentService {
    /// The operations Apply would send, in mongosh syntax.
    pub async fn preview_changes(
        &self,
        connection_id: &str,
        set: &DocChangeSet,
    ) -> Result<DocPreview, YadbeError> {
        let session = self.session(connection_id)?;
        let conn = Self::connection(&session)?;
        let planned = plan(set)?;
        let topology = conn.topology();
        let ns = Namespace::new(set.database.clone(), set.collection.clone());
        let mut lines: Vec<DocPreviewLine> = preview_lines(&ns, &planned, atomic(topology))
            .into_iter()
            .map(|mut line| {
                line.text = cut(line.text);
                line
            })
            .collect();
        if lines.len() > MAX_PREVIEW_LINES {
            let more = lines.len() - MAX_PREVIEW_LINES;
            lines.truncate(MAX_PREVIEW_LINES);
            lines.push(DocPreviewLine {
                text: format!("// … {more} more lines"),
                role: edit::DocLineRole::Control,
                edit: None,
            });
        }
        Ok(DocPreview {
            lines,
            operations: index(planned.len()),
            atomic: atomic(topology),
            topology,
        })
    }

    /// Applies a change set (see the module documentation) and journals what was applied.
    pub async fn apply_changes(
        &self,
        connection_id: &str,
        set: &DocChangeSet,
    ) -> Result<DocApplyOutcome, YadbeError> {
        self.apply_inner(connection_id, set, None).await
    }

    async fn run_one(
        &self,
        session: &ConnectionSession,
        ctx: &GateContext,
        conn: &dyn DocumentConnection,
        op: &DocOp,
        transaction: Option<&str>,
    ) -> Ran {
        let request = GateRequest {
            op,
            origin: Origin::Yadbe,
            confirmed: false,
            max_time: session.statement_timeout(),
            token: uuid::Uuid::new_v4().to_string(),
            max_documents: None,
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        match gate::run_in(ctx, conn, request, transaction, tx).await {
            Ok(GateOutcome::Done(DocReply::Document(reply))) => {
                if gate::reply_number(&reply, "n") == Some(1.0) {
                    Ran::Done
                } else {
                    Ran::Conflict
                }
            }
            Ok(GateOutcome::Done(DocReply::Cursor { .. })) => {
                Ran::Failed(YadbeError::internal("a write answered with a cursor"))
            }
            Ok(GateOutcome::Confirm(_)) => Ran::Failed(YadbeError::internal(
                "a guarded single-document write was classified as dangerous",
            )),
            Err(err) if matches!(op, DocOp::Insert { .. }) && duplicate_key(&err) => Ran::Conflict,
            Err(err) => Ran::Failed(err),
        }
    }

    /// The document `id` as the server holds it now (outside any transaction).
    async fn current(
        &self,
        ctx: &GateContext,
        conn: &dyn DocumentConnection,
        ns: &Namespace,
        id: &Json,
    ) -> Option<Json> {
        let op = DocOp::Find {
            ns: ns.clone(),
            filter: Json::object([("_id", id.clone())]),
            options: FindOptions {
                limit: Some(1),
                ..FindOptions::default()
            },
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let collect = async {
            let mut docs = Vec::new();
            while let Some(DocEvent::Documents(batch)) = rx.recv().await {
                docs.extend(batch);
            }
            docs
        };
        let (result, docs) = tokio::join!(gate::run_own(ctx, conn, &op, tx), collect);
        match result {
            Ok(_) => docs.into_iter().next(),
            Err(err) => {
                tracing::debug!(error = %err, "could not read a conflicting document");
                None
            }
        }
    }

    async fn conflicts(
        &self,
        ctx: &GateContext,
        conn: &dyn DocumentConnection,
        ns: &Namespace,
        conflicted: &[&Planned],
    ) -> Vec<DocConflict> {
        let mut out = Vec::with_capacity(conflicted.len());
        for planned in conflicted {
            let current = self.current(ctx, conn, ns, &planned.exact.id()).await;
            out.push(edit::conflict_of(planned, current.as_ref()));
        }
        out
    }

    async fn apply_inner(
        &self,
        connection_id: &str,
        set: &DocChangeSet,
        reverts: Option<u32>,
    ) -> Result<DocApplyOutcome, YadbeError> {
        let session = self.session(connection_id)?;
        let conn = Self::connection(&session)?;
        let ctx = GateContext::of(&session);
        if ctx.read_only {
            return Err(read_only_refusal());
        }
        let planned = plan(set)?;
        let ns = Namespace::new(set.database.clone(), set.collection.clone());
        let atomic = atomic(conn.topology());
        let started_at = SystemTime::now();
        let start = Instant::now();
        let mut outcome = DocApplyOutcome::new(DocApplyStatus::Applied, atomic);
        let mut applied: Vec<&Planned> = Vec::new();
        let mut rows: Vec<f64> = Vec::new();
        if atomic {
            let transaction = gate::begin(&ctx, &*conn).await?;
            let mut conflicted: Vec<&Planned> = Vec::new();
            let mut failure: Option<YadbeError> = None;
            for p in &planned {
                match self
                    .run_one(&session, &ctx, &*conn, &p.op, Some(&transaction))
                    .await
                {
                    Ran::Done => {}
                    Ran::Conflict => {
                        conflicted.push(p);
                        // A duplicate key aborts the transaction on the server.
                        if matches!(p.op, DocOp::Insert { .. }) {
                            break;
                        }
                    }
                    Ran::Failed(err) => {
                        failure = Some(err);
                        break;
                    }
                }
            }
            if failure.is_some() || !conflicted.is_empty() {
                if let Err(err) = gate::abort(&ctx, &*conn, &transaction).await {
                    // An aborted transaction leaves nothing whatever abort answers (the
                    // server aborts it itself after a failure or at its lifetime limit).
                    tracing::debug!(error = %err, "abortTransaction answered an error");
                }
                if let Some(err) = failure {
                    outcome.status = DocApplyStatus::Failed;
                    outcome.retryable = is_transient(&err);
                    outcome.error = Some(err);
                } else {
                    outcome.status = DocApplyStatus::Conflicted;
                    outcome.conflicts = self.conflicts(&ctx, &*conn, &ns, &conflicted).await;
                }
                return Ok(outcome);
            }
            match gate::commit(&ctx, &*conn, &transaction).await {
                Ok(()) => {
                    applied = planned.iter().collect();
                    rows = vec![1.0; applied.len()];
                }
                Err(err) if err.unknown_result => {
                    outcome.status = DocApplyStatus::Uncertain;
                    outcome.error = Some(err.error);
                    return Ok(outcome);
                }
                Err(err) => {
                    outcome.status = DocApplyStatus::Failed;
                    outcome.retryable = err.transient || is_transient(&err.error);
                    outcome.error = Some(err.error);
                    return Ok(outcome);
                }
            }
        } else {
            for p in &planned {
                match self.run_one(&session, &ctx, &*conn, &p.op, None).await {
                    Ran::Done => {
                        applied.push(p);
                        rows.push(1.0);
                    }
                    Ran::Conflict => {
                        outcome.status = DocApplyStatus::Conflicted;
                        outcome.conflicts = self.conflicts(&ctx, &*conn, &ns, &[p]).await;
                        break;
                    }
                    Ran::Failed(err) => {
                        outcome.status = DocApplyStatus::Failed;
                        outcome.error = Some(err);
                        break;
                    }
                }
            }
        }
        let duration_ms = (start.elapsed().as_secs_f64() * 1000.0).round();
        outcome.applied = applied.iter().map(|p| index(p.edit)).collect();
        outcome.inserted_ids = applied
            .iter()
            .filter(|p| matches!(p.op, DocOp::Insert { .. }))
            .map(|p| (index(p.edit), p.exact.id().to_text()))
            .collect();
        if applied.is_empty() {
            return Ok(outcome);
        }
        let complete = outcome.status == DocApplyStatus::Applied;
        if let Some(journal) = &self.journal {
            let back = edit::inverse(set, &applied);
            let (inverse, inverse_statements, blocker) = match serde_json::to_string(&back) {
                Ok(json) if json.len() <= MAX_INVERSE_BYTES => {
                    let mut ids = new_object_id;
                    let lines = edit::plan(&back, &mut ids)
                        .map(|p| p.iter().map(|p| shell_op(&p.op)).collect())
                        .unwrap_or_default();
                    (Some(json), lines, None)
                }
                Ok(_) => (None, Vec::new(), Some(RevertBlocker::TooLarge)),
                Err(_) => (None, Vec::new(), Some(RevertBlocker::NotPlannable)),
            };
            outcome.revertible = blocker.is_none();
            let (updated, inserted, deleted) = edit::counts(&applied);
            outcome.journal_id = journal
                .record(NewJournalEntry {
                    connection_id: connection_id.to_owned(),
                    connection_name: journal.connection_name(connection_id),
                    engine: session.target().engine,
                    target_kind: JournalTargetKind::Collection,
                    table: ObjectRef {
                        database: set.database.clone(),
                        schema: None,
                        name: set.collection.clone(),
                    },
                    applied_at_ms: now_ms(started_at),
                    duration_ms,
                    updated,
                    inserted,
                    deleted,
                    statements: applied
                        .iter()
                        .zip(rows)
                        .map(|(p, n)| JournalStatement {
                            sql: shell_op(&p.op),
                            rows_affected: Some(n),
                        })
                        .collect(),
                    inverse,
                    inverse_statements,
                    blocker,
                    // A revert stopped half-way does not mark the entry reverted.
                    reverts: reverts.filter(|_| complete).map(i64::from),
                })
                .await
                .and_then(|id| u32::try_from(id).ok());
        }
        Ok(outcome)
    }

    fn revert_set(&self, connection_id: &str, entry_id: u32) -> Result<DocChangeSet, YadbeError> {
        let journal = self
            .journal
            .as_ref()
            .ok_or_else(|| YadbeError::internal("no change journal"))?;
        let (_, inverse) = journal.revertible(entry_id, connection_id, EngineFamily::Document)?;
        serde_json::from_str(&inverse).map_err(|e| {
            YadbeError::invalid_argument(
                "This change set cannot be reverted: its journal entry is unreadable.",
                "Cet ensemble de modifications ne peut pas être annulé : son entrée de journal est illisible.",
            )
            .with_detail(e.to_string())
        })
    }

    /// What reverting journal entry `entry_id` would run.
    pub async fn preview_revert(
        &self,
        connection_id: &str,
        entry_id: u32,
    ) -> Result<DocPreview, YadbeError> {
        let set = self.revert_set(connection_id, entry_id)?;
        self.preview_changes(connection_id, &set).await
    }

    /// Reverts journal entry `entry_id`: its inverse applied with the same checks.
    pub async fn apply_revert(
        &self,
        connection_id: &str,
        entry_id: u32,
    ) -> Result<DocApplyOutcome, YadbeError> {
        let set = self.revert_set(connection_id, entry_id)?;
        self.apply_inner(connection_id, &set, Some(entry_id)).await
    }
}
