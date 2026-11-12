//! Applying key-value edits (M4-6, rule 10): the change set planned by
//! [`crate::db::keyvalue::edit`] runs on a connection of its own, in three round trips through
//! the gate:
//!
//! 1. `WATCH` the keys, then the checks (what the user saw) and the sizes of the keys to
//!    snapshot. A check that fails is a conflict: `UNWATCH`, nothing runs.
//! 2. The snapshots kept for the journal (`DUMP` + `PEXPIRETIME`), when they fit the bound.
//! 3. `MULTI`, the commands, the reads of what they leave, `EXEC`. An aborted `EXEC` (a
//!    watched key changed in between) is a conflict too: the checks are read again to say
//!    which.
//!
//! `WATCH` holds for one connection, and the multiplexed connection of the session carries
//! every other command of the explorer and the key tabs: each database gets an editing
//! connection of its own, opened on first use and held by one apply at a time. After a
//! failure whose effect on the connection is unknown (timeout, lost link), it is closed and
//! the next apply opens another.
//!
//! A namespace is deleted by batches (`SCAN … MATCH prefix*`, then per batch `MULTI`, the
//! snapshots, `UNLINK`, `EXEC`): each batch is atomic, the whole is not, which the
//! confirmation says.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use serde::Serialize;
use specta::Type;

use crate::db::driver::KeyValueConnection;
use crate::db::engine::EngineFamily;
use crate::db::errors::{ErrorCode, LocalizedText, YadbeError};
use crate::db::keyvalue::edit::{
    self, KvChangeSet, KvConflict, KvConflictKind, KvEdit, KvPlan, KvPreviewLine, MANY_KEYS,
    MAX_SNAPSHOT_BYTES, Observed, key_text, prefix_pattern, read_snapshots, shown_command,
    snapshot_reads,
};
use crate::db::keyvalue::{KvBytes, KvCommand, KvReply};
use crate::db::meta::ObjectRef;
use crate::events::BackendEvent;
use crate::session::history_hook::NoHistory;
use crate::session::journal::ChangeJournal;
use crate::session::keyvalue::Pool;
use crate::session::keyvalue::model::KvScanProgress;
use crate::store::{JournalStatement, JournalTargetKind, NewJournalEntry, RevertBlocker};

/// Keys read and deleted per batch of a namespace deletion.
pub const NAMESPACE_BATCH: usize = 500;
/// Keys one transaction watches at most. `WATCH` costs the server the square of the keys a
/// client watches (it looks for each new key in the client's list): 40 000 keys block a
/// server for seconds. Above it, a change set runs as batches of this many keys, each one
/// checked and atomic; all their checks pass first.
pub const MAX_WATCHED_KEYS: usize = 500;
/// Preview lines sent; the rest are counted.
const MAX_PREVIEW_LINES: usize = 2_000;
/// Keys a namespace preview names.
const NAMESPACE_SAMPLE: usize = 20;

/// A change set that needs a confirmation of its concrete effect.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KvEditDangerKind {
    /// Deletes this many keys at once.
    DeleteKeys { count: u32 },
    /// A rename replaces an existing key.
    Overwrite { key: KvBytes, to: KvBytes },
    /// Changes the time to live of this many keys at once.
    ExpireMany { count: u32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvEditDanger {
    pub kind: KvEditDangerKind,
    /// Measured on the server (`Deletes 12 keys; 11 exist now`).
    pub effect: LocalizedText,
}

/// What Apply would run.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvPreview {
    /// Every command in order, as `redis-cli` takes it (long values cut, snapshots named).
    pub lines: Vec<KvPreviewLine>,
    /// Commands that change data (between `MULTI` and `EXEC`).
    pub commands: u32,
    /// Transactions it runs in: 1, or batches of [`MAX_WATCHED_KEYS`] keys for a change set
    /// on more keys (each batch atomic, the whole not).
    pub batches: u32,
    pub dangers: Vec<KvEditDanger>,
}

/// What an apply did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KvApplyOutcome {
    /// Everything ran in one transaction.
    Applied {
        database: u32,
        /// The journal entry; `null` when the journal could not be written.
        journal_id: Option<u32>,
        /// The entry can be reverted (its snapshots fit the bound).
        revertible: bool,
        /// Keys created and deleted (renames are both), for the explorer.
        added: Vec<KvBytes>,
        removed: Vec<KvBytes>,
    },
    /// Nothing ran: the server no longer holds what the user saw.
    Conflicted { conflicts: Vec<KvConflict> },
    /// Nothing ran: confirm these effects, then apply again with `confirmed`.
    NeedsConfirmation { dangers: Vec<KvEditDanger> },
}

/// What deleting a namespace would delete.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvNamespaceCount {
    /// The `SCAN` pattern, as `redis-cli` shows it.
    pub pattern: String,
    /// Keys under the prefix now (a full `SCAN`).
    pub keys: f64,
    /// The first keys found.
    pub sample: Vec<KvBytes>,
    /// Snapshot bytes the journal keeps to restore deleted keys.
    pub snapshot_bound: f64,
}

/// What a namespace deletion did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvNamespaceDeleted {
    pub deleted: f64,
    pub batches: u32,
    pub journal_id: Option<u32>,
    /// Every deleted key fit the snapshot bound: the entry can be reverted.
    pub revertible: bool,
}

