//! Key-value edits (M4-6): what a key tab or the explorer asks to change, planned as the
//! commands of one `WATCH` / `MULTI` / `EXEC` transaction (rule 10).
//!
//! Every edit carries what the user saw of what it changes (`original`). The plan has three
//! parts, all built here without a server:
//!
//! 1. **Checks**, read under `WATCH` before the transaction: the type of every key touched and
//!    the value each edit replaces. A mismatch is a conflict and nothing runs.
//! 2. **Commands**, queued between `MULTI` and `EXEC`. Redis does not roll back a command
//!    that fails inside `EXEC`, so every way a queued command could fail at run time (wrong
//!    type, missing key, index out of range, JSON path absent, target key present) is one of
//!    the checks: once they pass under `WATCH`, `EXEC` either runs everything or nothing (the
//!    watched keys changed in between: a conflict as well).
//! 3. **Snapshots** for the journal: `DUMP` + `PEXPIRETIME` of keys whose change cannot be
//!    reverted edit by edit (deleted keys, list removals, stream deletions, an overwritten
//!    rename target), read before; and of keys created, read inside the transaction, so that
//!    a revert can check they are still exactly what the apply left.
//!
//! A list element is removed by index safely: Redis has `LREM` by value only. Inside the
//! transaction the element is first replaced by a tombstone unique to the apply (`LSET key
//! index tombstone`), then the tombstones are removed (`LREM key 0 tombstone`). Under `WATCH`
//! the checks make sure the element at that index is still the one the user saw and that the
//! tombstone appears nowhere in the list (`LPOS`), so exactly the chosen elements go.
//!
//! The inverse of a change set is another change set ([`inverse`]): a revert is an apply, with
//! the same checks. Edits are reverted one by one where that is exact (a hash field back to
//! its value, a member back to its score, pushed elements popped); a key whose change cannot
//! be undone that way comes back whole from its snapshot (`RESTORE … REPLACE`), guarded by the
//! snapshot taken after the apply.

use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::bytes::escape;
use super::command::quote;
use super::{KvBytes, KvCommand, KvReply};
use crate::db::errors::YadbeError;
use crate::store::RevertBlocker;

/// Snapshots (`DUMP`) kept for the journal of one change set, in bytes of `MEMORY USAGE`:
/// above it, the change set is applied and journaled but cannot be reverted.
pub const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
/// Deleting or changing the time to live of this many keys at once is confirmed.
pub const MANY_KEYS: usize = 10;
/// Characters of one argument shown in a preview or the journal; longer ones are cut with
/// their size.
pub const SHOWN_ARG_CHARS: usize = 512;

/// A hash field or a stream entry field with its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvField {
    pub field: KvBytes,
    pub value: KvBytes,
}

/// A sorted set member with its score. Scores travel as text (`1.5`, `-inf`): a JSON number
/// cannot hold an infinite score.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvScored {
    pub member: KvBytes,
    pub score: String,
}

/// A whole key as `DUMP` serializes it, with its absolute expiry: what `RESTORE` brings back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvSnapshot {
    /// The `DUMP` payload, base64.
    pub dump: String,
    /// Unix time in milliseconds when the key expires (`PEXPIRETIME`); `null`: never.
    pub expire_at: Option<f64>,
}

impl KvSnapshot {
    pub fn payload(&self) -> Result<Vec<u8>, YadbeError> {
        STANDARD.decode(&self.dump).map_err(|e| {
            YadbeError::invalid_argument(
                "A key snapshot is not valid base64.",
                "Un instantané de clé n'est pas du base64 valide.",
            )
            .with_detail(e.to_string())
        })
    }

    pub fn of(dump: &[u8], expire_at: Option<i64>) -> Self {
        Self {
            dump: STANDARD.encode(dump),
            expire_at: expire_at.map(|ms| ms as f64),
        }
    }
}

/// A new time to live.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KvTtl {
    /// No expiry (`PERSIST`).
    Persist,
    /// Expires `ms` milliseconds after the apply (`PEXPIRE`).
    In { ms: f64 },
    /// Expires at this Unix time in milliseconds (`PEXPIREAT`).
    At { ms: f64 },
}

/// The first content of a key created by the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KvNewValue {
    String {
        value: KvBytes,
    },
    Hash {
        fields: Vec<KvField>,
    },
    List {
        values: Vec<KvBytes>,
    },
    Set {
        members: Vec<KvBytes>,
    },
    Zset {
        members: Vec<KvScored>,
    },
    Stream {
        fields: Vec<KvField>,
    },
    /// A RedisJSON document, as JSON text.
    Json {
        value: String,
    },
}

/// One change. `original` fields hold what the user saw; the apply compares them on the
/// server before anything runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KvEdit {
    /// Replaces a string value (`SET … KEEPTTL`); `original` `null`: the key is created.
    StringSet {
        key: KvBytes,
        original: Option<KvBytes>,
        value: KvBytes,
    },
    /// Sets a hash field; `original` `null`: the field is added.
    HashSet {
        key: KvBytes,
        field: KvBytes,
        original: Option<KvBytes>,
        value: KvBytes,
    },
    HashDelete {
        key: KvBytes,
        field: KvBytes,
        original: KvBytes,
    },
    /// Moves a field's value to a new field name (`to` must not exist).
    HashRename {
        key: KvBytes,
        field: KvBytes,
        to: KvBytes,
        value: KvBytes,
    },
    ListSet {
        key: KvBytes,
        index: u32,
        original: KvBytes,
        value: KvBytes,
    },
    /// `LPUSH` (`head`) or `RPUSH` of `values`, in that order.
    ListPush {
        key: KvBytes,
        head: bool,
        values: Vec<KvBytes>,
    },
    /// Pops `values`, which must be the first (`head`) or last elements, in list order.
    ListPop {
        key: KvBytes,
        head: bool,
        values: Vec<KvBytes>,
    },
    /// Removes the element at `index` (see the module comment).
    ListRemove {
        key: KvBytes,
        index: u32,
        original: KvBytes,
    },
    SetAdd {
        key: KvBytes,
        member: KvBytes,
    },
    SetRemove {
        key: KvBytes,
        member: KvBytes,
    },
    /// Adds a member or changes its score; `original` `null`: the member is added.
    ZsetSet {
        key: KvBytes,
        member: KvBytes,
        original: Option<String>,
        score: String,
    },
    ZsetRemove {
        key: KvBytes,
        member: KvBytes,
        original: String,
    },
    /// Appends an entry with a server-made id (`XADD key *`).
    StreamAdd {
        key: KvBytes,
        fields: Vec<KvField>,
    },
    /// Deletes an entry (`fields`: what the user saw of it).
    StreamDelete {
        key: KvBytes,
        id: String,
        fields: Vec<KvField>,
    },
    /// Replaces a RedisJSON document (`path` `$`) or the value at an existing path;
    /// `original` `null`: the document is created (path `$` only).
    JsonSet {
        key: KvBytes,
        path: String,
        original: Option<String>,
        value: String,
    },
    /// Changes the time to live; `original`: the expiry the user saw (`PEXPIRETIME`, Unix
    /// milliseconds), `null` for none.
    Expire {
        key: KvBytes,
        original: Option<f64>,
        ttl: KvTtl,
    },
    /// Renames a key; `overwrite`: `to` may exist and is replaced (confirmed as dangerous).
    Rename {
        key: KvBytes,
        to: KvBytes,
        overwrite: bool,
    },
    /// Copies a key to a new name (`COPY`; `to` must not exist).
    Copy {
        key: KvBytes,
        to: KvBytes,
    },
    /// Creates a key that must not exist.
    Create {
        key: KvBytes,
        value: KvNewValue,
        ttl_ms: Option<f64>,
    },
    /// Deletes a key (`UNLINK`); `guard`: the key must still be exactly this snapshot (a
    /// revert). Without a guard, a key already gone is not a conflict.
    Delete {
        key: KvBytes,
        guard: Option<KvSnapshot>,
    },
    /// Brings a key back from a snapshot; `replace`: the key exists and must be exactly this
    /// snapshot, else it must not exist.
    Restore {
        key: KvBytes,
        snapshot: KvSnapshot,
        replace: Option<KvSnapshot>,
    },
}

