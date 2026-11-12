//! `KeyValueService`: what the key-value commands (`kv_*`) do on a Redis / Valkey session —
//! the explorer (databases, key scans and their tree levels, key summaries), the key tabs
//! (key header, string windows, JSON documents, collections paged into the result store) and
//! the console. Every command goes through the session's [`gate::Gate`].
//!
//! Connections: one per database index and session (`SELECT` is per connection), the
//! session's own connection for its database, and one per console tab.

pub mod console;
pub mod gate;
pub mod model;
pub mod scan;
pub mod viewer;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use crate::db::driver::{BoxFuture, KeyValueConnection};
use crate::db::engine::EngineFamily;
use crate::db::errors::YadbeError;
use crate::db::keyvalue::{KvBytes, KvCommand, KvReply, key_value_only};
use crate::events::{BackendEvent, EventSink};
use crate::session::history_hook::{HistoryRecorder, NoHistory};
use crate::session::result_store::ResultStore;
use crate::session::{ConnectionManager, ConnectionSession};

use self::gate::{Gate, Origin, SpecCache, parse_keyspace};
use self::model::{
    KvCollection, KvConsoleOutcome, KvDatabase, KvKeyInfo, KvKeyKind, KvKeySummary, KvLevel,
    KvScanProgress, KvScanStatus, KvStringChunk,
};
use self::scan::{DEFAULT_SCAN_TARGET, KeyScan, ScanHost, run_scan};

/// Keys whose summary one call may ask for (the rows on screen).
const MAX_SUMMARIES: usize = 500;
/// Largest level page.
const MAX_LEVEL_PAGE: u32 = 5_000;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A connection per database index; `true`: opened for yadbe (closed with the pool), not the
/// session's own.
type ByDatabase = HashMap<u32, (Arc<dyn KeyValueConnection>, bool)>;

/// The key-value connections and scans of one open session.
pub struct Pool {
    connection_id: String,
    session: Arc<ConnectionSession>,
    specs: SpecCache,
    by_db: tokio::sync::Mutex<ByDatabase>,
    scans: Mutex<HashMap<u32, Arc<KeyScan>>>,
    sink: Arc<dyn EventSink>,
}

impl Pool {
    pub fn gate<'a>(&'a self, history: &'a dyn HistoryRecorder) -> Gate<'a> {
        Gate {
            session: &self.session,
            specs: &self.specs,
            history,
        }
    }

    pub fn session(&self) -> &ConnectionSession {
        &self.session
    }

    /// The database the connection is saved on.
    pub fn home_database(&self) -> u32 {
        self.session.target().database.trim().parse().unwrap_or(0)
    }

    /// A connection on database `db`, opened on first use and again after a drop.
    pub async fn conn(&self, db: u32) -> Result<Arc<dyn KeyValueConnection>, YadbeError> {
        let mut by_db = self.by_db.lock().await;
        if let Some((conn, _)) = by_db.get(&db)
            && !conn.link().is_lost()
        {
            return Ok(Arc::clone(conn));
        }
        let main = self.session.backend()?.into_key_value()?;
        let (conn, dedicated) = if main.database() == db {
            (main, false)
        } else {
            let opened = self
                .session
                .open_dedicated(Some(&db.to_string()))
                .await?
                .into_key_value()?;
            (opened, true)
        };
        if let Some((old, true)) = by_db.insert(db, (Arc::clone(&conn), dedicated)) {
            old.close().await;
        }
        Ok(conn)
    }

    /// Yadbe's own command on database `db`, through the gate, in the statement log.
    pub async fn run(&self, db: u32, cmd: &KvCommand) -> Result<KvReply, YadbeError> {
        let conn = self.conn(db).await?;
        self.gate(&NoHistory)
            .run(&*conn, cmd, Origin::Yadbe, false)
            .await
    }

    /// Yadbe's own commands on database `db` in one round trip, one statement-log entry.
    pub async fn run_all(
        &self,
        db: u32,
        cmds: &[KvCommand],
    ) -> Result<Vec<Result<KvReply, YadbeError>>, YadbeError> {
        let conn = self.conn(db).await?;
        Ok(self.gate(&NoHistory).run_all(&*conn, cmds).await)
    }

    fn closed(&self) -> bool {
        self.session.is_closed()
    }

    async fn shutdown(&self) {
        for scan in lock(&self.scans).drain().map(|(_, s)| s) {
            scan.cancel();
        }
        let conns: Vec<_> = self.by_db.lock().await.drain().map(|(_, c)| c).collect();
        for (conn, dedicated) in conns {
            if dedicated {
                conn.close().await;
            }
        }
    }
}

