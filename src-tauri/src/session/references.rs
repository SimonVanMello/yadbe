//! `ReferenceService`: the reads of foreign key navigation (M3-2, F-088) — the row a foreign
//! key value references, how many rows reference a row, and a searchable page of a
//! referenced table for the foreign key cell editor.
//!
//! **Connection.** A table tab's lookups run on a server connection of their own, opened on
//! the tab's database on first use and closed with the tab: not the tab's page connection, so
//! a peek or a count never waits behind a long page and cancelling one never stops the
//! other; not the session's shared connection, which metadata reads use. One lookup runs per
//! tab at a time, the next ones wait their turn.
//!
//! **Cancellation.** Each call carries a request id; `cancel` stops it with the engine's
//! native cancel when it runs, or before it starts when it waits. The call then fails with
//! `cancelled`.
//!
//! **Statements** are built by `reference_sql.rs` from the referenced table's cached
//! metadata (values bound, identifiers quoted) and recorded in the statement log. Rows are
//! kept in the shared `ResultStore` (long cells: `fetch_result_cell`), a few per tab.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::db::driver::{BoundStatement, CancelHandle, Connection};
use crate::db::errors::YadbeError;
use crate::db::meta::{ObjectRef, Qualifier};
use crate::db::value::{ColumnMeta, QueryResult, Value};
use crate::session::ConnectionManager;
use crate::session::meta_cache::MetaService;
use crate::session::query_model::ResultWindow;
use crate::session::reference_model::{
    BoundedCount, KeyValue, LookupPage, LookupRequest, MAX_COUNT_LIMIT, ReferencedRow,
};
use crate::session::reference_sql;
use crate::session::result_store::ResultStore;
use crate::session::table_data::{TabTarget, TableDataService};
use crate::session::table_model::PAGE_WINDOW_ROWS;
use crate::session::table_shape::TableShape;

/// Lookup results a tab keeps in the store (older ones are freed).
const KEPT_RESULTS: usize = 16;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn ms(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The lookup connection of a tab.
struct LookupConnection {
    connection_id: String,
    database: Option<String>,
    conn: Arc<dyn Connection>,
    /// Its link dropped or its session closed.
    dead: Arc<AtomicBool>,
    watcher: JoinHandle<()>,
}

impl LookupConnection {
    fn usable(&self, target: &TabTarget) -> bool {
        !self.dead.load(Ordering::SeqCst)
            && !self.conn.link().is_lost()
            && self.connection_id == target.connection_id
            && self.database == target.database
    }

    async fn close(self) {
        self.watcher.abort();
        self.conn.close().await;
    }
}

#[derive(Default)]
struct Slot {
    conn: Arc<AsyncMutex<Option<LookupConnection>>>,
    results: Mutex<VecDeque<u32>>,
}

#[derive(Default)]
struct Request {
    cancelled: AtomicBool,
    handle: Mutex<Option<Arc<dyn CancelHandle>>>,
}

/// Forgets a request when its call ends, however it ends.
struct Registered<'a> {
    service: &'a ReferenceService,
    id: String,
    request: Arc<Request>,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        let mut requests = lock(&self.service.requests);
        if requests
            .get(&self.id)
            .is_some_and(|r| Arc::ptr_eq(r, &self.request))
        {
            requests.remove(&self.id);
        }
    }
}

pub struct ReferenceService {
    manager: Arc<ConnectionManager>,
    meta: Arc<MetaService>,
    tables: Arc<TableDataService>,
    store: Arc<ResultStore>,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    requests: Mutex<HashMap<String, Arc<Request>>>,
}

impl ReferenceService {
    pub fn new(
        manager: Arc<ConnectionManager>,
        meta: Arc<MetaService>,
        tables: Arc<TableDataService>,
        store: Arc<ResultStore>,
    ) -> Self {
        Self {
            manager,
            meta,
            tables,
            store,
            slots: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
        }
    }

    fn slot(&self, tab_id: &str) -> Arc<Slot> {
        Arc::clone(lock(&self.slots).entry(tab_id.to_owned()).or_default())
    }