/// Changes to apply together on one database.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvChangeSet {
    pub database: u32,
    pub edits: Vec<KvEdit>,
}

/// What made a check fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KvConflictKind {
    /// The value changed (`current` holds it now).
    Changed,
    /// The key, field, member, element or entry is gone.
    Missing,
    /// What the edit adds is there already (a field, a member, a key).
    Exists,
    /// The key now holds another type (`actualType`).
    TypeChanged,
    /// `EXEC` was aborted: a watched key changed between the checks and the transaction.
    Aborted,
}

/// An edit that cannot be applied as the user saw it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvConflict {
    /// Index of the edit in its change set.
    pub edit: u32,
    pub key: KvBytes,
    pub kind: KvConflictKind,
    /// What the edit expected, as `redis-cli` shows it (`null`: nothing, the thing was absent).
    pub expected: Option<String>,
    /// What the server holds now, exact (bytes; a score, an expiry in Unix milliseconds or a
    /// JSON value as text); `null`: nothing.
    pub current: Option<KvBytes>,
    pub actual_type: Option<String>,
    /// "Keep mine" can apply the edit over what is there now.
    pub rebasable: bool,
}

/// A field and its value, as bytes.
type FieldBytes = (Vec<u8>, Vec<u8>);

/// What a check expects of its reply.
#[derive(Debug, Clone, PartialEq)]
pub enum Expect {
    /// `TYPE` is one of these.
    TypeIn(&'static [&'static str]),
    /// A string-like reply equal to these bytes; `None`: nil.
    Bytes(Option<Vec<u8>>),
    /// An integer reply (`EXISTS`, `HEXISTS`, `SISMEMBER`).
    Int(i64),
    /// `ZSCORE`: this score, or nil.
    Score(Option<f64>),
    /// `JSON.GET key $path`: an array holding exactly this value.
    Json(serde_json::Value),
    /// `PEXPIRETIME`: this expiry, `-1` for none.
    ExpireAt(i64),
    /// `LRANGE`: exactly these elements.
    Range(Vec<Vec<u8>>),
    /// `XRANGE key id id`: this one entry.
    StreamEntry(Vec<u8>, Vec<FieldBytes>),
    /// `DUMP`: this payload.
    Dump(Vec<u8>),
}

/// A read compared under `WATCH` before the transaction.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub edit: usize,
    pub key: Vec<u8>,
    pub cmd: KvCommand,
    pub expect: Expect,
    /// What the mismatch of an `Int` / `Bytes` check means when the thing is absent or there.
    pub missing: KvConflictKind,
}

/// A command queued in the transaction.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub edit: usize,
    pub cmd: KvCommand,
    /// List commands run in phases (sets, then removals, then pushes and pops) so that the
    /// indices the user saw stay valid.
    phase: u8,
}

/// The planned transaction of a change set.
#[derive(Debug, Clone, PartialEq)]
pub struct KvPlan {
    pub database: u32,
    /// Keys to `WATCH`, each once.
    pub watch: Vec<Vec<u8>>,
    pub checks: Vec<Check>,
    /// Commands between `MULTI` and `EXEC`, in order.
    pub steps: Vec<Step>,
    /// Keys snapshotted before the transaction (their change is reverted from it).
    pub before: Vec<Vec<u8>>,
    /// Keys snapshotted inside the transaction, after its commands (revert guards).
    pub after: Vec<Vec<u8>>,
    /// Keys whose expiry is read inside the transaction, after its commands.
    pub expiry_after: Vec<Vec<u8>>,
    /// Keys whose `MEMORY USAGE` bounds the snapshots.
    pub sized: Vec<Vec<u8>>,
    /// The tombstone of list removals, unique to this apply.
    pub tombstone: Vec<u8>,
}

fn bytes(value: &KvBytes) -> Result<Vec<u8>, YadbeError> {
    value.to_bytes()
}

fn invalid(en: impl Into<String>, fr: impl Into<String>) -> YadbeError {
    YadbeError::invalid_argument(en, fr)
}

/// A score as `ZADD` reads it: Redis takes `inf` / `-inf` and decimal text.
pub fn score_text(score: f64) -> String {
    if score.is_infinite() {
        if score > 0.0 { "+inf" } else { "-inf" }.to_owned()
    } else {
        format!("{score}")
    }
}

/// A score typed or read back: a decimal number, `inf`, `+inf` or `-inf`.
pub fn parse_score(text: &str) -> Result<f64, YadbeError> {
    let trimmed = text.trim();
    let parsed = match trimmed.to_ascii_lowercase().as_str() {
        "inf" | "+inf" => Some(f64::INFINITY),
        "-inf" => Some(f64::NEG_INFINITY),
        other => other.parse::<f64>().ok().filter(|f| f.is_finite()),
    };
    parsed.ok_or_else(|| {
        invalid(
            format!("\"{trimmed}\" is not a score: a number, inf or -inf."),
            format!("« {trimmed} » n'est pas un score : un nombre, inf ou -inf."),
        )
    })
}

fn parse_json(text: &str) -> Result<serde_json::Value, YadbeError> {
    serde_json::from_str(text).map_err(|e| {
        invalid(
            "The value is not valid JSON.",
            "La valeur n'est pas du JSON valide.",
        )
        .with_detail(e.to_string())
    })
}

fn ms(value: f64) -> Result<i64, YadbeError> {
    if !value.is_finite() || value < 0.0 {
        return Err(invalid(
            "A time to live must be a positive number of milliseconds.",
            "Une durée de vie doit être un nombre positif de millisecondes.",
        ));
    }
    Ok(value.round() as i64)
}

const STRING: &[&str] = &["string"];
const HASH: &[&str] = &["hash"];
const HASH_OR_NONE: &[&str] = &["hash", "none"];
const LIST: &[&str] = &["list"];
const LIST_OR_NONE: &[&str] = &["list", "none"];
const SET: &[&str] = &["set"];
const SET_OR_NONE: &[&str] = &["set", "none"];
const ZSET: &[&str] = &["zset"];
const ZSET_OR_NONE: &[&str] = &["zset", "none"];
const STREAM: &[&str] = &["stream"];
const STREAM_OR_NONE: &[&str] = &["stream", "none"];
const JSON: &[&str] = &["ReJSON-RL"];
const NONE: &[&str] = &["none"];

impl KvEdit {
    /// The key the edit changes (a rename or copy also changes its target).
    pub fn key(&self) -> &KvBytes {
        match self {
            KvEdit::StringSet { key, .. }
            | KvEdit::HashSet { key, .. }
            | KvEdit::HashDelete { key, .. }
            | KvEdit::HashRename { key, .. }
            | KvEdit::ListSet { key, .. }
            | KvEdit::ListPush { key, .. }
            | KvEdit::ListPop { key, .. }
            | KvEdit::ListRemove { key, .. }
            | KvEdit::SetAdd { key, .. }
            | KvEdit::SetRemove { key, .. }
            | KvEdit::ZsetSet { key, .. }
            | KvEdit::ZsetRemove { key, .. }
            | KvEdit::StreamAdd { key, .. }
            | KvEdit::StreamDelete { key, .. }
            | KvEdit::JsonSet { key, .. }
            | KvEdit::Expire { key, .. }
            | KvEdit::Rename { key, .. }
            | KvEdit::Copy { key, .. }
            | KvEdit::Create { key, .. }
            | KvEdit::Delete { key, .. }
            | KvEdit::Restore { key, .. } => key,
        }
    }