impl ScanHost for Pool {
    fn run<'a>(
        &'a self,
        database: u32,
        cmd: &'a KvCommand,
    ) -> BoxFuture<'a, Result<KvReply, YadbeError>> {
        Box::pin(async move {
            let conn = self.conn(database).await?;
            // `SCAN` batches are logged together by the scan; the rest one by one.
            let origin = if cmd.name() == "scan" {
                Origin::Batched
            } else {
                Origin::Yadbe
            };
            self.gate(&NoHistory).run(&*conn, cmd, origin, false).await
        })
    }

    fn log(
        &self,
        text: String,
        started_at: SystemTime,
        duration: Duration,
        outcome: Result<Option<u64>, YadbeError>,
    ) {
        self.gate(&NoHistory)
            .log_batch(text, started_at, duration, outcome);
    }

    fn progress(&self, status: KvScanStatus) {
        self.sink.emit(BackendEvent::KvScanProgress(KvScanProgress {
            connection_id: self.connection_id.clone(),
            status,
        }));
    }

    fn closed(&self) -> bool {
        Pool::closed(self)
    }
}

pub struct KeyValueService {
    connections: Arc<ConnectionManager>,
    store: Arc<ResultStore>,
    sink: Arc<dyn EventSink>,
    history: Arc<dyn HistoryRecorder>,
    pools: Arc<Mutex<HashMap<String, Arc<Pool>>>>,
    collections: Mutex<HashMap<u32, Arc<tokio::sync::Mutex<viewer::Collection>>>>,
    consoles: Mutex<HashMap<String, Arc<console::Console>>>,
    next_scan: AtomicU32,
}

impl KeyValueService {
    pub fn new(
        connections: Arc<ConnectionManager>,
        store: Arc<ResultStore>,
        sink: Arc<dyn EventSink>,
        history: Arc<dyn HistoryRecorder>,
    ) -> Self {
        Self {
            connections,
            store,
            sink,
            history,
            pools: Arc::new(Mutex::new(HashMap::new())),
            collections: Mutex::new(HashMap::new()),
            consoles: Mutex::new(HashMap::new()),
            next_scan: AtomicU32::new(1),
        }
    }

    /// The pool of an open key-value session: `notConnected`, or `notSupported` for another
    /// family.
    pub fn pool(&self, connection_id: &str) -> Result<Arc<Pool>, YadbeError> {
        let session = self.connections.session(connection_id)?;
        if session.target().engine.family() != EngineFamily::KeyValue {
            return Err(key_value_only());
        }
        let mut pools = lock(&self.pools);
        if let Some(pool) = pools.get(connection_id)
            && Arc::ptr_eq(&pool.session, &session)
            && !pool.closed()
        {
            return Ok(Arc::clone(pool));
        }
        let pool = Arc::new(Pool {
            connection_id: connection_id.to_owned(),
            session: Arc::clone(&session),
            specs: SpecCache::default(),
            by_db: tokio::sync::Mutex::new(HashMap::new()),
            scans: Mutex::new(HashMap::new()),
            sink: Arc::clone(&self.sink),
        });
        if let Some(old) = pools.insert(connection_id.to_owned(), Arc::clone(&pool)) {
            tokio::spawn(async move { old.shutdown().await });
        }
        // The pool goes with its session.
        let watched = Arc::clone(&pool);
        let all = Arc::clone(&self.pools);
        tokio::spawn(async move {
            let mut closed = watched.session.closed();
            let _ = closed.wait_for(|closed| *closed).await;
            {
                let mut pools = lock(&all);
                if pools
                    .get(&watched.connection_id)
                    .is_some_and(|p| Arc::ptr_eq(p, &watched))
                {
                    pools.remove(&watched.connection_id);
                }
            }
            watched.shutdown().await;
        });
        Ok(pool)
    }

    pub fn history(&self) -> &dyn HistoryRecorder {
        &*self.history
    }

    pub fn store(&self) -> &Arc<ResultStore> {
        &self.store
    }

    // --- Explorer -------------------------------------------------------------------------

    /// The databases that hold keys (`INFO keyspace`), and the connection's own.
    pub async fn databases(&self, connection_id: &str) -> Result<Vec<KvDatabase>, YadbeError> {
        let pool = self.pool(connection_id)?;
        let home = pool.home_database();
        let info = pool
            .run(home, &KvCommand::of(["INFO", "keyspace"]))
            .await?
            .text()
            .unwrap_or_default();
        let mut databases: Vec<KvDatabase> = parse_keyspace(&info)
            .into_iter()
            .map(|(index, keys, expires)| KvDatabase {
                index,
                keys: u32::try_from(keys).unwrap_or(u32::MAX),
                expires: u32::try_from(expires).unwrap_or(u32::MAX),
                current: index == home,
            })
            .collect();
        if !databases.iter().any(|db| db.index == home) {
            databases.push(KvDatabase {
                index: home,
                keys: 0,
                expires: 0,
                current: true,
            });
        }
        databases.sort_by_key(|db| db.index);
        Ok(databases)
    }

