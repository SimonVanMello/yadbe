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
use crate::db::driver::{BoundFailure, BoundStatement, CancelHandle, Connection};
use crate::db::edit_dialect::{RowEstimateSource, plain_text};
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::db::value::{QueryResult, Value, ValueKind};
use crate::edit::model::{
    AppliedStatement, ApplyOutcome, ChangeSet, EditPreview, InsertedRows, PlannedChange,
    StatementFailure,
};
use crate::edit::planner::{self, PlannedEdit};
use crate::events::{BackendEvent, EventSink, TableDataChanged};
use crate::session::ConnectionManager;
use crate::session::connection::ConnectionSession;
use crate::session::meta_cache::MetaService;
use crate::session::query_model::ResultWindow;
use crate::session::result_store::ResultStore;
use crate::session::table_model::{
    CountMode, MAX_PAGE_ROWS, PAGE_WINDOW_ROWS, RefreshedRows, RowKey, TableDataInfo, TableFilter,
    TablePage, TablePageRequest, TableRowCount,
};
use crate::session::table_shape::TableShape;
use crate::session::table_sql;

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

/// A tab's own server connection.
struct TabConnection {
    conn: Arc<dyn Connection>,
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
        }
    }

    fn tab(&self, tab_id: &str) -> Result<Arc<TableTab>, YadbeError> {
        lock(&self.tabs).get(tab_id).cloned().ok_or_else(not_open)
    }

    /// The tab's connection, opened when missing or dead; the guard serializes the tab's
    /// statements.
    async fn connection(
        &self,
        tab: &TableTab,
    ) -> Result<(OwnedMutexGuard<Option<TabConnection>>, Arc<dyn Connection>), YadbeError> {
        let session = self.manager.session(&tab.connection_id)?;
        let mut guard = Arc::clone(&tab.conn).lock_owned().await;
        if let Some(current) = guard.as_ref()
            && current.is_alive()
        {
            let conn = Arc::clone(&current.conn);
            return Ok((guard, conn));
        }
        if let Some(stale) = guard.take() {
            stale.close().await;
        }
        let conn: Arc<dyn Connection> =
            Arc::from(session.open_dedicated(tab.database.as_deref()).await?);
        let dead = Arc::new(AtomicBool::new(false));
        let watcher = spawn_watcher(&session, Arc::clone(&conn), Arc::clone(&dead));
        *guard = Some(TabConnection {
            conn: Arc::clone(&conn),
            dead,
            watcher,
        });
        Ok((guard, conn))
    }

    /// Runs one bound statement, cancellable with `cancel_table_data`.
    async fn run(
        &self,
        tab: &TableTab,
        conn: &Arc<dyn Connection>,
        statement: &BoundStatement,
        max_rows: usize,
    ) -> Result<QueryResult, BoundFailure> {
        if tab.cancel_requested.load(Ordering::SeqCst) {
            return Err(YadbeError::cancelled().into());
        }
        *lock(&tab.cancel) = Some(conn.cancel_handle());
        let result = conn.query_bound(statement, max_rows).await;
        *lock(&tab.cancel) = None;
        result
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
        session.connection()?;
        let details = meta
            .table_details(&self.manager, None, connection_id, table)
            .await?;
        let target = session.target();
        let dialect = target.engine.dialect();
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
        if tab.read_only {
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
        if tab.read_only {
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
        let per_statement = (KEYS_PER_STATEMENT / shape.identity.len().max(1)).max(1);
        let mut found: Vec<Vec<Value>> = Vec::new();
        if !keys.is_empty() {
            let (_guard, conn) = self.connection(&tab).await?;
            tab.cancel_requested.store(false, Ordering::SeqCst);
            for chunk in keys.chunks(per_statement) {
                let statement = table_sql::rows_by_key(tab.dialect, shape, chunk);
                let result = self
                    .run(&tab, &conn, &statement, usize::MAX)
                    .await
                    .map_err(|f| f.error)?;
                found.extend(result.rows);
            }
        }
        shape.normalize(&mut found);
        let identity_of = |row: &[Value]| -> Vec<Option<String>> {
            shape
                .identity
                .iter()
                .map(|&i| row.get(i).and_then(|v| comparable(v, shape, i)))
                .collect()
        };
        let mut rows = Vec::new();
        let mut positions = Vec::with_capacity(keys.len());
        for key in &keys {
            let wanted: Vec<Option<String>> = key
                .iter()
                .zip(&shape.identity)
                .map(|(v, &i)| comparable(v, shape, i))
                .collect();
            match found.iter().position(|row| identity_of(row) == wanted) {
                Some(at) => {
                    rows.push(found[at].clone());
                    positions.push(Some(to_u32(rows.len() - 1)));
                }
                None => positions.push(None),
            }
        }
        let window = self.keep(&tab, rows);
        Ok(RefreshedRows { window, positions })
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

    pub async fn apply(
        &self,
        tab_id: &str,
        changes: &ChangeSet,
    ) -> Result<ApplyOutcome, YadbeError> {
        let tab = self.tab(tab_id)?;
        if tab.read_only {
            let statement = if !changes.deletes.is_empty() {
                "DELETE"
            } else if !changes.updates.is_empty() {
                "UPDATE"
            } else {
                "INSERT"
            };
            return Err(YadbeError::read_only_violation(statement));
        }
        let planned = planner::plan(tab.dialect, &tab.shape, changes)?;
        let started = Instant::now();
        let (_guard, conn) = self.connection(&tab).await?;
        tab.cancel_requested.store(false, Ordering::SeqCst);
        conn.query(tab.dialect.begin_transaction(), 0).await?;
        let mut applied = Vec::with_capacity(planned.len());
        let mut inserted: Vec<Option<Vec<Value>>> = vec![None; changes.inserts.len()];
        for (index, edit) in planned.iter().enumerate() {
            let statement_started = Instant::now();
            let result = match self.run(&tab, &conn, &edit.statement, 2).await {
                Ok(result) => result,
                Err(failure) => {
                    self.rollback(&tab, &conn).await;
                    return Ok(rolled_back(index, edit, failure, None));
                }
            };
            if edit.one_row() && result.rows_affected != Some(1) {
                self.rollback(&tab, &conn).await;
                let count = result.rows_affected.unwrap_or(0);
                let row = edit.row.as_deref().unwrap_or_default();
                let error = if count == 0 {
                    YadbeError::row_not_found(row)
                } else {
                    YadbeError::row_not_unique(row, count)
                };
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
        if let Err(error) = conn.query(tab.dialect.commit(), 0).await {
            self.rollback(&tab, &conn).await;
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
        let window = self.keep(&tab, rows);
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
            duration_ms: ms(started),
        })
    }

    /// Ends the transaction after a failure; an engine that already ended it is not asked.
    async fn rollback(&self, tab: &TableTab, conn: &Arc<dyn Connection>) {
        if conn.in_transaction() == Some(false) || conn.link().is_lost() {
            return;
        }
        if let Err(err) = conn.query(tab.dialect.rollback(), 0).await {
            tracing::warn!(tab = %tab.id, error = %err, "rollback after a failed apply");
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
    conn: Arc<dyn Connection>,
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