    /// The other key a rename or a copy writes.
    pub fn target(&self) -> Option<&KvBytes> {
        match self {
            KvEdit::Rename { to, .. } | KvEdit::Copy { to, .. } => Some(to),
            _ => None,
        }
    }

    /// Reverted from a snapshot of its key rather than edit by edit.
    fn needs_snapshot(&self) -> bool {
        matches!(
            self,
            KvEdit::ListRemove { .. } | KvEdit::StreamDelete { .. } | KvEdit::Delete { .. }
        )
    }
}

struct Builder {
    edit: usize,
    checks: Vec<Check>,
    steps: Vec<Step>,
}

impl Builder {
    fn check(&mut self, key: &[u8], cmd: KvCommand, expect: Expect, missing: KvConflictKind) {
        self.checks.push(Check {
            edit: self.edit,
            key: key.to_vec(),
            cmd,
            expect,
            missing,
        });
    }

    fn type_in(&mut self, key: &[u8], types: &'static [&'static str]) {
        self.check(
            key,
            KvCommand::of([b"TYPE".as_slice(), key]),
            Expect::TypeIn(types),
            KvConflictKind::Missing,
        );
    }

    fn exists(&mut self, key: &[u8], expected: bool) {
        self.check(
            key,
            KvCommand::of([b"EXISTS".as_slice(), key]),
            Expect::Int(i64::from(expected)),
            if expected {
                KvConflictKind::Missing
            } else {
                KvConflictKind::Exists
            },
        );
    }

    fn step(&mut self, phase: u8, cmd: KvCommand) {
        self.steps.push(Step {
            edit: self.edit,
            cmd,
            phase,
        });
    }
}

fn args(parts: Vec<Vec<u8>>) -> KvCommand {
    KvCommand::new(parts)
}

fn ttl_args(cmd: &str, key: &[u8], ms: i64) -> KvCommand {
    args(vec![
        cmd.as_bytes().to_vec(),
        key.to_vec(),
        ms.to_string().into_bytes(),
    ])
}

/// `RESTORE key ttl payload [REPLACE] [ABSTTL]`.
fn restore_command(
    key: &[u8],
    snapshot: &KvSnapshot,
    replace: bool,
) -> Result<KvCommand, YadbeError> {
    let mut parts = vec![b"RESTORE".to_vec(), key.to_vec()];
    match snapshot.expire_at {
        Some(at) => parts.push(ms(at)?.to_string().into_bytes()),
        None => parts.push(b"0".to_vec()),
    }
    parts.push(snapshot.payload()?);
    if replace {
        parts.push(b"REPLACE".to_vec());
    }
    if snapshot.expire_at.is_some() {
        parts.push(b"ABSTTL".to_vec());
    }
    Ok(args(parts))
}

/// The commands that create a key holding `value`.
fn create_commands(key: &[u8], value: &KvNewValue) -> Result<Vec<KvCommand>, YadbeError> {
    let empty = || {
        invalid(
            "A new key needs a first value: Redis does not keep empty collections.",
            "Une nouvelle clé doit avoir une première valeur : Redis ne conserve pas les collections vides.",
        )
    };
    let mut parts: Vec<Vec<u8>>;
    match value {
        KvNewValue::String { value } => {
            parts = vec![b"SET".to_vec(), key.to_vec(), bytes(value)?];
        }
        KvNewValue::Hash { fields } => {
            if fields.is_empty() {
                return Err(empty());
            }
            parts = vec![b"HSET".to_vec(), key.to_vec()];
            for f in fields {
                parts.push(bytes(&f.field)?);
                parts.push(bytes(&f.value)?);
            }
        }
        KvNewValue::List { values } => {
            if values.is_empty() {
                return Err(empty());
            }
            parts = vec![b"RPUSH".to_vec(), key.to_vec()];
            for v in values {
                parts.push(bytes(v)?);
            }
        }
        KvNewValue::Set { members } => {
            if members.is_empty() {
                return Err(empty());
            }
            parts = vec![b"SADD".to_vec(), key.to_vec()];
            for m in members {
                parts.push(bytes(m)?);
            }
        }
        KvNewValue::Zset { members } => {
            if members.is_empty() {
                return Err(empty());
            }
            parts = vec![b"ZADD".to_vec(), key.to_vec()];
            for m in members {
                parts.push(score_text(parse_score(&m.score)?).into_bytes());
                parts.push(bytes(&m.member)?);
            }
        }
        KvNewValue::Stream { fields } => {
            if fields.is_empty() {
                return Err(empty());
            }
            parts = vec![b"XADD".to_vec(), key.to_vec(), b"*".to_vec()];
            for f in fields {
                parts.push(bytes(&f.field)?);
                parts.push(bytes(&f.value)?);
            }
        }
        KvNewValue::Json { value } => {
            parse_json(value)?;
            parts = vec![
                b"JSON.SET".to_vec(),
                key.to_vec(),
                b"$".to_vec(),
                value.as_bytes().to_vec(),
            ];
        }
    }
    Ok(vec![args(parts)])
}

fn json_path(path: &str) -> Result<(), YadbeError> {
    if !path.starts_with('$') {
        return Err(invalid(
            "A JSON path starts with $ (JSONPath).",
            "Un chemin JSON commence par $ (JSONPath).",
        ));
    }
    Ok(())
}

fn stream_fields(fields: &[KvField]) -> Result<Vec<FieldBytes>, YadbeError> {
    fields
        .iter()
        .map(|f| Ok((bytes(&f.field)?, bytes(&f.value)?)))
        .collect()
}

