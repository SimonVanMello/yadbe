//! `TableDataService`: table tabs (M2-1 browsing, M2-2 edits).
//!
//! **Connection.** Each table tab owns a dedicated server connection, opened on its first
//! use from its `ConnectionSession` (on the table's database) and kept until the tab closes,
//! opens a table of another connection or database, or the session closes. Not the
//! session's shared connection: a native cancel (PostgreSQL cancel request, TDS Attention,
//! `sqlite3_interrupt`) stops whatever runs on a connection, so on the shared one it could
//! stop a metadata read; the apply transaction must not capture the metadata reads running
//! meanwhile; and PostgreSQL reaches another database only through another connection. One
//! statement runs per tab at a time (later calls wait their turn); every statement is
//! recorded in the statement log, bound values written as literals.
//!
//! **Rows** of pages, refreshed rows and inserted rows live in the shared `ResultStore`
//! (`fetch_result_window` reads them), until the tab reads another page or closes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio::task::JoinHandle;

use crate::db::dialect::Dialect;
use crate::db::driver::{BoundFailure, BoundStatement, CancelHandle, SqlConnection};
use crate::db::edit_dialect::{RowEstimateSource, plain_text};
use crate::db::errors::ErrorCode;
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::db::value::{ColumnMeta, QueryResult, Value, ValueKind};
use crate::edit::inverse::{self, AppliedSet};
use crate::edit::model::{
    AppliedStatement, ApplyOutcome, ChangeSet, EditPreview, InsertedRows, PlannedChange,
    RowConflict, StatementFailure,
};
use crate::edit::planner::{self, PlanMode, PlannedEdit};
use crate::events::{BackendEvent, EventSink, TableDataChanged};
use crate::session::ConnectionManager;
use crate::session::connection::ConnectionSession;
use crate::session::journal::ChangeJournal;
use crate::session::meta_cache::MetaService;
use crate::session::query_model::ResultWindow;
use crate::session::result_store::ResultStore;
use crate::session::table_model::{
    CountMode, MAX_PAGE_ROWS, PAGE_WINDOW_ROWS, RefreshedRows, RowKey, SortKey, TableDataInfo,
    TableFilter, TablePage, TablePageRequest, TableRowCount,
};
use crate::session::table_shape::TableShape;
use crate::session::table_sql;
use crate::store::{JournalStatement, MAX_INVERSE_BYTES, NewJournalEntry, RevertBlocker};

/// Rows per statement of a table export: big enough that the paging overhead stays small, small
/// enough that one batch is a modest amount of memory.
const EXPORT_BATCH_ROWS: u32 = 10_000;

/// Rows read back at most by one statement of `refresh_table_rows` (SQL Server binds at most
/// 2 100 parameters).
const KEYS_PER_STATEMENT: usize = 500;

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

fn not_open() -> YadbeError {
    YadbeError::invalid_argument(
        "This table tab is not open.",
        "Cet onglet de table n'est pas ouvert.",
    )
}

/// The connection, database and table of a table tab.
pub struct TabTarget {
    pub connection_id: String,
    /// The database its server connections open on (`None`: the session's).
    pub database: Option<String>,
    pub table: ObjectRef,
    pub read_only: bool,
    pub dialect: &'static dyn Dialect,
}

/// A tab's own server connection.
struct TabConnection {
    conn: Arc<dyn SqlConnection>,
    /// Its link dropped or its session closed.
    dead: Arc<AtomicBool>,
    watcher: JoinHandle<()>,
}

impl TabConnection {
    fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst) && !self.conn.link().is_lost()
    }

    async fn close(self) {
        self.watcher.abort();
        self.conn.close().await;
    }
}

struct TableTab {
    id: String,
    connection_id: String,
    /// The database the connection is opened on (`None`: the session's).
    database: Option<String>,
    shape: TableShape,
    read_only: bool,
    dialect: &'static dyn Dialect,
    conn: Arc<AsyncMutex<Option<TabConnection>>>,
    /// Cancels the running statement.
    cancel: Mutex<Option<Arc<dyn CancelHandle>>>,
    cancel_requested: AtomicBool,
    /// Results this tab owns in the store.
    results: Mutex<Vec<u32>>,
}

pub struct TableDataService {
    manager: Arc<ConnectionManager>,
    store: Arc<ResultStore>,
    sink: Arc<dyn EventSink>,
    tabs: Mutex<HashMap<String, Arc<TableTab>>>,
    export_batch_rows: u32,
    /// Where applied change sets are recorded (F-090); `None`: not recorded, no revert.
    journal: Option<Arc<ChangeJournal>>,
}

/// Rows read by their identity, in the order of the keys asked for (`None`: not found).
type RowsByKey = Vec<Option<Vec<Value>>>;

/// A read that failed, with the statement as shown.
struct ReadFailure {
    failure: BoundFailure,
    sql: String,
}