pub fn read_only_refusal() -> YadbeError {
    YadbeError::new(
        ErrorCode::ReadOnlyViolation,
        "This connection is read-only: keys cannot be changed. Nothing was run.",
        "Cette connexion est en lecture seule : les clés ne peuvent pas être modifiées. Rien n'a été exécuté.",
    )
    .with_action(crate::db::errors::ErrorAction::EditConnection)
}

fn tombstone() -> Vec<u8> {
    format!("yadbe:removed:{}", uuid::Uuid::new_v4().simple()).into_bytes()
}

fn now_ms(at: SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The dangers of a change set, before measuring them.
fn danger_kinds(set: &KvChangeSet) -> Vec<KvEditDangerKind> {
    let mut found = Vec::new();
    let deletes = set
        .edits
        .iter()
        .filter(|e| matches!(e, KvEdit::Delete { guard: None, .. }))
        .count();
    if deletes >= MANY_KEYS {
        found.push(KvEditDangerKind::DeleteKeys {
            count: u32::try_from(deletes).unwrap_or(u32::MAX),
        });
    }
    let expires = set
        .edits
        .iter()
        .filter(|e| matches!(e, KvEdit::Expire { .. }))
        .count();
    if expires >= MANY_KEYS {
        found.push(KvEditDangerKind::ExpireMany {
            count: u32::try_from(expires).unwrap_or(u32::MAX),
        });
    }
    for e in &set.edits {
        if let KvEdit::Rename {
            key,
            to,
            overwrite: true,
        } = e
        {
            found.push(KvEditDangerKind::Overwrite {
                key: key.clone(),
                to: to.clone(),
            });
        }
    }
    found
}

/// The single, or joined, name of the keys a change set touches, for the journal.
fn journal_target(set: &KvChangeSet) -> (JournalTargetKind, String) {
    let mut keys: Vec<&KvBytes> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for edit in &set.edits {
        for key in std::iter::once(edit.key()).chain(edit.target()) {
            if seen.insert(key) {
                keys.push(key);
            }
        }
    }
    match keys.as_slice() {
        [one] => (JournalTargetKind::Key, one.text.clone()),
        many => {
            let mut names: Vec<String> = many.iter().take(5).map(|k| k.text.clone()).collect();
            if many.len() > 5 {
                names.push(format!("… ({} keys)", many.len()));
            }
            (JournalTargetKind::Keys, names.join(", "))
        }
    }
}

/// The keys an edit reads or writes.
fn edit_keys(edit: &KvEdit) -> Vec<&KvBytes> {
    std::iter::once(edit.key()).chain(edit.target()).collect()
}

/// A change set as one batch, or, on more than [`MAX_WATCHED_KEYS`] keys, as batches of
/// that many keys (the edits of a key stay together and in order), with the index of each
/// edit in `set`.
fn batches(set: &KvChangeSet) -> Vec<(KvChangeSet, Vec<usize>)> {
    batches_of(set)
}

fn batches_of(set: &KvChangeSet) -> Vec<(KvChangeSet, Vec<usize>)> {
    let mut keys = std::collections::HashSet::new();
    for edit in &set.edits {
        keys.extend(edit_keys(edit));
    }
    if keys.len() <= MAX_WATCHED_KEYS {
        return vec![(set.clone(), (0..set.edits.len()).collect())];
    }
    // Edits grouped by their first key, groups in first-seen order.
    let mut order: Vec<&KvBytes> = Vec::new();
    let mut groups: HashMap<&KvBytes, Vec<usize>> = HashMap::new();
    for (i, edit) in set.edits.iter().enumerate() {
        let entry = groups.entry(edit.key()).or_default();
        if entry.is_empty() {
            order.push(edit.key());
        }
        entry.push(i);
    }
    let mut out = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut current_keys = std::collections::HashSet::new();
    for key in order {
        let group = groups.remove(key).unwrap_or_default();
        let mut group_keys = std::collections::HashSet::new();
        for &i in &group {
            group_keys.extend(edit_keys(&set.edits[i]));
        }
        if !current.is_empty() && current_keys.len() + group_keys.len() > MAX_WATCHED_KEYS {
            out.push(std::mem::take(&mut current));
            current_keys.clear();
        }
        current.extend(group);
        current_keys.extend(group_keys);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out.into_iter()
        .map(|mut indices| {
            indices.sort_unstable();
            let edits = indices.iter().map(|&i| set.edits[i].clone()).collect();
            (
                KvChangeSet {
                    database: set.database,
                    edits,
                },
                indices,
            )
        })
        .collect()
}

fn original_index(indices: &[usize], edit: u32) -> u32 {
    indices
        .get(edit as usize)
        .and_then(|&i| u32::try_from(i).ok())
        .unwrap_or(edit)
}

fn exec_reply(replies: &mut Vec<Result<KvReply, YadbeError>>) -> Result<KvReply, YadbeError> {
    replies
        .pop()
        .unwrap_or_else(|| Err(YadbeError::internal("EXEC reply missing")))
}

impl Pool {
    /// The editing connection of database `db` (opened when needed) under its lock: one apply
    /// at a time per session.
    async fn editing(
        &self,
    ) -> tokio::sync::MutexGuard<'_, HashMap<u32, Arc<dyn KeyValueConnection>>> {
        self.edit_conns.lock().await
    }

    async fn edit_conn(
        &self,
        conns: &mut HashMap<u32, Arc<dyn KeyValueConnection>>,
        db: u32,
    ) -> Result<Arc<dyn KeyValueConnection>, YadbeError> {
        if let Some(conn) = conns.get(&db)
            && !conn.link().is_lost()
        {
            return Ok(Arc::clone(conn));
        }
        let conn = self
            .session
            .open_dedicated(Some(&db.to_string()))
            .await?
            .into_key_value()?;
        if let Some(old) = conns.insert(db, Arc::clone(&conn)) {
            old.close().await;
        }
        Ok(conn)
    }

    /// Forgets an editing connection whose state is unknown.
    async fn drop_edit_conn(&self, conns: &mut HashMap<u32, Arc<dyn KeyValueConnection>>, db: u32) {
        if let Some(conn) = conns.remove(&db) {
            conn.close().await;
        }
    }

    /// Tells the explorer's scan of `db` about keys created and deleted.
    pub(super) fn keys_moved(&self, db: u32, added: &[Vec<u8>], removed: &[Vec<u8>]) {
        let scan = super::lock(&self.scans).get(&db).cloned();
        if let Some(scan) = scan
            && scan.apply_change(added, removed)
        {
            self.sink.emit(BackendEvent::KvScanProgress(KvScanProgress {
                connection_id: self.connection_id.clone(),
                status: scan.status(),
            }));
        }
    }
}

/// Measures the effect of each danger (read-only probes through the gate).
async fn measure(
    pool: &Pool,
    conn: &dyn KeyValueConnection,
    kinds: Vec<KvEditDangerKind>,
    set: &KvChangeSet,
) -> Vec<KvEditDanger> {
    let gate = pool.gate(&NoHistory);
    let mut out = Vec::new();
    for kind in kinds {
        let effect = match &kind {
            KvEditDangerKind::DeleteKeys { count } => {
                let mut exists = vec![b"EXISTS".to_vec()];
                for e in &set.edits {
                    if let KvEdit::Delete { key, guard: None } = e
                        && let Ok(key) = key.to_bytes()
                    {
                        exists.push(key);
                    }
                }
                let now = gate
                    .run_batch(conn, &[KvCommand::new(exists)], false)
                    .await
                    .ok()
                    .and_then(|mut r| r.pop())
                    .and_then(Result::ok)
                    .and_then(|r| r.int())
                    .map_or_else(|| "?".to_owned(), |n| n.to_string());
                LocalizedText::new(
                    format!(
                        "Deletes {count} keys; {now} of them exist now. The journal keeps them (up to {} MB in all) so that they can be restored.",
                        MAX_SNAPSHOT_BYTES / 1024 / 1024
                    ),
                    format!(
                        "Supprime {count} clés ; {now} d'entre elles existent actuellement. Le journal les conserve (jusqu'à {} Mo en tout) pour pouvoir les restaurer.",
                        MAX_SNAPSHOT_BYTES / 1024 / 1024
                    ),
                )
            }
            KvEditDangerKind::ExpireMany { count } => LocalizedText::new(
                format!("Changes the time to live of {count} keys."),
                format!("Modifie la durée de vie de {count} clés."),
            ),
            KvEditDangerKind::Overwrite { key, to } => {
                let target = to.to_bytes().unwrap_or_default();
                let replies = gate
                    .run_batch(
                        conn,
                        &[
                            KvCommand::of([b"TYPE".as_slice(), &target]),
                            KvCommand::of([b"MEMORY".as_slice(), b"USAGE", &target]),
                        ],
                        false,
                    )
                    .await
                    .unwrap_or_default();
                let type_name = replies
                    .first()
                    .and_then(|r| r.as_ref().ok())
                    .and_then(KvReply::text)
                    .unwrap_or_default();
                let memory = replies
                    .get(1)
                    .and_then(|r| r.as_ref().ok())
                    .and_then(KvReply::int)
                    .unwrap_or(0);
                if type_name == "none" || type_name.is_empty() {
                    LocalizedText::new(
                        format!(
                            "Renames \"{}\" to \"{}\", which does not exist now.",
                            key.text, to.text
                        ),
                        format!(
                            "Renomme « {} » en « {} », qui n'existe pas actuellement.",
                            key.text, to.text
                        ),
                    )
                } else {
                    LocalizedText::new(
                        format!(
                            "Replaces the key \"{}\" (a {type_name}, {memory} bytes) with \"{}\": its value is lost unless the change is reverted.",
                            to.text, key.text
                        ),
                        format!(
                            "Remplace la clé « {} » (de type {type_name}, {memory} octets) par « {} » : sa valeur est perdue sauf annulation de la modification.",
                            to.text, key.text
                        ),
                    )
                }
            }
        };
        out.push(KvEditDanger { kind, effect });
    }
    out
}

/// What the transaction left, read from the `EXEC` reply.
struct Executed {
    observed: Observed,
    statements: Vec<JournalStatement>,
}

enum Round {
    Done(Executed),
    Conflicted(Vec<KvConflict>),
}

fn conflicts_of(
    plan: &KvPlan,
    set: &KvChangeSet,
    replies: &[Result<KvReply, YadbeError>],
) -> Vec<KvConflict> {
    let mut out: Vec<KvConflict> = Vec::new();
    for (check, reply) in plan.checks.iter().zip(replies) {
        let key = set.edits[check.edit].key();
        if let Some(conflict) = edit::verdict(check, reply, key) {
            // One conflict per edit: the first check that fails says the most.
            if !out.iter().any(|c| c.edit == conflict.edit) {
                out.push(conflict);
            }
        }
    }
    out
}

/// The three round trips on the editing connection. `Err`: nothing was applied, or the
/// connection's state is unknown (the caller closes it).
async fn transact(
    pool: &Pool,
    conn: &dyn KeyValueConnection,
    plan: &KvPlan,
    set: &KvChangeSet,
) -> Result<Round, YadbeError> {
    let gate = pool.gate(&NoHistory);
    // 1. WATCH, checks, sizes.
    let mut first = vec![plan.watch_command()];
    first.extend(plan.checks.iter().map(|c| c.cmd.clone()));
    first.extend(
        plan.sized
            .iter()
            .map(|k| KvCommand::of([b"MEMORY".as_slice(), b"USAGE", k])),
    );
    let replies = gate.run_batch(conn, &first, true).await?;
    if let Some(Err(err)) = replies.first() {
        return Err(err.clone());
    }
    let checks = &replies[1..1 + plan.checks.len()];
    let conflicts = conflicts_of(plan, set, checks);
    if !conflicts.is_empty() {
        gate.run_batch(conn, &[KvCommand::of(["UNWATCH"])], true)
            .await?;
        return Ok(Round::Conflicted(conflicts));
    }
    let size: u64 = replies[1 + plan.checks.len()..]
        .iter()
        .filter_map(|r| r.as_ref().ok().and_then(KvReply::int))
        .map(|n| u64::try_from(n).unwrap_or(0))
        .sum();
    // Before and after: twice what the keys hold now.
    let snapshots = size.saturating_mul(2) <= MAX_SNAPSHOT_BYTES;

    // 2. Snapshots kept for the revert.
    let mut observed = Observed::default();
    if snapshots && !plan.before.is_empty() {
        let reads = plan.before_reads();
        let replies = gate.run_batch(conn, &reads, true).await?;
        observed.before = read_snapshots(&plan.before, &replies);
    }

    // 3. The transaction.
    let inner = plan.transaction(snapshots);
    let mut cmds = Vec::with_capacity(inner.len() + 2);
    cmds.push(KvCommand::of(["MULTI"]));
    cmds.extend(inner.iter().cloned());
    cmds.push(KvCommand::of(["EXEC"]));
    let mut replies = gate.run_batch(conn, &cmds, true).await?;
    let exec = exec_reply(&mut replies)?;
    let items = match exec {
        // A watched key changed between the checks and EXEC: nothing ran.
        KvReply::Nil => {
            let checks: Vec<KvCommand> = plan.checks.iter().map(|c| c.cmd.clone()).collect();
            let again = gate.run_batch(conn, &checks, true).await?;
            let mut conflicts = conflicts_of(plan, set, &again);
            if conflicts.is_empty() {
                conflicts = plan
                    .watch
                    .iter()
                    .take(1)
                    .map(|key| KvConflict {
                        edit: 0,
                        key: KvBytes::from_bytes(key),
                        kind: KvConflictKind::Aborted,
                        expected: None,
                        current: None,
                        actual_type: None,
                        rebasable: true,
                    })
                    .collect();
            }
            return Ok(Round::Conflicted(conflicts));
        }
        other => other
            .into_items()
            .ok_or_else(|| YadbeError::internal("unexpected EXEC reply"))?,
    };
    let steps = plan.steps.len();
    let statements: Vec<JournalStatement> = plan
        .steps
        .iter()
        .zip(&items)
        .map(|(step, reply)| JournalStatement {
            sql: shown_command(&step.cmd),
            rows_affected: reply.int().map(|n| n as f64),
        })
        .collect();
    if let Some(failed) = items.iter().take(steps).find_map(|r| match r {
        KvReply::Error(message) => Some(message.clone()),
        _ => None,
    }) {
        // The checks are meant to make this impossible; Redis does not roll back the others.
        return Err(YadbeError::new(
            ErrorCode::QueryFailed,
            "A command failed inside the transaction and Redis does not roll back the others: the change was applied partly. Read the key again before going on.",
            "Une commande a échoué dans la transaction et Redis n'annule pas les autres : la modification a été appliquée en partie. Relisez la clé avant de continuer.",
        )
        .with_detail(failed));
    }
    observed.step_replies = items[..steps.min(items.len())].to_vec();
    let rest = &items[steps.min(items.len())..];
    let mut at = 0;
    if snapshots {
        let after_replies: Vec<Result<KvReply, YadbeError>> = rest
            .iter()
            .take(plan.after.len() * 2)
            .cloned()
            .map(Ok)
            .collect();
        observed.after = read_snapshots(&plan.after, &after_replies);
        at = plan.after.len() * 2;
    }
    for (i, key) in plan.expiry_after.iter().enumerate() {
        let expiry = rest
            .get(at + i)
            .and_then(KvReply::int)
            .filter(|ms| *ms >= 0);
        observed.expiry_after.insert(key.clone(), expiry);
    }
    Ok(Round::Done(Executed {
        observed,
        statements,
    }))
}

impl super::KeyValueService {
    pub fn with_journal(mut self, journal: Arc<ChangeJournal>) -> Self {
        self.journal = Some(journal);
        self
    }

    /// The commands Apply would run, and the dangers to confirm with their effect.
    pub async fn preview_changes(
        &self,
        connection_id: &str,
        set: &KvChangeSet,
    ) -> Result<KvPreview, YadbeError> {
        let pool = self.pool(connection_id)?;
        let batches = batches(set);
        let mut lines = Vec::new();
        let mut commands = 0_usize;
        for (batch, _) in &batches {
            let plan = edit::plan(batch, tombstone())?;
            commands += plan.steps.len();
            if lines.len() < MAX_PREVIEW_LINES {
                lines.extend(plan.preview());
            }
        }
        if lines.len() > MAX_PREVIEW_LINES {
            let more = lines.len() - MAX_PREVIEW_LINES;
            lines.truncate(MAX_PREVIEW_LINES);
            lines.push(KvPreviewLine {
                text: format!("… {more} more lines"),
                role: edit::KvLineRole::Control,
            });
        }
        let kinds = danger_kinds(set);
        let dangers = if kinds.is_empty() {
            Vec::new()
        } else {
            let conn = pool.conn(set.database).await?;
            measure(&pool, &*conn, kinds, set).await
        };
        Ok(KvPreview {
            lines,
            commands: u32::try_from(commands).unwrap_or(u32::MAX),
            batches: u32::try_from(batches.len()).unwrap_or(u32::MAX),
            dangers,
        })
    }

    /// Applies a change set in one checked transaction and journals it.
    pub async fn apply_changes(
        &self,
        connection_id: &str,
        set: &KvChangeSet,
        confirmed: bool,
    ) -> Result<KvApplyOutcome, YadbeError> {
        self.apply_inner(connection_id, set, confirmed, None).await
    }

    async fn apply_inner(
        &self,
        connection_id: &str,
        set: &KvChangeSet,
        confirmed: bool,
        reverts: Option<u32>,
    ) -> Result<KvApplyOutcome, YadbeError> {
        let pool = self.pool(connection_id)?;
        if pool.session().read_only() {
            return Err(read_only_refusal());
        }
        let db = set.database;
        let batches: Vec<(KvChangeSet, KvPlan, Vec<usize>)> = batches(set)
            .into_iter()
            .map(|(batch, indices)| {
                let plan = edit::plan(&batch, tombstone())?;
                Ok((batch, plan, indices))
            })
            .collect::<Result<_, YadbeError>>()?;
        let kinds = danger_kinds(set);
        if !kinds.is_empty() && !confirmed {
            let conn = pool.conn(db).await?;
            return Ok(KvApplyOutcome::NeedsConfirmation {
                dangers: measure(&pool, &*conn, kinds, set).await,
            });
        }
        let started_at = SystemTime::now();
        let start = Instant::now();
        let mut done: Vec<(&KvChangeSet, &KvPlan, Executed)> = Vec::new();
        let mut stopped: Option<Vec<KvConflict>> = None;
        {
            let mut conns = pool.editing().await;
            let conn = pool.edit_conn(&mut conns, db).await?;
            // Many keys: every check first, so that a stale change set applies nothing.
            if batches.len() > 1 {
                let gate = pool.gate(&NoHistory);
                let mut conflicts = Vec::new();
                for (batch, plan, indices) in &batches {
                    let checks: Vec<KvCommand> =
                        plan.checks.iter().map(|c| c.cmd.clone()).collect();
                    let replies = match gate.run_batch(&*conn, &checks, true).await {
                        Ok(replies) => replies,
                        Err(err) => {
                            pool.drop_edit_conn(&mut conns, db).await;
                            return Err(err);
                        }
                    };
                    conflicts.extend(conflicts_of(plan, batch, &replies).into_iter().map(
                        |mut c| {
                            c.edit = original_index(indices, c.edit);
                            c
                        },
                    ));
                }
                if !conflicts.is_empty() {
                    return Ok(KvApplyOutcome::Conflicted { conflicts });
                }
            }
            for (batch, plan, indices) in &batches {
                match transact(&pool, &*conn, plan, batch).await {
                    Ok(Round::Done(executed)) => done.push((batch, plan, executed)),
                    Ok(Round::Conflicted(conflicts)) => {
                        let conflicts: Vec<KvConflict> = conflicts
                            .into_iter()
                            .map(|mut c| {
                                c.edit = original_index(indices, c.edit);
                                c
                            })
                            .collect();
                        if done.is_empty() {
                            return Ok(KvApplyOutcome::Conflicted { conflicts });
                        }
                        stopped = Some(conflicts);
                        break;
                    }
                    Err(err) => {
                        // Possibly mid-transaction (timeout, lost link): never reuse it.
                        if err.code != ErrorCode::ReadOnlyViolation {
                            pool.drop_edit_conn(&mut conns, db).await;
                        }
                        if done.is_empty() {
                            return Err(err);
                        }
                        stopped = Some(Vec::new());
                        break;
                    }
                }
            }
        }
        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
        // What ran: every batch, or those before the one that stopped.
        let applied = KvChangeSet {
            database: db,
            edits: done
                .iter()
                .flat_map(|(batch, _, _)| batch.edits.iter().cloned())
                .collect(),
        };
        let (added, removed) = edit::key_moves(&applied);
        let raw = |keys: &[KvBytes]| -> Vec<Vec<u8>> {
            keys.iter().filter_map(|k| k.to_bytes().ok()).collect()
        };
        pool.keys_moved(db, &raw(&added), &raw(&removed));

        let mut inverse: Result<Vec<KvEdit>, RevertBlocker> = Ok(Vec::new());
        for (batch, plan, executed) in done.iter().rev() {
            inverse = inverse.and_then(|mut edits| {
                edits.extend(edit::inverse(batch, plan, &executed.observed)?.edits);
                Ok(edits)
            });
        }
        // A part of a change set is not reverted as if it were the whole.
        let complete = stopped.is_none();
        let inverse = inverse.map(|edits| KvChangeSet {
            database: db,
            edits,
        });
        let revertible = inverse.is_ok();
        let statements: Vec<JournalStatement> = done
            .into_iter()
            .flat_map(|(_, _, executed)| executed.statements)
            .collect();
        let journal_id = match &self.journal {
            Some(journal) => {
                let (updated, inserted, deleted) = edit::counts(&applied);
                let (target_kind, name) = journal_target(&applied);
                let (inverse_json, inverse_statements, blocker) = match inverse {
                    Ok(back) => {
                        let mut lines = Vec::new();
                        for (batch, _) in batches_of(&back) {
                            if lines.len() >= crate::session::keyvalue::gate::BATCH_LOG_LINES {
                                lines.push("…".to_owned());
                                break;
                            }
                            if let Ok(plan) = edit::plan(&batch, b"<tombstone>".to_vec()) {
                                lines.extend(plan.steps.iter().map(|s| shown_command(&s.cmd)));
                            }
                        }
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
                        engine: pool.session().target().engine,
                        target_kind,
                        table: ObjectRef {
                            database: db.to_string(),
                            schema: None,
                            name,
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
            None => None,
        };
        if let Some(conflicts) = stopped {
            let keys = applied.edits.len();
            let mut err = YadbeError::new(
                ErrorCode::QueryFailed,
                format!(
                    "The change was stopped after {keys} of {} changes: a key changed meanwhile. What was applied is in the journal and can be reverted from there.",
                    set.edits.len()
                ),
                format!(
                    "La modification s'est arrêtée après {keys} changements sur {} : une clé a changé entre-temps. Ce qui a été appliqué est dans le journal et peut être annulé depuis celui-ci.",
                    set.edits.len()
                ),
            );
            if let Some(first) = conflicts.first() {
                err = err.with_detail(format!("{:?} on {}", first.kind, first.key.text));
            }
            return Err(err);
        }
        Ok(KvApplyOutcome::Applied {
            database: db,
            journal_id,
            revertible,
            added,
            removed,
        })
    }

    fn revert_set(&self, connection_id: &str, entry_id: u32) -> Result<KvChangeSet, YadbeError> {
        let journal = self
            .journal
            .as_ref()
            .ok_or_else(|| YadbeError::internal("no change journal"))?;
        let (_, inverse) = journal.revertible(entry_id, connection_id, EngineFamily::KeyValue)?;
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
    ) -> Result<KvPreview, YadbeError> {
        let set = self.revert_set(connection_id, entry_id)?;
        let mut preview = self.preview_changes(connection_id, &set).await?;
        // The revert of a confirmed change is not asked again.
        preview.dangers.clear();
        Ok(preview)
    }

    /// Reverts journal entry `entry_id`: its inverse applied with the same checks.
    pub async fn apply_revert(
        &self,
        connection_id: &str,
        entry_id: u32,
    ) -> Result<KvApplyOutcome, YadbeError> {
        let set = self.revert_set(connection_id, entry_id)?;
        self.apply_inner(connection_id, &set, true, Some(entry_id))
            .await
    }

    /// The keys under `prefix` in database `db`, counted with a full `SCAN`.
    pub async fn namespace_count(
        &self,
        connection_id: &str,
        db: u32,
        prefix: &KvBytes,
    ) -> Result<KvNamespaceCount, YadbeError> {
        let pool = self.pool(connection_id)?;
        let pattern = prefix_pattern(&prefix.to_bytes()?);
        let conn = pool.conn(db).await?;
        let gate = pool.gate(&NoHistory);
        let mut cursor = 0_u64;
        let mut keys = 0_u64;
        let mut sample = Vec::new();
        let started_at = SystemTime::now();
        let start = Instant::now();
        loop {
            let cmd = scan_command(cursor, &pattern);
            let reply = gate
                .run(&*conn, &cmd, super::gate::Origin::Batched, false)
                .await;
            let (next, found) = match reply.and_then(scan_reply) {
                Ok(page) => page,
                Err(err) => {
                    gate.log_batch(
                        scan_command(0, &pattern).display(),
                        started_at,
                        start.elapsed(),
                        Err(err.clone()),
                    );
                    return Err(err);
                }
            };
            keys += found.len() as u64;
            for key in found {
                if sample.len() < NAMESPACE_SAMPLE {
                    sample.push(KvBytes::from_bytes(&key));
                }
            }
            cursor = next;
            if cursor == 0 {
                break;
            }
        }
        gate.log_batch(
            format!(
                "{}  -- full scan, {keys} keys",
                scan_command(0, &pattern).display()
            ),
            started_at,
            start.elapsed(),
            Ok(Some(keys)),
        );
        sample.sort_by(|a, b| a.text.cmp(&b.text));
        Ok(KvNamespaceCount {
            pattern: crate::db::keyvalue::command::quote(&pattern),
            keys: keys as f64,
            sample,
            snapshot_bound: MAX_SNAPSHOT_BYTES as f64,
        })
    }

    /// Deletes every key under `prefix` by batches (see the module comment) and journals
    /// them, restorable when they fit the snapshot bound.
    pub async fn delete_namespace(
        &self,
        connection_id: &str,
        db: u32,
        prefix: &KvBytes,
    ) -> Result<KvNamespaceDeleted, YadbeError> {
        let pool = self.pool(connection_id)?;
        if pool.session().read_only() {
            return Err(read_only_refusal());
        }
        let prefix_bytes = prefix.to_bytes()?;
        if prefix_bytes.is_empty() {
            return Err(YadbeError::invalid_argument(
                "A namespace needs a prefix; to empty a database, use FLUSHDB in the console.",
                "Un espace de noms a besoin d'un préfixe ; pour vider une base, utilisez FLUSHDB dans la console.",
            ));
        }
        let pattern = prefix_pattern(&prefix_bytes);
        let started_at = SystemTime::now();
        let start = Instant::now();
        let mut conns = pool.editing().await;
        let conn = pool.edit_conn(&mut conns, db).await?;
        let gate = pool.gate(&NoHistory);
        let mut cursor = 0_u64;
        let mut deleted = 0_u64;
        let mut batches = 0_u32;
        let mut kept: u64 = 0;
        let mut over_bound = false;
        let mut restores: Vec<KvEdit> = Vec::new();
        let mut statements = Vec::new();
        let mut removed_keys: Vec<Vec<u8>> = Vec::new();
        let failure = loop {
            let found = match gate
                .run_batch(&*conn, &[scan_command(cursor, &pattern)], false)
                .await
                .and_then(|mut r| exec_reply(&mut r))
                .and_then(scan_reply)
            {
                Ok(page) => page,
                Err(err) => break Some(err),
            };
            let (next, keys) = found;
            cursor = next;
            for chunk in keys.chunks(NAMESPACE_BATCH) {
                // Which keys of the batch the journal can keep.
                let mut dumped: Vec<Vec<u8>> = Vec::new();
                if !over_bound {
                    let sizes: Vec<KvCommand> = chunk
                        .iter()
                        .map(|k| KvCommand::of([b"MEMORY".as_slice(), b"USAGE", k]))
                        .collect();
                    match gate.run_batch(&*conn, &sizes, false).await {
                        Ok(replies) => {
                            for (key, size) in chunk.iter().zip(replies) {
                                let size = size
                                    .ok()
                                    .and_then(|r| r.int())
                                    .and_then(|n| u64::try_from(n).ok())
                                    .unwrap_or(0);
                                if over_bound || kept + size > MAX_SNAPSHOT_BYTES {
                                    over_bound = true;
                                } else {
                                    kept += size;
                                    dumped.push(key.clone());
                                }
                            }
                        }
                        Err(_) => over_bound = true,
                    }
                }
                let mut unlink = vec![b"UNLINK".to_vec()];
                unlink.extend(chunk.iter().cloned());
                let unlink = KvCommand::new(unlink);
                let mut cmds = vec![KvCommand::of(["MULTI"])];
                cmds.extend(snapshot_reads(&dumped));
                cmds.push(unlink.clone());
                cmds.push(KvCommand::of(["EXEC"]));
                let items = match gate
                    .run_batch(&*conn, &cmds, true)
                    .await
                    .and_then(|mut r| exec_reply(&mut r))
                    .and_then(|exec| {
                        exec.into_items()
                            .ok_or_else(|| YadbeError::internal("unexpected EXEC reply"))
                    }) {
                    Ok(items) => items,
                    Err(err) => {
                        pool.drop_edit_conn(&mut conns, db).await;
                        return Err(self
                            .namespace_failed(
                                &pool,
                                connection_id,
                                db,
                                &pattern,
                                started_at,
                                start,
                                statements,
                                deleted,
                                removed_keys,
                                err,
                            )
                            .await);
                    }
                };
                batches += 1;
                let snaps: Vec<Result<KvReply, YadbeError>> = items
                    .iter()
                    .take(dumped.len() * 2)
                    .cloned()
                    .map(Ok)
                    .collect();
                let snapshots = read_snapshots(&dumped, &snaps);
                for key in &dumped {
                    if let Some(Some(snapshot)) = snapshots.get(key) {
                        restores.push(KvEdit::Restore {
                            key: KvBytes::from_bytes(key),
                            snapshot: snapshot.clone(),
                            replace: None,
                        });
                    }
                }
                let count = items
                    .get(dumped.len() * 2)
                    .and_then(KvReply::int)
                    .unwrap_or(0);
                deleted += u64::try_from(count).unwrap_or(0);
                statements.push(JournalStatement {
                    sql: shown_command(&unlink),
                    rows_affected: Some(count as f64),
                });
                removed_keys.extend(chunk.iter().cloned());
            }
            if cursor == 0 {
                break None;
            }
        };
        drop(conns);
        if let Some(err) = failure {
            return Err(self
                .namespace_failed(
                    &pool,
                    connection_id,
                    db,
                    &pattern,
                    started_at,
                    start,
                    statements,
                    deleted,
                    removed_keys,
                    err,
                )
                .await);
        }
        pool.keys_moved(db, &[], &removed_keys);
        let revertible = !over_bound && !restores.is_empty();
        let journal_id = if deleted > 0 {
            self.record_namespace(
                &pool,
                connection_id,
                db,
                &pattern,
                started_at,
                start,
                statements,
                deleted,
                (!over_bound).then_some(restores),
            )
            .await
        } else {
            None
        };
        Ok(KvNamespaceDeleted {
            deleted: deleted as f64,
            batches,
            journal_id,
            revertible,
        })
    }

    /// A namespace deletion stopped by an error: what was deleted is journaled (not
    /// revertible: only part of it ran) and the error says how far it went.
    #[allow(clippy::too_many_arguments)]
    async fn namespace_failed(
        &self,
        pool: &Pool,
        connection_id: &str,
        db: u32,
        pattern: &[u8],
        started_at: SystemTime,
        start: Instant,
        statements: Vec<JournalStatement>,
        deleted: u64,
        removed_keys: Vec<Vec<u8>>,
        err: YadbeError,
    ) -> YadbeError {
        pool.keys_moved(db, &[], &removed_keys);
        if deleted > 0 {
            self.record_namespace(
                pool,
                connection_id,
                db,
                pattern,
                started_at,
                start,
                statements,
                deleted,
                None,
            )
            .await;
        }
        YadbeError {
            message: LocalizedText::new(
                format!(
                    "{} {deleted} keys were deleted before the failure (in the journal).",
                    err.message.en
                ),
                format!(
                    "{} {deleted} clés ont été supprimées avant l'échec (dans le journal).",
                    err.message.fr
                ),
            ),
            ..err
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_namespace(
        &self,
        pool: &Pool,
        connection_id: &str,
        db: u32,
        pattern: &[u8],
        started_at: SystemTime,
        start: Instant,
        statements: Vec<JournalStatement>,
        deleted: u64,
        restores: Option<Vec<KvEdit>>,
    ) -> Option<u32> {
        let journal = self.journal.as_ref()?;
        let (inverse, inverse_statements, blocker) = match restores {
            Some(edits) if !edits.is_empty() => {
                let set = KvChangeSet {
                    database: db,
                    edits,
                };
                let lines: Vec<String> = set
                    .edits
                    .iter()
                    .take(crate::session::keyvalue::gate::BATCH_LOG_LINES)
                    .map(|e| match e {
                        KvEdit::Restore { key, snapshot, .. } => format!(
                            "RESTORE {} … <DUMP payload, {} bytes>",
                            crate::db::keyvalue::command::quote(
                                &key.to_bytes().unwrap_or_default()
                            ),
                            snapshot.payload().map(|p| p.len()).unwrap_or(0)
                        ),
                        _ => String::new(),
                    })
                    .collect();
                match serde_json::to_string(&set) {
                    Ok(json) if json.len() <= crate::store::MAX_INVERSE_BYTES => {
                        (Some(json), lines, None)
                    }
                    _ => (None, Vec::new(), Some(RevertBlocker::TooLarge)),
                }
            }
            Some(_) => (None, Vec::new(), Some(RevertBlocker::NotPlannable)),
            None => (None, Vec::new(), Some(RevertBlocker::TooLarge)),
        };
        journal
            .record(NewJournalEntry {
                connection_id: connection_id.to_owned(),
                connection_name: journal.connection_name(connection_id),
                engine: pool.session().target().engine,
                target_kind: JournalTargetKind::Namespace,
                table: ObjectRef {
                    database: db.to_string(),
                    schema: None,
                    name: key_text(pattern),
                },
                applied_at_ms: now_ms(started_at),
                duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                updated: 0,
                inserted: 0,
                deleted: u32::try_from(deleted).unwrap_or(u32::MAX),
                statements,
                inverse,
                inverse_statements,
                blocker,
                reverts: None,
            })
            .await
            .and_then(|id| u32::try_from(id).ok())
    }
}

fn scan_command(cursor: u64, pattern: &[u8]) -> KvCommand {
    KvCommand::new(vec![
        b"SCAN".to_vec(),
        cursor.to_string().into_bytes(),
        b"MATCH".to_vec(),
        pattern.to_vec(),
        b"COUNT".to_vec(),
        b"1000".to_vec(),
    ])
}

fn scan_reply(reply: KvReply) -> Result<(u64, Vec<Vec<u8>>), YadbeError> {
    let malformed = || YadbeError::internal("unexpected SCAN reply");
    let mut items = reply.into_items().ok_or_else(malformed)?.into_iter();
    let cursor = items
        .next()
        .and_then(|c| c.text())
        .and_then(|c| c.parse::<u64>().ok())
        .ok_or_else(malformed)?;
    let keys = items
        .next()
        .and_then(KvReply::into_items)
        .ok_or_else(malformed)?
        .into_iter()
        .filter_map(|k| k.bytes())
        .collect();
    Ok((cursor, keys))
}