/// Plans a change set: checks, commands, snapshots. `tombstone`: unique bytes for list
/// removals (the caller makes them random).
pub fn plan(set: &KvChangeSet, tombstone: Vec<u8>) -> Result<KvPlan, YadbeError> {
    if set.edits.is_empty() {
        return Err(invalid(
            "There is nothing to apply.",
            "Il n'y a rien à appliquer.",
        ));
    }
    let mut checks = Vec::new();
    let mut steps = Vec::new();
    let mut before = Keys::default();
    let mut after = Keys::default();
    let mut expiry_after = Keys::default();
    let mut sized = Keys::default();
    let mut watch = Keys::default();
    let mut list_slots: HashSet<(Vec<u8>, u32)> = HashSet::new();
    let mut tombstoned: Vec<Vec<u8>> = Vec::new();

    for (index, edit) in set.edits.iter().enumerate() {
        let key = bytes(edit.key())?;
        watch.push(&key);
        if let Some(target) = edit.target() {
            let target = bytes(target)?;
            if target == key {
                return Err(invalid(
                    "A key cannot be renamed or copied to itself.",
                    "Une clé ne peut pas être renommée ou copiée sur elle-même.",
                ));
            }
            watch.push(&target);
        }
        if edit.needs_snapshot() {
            before.push(&key);
            sized.push(&key);
            // What the revert must find to restore the key over it; a deleted key is absent.
            if !matches!(edit, KvEdit::Delete { .. }) {
                after.push(&key);
            }
        }
        let mut b = Builder {
            edit: index,
            checks: Vec::new(),
            steps: Vec::new(),
        };
        let k = key.as_slice();
        match edit {
            KvEdit::StringSet {
                original, value, ..
            } => {
                let value = bytes(value)?;
                match original {
                    Some(original) => {
                        b.type_in(k, STRING);
                        b.check(
                            k,
                            KvCommand::of([b"GET".as_slice(), k]),
                            Expect::Bytes(Some(bytes(original)?)),
                            KvConflictKind::Missing,
                        );
                        b.step(0, KvCommand::of([b"SET".as_slice(), k, &value, b"KEEPTTL"]));
                    }
                    None => {
                        b.type_in(k, NONE);
                        b.step(0, KvCommand::of([b"SET".as_slice(), k, &value]));
                        after.push(k);
                    }
                }
            }
            KvEdit::HashSet {
                field,
                original,
                value,
                ..
            } => {
                let field = bytes(field)?;
                b.type_in(
                    k,
                    if original.is_some() {
                        HASH
                    } else {
                        HASH_OR_NONE
                    },
                );
                match original {
                    Some(original) => b.check(
                        k,
                        KvCommand::of([b"HGET".as_slice(), k, &field]),
                        Expect::Bytes(Some(bytes(original)?)),
                        KvConflictKind::Missing,
                    ),
                    None => b.check(
                        k,
                        KvCommand::of([b"HGET".as_slice(), k, &field]),
                        Expect::Bytes(None),
                        KvConflictKind::Exists,
                    ),
                }
                b.step(
                    0,
                    KvCommand::of([b"HSET".as_slice(), k, &field, &bytes(value)?]),
                );
            }
            KvEdit::HashDelete {
                field, original, ..
            } => {
                let field = bytes(field)?;
                b.type_in(k, HASH);
                b.check(
                    k,
                    KvCommand::of([b"HGET".as_slice(), k, &field]),
                    Expect::Bytes(Some(bytes(original)?)),
                    KvConflictKind::Missing,
                );
                b.step(0, KvCommand::of([b"HDEL".as_slice(), k, &field]));
            }
            KvEdit::HashRename {
                field, to, value, ..
            } => {
                let field = bytes(field)?;
                let to = bytes(to)?;
                if field == to {
                    return Err(invalid(
                        "The new field name is the same as the old one.",
                        "Le nouveau nom de champ est identique à l'ancien.",
                    ));
                }
                let value = bytes(value)?;
                b.type_in(k, HASH);
                b.check(
                    k,
                    KvCommand::of([b"HGET".as_slice(), k, &field]),
                    Expect::Bytes(Some(value.clone())),
                    KvConflictKind::Missing,
                );
                b.check(
                    k,
                    KvCommand::of([b"HGET".as_slice(), k, &to]),
                    Expect::Bytes(None),
                    KvConflictKind::Exists,
                );
                b.step(0, KvCommand::of([b"HSET".as_slice(), k, &to, &value]));
                b.step(0, KvCommand::of([b"HDEL".as_slice(), k, &field]));
            }
            KvEdit::ListSet {
                index: at,
                original,
                value,
                ..
            } => {
                if !list_slots.insert((key.clone(), *at)) {
                    return Err(duplicate_index());
                }
                b.type_in(k, LIST);
                let at = at.to_string().into_bytes();
                b.check(
                    k,
                    KvCommand::of([b"LINDEX".as_slice(), k, &at]),
                    Expect::Bytes(Some(bytes(original)?)),
                    KvConflictKind::Missing,
                );
                b.step(
                    0,
                    KvCommand::of([b"LSET".as_slice(), k, &at, &bytes(value)?]),
                );
            }
            KvEdit::ListRemove {
                index: at,
                original,
                ..
            } => {
                if !list_slots.insert((key.clone(), *at)) {
                    return Err(duplicate_index());
                }
                b.type_in(k, LIST);
                let at = at.to_string().into_bytes();
                b.check(
                    k,
                    KvCommand::of([b"LINDEX".as_slice(), k, &at]),
                    Expect::Bytes(Some(bytes(original)?)),
                    KvConflictKind::Missing,
                );
                b.step(0, KvCommand::of([b"LSET".as_slice(), k, &at, &tombstone]));
                if !tombstoned.contains(&key) {
                    tombstoned.push(key.clone());
                    // The tombstone must be nowhere in the list, or LREM would take more.
                    b.check(
                        k,
                        KvCommand::of([b"LPOS".as_slice(), k, &tombstone]),
                        Expect::Bytes(None),
                        KvConflictKind::Exists,
                    );
                    b.step(1, KvCommand::of([b"LREM".as_slice(), k, b"0", &tombstone]));
                }
            }
            KvEdit::ListPush { head, values, .. } => {
                if values.is_empty() {
                    return Err(invalid("Nothing to push.", "Rien à ajouter."));
                }
                b.type_in(k, LIST_OR_NONE);
                let mut parts = vec![
                    if *head {
                        b"LPUSH".to_vec()
                    } else {
                        b"RPUSH".to_vec()
                    },
                    key.clone(),
                ];
                for v in values {
                    parts.push(bytes(v)?);
                }
                b.step(2, args(parts));
            }
            KvEdit::ListPop { head, values, .. } => {
                if values.is_empty() {
                    return Err(invalid("Nothing to pop.", "Rien à retirer."));
                }
                b.type_in(k, LIST);
                let n = values.len() as i64;
                let (start, stop) = if *head { (0, n - 1) } else { (-n, -1) };
                b.check(
                    k,
                    args(vec![
                        b"LRANGE".to_vec(),
                        key.clone(),
                        start.to_string().into_bytes(),
                        stop.to_string().into_bytes(),
                    ]),
                    Expect::Range(values.iter().map(bytes).collect::<Result<_, _>>()?),
                    KvConflictKind::Changed,
                );
                b.step(
                    2,
                    args(vec![
                        if *head {
                            b"LPOP".to_vec()
                        } else {
                            b"RPOP".to_vec()
                        },
                        key.clone(),
                        n.to_string().into_bytes(),
                    ]),
                );
            }
            KvEdit::SetAdd { member, .. } => {
                let member = bytes(member)?;
                b.type_in(k, SET_OR_NONE);
                b.check(
                    k,
                    KvCommand::of([b"SISMEMBER".as_slice(), k, &member]),
                    Expect::Int(0),
                    KvConflictKind::Exists,
                );
                b.step(0, KvCommand::of([b"SADD".as_slice(), k, &member]));
            }
            KvEdit::SetRemove { member, .. } => {
                let member = bytes(member)?;
                b.type_in(k, SET);
                b.check(
                    k,
                    KvCommand::of([b"SISMEMBER".as_slice(), k, &member]),
                    Expect::Int(1),
                    KvConflictKind::Missing,
                );
                b.step(0, KvCommand::of([b"SREM".as_slice(), k, &member]));
            }
            KvEdit::ZsetSet {
                member,
                original,
                score,
                ..
            } => {
                let score = parse_score(score)?;
                let seen = original.as_deref().map(parse_score).transpose()?;
                let member = bytes(member)?;
                b.type_in(
                    k,
                    if original.is_some() {
                        ZSET
                    } else {
                        ZSET_OR_NONE
                    },
                );
                b.check(
                    k,
                    KvCommand::of([b"ZSCORE".as_slice(), k, &member]),
                    Expect::Score(seen),
                    if original.is_some() {
                        KvConflictKind::Missing
                    } else {
                        KvConflictKind::Exists
                    },
                );
                b.step(
                    0,
                    KvCommand::of([b"ZADD".as_slice(), k, score_text(score).as_bytes(), &member]),
                );
            }
            KvEdit::ZsetRemove {
                member, original, ..
            } => {
                let member = bytes(member)?;
                b.type_in(k, ZSET);
                b.check(
                    k,
                    KvCommand::of([b"ZSCORE".as_slice(), k, &member]),
                    Expect::Score(Some(parse_score(original)?)),
                    KvConflictKind::Missing,
                );
                b.step(0, KvCommand::of([b"ZREM".as_slice(), k, &member]));
            }
            KvEdit::StreamAdd { fields, .. } => {
                if fields.is_empty() {
                    return Err(invalid(
                        "A stream entry needs at least one field.",
                        "Une entrée de flux doit avoir au moins un champ.",
                    ));
                }
                b.type_in(k, STREAM_OR_NONE);
                let mut parts = vec![b"XADD".to_vec(), key.clone(), b"*".to_vec()];
                for (f, v) in stream_fields(fields)? {
                    parts.push(f);
                    parts.push(v);
                }
                b.step(0, args(parts));
            }
            KvEdit::StreamDelete { id, fields, .. } => {
                b.type_in(k, STREAM);
                let id = id.as_bytes().to_vec();
                b.check(
                    k,
                    KvCommand::of([b"XRANGE".as_slice(), k, &id, &id]),
                    Expect::StreamEntry(id.clone(), stream_fields(fields)?),
                    KvConflictKind::Missing,
                );
                b.step(0, KvCommand::of([b"XDEL".as_slice(), k, &id]));
            }
            KvEdit::JsonSet {
                path,
                original,
                value,
                ..
            } => {
                json_path(path)?;
                parse_json(value)?;
                match original {
                    Some(original) => {
                        b.type_in(k, JSON);
                        b.check(
                            k,
                            KvCommand::of([b"JSON.GET".as_slice(), k, path.as_bytes()]),
                            Expect::Json(parse_json(original)?),
                            KvConflictKind::Missing,
                        );
                    }
                    None => {
                        if path != "$" {
                            return Err(invalid(
                                "Only an existing JSON path can be set; a new document is set at $.",
                                "Seul un chemin JSON existant peut être modifié ; un nouveau document se crée à $.",
                            ));
                        }
                        b.type_in(k, NONE);
                        after.push(k);
                    }
                }
                b.step(
                    0,
                    KvCommand::of([b"JSON.SET".as_slice(), k, path.as_bytes(), value.as_bytes()]),
                );
            }
            KvEdit::Expire { original, ttl, .. } => {
                let expected = match original {
                    Some(at) => ms(*at)?,
                    None => -1,
                };
                b.check(
                    k,
                    KvCommand::of([b"PEXPIRETIME".as_slice(), k]),
                    Expect::ExpireAt(expected),
                    KvConflictKind::Missing,
                );
                b.step(
                    0,
                    match ttl {
                        KvTtl::Persist => KvCommand::of([b"PERSIST".as_slice(), k]),
                        KvTtl::In { ms: d } => ttl_args("PEXPIRE", k, ms(*d)?.max(1)),
                        KvTtl::At { ms: at } => ttl_args("PEXPIREAT", k, ms(*at)?),
                    },
                );
                expiry_after.push(k);
            }
            KvEdit::Rename { to, overwrite, .. } => {
                let to = bytes(to)?;
                b.exists(k, true);
                if *overwrite {
                    // The key replaced comes back from its snapshot on a revert, and the
                    // renamed one from its snapshot after the transaction.
                    before.push(&to);
                    after.push(&to);
                    sized.push(&to);
                    sized.push(k);
                } else {
                    b.exists(&to, false);
                }
                b.step(0, KvCommand::of([b"RENAME".as_slice(), k, &to]));
            }
            KvEdit::Copy { to, .. } => {
                let to = bytes(to)?;
                b.exists(k, true);
                b.exists(&to, false);
                b.step(0, KvCommand::of([b"COPY".as_slice(), k, &to]));
                after.push(&to);
                sized.push(k);
            }
            KvEdit::Create { value, ttl_ms, .. } => {
                b.type_in(k, NONE);
                for cmd in create_commands(k, value)? {
                    b.step(0, cmd);
                }
                if let Some(ttl) = ttl_ms {
                    b.step(0, ttl_args("PEXPIRE", k, ms(*ttl)?.max(1)));
                }
                after.push(k);
            }
            KvEdit::Delete { guard, .. } => {
                if let Some(guard) = guard {
                    b.check(
                        k,
                        KvCommand::of([b"DUMP".as_slice(), k]),
                        Expect::Dump(guard.payload()?),
                        KvConflictKind::Missing,
                    );
                }
                b.step(0, KvCommand::of([b"UNLINK".as_slice(), k]));
            }
            KvEdit::Restore {
                snapshot, replace, ..
            } => {
                match replace {
                    Some(current) => b.check(
                        k,
                        KvCommand::of([b"DUMP".as_slice(), k]),
                        Expect::Dump(current.payload()?),
                        KvConflictKind::Missing,
                    ),
                    None => b.exists(k, false),
                }
                b.step(0, restore_command(k, snapshot, replace.is_some())?);
                after.push(k);
            }
        }
        checks.extend(b.checks);
        steps.extend(b.steps);
    }
    // A key's own edits: one type check is enough, and the same check twice says nothing more.
    let mut seen = HashSet::new();
    checks.retain(|c| seen.insert((c.cmd.args.clone(), format!("{:?}", c.expect))));
    steps.sort_by_key(|s| s.phase);
    Ok(KvPlan {
        database: set.database,
        watch: watch.list,
        checks,
        steps,
        before: before.list,
        after: after.list,
        expiry_after: expiry_after.list,
        sized: sized.list,
        tombstone,
    })
}