impl TableDataService {
    pub fn new(
        manager: Arc<ConnectionManager>,
        store: Arc<ResultStore>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            manager,
            store,
            sink,
            tabs: Mutex::new(HashMap::new()),
            export_batch_rows: EXPORT_BATCH_ROWS,
            journal: None,
        }
    }

    /// Records every applied change set in `journal` and allows reverting them.
    #[must_use]
    pub fn with_journal(mut self, journal: Arc<ChangeJournal>) -> Self {
        self.journal = Some(journal);
        self
    }

    /// Rows per statement of a table export (tests use small pages).
    #[must_use]
    pub fn with_export_batch_rows(mut self, rows: u32) -> Self {
        self.export_batch_rows = rows.clamp(1, MAX_PAGE_ROWS);
        self
    }

    fn tab(&self, tab_id: &str) -> Result<Arc<TableTab>, YadbeError> {
        lock(&self.tabs).get(tab_id).cloned().ok_or_else(not_open)
    }

    /// The tab's connection, opened when missing or dead; the guard serializes the tab's
    /// statements.
    async fn connection(
        &self,
        tab: &TableTab,
    ) -> Result<
        (
            OwnedMutexGuard<Option<TabConnection>>,
            Arc<dyn SqlConnection>,
        ),
        YadbeError,
    > {
        let session = self.manager.session(&tab.connection_id)?;
        let mut guard = Arc::clone(&tab.conn).lock_owned().await;
        if let Some(current) = guard.as_ref()
            && current.is_alive()
        {
            let conn = Arc::clone(&current.conn);
            // Between two calls the connection is outside any transaction.
            session.align(&*conn).await?;
            return Ok((guard, conn));
        }
        if let Some(stale) = guard.take() {
            stale.close().await;
        }
        let conn: Arc<dyn SqlConnection> =
            session.open_dedicated_sql(tab.database.as_deref()).await?;
        let dead = Arc::new(AtomicBool::new(false));
        let watcher = spawn_watcher(&session, Arc::clone(&conn), Arc::clone(&dead));
        *guard = Some(TabConnection {
            conn: Arc::clone(&conn),
            dead,
            watcher,
        });
        Ok((guard, conn))
    }

    /// Whether the tab's connection refuses writes now (F-008: it can change under the tab);
    /// the flag the tab was opened with once the session is gone.
    fn read_only(&self, tab: &TableTab) -> bool {
        self.manager
            .session(&tab.connection_id)
            .map_or(tab.read_only, |session| session.read_only())
    }

    /// Runs one bound statement, cancellable with `cancel_table_data`.
    async fn run(
        &self,
        tab: &TableTab,
        conn: &Arc<dyn SqlConnection>,
        statement: &BoundStatement,
        max_rows: usize,
    ) -> Result<QueryResult, BoundFailure> {
        if tab.cancel_requested.load(Ordering::SeqCst) {
            return Err(YadbeError::cancelled().into());
        }
        *lock(&tab.cancel) = Some(conn.cancel_handle());
        let result = conn.query_bound(statement, max_rows).await;
        *lock(&tab.cancel) = None;
        result.map_err(|mut failure| {
            // The driver saw the table gone (dropped or renamed elsewhere): say which.
            if failure.error.code == ErrorCode::ObjectNotFound {
                let table = &tab.shape.details.table;
                let name = match &table.schema {
                    Some(schema) => format!("{schema}.{}", table.name),
                    None => table.name.clone(),
                };
                let mut named = YadbeError::object_not_found(&name);
                named.detail = failure.error.detail.take();
                failure.error = named;
            }
            failure
        })
    }

    fn keep(&self, tab: &TableTab, rows: Vec<Vec<Value>>) -> ResultWindow {
        let stored = self.store.create(tab.shape.column_meta());
        stored.append(rows);
        lock(&tab.results).push(stored.id());
        stored.window(0, PAGE_WINDOW_ROWS as usize)
    }

    fn free(&self, tab: &TableTab) {
        let ids = std::mem::take(&mut *lock(&tab.results));
        self.store.remove(ids);
    }

    pub async fn open(
        &self,
        meta: &MetaService,
        tab_id: &str,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<TableDataInfo, YadbeError> {
        let session = self.manager.session(connection_id)?;
        session.sql()?;
        let details = meta
            .table_details(&self.manager, None, connection_id, table)
            .await?;
        let target = session.target();
        let dialect = session.dialect()?;
        let database = (dialect.capabilities().multiple_databases && !table.database.is_empty())
            .then(|| table.database.clone());
        // The same connection and database: the tab keeps its server connection.
        let previous = lock(&self.tabs).remove(tab_id);
        let conn = match previous {
            Some(old) => {
                old.cancel_requested.store(true, Ordering::SeqCst);
                cancel_running(&old).await;
                self.free(&old);
                let mut guard = old.conn.lock().await;
                let kept = guard.take();
                drop(guard);
                match kept {
                    Some(kept)
                        if old.connection_id == connection_id && old.database == database =>
                    {
                        Some(kept)
                    }
                    Some(other) => {
                        other.close().await;
                        None
                    }
                    None => None,
                }
            }
            None => None,
        };
        let shape = TableShape::new(dialect, details.clone(), target.read_only, &HashMap::new());
        let tab = Arc::new(TableTab {
            id: tab_id.to_owned(),
            connection_id: connection_id.to_owned(),
            database,
            shape,
            read_only: target.read_only,
            dialect,
            conn: Arc::new(AsyncMutex::new(conn)),
            cancel: Mutex::new(None),
            cancel_requested: AtomicBool::new(false),
            results: Mutex::new(Vec::new()),
        });
        let enums = match dialect.enum_labels_sql() {
            Some(template) => self.enum_labels(&tab, template).await?,
            None => HashMap::new(),
        };
        let tab = if enums.is_empty() {
            tab
        } else {
            let shape = TableShape::new(dialect, details, target.read_only, &enums);
            Arc::new(TableTab {
                shape,
                ..Arc::try_unwrap(tab).map_err(|_| YadbeError::internal("table tab shared"))?
            })
        };
        let info = tab.shape.info.clone();
        lock(&self.tabs).insert(tab_id.to_owned(), tab);
        Ok(info)
    }

    async fn enum_labels(
        &self,
        tab: &TableTab,
        template: &str,
    ) -> Result<HashMap<String, Vec<String>>, YadbeError> {
        let statement = table_sql::with_table_name(tab.dialect, &tab.shape.details.table, template);
        let (_guard, conn) = self.connection(tab).await?;
        let result = self
            .run(tab, &conn, &statement, usize::MAX)
            .await
            .map_err(|f| f.error)?;
        let mut labels: HashMap<String, Vec<String>> = HashMap::new();
        for row in result.rows {
            if let [Value::Text(column), Value::Text(label)] = row.as_slice() {
                labels
                    .entry(column.clone())
                    .or_default()
                    .push(label.clone());
            }
        }
        Ok(labels)
    }

    pub async fn page(
        &self,
        tab_id: &str,
        request: TablePageRequest,
    ) -> Result<TablePage, YadbeError> {
        if request.limit == 0 || request.limit > MAX_PAGE_ROWS {
            return Err(YadbeError::invalid_argument(
                format!("A page has 1 to {MAX_PAGE_ROWS} rows."),
                format!("Une page compte de 1 à {MAX_PAGE_ROWS} lignes."),
            ));
        }
        let tab = self.tab(tab_id)?;
        if self.read_only(&tab) {
            table_sql::check_read_only(tab.dialect, &request.filter)?;
        }
        let order = table_sql::resolve_order(&tab.shape, &request.sort)?;
        let statement = table_sql::page(
            tab.dialect,
            &tab.shape,
            &request.filter,
            &order,
            request.offset,
            request.limit,
        )?;
        let started = Instant::now();
        let (_guard, conn) = self.connection(&tab).await?;
        tab.cancel_requested.store(false, Ordering::SeqCst);
        let result = self
            .run(&tab, &conn, &statement, usize::MAX)
            .await
            .map_err(|f| f.error)?;
        let mut rows = result.rows;
        let limit = request.limit as usize;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        tab.shape.normalize(&mut rows);
        self.free(&tab);
        let row_count = to_u32(rows.len());
        let window = self.keep(&tab, rows);
        Ok(TablePage {
            result_id: window.result_id,
            columns: tab.shape.column_meta(),
            offset: request.offset,
            row_count,
            has_more,
            window,
            order,
            duration_ms: ms(started),
        })
    }

    pub async fn count(
        &self,
        tab_id: &str,
        filter: TableFilter,
        mode: CountMode,
    ) -> Result<TableRowCount, YadbeError> {
        let tab = self.tab(tab_id)?;
        let dialect = tab.dialect;
        table_sql::check_filter(dialect, &tab.shape, &filter)?;
        if self.read_only(&tab) {
            table_sql::check_read_only(dialect, &filter)?;
        }
        let unfiltered = filter.conditions.is_empty()
            && filter
                .raw_where
                .as_deref()
                .is_none_or(|r| r.trim().is_empty());
        let (statement, filtered) = match mode {
            CountMode::Exact => (table_sql::count(dialect, &tab.shape, &filter)?, true),
            CountMode::Estimate => match dialect.row_estimate() {
                RowEstimateSource::None => {
                    return Ok(TableRowCount {
                        mode,
                        count: None,
                        filtered: false,
                        duration_ms: 0.0,
                    });
                }
                RowEstimateSource::ExplainJson => {
                    (table_sql::explain(dialect, &tab.shape, &filter)?, true)
                }
                RowEstimateSource::Catalog(template) => (
                    table_sql::with_table_name(dialect, &tab.shape.details.table, template),
                    unfiltered,
                ),
            },
        };
        let started = Instant::now();
        let (_guard, conn) = self.connection(&tab).await?;
        tab.cancel_requested.store(false, Ordering::SeqCst);
        let result = self
            .run(&tab, &conn, &statement, 1)
            .await
            .map_err(|f| f.error)?;
        let text = result.scalar_text();
        let count = match (mode, dialect.row_estimate()) {
            (CountMode::Estimate, RowEstimateSource::ExplainJson) => {
                text.as_deref().and_then(table_sql::plan_rows)
            }
            _ => text.and_then(|t| t.trim().parse::<f64>().ok()),
        };
        Ok(TableRowCount {
            mode,
            // PostgreSQL reports -1 for a table never analyzed.
            count: count.filter(|c| *c >= 0.0),
            filtered,
            duration_ms: ms(started),
        })
    }

    pub async fn refresh_rows(
        &self,
        tab_id: &str,
        keys: Vec<RowKey>,
    ) -> Result<RefreshedRows, YadbeError> {
        let tab = self.tab(tab_id)?;
        let shape = &tab.shape;
        if shape.identity.is_empty() {
            shape.check_editable()?;
        }
        for key in &keys {
            shape.check_key(key)?;
        }
        let found = if keys.is_empty() {
            Vec::new()
        } else {
            let (_guard, conn) = self.connection(&tab).await?;
            tab.cancel_requested.store(false, Ordering::SeqCst);
            self.rows_by_key(&tab, &conn, &keys)
                .await
                .map_err(|f| f.failure.error)?
        };
        Ok(self.keep_found(&tab, found))
    }

    /// The rows found, kept in the store, with each key's position.
    fn keep_found(&self, tab: &TableTab, found: RowsByKey) -> RefreshedRows {
        let mut rows = Vec::new();
        let positions = found
            .into_iter()
            .map(|row| {
                row.map(|row| {
                    rows.push(row);
                    to_u32(rows.len() - 1)
                })
            })
            .collect();
        let window = self.keep(tab, rows);
        RefreshedRows { window, positions }
    }

    /// Reads rows by their identity on `conn` (a page per [`KEYS_PER_STATEMENT`] values).
    async fn rows_by_key(
        &self,
        tab: &TableTab,
        conn: &Arc<dyn SqlConnection>,
        keys: &[RowKey],
    ) -> Result<RowsByKey, ReadFailure> {
        let shape = &tab.shape;
        let per_statement = (KEYS_PER_STATEMENT / shape.identity.len().max(1)).max(1);
        let mut found: Vec<Vec<Value>> = Vec::new();
        for chunk in keys.chunks(per_statement) {
            let statement = table_sql::rows_by_key(tab.dialect, shape, chunk);
            let result = self
                .run(tab, conn, &statement, usize::MAX)
                .await
                .map_err(|failure| ReadFailure {
                    failure,
                    sql: statement.display.clone(),
                })?;
            found.extend(result.rows);
        }
        shape.normalize(&mut found);
        let identity_of = |row: &[Value]| -> Vec<Option<String>> {
            shape
                .identity
                .iter()
                .map(|&i| row.get(i).and_then(|v| comparable(v, shape, i)))
                .collect()
        };
        Ok(keys
            .iter()
            .map(|key| {
                let wanted: Vec<Option<String>> = key
                    .iter()
                    .zip(&shape.identity)
                    .map(|(v, &i)| comparable(v, shape, i))
                    .collect();
                found.iter().find(|row| identity_of(row) == wanted).cloned()
            })
            .collect())
    }

    /// The checked filter and order of an export of the tab's table.
    fn export_plan(
        &self,
        tab_id: &str,
        filter: &TableFilter,
        sort: &[SortKey],
    ) -> Result<(Arc<TableTab>, Vec<SortKey>), YadbeError> {
        let tab = self.tab(tab_id)?;
        if self.read_only(&tab) {
            table_sql::check_read_only(tab.dialect, filter)?;
        }
        table_sql::check_filter(tab.dialect, &tab.shape, filter)?;
        let order = table_sql::resolve_order(&tab.shape, sort)?;
        Ok((tab, order))
    }

    /// Every row of the tab's table under `filter` and `sort`, read in pages on a server
    /// connection of the export's own, so that the tab stays usable meanwhile (F-066).
    pub async fn export_rows(
        &self,
        tab_id: &str,
        filter: TableFilter,
        sort: Vec<SortKey>,
    ) -> Result<TableExportRows, YadbeError> {
        let (tab, order) = self.export_plan(tab_id, &filter, &sort)?;
        let session = self.manager.session(&tab.connection_id)?;
        let conn: Arc<dyn SqlConnection> =
            session.open_dedicated_sql(tab.database.as_deref()).await?;
        let keyset = table_sql::keyset_pageable(&tab.shape, &order);
        Ok(TableExportRows {
            columns: tab.shape.column_meta(),
            tab,
            conn,
            filter,
            order,
            batch: self.export_batch_rows,
            offset: 0,
            last: None,
            keyset,
            done: false,
        })
    }

    /// The first `limit` rows of an export, read on the tab's connection, for the preview.
    pub async fn export_preview(
        &self,
        tab_id: &str,
        filter: &TableFilter,
        sort: &[SortKey],
        limit: u32,
    ) -> Result<(Vec<ColumnMeta>, Vec<Vec<Value>>), YadbeError> {
        let (tab, order) = self.export_plan(tab_id, filter, sort)?;
        let statement = table_sql::page(tab.dialect, &tab.shape, filter, &order, 0, limit.max(1))?;
        let (_guard, conn) = self.connection(&tab).await?;
        tab.cancel_requested.store(false, Ordering::SeqCst);
        let result = self
            .run(&tab, &conn, &statement, usize::MAX)
            .await
            .map_err(|f| f.error)?;
        let mut rows = result.rows;
        rows.truncate(limit as usize);
        tab.shape.normalize(&mut rows);
        Ok((tab.shape.column_meta(), rows))
    }

    /// Cancels the tab's running statement; the call running it fails with `cancelled`.
    pub async fn cancel(&self, tab_id: &str) {
        let tab = lock(&self.tabs).get(tab_id).cloned();
        if let Some(tab) = tab {
            tab.cancel_requested.store(true, Ordering::SeqCst);
            cancel_running(&tab).await;
        }
    }

    pub async fn close(&self, tab_id: &str) {
        let Some(tab) = lock(&self.tabs).remove(tab_id) else {
            return;
        };
        tab.cancel_requested.store(true, Ordering::SeqCst);
        cancel_running(&tab).await;
        self.free(&tab);
        let taken = tab.conn.lock().await.take();
        if let Some(conn) = taken {
            conn.close().await;
        }
    }

    pub fn preview(&self, tab_id: &str, changes: &ChangeSet) -> Result<EditPreview, YadbeError> {
        let tab = self.tab(tab_id)?;
        let planned = planner::plan(tab.dialect, &tab.shape, changes)?;
        Ok(planner::preview(tab.dialect, &planned))
    }

    /// Applies `changes` in one transaction (F-085, F-089); recorded in the journal (F-090).
    pub async fn apply(
        &self,
        tab_id: &str,
        changes: &ChangeSet,
    ) -> Result<ApplyOutcome, YadbeError> {
        let tab = self.tab(tab_id)?;
        self.apply_on(&tab, changes, PlanMode::Edit, None).await
    }

    /// The inverse of journal entry `entry_id` (F-090), checked against the tab's table.
    fn revert_changes(&self, tab: &TableTab, entry_id: u32) -> Result<ChangeSet, YadbeError> {
        let journal = self.journal.as_ref().ok_or_else(|| {
            YadbeError::invalid_argument(
                "The change journal is not available.",
                "Le journal des modifications n'est pas disponible.",
            )
        })?;
        let inverse =
            journal.revert_input(entry_id, &tab.connection_id, &tab.shape.details.table)?;
        serde_json::from_str(&inverse)
            .map_err(|err| YadbeError::internal(format!("unreadable journal inverse: {err}")))
    }

    /// The statements "Revert this change set" would run on the tab's table, as planned now.
    pub fn preview_revert(&self, tab_id: &str, entry_id: u32) -> Result<EditPreview, YadbeError> {
        let tab = self.tab(tab_id)?;
        let changes = self.revert_changes(&tab, entry_id)?;
        let planned = planner::plan_with(tab.dialect, &tab.shape, &changes, PlanMode::Restore)?;
        Ok(planner::preview(tab.dialect, &planned))
    }

    /// Reverts journal entry `entry_id` like an apply: one transaction, one row per `UPDATE`
    /// / `DELETE`, rows changed since reported as conflicts. Recorded as a change set of its
    /// own.
    pub async fn apply_revert(
        &self,
        tab_id: &str,
        entry_id: u32,
    ) -> Result<ApplyOutcome, YadbeError> {
        let tab = self.tab(tab_id)?;
        let changes = self.revert_changes(&tab, entry_id)?;
        self.apply_on(&tab, &changes, PlanMode::Restore, Some(i64::from(entry_id)))
            .await
    }

    async fn apply_on(
        &self,
        tab: &TableTab,
        changes: &ChangeSet,
        mode: PlanMode,
        reverts: Option<i64>,
    ) -> Result<ApplyOutcome, YadbeError> {
        if self.read_only(tab) {
            let statement = if !changes.deletes.is_empty() {
                "DELETE"
            } else if !changes.updates.is_empty() {
                "UPDATE"
            } else {
                "INSERT"
            };
            return Err(YadbeError::read_only_violation(statement));
        }
        let planned = planner::plan_with(tab.dialect, &tab.shape, changes, mode)?;
        let started = Instant::now();
        let applied_at = std::time::SystemTime::now();
        let (_guard, conn) = self.connection(tab).await?;
        tab.cancel_requested.store(false, Ordering::SeqCst);
        conn.query(tab.dialect.begin_transaction(), 0).await?;
        let mut applied = Vec::with_capacity(planned.len());
        let mut inserted: Vec<Option<Vec<Value>>> = vec![None; changes.inserts.len()];
        // Statements that matched no row: the row changed or went since it was read (F-089).
        let mut conflicts: Vec<usize> = Vec::new();
        let mut cleanups: Vec<&str> = Vec::new();
        for (index, edit) in planned.iter().enumerate() {
            if let Some(cleanup) = &edit.cleanup {
                cleanups.push(cleanup);
            }
            let statement_started = Instant::now();
            let result = match self.run(tab, &conn, &edit.statement, 2).await {
                Ok(result) => result,
                Err(failure) => {
                    self.abort(tab, &conn, &cleanups).await;
                    // A failure after a conflict is most likely its consequence (a key the
                    // conflicting delete did not free).
                    if !conflicts.is_empty() && failure.error.code != ErrorCode::Cancelled {
                        return Ok(self
                            .conflicted(tab, &conn, &planned, &conflicts, started)
                            .await);
                    }
                    return Ok(rolled_back(index, edit, failure, None));
                }
            };
            if edit.one_row() && result.rows_affected != Some(1) {
                let count = result.rows_affected.unwrap_or(0);
                if count == 0 {
                    conflicts.push(index);
                    continue;
                }
                self.abort(tab, &conn, &cleanups).await;
                let row = edit.row.as_deref().unwrap_or_default();
                let error = YadbeError::row_not_unique(row, count);
                return Ok(rolled_back(index, edit, error.into(), Some(count)));
            }
            if let PlannedChange::Insert { insert } = edit.change
                && let Some(mut row) = result.rows.into_iter().next()
            {
                tab.shape.normalize(std::slice::from_mut(&mut row));
                if let Some(slot) = inserted.get_mut(insert as usize) {
                    *slot = Some(row);
                }
            }
            applied.push(AppliedStatement {
                change: edit.change.clone(),
                // Row counts are far below 2^53.
                #[allow(clippy::cast_precision_loss)]
                rows_affected: result
                    .rows_affected
                    .map(|n| n as f64)
                    .or(edit.statement.returns_rows.then_some(1.0)),
                duration_ms: ms(statement_started),
            });
        }
        if !conflicts.is_empty() {
            self.abort(tab, &conn, &cleanups).await;
            return Ok(self
                .conflicted(tab, &conn, &planned, &conflicts, started)
                .await);
        }
        // The updated rows as stored, read in the transaction, for the journal's inverse.
        let updated = if self.journal.is_some() {
            match self.read_back_updates(tab, &conn, &planned).await {
                Ok(rows) => Some(rows),
                Err(read) => {
                    self.abort(tab, &conn, &cleanups).await;
                    return Ok(ApplyOutcome::RolledBack {
                        failure: Box::new(StatementFailure {
                            statement_index: None,
                            change: None,
                            sql: read.sql,
                            error: read.failure.error,
                            server: read.failure.server.map(|s| *s),
                            violation: None,
                            rows_affected: None,
                        }),
                    });
                }
            }
        } else {
            None
        };
        if let Err(error) = conn.query(tab.dialect.commit(), 0).await {
            self.abort(tab, &conn, &cleanups).await;
            return Ok(ApplyOutcome::RolledBack {
                failure: Box::new(StatementFailure {
                    statement_index: None,
                    change: None,
                    sql: tab.dialect.commit().to_owned(),
                    error,
                    server: None,
                    violation: None,
                    rows_affected: None,
                }),
            });
        }
        let duration_ms = ms(started);
        let journal_id = match (&self.journal, &updated) {
            (Some(journal), Some(updated)) => {
                let entry = self.journal_entry(
                    journal,
                    tab,
                    &AppliedSet {
                        changes,
                        planned: &planned,
                        inserted: &inserted,
                        updated,
                    },
                    &applied,
                    applied_at,
                    duration_ms,
                    reverts,
                );
                journal
                    .record(entry)
                    .await
                    .map(|id| u32::try_from(id).unwrap_or(u32::MAX))
            }
            _ => None,
        };
        let mut rows = Vec::new();
        let positions = inserted
            .into_iter()
            .map(|row| {
                row.map(|row| {
                    rows.push(row);
                    to_u32(rows.len() - 1)
                })
            })
            .collect();
        let window = self.keep(tab, rows);
        let count = |kind: fn(&PlannedChange) -> bool| {
            to_u32(planned.iter().filter(|p| kind(&p.change)).count())
        };
        self.sink
            .emit(BackendEvent::TableDataChanged(TableDataChanged {
                connection_id: tab.connection_id.clone(),
                table: tab.shape.details.table.clone(),
                tab_id: tab.id.clone(),
                updated: count(|c| matches!(c, PlannedChange::Update { .. })),
                inserted: count(|c| matches!(c, PlannedChange::Insert { .. })),
                deleted: count(|c| matches!(c, PlannedChange::Delete { .. })),
            }));
        Ok(ApplyOutcome::Applied {
            statements: applied,
            inserted: InsertedRows { window, positions },
            duration_ms,
            journal_id,
        })
    }

    /// After the rollback: the conflicting rows as stored now.
    async fn conflicted(
        &self,
        tab: &TableTab,
        conn: &Arc<dyn SqlConnection>,
        planned: &[PlannedEdit],
        conflicts: &[usize],
        started: Instant,
    ) -> ApplyOutcome {
        let edits: Vec<(usize, &PlannedEdit)> = conflicts
            .iter()
            .filter_map(|&i| planned.get(i).map(|edit| (i, edit)))
            .collect();
        let keys: Vec<RowKey> = edits
            .iter()
            .filter_map(|(_, edit)| match &edit.change {
                PlannedChange::Update { key, .. } | PlannedChange::Delete { key, .. } => {
                    Some(key.clone())
                }
                PlannedChange::Insert { .. } => None,
            })
            .collect();
        let found = match self.rows_by_key(tab, conn, &keys).await {
            Ok(found) => found,
            Err(read) => {
                tracing::warn!(tab = %tab.id, error = %read.failure.error, "reading conflicting rows");
                // Without the rows, the first conflict is reported as before F-089.
                let (index, edit) = edits[0];
                let row = edit.row.as_deref().unwrap_or_default();
                return rolled_back(index, edit, YadbeError::row_not_found(row).into(), Some(0));
            }
        };
        ApplyOutcome::Conflicted {
            conflicts: edits
                .iter()
                .map(|(index, edit)| RowConflict {
                    statement_index: to_u32(*index),
                    change: edit.change.clone(),
                    sql: edit.statement.display.clone(),
                    row: edit.row.clone().unwrap_or_default(),
                })
                .collect(),
            current: self.keep_found(tab, found),
            duration_ms: ms(started),
        }
    }

    /// The rows of the planned updates as stored after them, in plan order, read by their key
    /// as written.
    async fn read_back_updates(
        &self,
        tab: &TableTab,
        conn: &Arc<dyn SqlConnection>,
        planned: &[PlannedEdit],
    ) -> Result<RowsByKey, ReadFailure> {
        let keys: Vec<RowKey> = planned
            .iter()
            .filter_map(|edit| match &edit.change {
                PlannedChange::Update { key, .. } => Some(
                    tab.shape
                        .identity
                        .iter()
                        .zip(key)
                        .map(|(column, value)| {
                            edit.written
                                .iter()
                                .find(|(c, _, _)| c == column)
                                .map_or_else(|| value.clone(), |(_, written, _)| written.clone())
                        })
                        .collect(),
                ),
                _ => None,
            })
            .collect();
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        self.rows_by_key(tab, conn, &keys).await
    }

    /// The journal entry of an applied change set, with its inverse when it has a faithful one.
    #[allow(clippy::too_many_arguments)]
    fn journal_entry(
        &self,
        journal: &ChangeJournal,
        tab: &TableTab,
        set: &AppliedSet<'_>,
        applied: &[AppliedStatement],
        applied_at: std::time::SystemTime,
        duration_ms: f64,
        reverts: Option<i64>,
    ) -> NewJournalEntry {
        let mut blocker = None;
        let mut inverse_json = None;
        let mut inverse_statements = Vec::new();
        match inverse::inverse(tab.dialect, &tab.shape, set) {
            Ok(undo) => {
                match planner::plan_with(tab.dialect, &tab.shape, &undo, PlanMode::Restore) {
                    Ok(plan) => {
                        inverse_statements =
                            plan.iter().map(|p| p.statement.display.clone()).collect();
                        match serde_json::to_string(&undo) {
                            Ok(json) if json.len() <= MAX_INVERSE_BYTES => {
                                inverse_json = Some(json);
                            }
                            _ => {
                                inverse_statements.clear();
                                blocker = Some(RevertBlocker::TooLarge);
                            }
                        }
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "planning the inverse of a change set");
                        blocker = Some(RevertBlocker::NotPlannable);
                    }
                }
            }
            Err(reason) => blocker = Some(reason),
        }
        let count = |kind: fn(&PlannedChange) -> bool| {
            to_u32(set.planned.iter().filter(|p| kind(&p.change)).count())
        };
        NewJournalEntry {
            connection_id: tab.connection_id.clone(),
            connection_name: journal.connection_name(&tab.connection_id),
            engine: tab.dialect.engine(),
            target_kind: crate::store::JournalTargetKind::Table,
            table: tab.shape.details.table.clone(),
            applied_at_ms: applied_at
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX)),
            duration_ms,
            updated: count(|c| matches!(c, PlannedChange::Update { .. })),
            inserted: count(|c| matches!(c, PlannedChange::Insert { .. })),
            deleted: count(|c| matches!(c, PlannedChange::Delete { .. })),
            statements: set
                .planned
                .iter()
                .zip(applied)
                .map(|(edit, done)| JournalStatement {
                    sql: edit.statement.display.clone(),
                    rows_affected: done.rows_affected,
                })
                .collect(),
            inverse: inverse_json,
            inverse_statements,
            blocker,
            reverts,
        }
    }

    /// Where a table tab reads its rows: lookups on its database (F-088) go there too.
    pub fn tab_target(&self, tab_id: &str) -> Result<TabTarget, YadbeError> {
        let tab = self.tab(tab_id)?;
        Ok(TabTarget {
            connection_id: tab.connection_id.clone(),
            database: tab.database.clone(),
            table: tab.shape.details.table.clone(),
            read_only: self.read_only(&tab),
            dialect: tab.dialect,
        })
    }

    /// Ends the transaction after a failure; an engine that already ended it is not asked.
    async fn rollback(&self, tab: &TableTab, conn: &Arc<dyn SqlConnection>) {
        if conn.in_transaction() == Some(false) || conn.link().is_lost() {
            return;
        }
        if let Err(err) = conn.query(tab.dialect.rollback(), 0).await {
            tracing::warn!(tab = %tab.id, error = %err, "rollback after a failed apply");
        }
    }

    /// Rolls back, then undoes the session settings statements left on (`cleanups`).
    async fn abort(&self, tab: &TableTab, conn: &Arc<dyn SqlConnection>, cleanups: &[&str]) {
        self.rollback(tab, conn).await;
        if conn.link().is_lost() {
            return;
        }
        for cleanup in cleanups {
            if let Err(err) = conn.query(cleanup, 0).await {
                tracing::warn!(tab = %tab.id, error = %err, "cleanup after a failed apply");
            }
        }
    }
}