    fn start_scan(&self, pool: &Arc<Pool>, db: u32, pattern: Option<Vec<u8>>) -> Arc<KeyScan> {
        let id = self.next_scan.fetch_add(1, Ordering::Relaxed);
        let scan = Arc::new(KeyScan::new(id, db, pattern, DEFAULT_SCAN_TARGET));
        if let Some(old) = lock(&pool.scans).insert(db, Arc::clone(&scan)) {
            old.cancel();
        }
        let host: Arc<dyn ScanHost> = Arc::clone(pool) as Arc<dyn ScanHost>;
        tokio::spawn(run_scan(Arc::clone(&scan), host));
        scan
    }

    fn pattern_bytes(pattern: Option<String>) -> Option<Vec<u8>> {
        pattern
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty() && p != "*")
            .map(String::into_bytes)
    }

    /// The key scan of a database with this pattern: the running one, or a new one.
    pub fn scan_status(
        &self,
        connection_id: &str,
        db: u32,
        pattern: Option<String>,
    ) -> Result<KvScanStatus, YadbeError> {
        let pool = self.pool(connection_id)?;
        let pattern = Self::pattern_bytes(pattern);
        let current = lock(&pool.scans).get(&db).cloned();
        let scan = match current {
            Some(scan) if scan.pattern == pattern && !scan.is_cancelled() => scan,
            _ => self.start_scan(&pool, db, pattern),
        };
        Ok(scan.status())
    }

    fn scan(&self, connection_id: &str, db: u32) -> Result<Arc<KeyScan>, YadbeError> {
        let pool = self.pool(connection_id)?;
        let scan = lock(&pool.scans).get(&db).cloned();
        scan.ok_or_else(|| {
            YadbeError::invalid_argument(
                "No key scan runs on this database: open it in the explorer.",
                "Aucun parcours de clés n'est en cours sur cette base : ouvrez-la dans l'explorateur.",
            )
        })
    }

    /// Reads on: `count` more keys, or all of them.
    pub fn scan_more(
        &self,
        connection_id: &str,
        db: u32,
        count: Option<u32>,
    ) -> Result<KvScanStatus, YadbeError> {
        let scan = self.scan(connection_id, db)?;
        scan.more(count.map(|n| n as usize));
        Ok(scan.status())
    }

    pub fn scan_stop(&self, connection_id: &str, db: u32) -> Result<KvScanStatus, YadbeError> {
        let scan = self.scan(connection_id, db)?;
        scan.stop();
        Ok(scan.status())
    }

    /// Forgets the keys found and scans again (F5 on a database).
    pub fn scan_restart(&self, connection_id: &str, db: u32) -> Result<KvScanStatus, YadbeError> {
        let pool = self.pool(connection_id)?;
        let pattern = lock(&pool.scans).get(&db).and_then(|s| s.pattern.clone());
        Ok(self.start_scan(&pool, db, pattern).status())
    }

    /// One level of the key tree of a database's scan.
    pub fn scan_level(
        &self,
        connection_id: &str,
        db: u32,
        prefix: &KvBytes,
        delimiter: &str,
        offset: u32,
        limit: u32,
    ) -> Result<KvLevel, YadbeError> {
        let scan = self.scan(connection_id, db)?;
        let prefix = prefix.to_bytes()?;
        Ok(scan.level(
            &prefix,
            delimiter.as_bytes(),
            offset as usize,
            limit.min(MAX_LEVEL_PAGE) as usize,
        ))
    }

    /// Type, time to live and memory of the keys on screen, in one round trip.
    pub async fn key_summaries(
        &self,
        connection_id: &str,
        db: u32,
        keys: Vec<KvBytes>,
    ) -> Result<Vec<KvKeySummary>, YadbeError> {
        if keys.len() > MAX_SUMMARIES {
            return Err(YadbeError::invalid_argument(
                format!("At most {MAX_SUMMARIES} keys at a time."),
                format!("Au plus {MAX_SUMMARIES} clés à la fois."),
            ));
        }
        let pool = self.pool(connection_id)?;
        let raw: Vec<Vec<u8>> = keys
            .iter()
            .map(KvBytes::to_bytes)
            .collect::<Result<_, _>>()?;
        let mut cmds = Vec::with_capacity(raw.len() * 3);
        for key in &raw {
            cmds.push(KvCommand::of([b"TYPE".as_slice(), key]));
            cmds.push(KvCommand::of([b"PTTL".as_slice(), key]));
            cmds.push(KvCommand::of([b"MEMORY".as_slice(), b"USAGE", key]));
        }
        let replies = pool.run_all(db, &cmds).await?;
        let mut replies = replies.into_iter();
        let mut out = Vec::with_capacity(keys.len());
        for key in keys {
            let type_name = replies
                .next()
                .and_then(Result::ok)
                .and_then(|r| r.text())
                .unwrap_or_default();
            let ttl = replies.next().and_then(Result::ok).and_then(|r| r.int());
            let memory = replies.next().and_then(Result::ok).and_then(|r| r.int());
            out.push(KvKeySummary {
                key,
                kind: KvKeyKind::of_type(&type_name),
                type_name,
                ttl_ms: viewer::ttl_of(ttl),
                memory: memory.filter(|m| *m >= 0).map(|m| m as f64),
            });
        }
        Ok(out)
    }

    // --- Key tabs -------------------------------------------------------------------------

    pub async fn key_info(
        &self,
        connection_id: &str,
        db: u32,
        key: &KvBytes,
    ) -> Result<KvKeyInfo, YadbeError> {
        let pool = self.pool(connection_id)?;
        viewer::key_info(&pool, db, key).await
    }

    pub async fn read_string(
        &self,
        connection_id: &str,
        db: u32,
        key: &KvBytes,
        offset: u64,
        length: u32,
    ) -> Result<KvStringChunk, YadbeError> {
        let pool = self.pool(connection_id)?;
        viewer::read_string(&pool, db, key, offset, length).await
    }

    pub async fn read_json(
        &self,
        connection_id: &str,
        db: u32,
        key: &KvBytes,
    ) -> Result<String, YadbeError> {
        let pool = self.pool(connection_id)?;
        viewer::read_json(&pool, db, key).await
    }

    /// Opens a collection (hash, list, set, sorted set, stream) and reads its first rows.
    pub async fn open_collection(
        &self,
        connection_id: &str,
        db: u32,
        key: &KvBytes,
        rows: u32,
    ) -> Result<KvCollection, YadbeError> {
        let pool = self.pool(connection_id)?;
        let mut collection =
            viewer::Collection::open(pool, &self.store, db, key.to_bytes()?).await?;
        collection.fill(rows as usize).await?;
        let summary = collection.summary();
        lock(&self.collections).insert(
            summary.result_id,
            Arc::new(tokio::sync::Mutex::new(collection)),
        );
        Ok(summary)
    }

    /// Reads `rows` more rows of an open collection (all of them with `None`).
    pub async fn collection_more(
        &self,
        result_id: u32,
        rows: Option<u32>,
    ) -> Result<KvCollection, YadbeError> {
        let collection = lock(&self.collections)
            .get(&result_id)
            .cloned()
            .ok_or_else(|| YadbeError::result_not_found(result_id))?;
        let mut collection = collection.lock().await;
        collection
            .fill(rows.map_or(usize::MAX, |n| n as usize))
            .await?;
        Ok(collection.summary())
    }

    /// Frees an open collection's rows.
    pub fn close_collection(&self, result_id: u32) {
        lock(&self.collections).remove(&result_id);
        self.store.remove([result_id]);
    }

    // --- Console --------------------------------------------------------------------------

    pub async fn console_run(
        &self,
        tab_id: &str,
        connection_id: &str,
        text: &str,
        confirmed: bool,
    ) -> Result<KvConsoleOutcome, YadbeError> {
        let pool = self.pool(connection_id)?;
        let console = {
            let mut consoles = lock(&self.consoles);
            let entry = consoles
                .entry(tab_id.to_owned())
                .or_insert_with(|| Arc::new(console::Console::new(tab_id, connection_id)));
            if entry.connection_id() != connection_id {
                let old = std::mem::replace(
                    entry,
                    Arc::new(console::Console::new(tab_id, connection_id)),
                );
                old.release(&self.store);
            }
            Arc::clone(entry)
        };
        console
            .run(&pool, &self.store, &*self.history, text, confirmed)
            .await
    }

    /// Stops a console run after the command that runs now.
    pub fn console_stop(&self, tab_id: &str) {
        if let Some(console) = lock(&self.consoles).get(tab_id) {
            console.stop();
        }
    }

    /// Frees what a console tab holds (results, connection).
    pub async fn console_close(&self, tab_id: &str) {
        let console = lock(&self.consoles).remove(tab_id);
        if let Some(console) = console {
            console.release(&self.store);
            console.close().await;
        }
    }
}