/// Keys in first-seen order, each once (a namespace revert has 100 000 of them).
#[derive(Default)]
struct Keys {
    list: Vec<Vec<u8>>,
    seen: HashSet<Vec<u8>>,
}

impl Keys {
    fn push(&mut self, key: &[u8]) {
        if self.seen.insert(key.to_vec()) {
            self.list.push(key.to_vec());
        }
    }
}

fn duplicate_index() -> YadbeError {
    invalid(
        "The same list element is changed twice in one apply.",
        "Le même élément de liste est modifié deux fois dans une même application.",
    )
}

/// What a check's reply says: `None` when it is as expected.
pub fn verdict(
    check: &Check,
    reply: &Result<KvReply, YadbeError>,
    edit_key: &KvBytes,
) -> Option<KvConflict> {
    let conflict = |kind: KvConflictKind, current: Option<Vec<u8>>| KvConflict {
        edit: u32::try_from(check.edit).unwrap_or(u32::MAX),
        key: edit_key.clone(),
        kind,
        expected: expected_text(&check.expect),
        current: current.map(|c| KvBytes::from_bytes(&c)),
        actual_type: None,
        rebasable: false,
    };
    let reply = match reply {
        Ok(reply) => reply,
        // A read that fails (a module command on a key that changed type…) is a conflict
        // as well: the edit cannot be applied as seen.
        Err(_) => return Some(conflict(KvConflictKind::Changed, None)),
    };
    match &check.expect {
        Expect::TypeIn(types) => {
            let actual = reply.text().unwrap_or_default();
            if types.contains(&actual.as_str()) {
                return None;
            }
            let kind = if actual == "none" {
                KvConflictKind::Missing
            } else if types == &NONE {
                KvConflictKind::Exists
            } else {
                KvConflictKind::TypeChanged
            };
            let mut c = conflict(kind, None);
            c.actual_type = Some(actual);
            Some(c)
        }
        Expect::Bytes(expected) => {
            let actual = reply.bytes();
            if &actual == expected {
                return None;
            }
            let kind = match (&actual, expected) {
                (None, Some(_)) => KvConflictKind::Missing,
                (Some(_), None) => check.missing,
                _ => KvConflictKind::Changed,
            };
            let mut c = conflict(kind, actual);
            // A value that changed, or a field added meanwhile, can be overwritten on purpose.
            c.rebasable = matches!(kind, KvConflictKind::Changed)
                || (kind == KvConflictKind::Exists && check.cmd.name() == "hget");
            Some(c)
        }
        Expect::Int(expected) => {
            if reply.int() == Some(*expected) {
                return None;
            }
            Some(conflict(check.missing, None))
        }
        Expect::Score(expected) => {
            let actual = reply.float();
            if actual == *expected {
                return None;
            }
            let kind = match (actual, expected) {
                (None, Some(_)) => KvConflictKind::Missing,
                (Some(_), None) => KvConflictKind::Exists,
                _ => KvConflictKind::Changed,
            };
            let mut c = conflict(kind, actual.map(|s| score_text(s).into_bytes()));
            c.rebasable = kind != KvConflictKind::Missing;
            Some(c)
        }
        Expect::Json(expected) => {
            let text = reply.text();
            let actual = text
                .as_deref()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok());
            let single = match &actual {
                Some(serde_json::Value::Array(items)) if items.len() == 1 => items.first(),
                _ => None,
            };
            if single == Some(expected) {
                return None;
            }
            let current = single.map(|v| v.to_string().into_bytes());
            let kind = if current.is_some() {
                KvConflictKind::Changed
            } else {
                KvConflictKind::Missing
            };
            let mut c = conflict(kind, current);
            c.rebasable = kind == KvConflictKind::Changed;
            Some(c)
        }
        Expect::ExpireAt(expected) => {
            let actual = reply.int();
            if actual == Some(*expected) {
                return None;
            }
            match actual {
                Some(-2) | None => Some(conflict(KvConflictKind::Missing, None)),
                Some(at) => {
                    let mut c = conflict(
                        KvConflictKind::Changed,
                        (at >= 0).then(|| at.to_string().into_bytes()),
                    );
                    c.rebasable = true;
                    Some(c)
                }
            }
        }
        Expect::Range(expected) => {
            let actual: Option<Vec<Vec<u8>>> = reply
                .items()
                .map(|items| items.iter().filter_map(KvReply::bytes).collect());
            if actual.as_ref() == Some(expected) {
                return None;
            }
            Some(conflict(KvConflictKind::Changed, None))
        }
        Expect::StreamEntry(id, fields) => {
            let entry = reply.items().and_then(|entries| entries.first());
            let found = entry.and_then(|entry| {
                let parts = entry.items()?;
                let got_id = parts.first()?.bytes()?;
                let pairs = parts.get(1)?.clone().into_pairs()?;
                let pairs: Option<Vec<(Vec<u8>, Vec<u8>)>> = pairs
                    .into_iter()
                    .map(|(f, v)| Some((f.bytes()?, v.bytes()?)))
                    .collect();
                Some((got_id, pairs?))
            });
            match found {
                Some((got_id, got)) if &got_id == id && &got == fields => None,
                Some(_) => Some(conflict(KvConflictKind::Changed, None)),
                None => Some(conflict(KvConflictKind::Missing, None)),
            }
        }
        Expect::Dump(expected) => match reply.bytes() {
            Some(actual) if &actual == expected => None,
            Some(_) => Some(conflict(KvConflictKind::Changed, None)),
            None => Some(conflict(check.missing, None)),
        },
    }
}

