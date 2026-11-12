//! Key listing for the explorer: `SCAN` only (never `KEYS`), in batches read by a background
//! task, up to a target count (then "load more"), stoppable between batches. The keys found
//! are kept in a sorted index in the backend (rule 8): the tree reads one level of it at a
//! time, grouped by the delimiter, paged.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::Notify;

use crate::db::errors::YadbeError;
use crate::db::keyvalue::{KvBytes, KvCommand, KvReply};
use crate::session::keyvalue::model::{KvLevel, KvLevelEntry, KvScanState, KvScanStatus};

/// Keys asked of the server per `SCAN` call (its `COUNT` hint).
pub const SCAN_COUNT: u32 = 1000;
/// Keys a scan reads before it pauses, unless told otherwise.
pub const DEFAULT_SCAN_TARGET: usize = 10_000;
/// Pause between two progress events of a running scan.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// How many keys of a level are grouped under each namespace, and how many are keys of the
/// level itself.
#[derive(Default)]
struct LevelSummary {
    namespaces: BTreeMap<Box<[u8]>, u64>,
    leaves: u64,
}

impl LevelSummary {
    fn add(&mut self, rest: &[u8], delimiter: &[u8]) {
        match segment(rest, delimiter) {
            Some(name) => *self.namespaces.entry(name.into()).or_insert(0) += 1,
            None => self.leaves += 1,
        }
    }
}

/// A level: its prefix and the delimiter it groups by.
type LevelId = (Box<[u8]>, Box<[u8]>);

/// Levels whose summary is kept up to date as keys arrive (the open ones, in practice).
const MAX_CACHED_LEVELS: usize = 256;

/// The keys found so far, sorted by bytes, without duplicates (`SCAN` may return a key twice).
/// The summary of a level read once is kept and updated with each new key, so reading an open
/// level again while the scan runs costs its size on screen, not the keyspace.
#[derive(Default)]
pub struct KeyIndex {
    keys: BTreeSet<Box<[u8]>>,
    levels: HashMap<LevelId, LevelSummary>,
}

/// The smallest byte string greater than every string starting with `prefix`; `None` when
/// there is none (`prefix` is all `0xff`).
fn successor(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut next = prefix.to_vec();
    while let Some(last) = next.pop() {
        if last < u8::MAX {
            next.push(last + 1);
            return Some(next);
        }
    }
    None
}

impl KeyIndex {
    /// Adds keys; returns how many were new.
    pub fn extend(&mut self, keys: impl IntoIterator<Item = Vec<u8>>) -> usize {
        let mut added = 0;
        for key in keys {
            let key = key.into_boxed_slice();
            if self.keys.contains(&key) {
                continue;
            }
            for ((prefix, delimiter), summary) in &mut self.levels {
                if key.starts_with(prefix) {
                    summary.add(&key[prefix.len()..], delimiter);
                }
            }
            self.keys.insert(key);
            added += 1;
        }
        added
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    fn from<'a>(&'a self, start: Bound<&'a [u8]>) -> impl Iterator<Item = &'a [u8]> + 'a {
        self.keys
            .range::<[u8], _>((start, Bound::Unbounded))
            .map(AsRef::as_ref)
    }