    fn register(&self, request_id: &str) -> Registered<'_> {
        let request = Arc::new(Request::default());
        lock(&self.requests).insert(request_id.to_owned(), Arc::clone(&request));
        Registered {
            service: self,
            id: request_id.to_owned(),
            request,
        }
    }

    /// The referenced table as a tab of `tab_id` would see it: its target and shape. The table
    /// must be in the tab's database, unless the engine names objects by their database
    /// (MySQL: one connection reaches every database, and foreign keys may cross them).
    async fn describe(
        &self,
        tab_id: &str,
        request_id: &str,
        table: &ObjectRef,
    ) -> Result<(TabTarget, TableShape), YadbeError> {
        let target = self.tables.tab_target(tab_id)?;
        let qualified_by_database =
            Qualifier::of(&target.dialect.capabilities()) == Qualifier::Database;
        if table.database != target.table.database && !qualified_by_database {
            return Err(YadbeError::invalid_argument(
                "The table is in another database than the tab's.",
                "La table est dans une autre base que celle de l'onglet.",
            ));
        }
        let details = self
            .meta
            .table_details(
                &self.manager,
                Some(request_id),
                &target.connection_id,
                table,
            )
            .await?;
        let shape = TableShape::new(target.dialect, details, target.read_only, &HashMap::new());
        Ok((target, shape))
    }

    /// Runs one statement on the tab's lookup connection, cancellable with `request_id`.
    async fn run(
        &self,
        tab_id: &str,
        registered: &Registered<'_>,
        target: &TabTarget,
        statement: &BoundStatement,
        max_rows: usize,
    ) -> Result<QueryResult, YadbeError> {
        let request = &registered.request;
        let slot = self.slot(tab_id);
        let mut guard = Arc::clone(&slot.conn).lock_owned().await;
        if request.cancelled.load(Ordering::SeqCst) {
            return Err(YadbeError::cancelled());
        }
        if !guard.as_ref().is_some_and(|c| c.usable(target)) {
            if let Some(stale) = guard.take() {
                stale.close().await;
            }
            let session = self.manager.session(&target.connection_id)?;
            let conn: Arc<dyn Connection> =
                Arc::from(session.open_dedicated(target.database.as_deref()).await?);
            let dead = Arc::new(AtomicBool::new(false));
            let mut closed = session.closed();
            let watched = Arc::clone(&conn);
            let flag = Arc::clone(&dead);
            let watcher = tokio::spawn(async move {
                let mut link = watched.link();
                let session_closed = tokio::select! {
                    () = link.lost() => false,
                    _ = closed.wait_for(|closed| *closed) => true,
                };
                flag.store(true, Ordering::SeqCst);
                if session_closed {
                    watched.close().await;
                }
            });
            *guard = Some(LookupConnection {
                connection_id: target.connection_id.clone(),
                database: target.database.clone(),
                conn,
                dead,
                watcher,
            });
        }
        let conn = guard
            .as_ref()
            .map(|c| Arc::clone(&c.conn))
            .ok_or_else(|| YadbeError::internal("lookup connection missing"))?;
        *lock(&request.handle) = Some(conn.cancel_handle());
        // Checked after the handle is set: a cancel either sees the handle or is seen here.
        let result = if request.cancelled.load(Ordering::SeqCst) {
            Err(YadbeError::cancelled())
        } else {
            conn.query_bound(statement, max_rows)
                .await
                .map_err(|f| f.error)
        };
        *lock(&request.handle) = None;
        drop(guard);
        if request.cancelled.load(Ordering::SeqCst) {
            return Err(YadbeError::cancelled());
        }
        result
    }

    /// Keeps rows in the store for the tab; the oldest lookups of the tab are freed.
    fn keep(&self, tab_id: &str, columns: Vec<ColumnMeta>, rows: Vec<Vec<Value>>) -> ResultWindow {
        let stored = self.store.create(columns);
        stored.append(rows);
        let slot = self.slot(tab_id);
        let freed: Vec<u32> = {
            let mut results = lock(&slot.results);
            results.push_back(stored.id());
            let excess = results.len().saturating_sub(KEPT_RESULTS);
            results.drain(..excess).collect()
        };
        self.store.remove(freed);
        stored.window(0, PAGE_WINDOW_ROWS as usize)
    }

    /// The row `key` designates in `table` (the peek of a foreign key value).
    pub async fn referenced_row(
        &self,
        tab_id: &str,
        request_id: &str,
        table: &ObjectRef,
        key: &[KeyValue],
    ) -> Result<ReferencedRow, YadbeError> {
        let registered = self.register(request_id);
        let started = Instant::now();
        let (target, shape) = self.describe(tab_id, request_id, table).await?;
        let statement = reference_sql::referenced_row(target.dialect, &shape, key)?;
        let result = self
            .run(tab_id, &registered, &target, &statement, 2)
            .await?;
        let mut rows = result.rows;
        rows.truncate(2);
        shape.normalize(&mut rows);
        let matches = to_u32(rows.len());
        let window = self.keep(tab_id, shape.column_meta(), rows);
        Ok(ReferencedRow {
            columns: shape.info.columns,
            window,
            matches,
            duration_ms: ms(started),
        })
    }

    /// How many rows of `table` hold `key`, counted up to `limit` (rows referencing a row).
    pub async fn count_rows(
        &self,
        tab_id: &str,
        request_id: &str,
        table: &ObjectRef,
        key: &[KeyValue],
        limit: u32,
    ) -> Result<BoundedCount, YadbeError> {
        if limit == 0 || limit > MAX_COUNT_LIMIT {
            return Err(YadbeError::invalid_argument(
                format!("A count stops at 1 to {MAX_COUNT_LIMIT} rows."),
                format!("Un comptage s'arrête entre 1 et {MAX_COUNT_LIMIT} lignes."),
            ));
        }
        let registered = self.register(request_id);
        let started = Instant::now();
        let (target, shape) = self.describe(tab_id, request_id, table).await?;
        // One row more than shown tells "more than `limit`".
        let statement = reference_sql::bounded_count(target.dialect, &shape, key, limit + 1)?;
        let result = self
            .run(tab_id, &registered, &target, &statement, 1)
            .await?;
        let counted = result
            .scalar_text()
            .and_then(|t| t.trim().parse::<u64>().ok())
            .unwrap_or(0);
        Ok(BoundedCount {
            count: u32::try_from(counted.min(u64::from(limit))).unwrap_or(limit),
            more: counted > u64::from(limit),
            duration_ms: ms(started),
        })
    }

    /// A page of a referenced table: key and display columns, searched as text.
    pub async fn lookup(
        &self,
        tab_id: &str,
        request_id: &str,
        request: &LookupRequest,
    ) -> Result<LookupPage, YadbeError> {
        let registered = self.register(request_id);
        let started = Instant::now();
        let (target, shape) = self.describe(tab_id, request_id, &request.table).await?;
        let statement = reference_sql::lookup(target.dialect, &shape, request)?;
        let indices = reference_sql::lookup_columns(&shape, request)?;
        let result = self
            .run(tab_id, &registered, &target, &statement, usize::MAX)
            .await?;
        let mut rows = result.rows;
        let limit = request.limit as usize;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let as_text: Vec<bool> = indices.iter().map(|&i| shape.as_text[i]).collect();
        for row in &mut rows {
            for (value, text) in row.iter_mut().zip(&as_text) {
                if *text && let Value::Text(t) = value {
                    *value = Value::Other(std::mem::take(t));
                }
            }
        }
        let all = shape.column_meta();
        let columns: Vec<ColumnMeta> = indices.iter().map(|&i| all[i].clone()).collect();
        let window = self.keep(tab_id, columns.clone(), rows);
        Ok(LookupPage {
            columns,
            window,
            offset: request.offset,
            has_more,
            duration_ms: ms(started),
        })
    }

    /// Stops the call started with `request_id` (it fails with `cancelled`). Does nothing when
    /// it already ended.
    pub async fn cancel(&self, request_id: &str) {
        self.meta.cancel(request_id);
        let request = lock(&self.requests).get(request_id).cloned();
        let Some(request) = request else {
            return;
        };
        request.cancelled.store(true, Ordering::SeqCst);
        let handle = lock(&request.handle).clone();
        if let Some(handle) = handle
            && let Err(err) = handle.cancel().await
        {
            tracing::debug!(error = %err, "lookup cancel failed");
        }
    }

    /// The tab closed: its lookup connection and rows go.
    pub async fn close(&self, tab_id: &str) {
        let Some(slot) = lock(&self.slots).remove(tab_id) else {
            return;
        };
        let ids: Vec<u32> = lock(&slot.results).drain(..).collect();
        self.store.remove(ids);
        let taken = slot.conn.lock().await.take();
        if let Some(conn) = taken {
            conn.close().await;
        }
    }
}