fn shown(value: &[u8]) -> String {
    cut_arg(value)
}

fn expected_text(expect: &Expect) -> Option<String> {
    match expect {
        Expect::TypeIn(types) => Some(types.join(" | ")),
        Expect::Bytes(Some(value)) => Some(shown(value)),
        Expect::Bytes(None) => None,
        Expect::Int(n) => Some(n.to_string()),
        Expect::Score(score) => score.map(score_text),
        Expect::Json(value) => Some(value.to_string()),
        Expect::ExpireAt(at) => (*at >= 0).then(|| at.to_string()),
        Expect::Range(values) => Some(
            values
                .iter()
                .map(|v| shown(v))
                .collect::<Vec<_>>()
                .join(" "),
        ),
        Expect::StreamEntry(id, _) => Some(String::from_utf8_lossy(id).into_owned()),
        Expect::Dump(_) => None,
    }
}

/// One argument as `redis-cli` needs it, cut past [`SHOWN_ARG_CHARS`] with its size.
pub fn cut_arg(arg: &[u8]) -> String {
    let full = quote(arg);
    if full.chars().count() <= SHOWN_ARG_CHARS {
        return full;
    }
    let cut: String = full.chars().take(SHOWN_ARG_CHARS).collect();
    format!("{cut}…\" ({} bytes)", arg.len())
}