    /// Walks the level `prefix`: each namespace once (its keys skipped by a range jump) and
    /// each key of the level itself. `on_namespace` gets the segment and the namespace's keys
    /// counted, when `count` is set.
    fn walk(
        &self,
        prefix: &[u8],
        delimiter: &[u8],
        count: bool,
        mut on_namespace: impl FnMut(&[u8], u64),
        mut on_leaf: impl FnMut(&[u8]) -> bool,
    ) {
        let mut start: Vec<u8> = prefix.to_vec();
        'outer: loop {
            let jump = {
                let mut iter = self.from(Bound::Included(start.as_slice()));
                loop {
                    let Some(key) = iter.next() else { break 'outer };
                    if !key.starts_with(prefix) {
                        break 'outer;
                    }
                    match segment(&key[prefix.len()..], delimiter) {
                        Some(name) => {
                            let mut ns = prefix.to_vec();
                            ns.extend_from_slice(name);
                            ns.extend_from_slice(delimiter);
                            let upper = successor(&ns);
                            let keys = if count {
                                let range = match &upper {
                                    Some(upper) => self
                                        .keys
                                        .range::<[u8], _>((
                                            Bound::Included(ns.as_slice()),
                                            Bound::Excluded(upper.as_slice()),
                                        ))
                                        .count(),
                                    None => self
                                        .keys
                                        .range::<[u8], _>((
                                            Bound::Included(ns.as_slice()),
                                            Bound::Unbounded,
                                        ))
                                        .count(),
                                };
                                range as u64
                            } else {
                                0
                            };
                            on_namespace(name, keys);
                            break upper;
                        }
                        None => {
                            if !on_leaf(key) {
                                break 'outer;
                            }
                        }
                    }
                }
            };
            // Past the namespace's keys, or at the end of the key space.
            match jump {
                Some(upper) => start = upper,
                None => break,
            }
        }
    }

    fn summary(&mut self, prefix: &[u8], delimiter: &[u8]) -> &LevelSummary {
        let id: LevelId = (prefix.into(), delimiter.into());
        if !self.levels.contains_key(&id) {
            let mut summary = LevelSummary::default();
            self.walk(
                prefix,
                delimiter,
                true,
                |name, keys| {
                    summary.namespaces.insert(name.into(), keys);
                },
                |_| {
                    summary.leaves += 1;
                    true
                },
            );
            if self.levels.len() >= MAX_CACHED_LEVELS {
                self.levels.clear();
            }
            self.levels.insert(id.clone(), summary);
        }
        &self.levels[&id]
    }

    /// The children of `prefix`: the namespaces (keys sharing the next segment before
    /// `delimiter`, with how many keys they hold) then the keys themselves, entries
    /// `[offset, offset + limit)` of that list. An empty delimiter groups nothing.
    pub fn level(
        &mut self,
        prefix: &[u8],
        delimiter: &[u8],
        offset: usize,
        limit: usize,
    ) -> (Vec<KvLevelEntry>, usize) {
        let summary = self.summary(prefix, delimiter);
        let namespaces: Vec<(Box<[u8]>, u64)> = summary
            .namespaces
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(name, keys)| (name.clone(), *keys))
            .collect();
        let namespace_count = summary.namespaces.len();
        let total = namespace_count + usize::try_from(summary.leaves).unwrap_or(usize::MAX);
        let end = offset.saturating_add(limit).min(total);
        let mut entries: Vec<KvLevelEntry> = namespaces
            .into_iter()
            .map(|(name, keys)| {
                let mut full = prefix.to_vec();
                full.extend_from_slice(&name);
                full.extend_from_slice(delimiter);
                KvLevelEntry::Namespace {
                    name: KvBytes::from_bytes(&name),
                    prefix: KvBytes::from_bytes(&full),
                    keys: u32::try_from(keys).unwrap_or(u32::MAX),
                }
            })
            .collect();
        if end > namespace_count.max(offset) {
            let mut skip = offset.saturating_sub(namespace_count);
            let mut left = end - namespace_count.max(offset);
            self.walk(
                prefix,
                delimiter,
                false,
                |_, _| {},
                |key| {
                    if skip > 0 {
                        skip -= 1;
                        return true;
                    }
                    entries.push(KvLevelEntry::Key {
                        name: KvBytes::from_bytes(&key[prefix.len()..]),
                        key: KvBytes::from_bytes(key),
                    });
                    left -= 1;
                    left > 0
                },
            );
        }
        (entries, total)
    }
}