/// A key value as compared with the rows read back (SQL Server prints GUIDs in upper case).
fn comparable(value: &Value, shape: &TableShape, index: usize) -> Option<String> {
    let text = plain_text(value)?;
    let kind = shape.details.columns.get(index).map(|c| c.kind);
    Some(if kind == Some(ValueKind::Uuid) {
        text.to_ascii_lowercase()
    } else {
        text
    })
}

fn rolled_back(
    index: usize,
    edit: &PlannedEdit,
    failure: BoundFailure,
    rows: Option<u64>,
) -> ApplyOutcome {
    ApplyOutcome::RolledBack {
        failure: Box::new(StatementFailure {
            statement_index: Some(to_u32(index)),
            change: Some(edit.change.clone()),
            sql: edit.statement.display.clone(),
            error: failure.error,
            server: failure.server.map(|s| *s),
            violation: failure.violation.map(|v| *v),
            // Row counts are far below 2^53.
            #[allow(clippy::cast_precision_loss)]
            rows_affected: rows.map(|n| n as f64),
        }),
    }
}

/// The rows of a table export: pages of `EXPORT_BATCH_ROWS` (by default) in the export's order, each one a
/// bound statement recorded in the statement log. When the order only holds identity columns
/// (the default order, mostly) a page starts after the last key read (keyset paging: constant
/// cost per page, no row read twice or skipped when rows are added behind the cursor);
/// otherwise it starts at an `OFFSET`. Pages are read one after the other, not in one
/// snapshot: rows changed meanwhile by others can be missed or read twice.
pub struct TableExportRows {
    tab: Arc<TableTab>,
    conn: Arc<dyn SqlConnection>,
    columns: Vec<ColumnMeta>,
    filter: TableFilter,
    order: Vec<SortKey>,
    batch: u32,
    offset: u32,
    /// The last row's values for the order's columns, in keyset mode.
    last: Option<Vec<Value>>,
    keyset: bool,
    done: bool,
}