/// A command as shown in a preview or the journal: `redis-cli` quoting, long arguments cut,
/// `RESTORE` payloads named rather than shown.
pub fn shown_command(cmd: &KvCommand) -> String {
    let restore = cmd.name() == "restore";
    cmd.args
        .iter()
        .enumerate()
        .map(|(i, arg)| {
            if restore && i == 3 {
                format!("<DUMP payload, {} bytes>", arg.len())
            } else {
                cut_arg(arg)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What a preview line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KvLineRole {
    /// `WATCH`, `MULTI`, `EXEC`.
    Control,
    /// A read compared with what the user saw.
    Check,
    /// A read kept for the journal (snapshot, expiry).
    Snapshot,
    /// A command that changes data.
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvPreviewLine {
    pub text: String,
    pub role: KvLineRole,
}

fn watch_command(keys: &[Vec<u8>]) -> KvCommand {
    let mut parts = vec![b"WATCH".to_vec()];
    parts.extend(keys.iter().cloned());
    KvCommand::new(parts)
}

impl KvPlan {
    pub fn watch_command(&self) -> KvCommand {
        watch_command(&self.watch)
    }

    /// The reads of the snapshots taken before the transaction.
    pub fn before_reads(&self) -> Vec<KvCommand> {
        snapshot_reads(&self.before)
    }

    /// What runs between `MULTI` and `EXEC`: the commands, then the reads of the state they
    /// leave (snapshots of the keys created when `snapshots`, expiries changed).
    pub fn transaction(&self, snapshots: bool) -> Vec<KvCommand> {
        let mut cmds: Vec<KvCommand> = self.steps.iter().map(|s| s.cmd.clone()).collect();
        if snapshots {
            cmds.extend(snapshot_reads(&self.after));
        }
        for key in &self.expiry_after {
            cmds.push(KvCommand::of([b"PEXPIRETIME".as_slice(), key]));
        }
        cmds
    }

    /// Every line as it will run, in order.
    pub fn preview(&self) -> Vec<KvPreviewLine> {
        let line = |cmd: &KvCommand, role| KvPreviewLine {
            text: shown_command(cmd),
            role,
        };
        let mut lines = vec![line(&self.watch_command(), KvLineRole::Control)];
        lines.extend(self.checks.iter().map(|c| line(&c.cmd, KvLineRole::Check)));
        lines.extend(
            self.before_reads()
                .iter()
                .map(|c| line(c, KvLineRole::Snapshot)),
        );
        lines.push(line(&KvCommand::of(["MULTI"]), KvLineRole::Control));
        let steps = self.steps.len();
        for (i, cmd) in self.transaction(true).iter().enumerate() {
            let role = if i < steps {
                KvLineRole::Command
            } else {
                KvLineRole::Snapshot
            };
            lines.push(line(cmd, role));
        }
        lines.push(line(&KvCommand::of(["EXEC"]), KvLineRole::Control));
        lines
    }
}

/// `DUMP` and `PEXPIRETIME` of each key.
pub fn snapshot_reads(keys: &[Vec<u8>]) -> Vec<KvCommand> {
    keys.iter()
        .flat_map(|key| {
            [
                KvCommand::of([b"DUMP".as_slice(), key]),
                KvCommand::of([b"PEXPIRETIME".as_slice(), key]),
            ]
        })
        .collect()
}

/// Snapshots from the replies of [`snapshot_reads`]: `None` for a key that does not exist.
pub fn read_snapshots(
    keys: &[Vec<u8>],
    replies: &[Result<KvReply, YadbeError>],
) -> HashMap<Vec<u8>, Option<KvSnapshot>> {
    let mut out = HashMap::new();
    for (i, key) in keys.iter().enumerate() {
        let dump = replies
            .get(i * 2)
            .and_then(|r| r.as_ref().ok())
            .and_then(KvReply::bytes);
        let expire = replies
            .get(i * 2 + 1)
            .and_then(|r| r.as_ref().ok())
            .and_then(KvReply::int)
            .filter(|at| *at >= 0);
        out.insert(key.clone(), dump.map(|d| KvSnapshot::of(&d, expire)));
    }
    out
}

/// What the apply observed, for the inverse.
#[derive(Debug, Default)]
pub struct Observed {
    /// Snapshots before the transaction (`None` value: the key did not exist). Missing
    /// entirely: not taken (over the size bound).
    pub before: HashMap<Vec<u8>, Option<KvSnapshot>>,
    pub after: HashMap<Vec<u8>, Option<KvSnapshot>>,
    /// Expiry after the transaction, `None`: none.
    pub expiry_after: HashMap<Vec<u8>, Option<i64>>,
    /// The reply of each step, in plan order.
    pub step_replies: Vec<KvReply>,
}

/// The change set that undoes `set` as applied (`plan`, `observed`): a revert applies it,
/// with the same checks.
pub fn inverse(
    set: &KvChangeSet,
    plan: &KvPlan,
    observed: &Observed,
) -> Result<KvChangeSet, RevertBlocker> {
    let raw = |b: &KvBytes| b.to_bytes().map_err(|_| RevertBlocker::NotPlannable);
    // Head pushes minus head pops per list: how far the indices the user saw moved.
    let mut shift: HashMap<Vec<u8>, i64> = HashMap::new();
    for edit in &set.edits {
        match edit {
            KvEdit::ListPush {
                key,
                head: true,
                values,
            } => {
                *shift.entry(raw(key)?).or_default() += values.len() as i64;
            }
            KvEdit::ListPop {
                key,
                head: true,
                values,
            } => {
                *shift.entry(raw(key)?).or_default() -= values.len() as i64;
            }
            _ => {}
        }
    }
    let snapshot_keys: HashSet<Vec<u8>> = set
        .edits
        .iter()
        .filter(|e| e.needs_snapshot())
        .map(|e| raw(e.key()))
        .collect::<Result<_, _>>()?;
    let after = |key: &[u8]| -> Result<Option<KvSnapshot>, RevertBlocker> {
        observed
            .after
            .get(key)
            .cloned()
            .ok_or(RevertBlocker::TooLarge)
    };
    let before = |key: &[u8]| -> Result<Option<KvSnapshot>, RevertBlocker> {
        observed
            .before
            .get(key)
            .cloned()
            .ok_or(RevertBlocker::TooLarge)
    };
    let step_reply = |edit: usize| {
        plan.steps
            .iter()
            .zip(&observed.step_replies)
            .find(|(s, _)| s.edit == edit)
            .map(|(_, r)| r)
    };

    let mut per_edit: Vec<Vec<KvEdit>> = Vec::with_capacity(set.edits.len());
    let mut restored: HashSet<Vec<u8>> = HashSet::new();
    for (index, edit) in set.edits.iter().enumerate() {
        let key = raw(edit.key())?;
        let mut undo = Vec::new();
        if snapshot_keys.contains(&key) {
            // The whole key comes back from its snapshot, once.
            if restored.insert(key.clone()) {
                let guard = match observed.after.get(&key) {
                    Some(after) => after.clone(),
                    // Deleted by the transaction: nothing to read after it.
                    None if matches!(edit, KvEdit::Delete { .. }) => None,
                    None => return Err(RevertBlocker::TooLarge),
                };
                match (before(&key)?, guard) {
                    (Some(snapshot), replace) => undo.push(KvEdit::Restore {
                        key: edit.key().clone(),
                        snapshot,
                        replace,
                    }),
                    (None, Some(guard)) => undo.push(KvEdit::Delete {
                        key: edit.key().clone(),
                        guard: Some(guard),
                    }),
                    (None, None) => {}
                }
            }
            per_edit.push(undo);
            continue;
        }
        match edit {
            KvEdit::StringSet {
                key,
                original,
                value,
            } => match original {
                Some(original) => undo.push(KvEdit::StringSet {
                    key: key.clone(),
                    original: Some(value.clone()),
                    value: original.clone(),
                }),
                None => undo.push(KvEdit::Delete {
                    key: key.clone(),
                    guard: after(&raw(key)?)?,
                }),
            },
            KvEdit::HashSet {
                key,
                field,
                original,
                value,
            } => undo.push(match original {
                Some(original) => KvEdit::HashSet {
                    key: key.clone(),
                    field: field.clone(),
                    original: Some(value.clone()),
                    value: original.clone(),
                },
                None => KvEdit::HashDelete {
                    key: key.clone(),
                    field: field.clone(),
                    original: value.clone(),
                },
            }),
            KvEdit::HashDelete {
                key,
                field,
                original,
            } => undo.push(KvEdit::HashSet {
                key: key.clone(),
                field: field.clone(),
                original: None,
                value: original.clone(),
            }),
            KvEdit::HashRename {
                key,
                field,
                to,
                value,
            } => undo.push(KvEdit::HashRename {
                key: key.clone(),
                field: to.clone(),
                to: field.clone(),
                value: value.clone(),
            }),
            KvEdit::ListSet {
                key,
                index: at,
                original,
                value,
            } => {
                let moved = i64::from(*at) + shift.get(&raw(key)?).copied().unwrap_or(0);
                let at = u32::try_from(moved).map_err(|_| RevertBlocker::NotPlannable)?;
                undo.push(KvEdit::ListSet {
                    key: key.clone(),
                    index: at,
                    original: value.clone(),
                    value: original.clone(),
                });
            }
            KvEdit::ListPush { key, head, values } => {
                // `LPUSH a b` leaves `b a` at the head.
                let in_list: Vec<KvBytes> = if *head {
                    values.iter().rev().cloned().collect()
                } else {
                    values.clone()
                };
                undo.push(KvEdit::ListPop {
                    key: key.clone(),
                    head: *head,
                    values: in_list,
                });
            }
            KvEdit::ListPop { key, head, values } => {
                let pushed: Vec<KvBytes> = if *head {
                    values.iter().rev().cloned().collect()
                } else {
                    values.clone()
                };
                undo.push(KvEdit::ListPush {
                    key: key.clone(),
                    head: *head,
                    values: pushed,
                });
            }
            KvEdit::SetAdd { key, member } => undo.push(KvEdit::SetRemove {
                key: key.clone(),
                member: member.clone(),
            }),
            KvEdit::SetRemove { key, member } => undo.push(KvEdit::SetAdd {
                key: key.clone(),
                member: member.clone(),
            }),
            KvEdit::ZsetSet {
                key,
                member,
                original,
                score,
            } => undo.push(match original {
                Some(original) => KvEdit::ZsetSet {
                    key: key.clone(),
                    member: member.clone(),
                    original: Some(score.clone()),
                    score: original.clone(),
                },
                None => KvEdit::ZsetRemove {
                    key: key.clone(),
                    member: member.clone(),
                    original: score.clone(),
                },
            }),
            KvEdit::ZsetRemove {
                key,
                member,
                original,
            } => undo.push(KvEdit::ZsetSet {
                key: key.clone(),
                member: member.clone(),
                original: None,
                score: original.clone(),
            }),
            KvEdit::StreamAdd { key, fields } => {
                let id = step_reply(index)
                    .and_then(KvReply::text)
                    .ok_or(RevertBlocker::InsertedRowUnknown)?;
                undo.push(KvEdit::StreamDelete {
                    key: key.clone(),
                    id,
                    fields: fields.clone(),
                });
            }
            KvEdit::JsonSet {
                key,
                path,
                original,
                value,
            } => match original {
                Some(original) => undo.push(KvEdit::JsonSet {
                    key: key.clone(),
                    path: path.clone(),
                    original: Some(value.clone()),
                    value: original.clone(),
                }),
                None => undo.push(KvEdit::Delete {
                    key: key.clone(),
                    guard: after(&raw(key)?)?,
                }),
            },
            KvEdit::Expire { key, original, .. } => {
                let now = observed
                    .expiry_after
                    .get(&raw(key)?)
                    .ok_or(RevertBlocker::UpdatedRowUnknown)?;
                undo.push(KvEdit::Expire {
                    key: key.clone(),
                    original: now.map(|at| at as f64),
                    ttl: match original {
                        Some(at) => KvTtl::At { ms: *at },
                        None => KvTtl::Persist,
                    },
                });
            }
            KvEdit::Rename { key, to, overwrite } => {
                let replaced = if *overwrite { before(&raw(to)?)? } else { None };
                match replaced {
                    // Checks read the state before the revert, where `to` holds the renamed
                    // key: both keys come back from snapshots, each checked on its own.
                    Some(replaced) => {
                        let moved = after(&raw(to)?)?.ok_or(RevertBlocker::UpdatedRowUnknown)?;
                        undo.push(KvEdit::Restore {
                            key: key.clone(),
                            snapshot: moved.clone(),
                            replace: None,
                        });
                        undo.push(KvEdit::Restore {
                            key: to.clone(),
                            snapshot: replaced,
                            replace: Some(moved),
                        });
                    }
                    None => undo.push(KvEdit::Rename {
                        key: to.clone(),
                        to: key.clone(),
                        overwrite: false,
                    }),
                }
            }
            KvEdit::Copy { to, .. } => undo.push(KvEdit::Delete {
                key: to.clone(),
                guard: after(&raw(to)?)?,
            }),
            KvEdit::Create { key, .. } => undo.push(KvEdit::Delete {
                key: key.clone(),
                guard: after(&raw(key)?)?,
            }),
            KvEdit::Restore { key, replace, .. } => {
                let now = after(&raw(key)?)?;
                match replace {
                    Some(replaced) => undo.push(KvEdit::Restore {
                        key: key.clone(),
                        snapshot: replaced.clone(),
                        replace: now,
                    }),
                    None => undo.push(KvEdit::Delete {
                        key: key.clone(),
                        guard: now,
                    }),
                }
            }
            // Handled by the snapshot branch above.
            KvEdit::ListRemove { .. } | KvEdit::StreamDelete { .. } | KvEdit::Delete { .. } => {}
        }
        per_edit.push(undo);
    }
    let edits: Vec<KvEdit> = per_edit.into_iter().rev().flatten().collect();
    if edits.is_empty() {
        return Err(RevertBlocker::NotPlannable);
    }
    Ok(KvChangeSet {
        database: set.database,
        edits,
    })
}

/// Updated, inserted and deleted things of a change set, for the journal's counts.
pub fn counts(set: &KvChangeSet) -> (u32, u32, u32) {
    let (mut updated, mut inserted, mut deleted) = (0_u32, 0_u32, 0_u32);
    for edit in &set.edits {
        match edit {
            KvEdit::StringSet { original: None, .. }
            | KvEdit::HashSet { original: None, .. }
            | KvEdit::SetAdd { .. }
            | KvEdit::ZsetSet { original: None, .. }
            | KvEdit::StreamAdd { .. }
            | KvEdit::JsonSet { original: None, .. }
            | KvEdit::Copy { .. }
            | KvEdit::Create { .. }
            | KvEdit::Restore { replace: None, .. } => inserted += 1,
            KvEdit::ListPush { values, .. } => {
                inserted += u32::try_from(values.len()).unwrap_or(u32::MAX);
            }
            KvEdit::ListPop { values, .. } => {
                deleted += u32::try_from(values.len()).unwrap_or(u32::MAX);
            }
            KvEdit::HashDelete { .. }
            | KvEdit::ListRemove { .. }
            | KvEdit::SetRemove { .. }
            | KvEdit::ZsetRemove { .. }
            | KvEdit::StreamDelete { .. }
            | KvEdit::Delete { .. } => deleted += 1,
            _ => updated += 1,
        }
    }
    (updated, inserted, deleted)
}

/// Keys the explorer gains and loses when a change set is applied.
pub fn key_moves(set: &KvChangeSet) -> (Vec<KvBytes>, Vec<KvBytes>) {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    for edit in &set.edits {
        match edit {
            KvEdit::Rename { key, to, .. } => {
                removed.push(key.clone());
                added.push(to.clone());
            }
            KvEdit::Copy { to, .. } => added.push(to.clone()),
            KvEdit::Create { key, .. }
            | KvEdit::Restore { key, .. }
            | KvEdit::StringSet {
                key,
                original: None,
                ..
            }
            | KvEdit::JsonSet {
                key,
                original: None,
                ..
            } => added.push(key.clone()),
            KvEdit::Delete { key, .. } => removed.push(key.clone()),
            _ => {}
        }
    }
    (added, removed)
}

/// A pattern matching exactly the keys that start with `prefix` (`SCAN … MATCH`).
pub fn prefix_pattern(prefix: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(prefix.len() + 1);
    for &b in prefix {
        if matches!(b, b'*' | b'?' | b'[' | b']' | b'\\') {
            out.push(b'\\');
        }
        out.push(b);
    }
    out.push(b'*');
    out
}

/// Whether `key` matches a `SCAN` glob pattern (`*`, `?`, `[…]` with `^` and ranges, `\`).
pub fn glob_match(pattern: &[u8], key: &[u8]) -> bool {
    fn class(pattern: &[u8], mut p: usize, c: u8) -> Option<(bool, usize)> {
        // `p` is just after `[`; returns whether `c` matched and the index after `]`.
        let negate = pattern.get(p) == Some(&b'^');
        if negate {
            p += 1;
        }
        let mut matched = false;
        loop {
            let b = *pattern.get(p)?;
            if b == b']' {
                return Some((matched != negate, p + 1));
            }
            if b == b'\\' {
                p += 1;
                if pattern.get(p) == Some(&c) {
                    matched = true;
                }
                p += 1;
            } else if pattern.get(p + 1) == Some(&b'-')
                && pattern.get(p + 2).is_some_and(|e| *e != b']')
            {
                let (lo, hi) = (b.min(pattern[p + 2]), b.max(pattern[p + 2]));
                if (lo..=hi).contains(&c) {
                    matched = true;
                }
                p += 3;
            } else {
                if b == c {
                    matched = true;
                }
                p += 1;
            }
        }
    }
    fn go(pattern: &[u8], key: &[u8]) -> bool {
        let (mut p, mut k) = (0, 0);
        let (mut star_p, mut star_k) = (None::<usize>, 0);
        while k < key.len() {
            let step = match pattern.get(p) {
                Some(b'*') => {
                    star_p = Some(p);
                    star_k = k;
                    p += 1;
                    continue;
                }
                Some(b'?') => Some(p + 1),
                Some(b'[') => match class(pattern, p + 1, key[k]) {
                    Some((true, next)) => Some(next),
                    _ => None,
                },
                Some(b'\\') if p + 1 < pattern.len() => (pattern[p + 1] == key[k]).then_some(p + 2),
                Some(&b) => (b == key[k]).then_some(p + 1),
                None => None,
            };
            match step {
                Some(next) => {
                    p = next;
                    k += 1;
                }
                None => match star_p {
                    Some(sp) => {
                        p = sp + 1;
                        star_k += 1;
                        k = star_k;
                    }
                    None => return false,
                },
            }
        }
        pattern[p..].iter().all(|b| *b == b'*')
    }
    go(pattern, key)
}

/// Bytes shown in a message (a key name).
pub fn key_text(key: &[u8]) -> String {
    match std::str::from_utf8(key) {
        Ok(text) => text.to_owned(),
        Err(_) => escape(key),
    }
}

#[cfg(test)]
#[path = "edit_tests.rs"]
mod tests;