/// The part of `rest` before the first `delimiter`, when there is one.
fn segment<'a>(rest: &'a [u8], delimiter: &[u8]) -> Option<&'a [u8]> {
    if delimiter.is_empty() || rest.len() < delimiter.len() {
        return None;
    }
    rest.windows(delimiter.len())
        .position(|w| w == delimiter)
        .map(|at| &rest[..at])
}

struct ScanInner {
    index: KeyIndex,
    cursor: u64,
    started: bool,
    done: bool,
    /// Pause once the index holds this many keys; `usize::MAX`: read everything.
    target: usize,
    stop: bool,
    state: KvScanState,
    error: Option<YadbeError>,
    estimate: Option<u64>,
    version: u32,
}

/// One key scan of one database, with its index.
pub struct KeyScan {
    pub id: u32,
    pub database: u32,
    pub pattern: Option<Vec<u8>>,
    inner: Mutex<ScanInner>,
    wake: Notify,
    /// Replaced (new pattern, refresh) or its connection closed: the task ends.
    cancelled: AtomicBool,
}

impl KeyScan {
    pub fn new(id: u32, database: u32, pattern: Option<Vec<u8>>, target: usize) -> Self {
        Self {
            id,
            database,
            pattern,
            inner: Mutex::new(ScanInner {
                index: KeyIndex::default(),
                cursor: 0,
                started: false,
                done: false,
                target,
                stop: false,
                state: KvScanState::Running,
                error: None,
                estimate: None,
                version: 0,
            }),
            wake: Notify::new(),
            cancelled: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ScanInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn status(&self) -> KvScanStatus {
        let inner = self.lock();
        KvScanStatus {
            scan_id: self.id,
            database: self.database,
            pattern: self
                .pattern
                .as_ref()
                .map(|p| String::from_utf8_lossy(p).into_owned()),
            loaded: u32::try_from(inner.index.len()).unwrap_or(u32::MAX),
            estimate: inner.estimate.map(|n| u32::try_from(n).unwrap_or(u32::MAX)),
            state: inner.state,
            error: inner.error.clone(),
            version: inner.version,
        }
    }

    /// Reads on: `count` more keys, or every key left (`None`).
    pub fn more(&self, count: Option<usize>) {
        {
            let mut inner = self.lock();
            if inner.done {
                return;
            }
            inner.target = match count {
                None => usize::MAX,
                Some(n) => inner.index.len().saturating_add(n),
            };
            inner.stop = false;
            inner.error = None;
            inner.state = KvScanState::Running;
        }
        self.wake.notify_one();
    }

    /// Stops between two batches.
    pub fn stop(&self) {
        self.lock().stop = true;
        self.wake.notify_one();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn level(&self, prefix: &[u8], delimiter: &[u8], offset: usize, limit: usize) -> KvLevel {
        let mut inner = self.lock();
        let (entries, total) = inner.index.level(prefix, delimiter, offset, limit);
        KvLevel {
            entries,
            total: u32::try_from(total).unwrap_or(u32::MAX),
            version: inner.version,
        }
    }

    /// The `SCAN` call that reads the next batch.
    fn next_command(&self, cursor: u64) -> KvCommand {
        let mut args = vec![b"SCAN".to_vec(), cursor.to_string().into_bytes()];
        if let Some(pattern) = &self.pattern {
            args.push(b"MATCH".to_vec());
            args.push(pattern.clone());
        }
        args.push(b"COUNT".to_vec());
        args.push(SCAN_COUNT.to_string().into_bytes());
        KvCommand::new(args)
    }
}

/// What the scan task needs from the service: a connection on the scan's database through
/// the gate, a way to report progress, and whether the session is gone.
pub trait ScanHost: Send + Sync {
    fn run<'a>(
        &'a self,
        database: u32,
        cmd: &'a KvCommand,
    ) -> crate::db::driver::BoxFuture<'a, Result<KvReply, YadbeError>>;
    fn log(
        &self,
        text: String,
        started_at: SystemTime,
        duration: Duration,
        outcome: Result<Option<u64>, YadbeError>,
    );
    fn progress(&self, status: KvScanStatus);
    fn closed(&self) -> bool;
}

/// The `[cursor, [keys…]]` reply of `SCAN`.
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

/// Statistics of the batches read since the last pause, logged as one entry.
struct Run {
    started_at: SystemTime,
    start: Instant,
    from_cursor: u64,
    batches: u64,
    keys: u64,
}

impl Run {
    fn new(cursor: u64) -> Self {
        Self {
            started_at: SystemTime::now(),
            start: Instant::now(),
            from_cursor: cursor,
            batches: 0,
            keys: 0,
        }
    }
}

fn log_run(
    host: &dyn ScanHost,
    scan: &KeyScan,
    run: &Run,
    to_cursor: u64,
    error: Option<YadbeError>,
) {
    if run.batches == 0 && error.is_none() {
        return;
    }
    let mut text = scan.next_command(run.from_cursor).display();
    text.push_str(&format!(
        "  -- {} batches, cursor {} → {}, {} keys",
        run.batches, run.from_cursor, to_cursor, run.keys
    ));
    host.log(
        text,
        run.started_at,
        run.start.elapsed(),
        match error {
            Some(err) => Err(err),
            None => Ok(Some(run.keys)),
        },
    );
}

/// The scan task: reads batches until the target, waits for "more", ends when the scan is
/// done, replaced, or its session closed.
pub async fn run_scan(scan: Arc<KeyScan>, host: Arc<dyn ScanHost>) {
    let mut last_emit = Instant::now() - PROGRESS_EVERY;
    let mut run: Option<Run> = None;
    loop {
        if scan.is_cancelled() || host.closed() {
            return;
        }
        // Pause (target reached, stopped, failed) or finish.
        let (cursor, wait) = {
            let mut inner = scan.lock();
            if inner.done {
                inner.state = KvScanState::Done;
                (inner.cursor, None)
            } else if inner.stop {
                inner.state = KvScanState::Stopped;
                (inner.cursor, Some(()))
            } else if inner.error.is_some() {
                inner.state = KvScanState::Failed;
                (inner.cursor, Some(()))
            } else if inner.index.len() >= inner.target {
                inner.state = KvScanState::Paused;
                (inner.cursor, Some(()))
            } else {
                inner.state = KvScanState::Running;
                (inner.cursor, None)
            }
        };
        let done = scan.lock().done;
        if done || wait.is_some() {
            if let Some(finished) = run.take() {
                log_run(&*host, &scan, &finished, cursor, None);
            }
            host.progress(scan.status());
            last_emit = Instant::now();
            if done {
                return;
            }
            scan.wake.notified().await;
            continue;
        }
        let started = scan.lock().started;
        if !started {
            let dbsize = KvCommand::of(["DBSIZE"]);
            let estimate = host
                .run(scan.database, &dbsize)
                .await
                .ok()
                .and_then(|r| r.int())
                .and_then(|n| u64::try_from(n).ok());
            let mut inner = scan.lock();
            inner.estimate = estimate;
            inner.started = true;
        }
        let current = run.get_or_insert_with(|| Run::new(cursor));
        let cmd = scan.next_command(cursor);
        match host.run(scan.database, &cmd).await.and_then(scan_reply) {
            Ok((next, keys)) => {
                current.batches += 1;
                let mut inner = scan.lock();
                let added = inner.index.extend(keys);
                current.keys += added as u64;
                if added > 0 {
                    inner.version = inner.version.wrapping_add(1);
                }
                inner.cursor = next;
                if next == 0 {
                    inner.done = true;
                }
            }
            Err(err) => {
                if let Some(failed) = run.take() {
                    log_run(&*host, &scan, &failed, cursor, Some(err.clone()));
                }
                scan.lock().error = Some(err);
                continue;
            }
        }
        if last_emit.elapsed() >= PROGRESS_EVERY {
            host.progress(scan.status());
            last_emit = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(keys: &[&str]) -> KeyIndex {
        let mut index = KeyIndex::default();
        index.extend(keys.iter().map(|k| k.as_bytes().to_vec()));
        index
    }

    fn names(entries: &[KvLevelEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| match e {
                KvLevelEntry::Namespace { name, keys, .. } => format!("{}/ ({keys})", name.text),
                KvLevelEntry::Key { name, .. } => name.text.clone(),
            })
            .collect()
    }

    #[test]
    fn groups_keys_by_the_delimiter() {
        let mut index = index(&[
            "user:1:name",
            "user:1:email",
            "user:2:name",
            "user",
            "session:abc",
            "plain",
            "user:3",
        ]);
        let (root, total) = index.level(b"", b":", 0, 100);
        assert_eq!(names(&root), ["session/ (1)", "user/ (4)", "plain", "user"]);
        assert_eq!(total, 4);
        let (user, _) = index.level(b"user:", b":", 0, 100);
        assert_eq!(names(&user), ["1/ (2)", "2/ (1)", "3"]);
        match &user[0] {
            KvLevelEntry::Namespace { prefix, .. } => assert_eq!(prefix.text, "user:1:"),
            KvLevelEntry::Key { .. } => panic!("a namespace first"),
        }
        let (flat, total) = index.level(b"", b"", 0, 100);
        assert_eq!(total, 7);
        assert_eq!(flat.len(), 7);
    }

    #[test]
    fn pages_across_namespaces_and_keys() {
        let mut index = index(&["a:1", "b:1", "c:1", "k1", "k2", "k3"]);
        let mut page = |offset, limit| names(&index.level(b"", b":", offset, limit).0);
        assert_eq!(page(0, 2), ["a/ (1)", "b/ (1)"]);
        assert_eq!(page(2, 2), ["c/ (1)", "k1"]);
        assert_eq!(page(4, 10), ["k2", "k3"]);
        assert!(page(9, 2).is_empty());
    }

    #[test]
    fn a_level_read_once_follows_new_keys() {
        let mut index = index(&["user:1", "user:2", "top"]);
        assert_eq!(
            names(&index.level(b"", b":", 0, 10).0),
            ["user/ (2)", "top"]
        );
        index.extend([
            b"user:3".to_vec(),
            b"order:1".to_vec(),
            b"a".to_vec(),
            b"user:1".to_vec(),
        ]);
        assert_eq!(
            names(&index.level(b"", b":", 0, 10).0),
            ["order/ (1)", "user/ (3)", "a", "top"]
        );
        // Every key 0xff: no upper bound for the namespace jump.
        index.extend([vec![0xff, b':', 0xff]]);
        assert_eq!(index.level(b"", b":", 0, 10).1, 5);
        assert_eq!(index.level(&[0xff, b':'], b":", 0, 10).1, 1);
    }

    #[test]
    fn duplicates_and_binary_keys() {
        let mut index = KeyIndex::default();
        assert_eq!(
            index.extend([b"a".to_vec(), b"a".to_vec(), vec![0xff, b':', 1]]),
            2
        );
        let (root, _) = index.level(b"", b":", 0, 10);
        match &root[0] {
            KvLevelEntry::Namespace { name, prefix, .. } => {
                assert_eq!(name.text, "\\xff");
                assert_eq!(prefix.to_bytes().expect("bytes"), vec![0xff, b':']);
            }
            KvLevelEntry::Key { .. } => panic!("namespace"),
        }
        let mut multi = {
            let mut i = KeyIndex::default();
            i.extend([b"a::b".to_vec(), b"a::c::d".to_vec()]);
            i
        };
        assert_eq!(names(&multi.level(b"a::", b"::", 0, 10).0), ["c/ (1)", "b"]);
    }
}