impl TableExportRows {
    pub fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    /// The next page, `None` at the end. Cancel-safe: a dropped call reads the same page again.
    pub async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        if self.done {
            return Ok(None);
        }
        let tab = &self.tab;
        let statement = table_sql::page_after(
            tab.dialect,
            &tab.shape,
            &self.filter,
            &self.order,
            self.last.as_deref(),
            self.offset,
            self.batch,
        )?;
        let result = self
            .conn
            .query_bound(&statement, usize::MAX)
            .await
            .map_err(|f| f.error)?;
        let mut rows = result.rows;
        if rows.len() <= self.batch as usize {
            self.done = true;
        }
        rows.truncate(self.batch as usize);
        self.offset = self.offset.saturating_add(to_u32(rows.len()));
        tab.shape.normalize(&mut rows);
        if self.keyset
            && let Some(last) = rows.last()
        {
            self.last = table_sql::keyset_of(&tab.shape, &self.order, last);
        }
        Ok((!rows.is_empty()).then_some(rows))
    }
}

impl Drop for TableExportRows {
    /// A cancelled export stops the statement on the server, then closes its connection.
    fn drop(&mut self) {
        let conn = Arc::clone(&self.conn);
        let running = !self.done;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if running && let Err(err) = conn.cancel_handle().cancel().await {
                    tracing::debug!(error = %err, "table export cancel failed");
                }
                conn.close().await;
            });
        }
    }
}

async fn cancel_running(tab: &TableTab) {
    let handle = lock(&tab.cancel).clone();
    if let Some(handle) = handle
        && let Err(err) = handle.cancel().await
    {
        tracing::debug!(tab = %tab.id, error = %err, "table data cancel failed");
    }
}

/// Marks a tab connection dead when its link drops or its session closes.
fn spawn_watcher(
    session: &ConnectionSession,
    conn: Arc<dyn SqlConnection>,
    dead: Arc<AtomicBool>,
) -> JoinHandle<()> {
    let mut closed = session.closed();
    tokio::spawn(async move {
        let mut link = conn.link();
        let session_closed = tokio::select! {
            () = link.lost() => false,
            _ = closed.wait_for(|closed| *closed) => true,
        };
        dead.store(true, Ordering::SeqCst);
        if session_closed {
            conn.close().await;
        }
    })
}
