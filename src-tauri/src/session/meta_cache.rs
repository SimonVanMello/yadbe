//! `MetaCache`: the metadata of each open connection, read lazily node by node on the
//! session's shared connection, kept until refreshed (F-020 to F-022).
//!
//! - **Per session.** A cache belongs to one `ConnectionSession`; a new session (disconnect
//!   then connect) starts empty. A lost link empties it, and once the session reconnects a
//!   `meta-refreshed` event (reason `reconnected`) tells the frontend to read again.
//! - **Refresh** drops a node and everything below it, then emits `meta-refreshed`; the next
//!   read goes to the server.
//! - **Other databases.** On engines whose connections see one database (PostgreSQL),
//!   browsing another database opens a metadata connection to it, kept with the cache.
//! - **Cancellation.** A call given a request id stops when `cancel` is called with it: the
//!   wait is abandoned and, when no other metadata call shares the connection, the engine's
//!   native cancel stops the statement.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::Notify;

use crate::db::driver::{BoxFuture, Connection};
use crate::db::errors::YadbeError;
use crate::db::introspect::Introspector;
use crate::db::meta::{
    CompletionCatalog, DatabaseInfo, IncomingForeignKeys, MetaNode, ObjectCount, ObjectInfo,
    ObjectKind, ObjectRef, SchemaInfo, TableDetails,
};
use crate::db::script::{ScriptKind, script};
use crate::events::{BackendEvent, EventSink, MetaRefreshReason, MetaRefreshed};
use crate::session::{ConnectionManager, ConnectionSession, ConnectionState, SessionInfo};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

type Fetch<T> = BoxFuture<'static, Result<T, YadbeError>>;

#[derive(Default)]
struct DbCache {
    schemas: Option<Vec<SchemaInfo>>,
    counts: HashMap<Option<String>, Vec<ObjectCount>>,
    objects: HashMap<(Option<String>, ObjectKind), Vec<ObjectInfo>>,
    tables: HashMap<(Option<String>, String), TableDetails>,
    catalogs: HashMap<bool, Arc<CompletionCatalog>>,
    /// Foreign keys referencing a table; they depend on every table of the database.
    incoming: HashMap<(Option<String>, String), IncomingForeignKeys>,
}

#[derive(Default)]
struct CacheData {
    /// Bumped by every invalidation: a read that started before is not stored.
    epoch: u64,
    databases: Option<Vec<DatabaseInfo>>,
    per_db: HashMap<String, DbCache>,
}

impl CacheData {
    fn has_data(&self) -> bool {
        self.databases.is_some() || !self.per_db.is_empty()
    }

    fn db(&mut self, database: &str) -> &mut DbCache {
        self.per_db.entry(database.to_owned()).or_default()
    }

    fn invalidate(&mut self, node: &MetaNode) {
        self.epoch += 1;
        match node {
            MetaNode::Connection => {
                self.databases = None;
                self.per_db.clear();
            }
            MetaNode::Database { database } => {
                self.per_db.remove(database);
            }
            MetaNode::Schema { database, schema } => {
                if let Some(db) = self.per_db.get_mut(database) {
                    db.counts.remove(schema);
                    db.objects.retain(|(s, _), _| s != schema);
                    db.tables.retain(|(s, _), _| s != schema);
                    db.catalogs.clear();
                    db.incoming.clear();
                }
            }
            MetaNode::Objects {
                database,
                schema,
                kind,
            } => {
                if let Some(db) = self.per_db.get_mut(database) {
                    db.counts.remove(schema);
                    db.objects.remove(&(schema.clone(), *kind));
                    db.tables
                        .retain(|(s, _), t| !(s == schema && t.kind == *kind));
                    db.catalogs.clear();
                    db.incoming.clear();
                }
            }
            MetaNode::Table { table } => {
                if let Some(db) = self.per_db.get_mut(&table.database) {
                    db.tables
                        .remove(&(table.schema.clone(), table.name.clone()));
                    db.catalogs.clear();
                    db.incoming.clear();
                }
            }
        }
    }
}

struct MetaCache {
    session: Weak<ConnectionSession>,
    data: Mutex<CacheData>,
    /// Metadata connections to databases the main connection cannot see.
    extra: Mutex<HashMap<String, Arc<dyn Connection>>>,
    /// Serializes opening extra connections, so a database gets one.
    opening: tokio::sync::Mutex<()>,
    /// Data was dropped with the link: announce it once the session is back.
    dropped: AtomicBool,
}

impl MetaCache {
    /// Drops everything; returns whether something was cached.
    fn reset(&self) -> bool {
        let had = {
            let mut data = lock(&self.data);
            let had = data.has_data();
            data.invalidate(&MetaNode::Connection);
            had
        };
        // Dropping the last handle closes a connection (PostgreSQL sends Terminate).
        lock(&self.extra).clear();
        had
    }
}

/// Decrements the in-flight count of a connection when a call ends.
struct InFlight<'a> {
    service: &'a MetaService,
    key: usize,
}

impl InFlight<'_> {
    fn alone(&self) -> bool {
        lock(&self.service.in_flight).get(&self.key).copied() == Some(1)
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut map = lock(&self.service.in_flight);
        if let Some(count) = map.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.key);
            }
        }
    }
}

fn conn_key(conn: &Arc<dyn Connection>) -> usize {
    Arc::as_ptr(conn).cast::<()>() as usize
}

pub struct MetaService {
    sink: Arc<dyn EventSink>,
    caches: Mutex<HashMap<String, Arc<MetaCache>>>,
    requests: Mutex<HashMap<String, Arc<Notify>>>,
    in_flight: Mutex<HashMap<usize, usize>>,
}

impl MetaService {
    /// `sink`: where `meta-refreshed` goes (the frontend).
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sink,
            caches: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    fn emit(&self, connection_id: &str, node: MetaNode, reason: MetaRefreshReason) {
        self.sink.emit(BackendEvent::MetaRefreshed(MetaRefreshed {
            connection_id: connection_id.to_owned(),
            node,
            reason,
        }));
    }

    /// Follows the life cycle of sessions (see [`ObservingSink`]).
    pub fn on_state(&self, info: &SessionInfo) {
        let id = &info.connection_id;
        match info.state {
            ConnectionState::Connecting => {}
            ConnectionState::Connected => {
                let cache = lock(&self.caches).get(id).cloned();
                if cache.is_some_and(|c| c.reset() | c.dropped.swap(false, Ordering::SeqCst)) {
                    self.emit(id, MetaNode::Connection, MetaRefreshReason::Reconnected);
                }
            }
            ConnectionState::Lost | ConnectionState::Reconnecting => {
                if let Some(cache) = lock(&self.caches).get(id).cloned()
                    && cache.reset()
                {
                    cache.dropped.store(true, Ordering::SeqCst);
                }
            }
            ConnectionState::Closed => {
                if let Some(cache) = lock(&self.caches).remove(id) {
                    cache.reset();
                }
            }
        }
    }

    fn cache(&self, session: &Arc<ConnectionSession>) -> Arc<MetaCache> {
        let mut caches = lock(&self.caches);
        if let Some(cache) = caches.get(session.id())
            && cache.session.ptr_eq(&Arc::downgrade(session))
        {
            return Arc::clone(cache);
        }
        let cache = Arc::new(MetaCache {
            session: Arc::downgrade(session),
            data: Mutex::new(CacheData::default()),
            extra: Mutex::new(HashMap::new()),
            opening: tokio::sync::Mutex::new(()),
            dropped: AtomicBool::new(false),
        });
        if let Some(old) = caches.insert(session.id().to_owned(), Arc::clone(&cache)) {
            old.reset();
        }
        cache
    }

    /// Stops the call started with `request_id` (it fails with `cancelled`).
    pub fn cancel(&self, request_id: &str) {
        if let Some(notify) = lock(&self.requests).get(request_id) {
            notify.notify_one();
        }
    }

    /// Runs `work` on `conn`, cancellable through `request_id`.
    async fn run<T>(
        &self,
        request_id: Option<&str>,
        conn: &Arc<dyn Connection>,
        work: impl Future<Output = Result<T, YadbeError>>,
    ) -> Result<T, YadbeError> {
        let key = conn_key(conn);
        *lock(&self.in_flight).entry(key).or_insert(0) += 1;
        let guard = InFlight { service: self, key };
        let Some(request_id) = request_id else {
            return work.await;
        };
        let notify = Arc::new(Notify::new());
        lock(&self.requests).insert(request_id.to_owned(), Arc::clone(&notify));
        let result = tokio::select! {
            result = work => result,
            () = notify.notified() => {
                // Cancelling the statement of another caller would fail that caller instead.
                if guard.alone()
                    && let Err(err) = conn.cancel_handle().cancel().await
                {
                    tracing::debug!(error = %err, "metadata cancel request failed");
                }
                Err(YadbeError::cancelled())
            }
        };
        lock(&self.requests).remove(request_id);
        result
    }

    fn introspector(conn: &dyn Connection) -> Result<&dyn Introspector, YadbeError> {
        conn.introspector().ok_or_else(YadbeError::not_implemented)
    }

    /// The connection that sees `database`.
    async fn connection_for(
        &self,
        session: &Arc<ConnectionSession>,
        cache: &MetaCache,
        database: Option<&str>,
    ) -> Result<Arc<dyn Connection>, YadbeError> {
        let main = session.connection()?;
        let Some(database) = database else {
            return Ok(main);
        };
        let caps = session.target().engine.dialect().meta_capabilities();
        if !caps.connection_per_database {
            return Ok(main);
        }
        let cached = lock(&cache.data).databases.clone();
        let databases = match cached {
            Some(databases) => databases,
            None => {
                let epoch = lock(&cache.data).epoch;
                let databases = Self::introspector(&*main)?.databases().await?;
                let mut data = lock(&cache.data);
                if data.epoch == epoch {
                    data.databases = Some(databases.clone());
                }
                databases
            }
        };
        if databases.iter().any(|d| d.current && d.name == database) {
            return Ok(main);
        }
        let usable = |c: &Arc<dyn Connection>| !c.link().is_lost();
        if let Some(conn) = lock(&cache.extra).get(database).filter(|c| usable(c)) {
            return Ok(Arc::clone(conn));
        }
        let _opening = cache.opening.lock().await;
        if let Some(conn) = lock(&cache.extra).get(database).filter(|c| usable(c)) {
            return Ok(Arc::clone(conn));
        }
        let epoch = lock(&cache.data).epoch;
        let conn: Arc<dyn Connection> = session.open_dedicated(Some(database)).await?.into();
        if lock(&cache.data).epoch == epoch {
            lock(&cache.extra).insert(database.to_owned(), Arc::clone(&conn));
        }
        Ok(conn)
    }

    /// Reads from the cache, or fetches on the connection that sees `database` and stores
    /// the result unless the cache was invalidated meanwhile.
    #[allow(clippy::too_many_arguments)]
    async fn cached<T: Clone>(
        &self,
        request_id: Option<&str>,
        session: &Arc<ConnectionSession>,
        cache: &MetaCache,
        database: Option<&str>,
        read: impl FnOnce(&mut CacheData) -> Option<T>,
        write: impl FnOnce(&mut CacheData, T),
        fetch: impl FnOnce(Arc<dyn Connection>) -> Fetch<T>,
    ) -> Result<T, YadbeError> {
        let epoch = {
            let mut data = lock(&cache.data);
            if let Some(hit) = read(&mut data) {
                return Ok(hit);
            }
            data.epoch
        };
        let conn = self.connection_for(session, cache, database).await?;
        let value = self
            .run(request_id, &conn, fetch(Arc::clone(&conn)))
            .await?;
        let mut data = lock(&cache.data);
        if data.epoch == epoch {
            write(&mut data, value.clone());
        }
        Ok(value)
    }

    fn session(
        manager: &ConnectionManager,
        connection_id: &str,
    ) -> Result<Arc<ConnectionSession>, YadbeError> {
        manager.session(connection_id)
    }

    /// Checks that `schema` is given exactly when the engine has schemas.
    fn check_schema(session: &ConnectionSession, schema: Option<&str>) -> Result<(), YadbeError> {
        let has_schemas = session.target().engine.dialect().capabilities().schemas;
        match (has_schemas, schema) {
            (true, Some(s)) if !s.is_empty() => Ok(()),
            (false, None) => Ok(()),
            (true, _) => Err(YadbeError::invalid_argument(
                "This engine needs a schema name.",
                "Ce moteur a besoin d'un nom de schéma.",
            )),
            (false, Some(_)) => Err(YadbeError::invalid_argument(
                "This engine has no schemas.",
                "Ce moteur n'a pas de schémas.",
            )),
        }
    }

    fn check_database(database: &str) -> Result<(), YadbeError> {
        if database.is_empty() {
            return Err(YadbeError::invalid_argument(
                "A database name is required.",
                "Un nom de base est requis.",
            ));
        }
        Ok(())
    }

    async fn databases_of(
        &self,
        request_id: Option<&str>,
        session: &Arc<ConnectionSession>,
        cache: &MetaCache,
    ) -> Result<Vec<DatabaseInfo>, YadbeError> {
        self.cached(
            request_id,
            session,
            cache,
            None,
            |d| d.databases.clone(),
            |d, v| d.databases = Some(v),
            |conn| Box::pin(async move { Self::introspector(&*conn)?.databases().await }),
        )
        .await
    }

    pub async fn databases(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
    ) -> Result<Vec<DatabaseInfo>, YadbeError> {
        let session = Self::session(manager, connection_id)?;
        let cache = self.cache(&session);
        self.databases_of(request_id, &session, &cache).await
    }

    pub async fn schemas(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<SchemaInfo>, YadbeError> {
        Self::check_database(database)?;
        let session = Self::session(manager, connection_id)?;
        let cache = self.cache(&session);
        let db = database.to_owned();
        self.cached(
            request_id,
            &session,
            &cache,
            Some(database),
            |d| d.per_db.get(database).and_then(|c| c.schemas.clone()),
            |d, v| d.db(database).schemas = Some(v),
            move |conn| Box::pin(async move { Self::introspector(&*conn)?.schemas(&db).await }),
        )
        .await
    }

    pub async fn object_counts(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        database: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ObjectCount>, YadbeError> {
        Self::check_database(database)?;
        let session = Self::session(manager, connection_id)?;
        Self::check_schema(&session, schema)?;
        let cache = self.cache(&session);
        let key = schema.map(str::to_owned);
        let (db, owned) = (database.to_owned(), key.clone());
        self.cached(
            request_id,
            &session,
            &cache,
            Some(database),
            |d| {
                d.per_db
                    .get(database)
                    .and_then(|c| c.counts.get(&key).cloned())
            },
            |d, v| {
                d.db(database).counts.insert(key.clone(), v);
            },
            move |conn| {
                Box::pin(async move {
                    Self::introspector(&*conn)?
                        .object_counts(&db, owned.as_deref())
                        .await
                })
            },
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn objects(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        database: &str,
        schema: Option<&str>,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        Self::check_database(database)?;
        let session = Self::session(manager, connection_id)?;
        Self::check_schema(&session, schema)?;
        let caps = session.target().engine.dialect().meta_capabilities();
        if !caps.object_kinds.contains(&kind) {
            return Ok(Vec::new());
        }
        let cache = self.cache(&session);
        let key = (schema.map(str::to_owned), kind);
        let (db, owned) = (database.to_owned(), key.0.clone());
        self.cached(
            request_id,
            &session,
            &cache,
            Some(database),
            |d| {
                d.per_db
                    .get(database)
                    .and_then(|c| c.objects.get(&key).cloned())
            },
            |d, v| {
                d.db(database).objects.insert(key.clone(), v);
            },
            move |conn| {
                Box::pin(async move {
                    Self::introspector(&*conn)?
                        .objects(&db, owned.as_deref(), kind)
                        .await
                })
            },
        )
        .await
    }

    pub async fn table_details(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<TableDetails, YadbeError> {
        Self::check_database(&table.database)?;
        let session = Self::session(manager, connection_id)?;
        Self::check_schema(&session, table.schema.as_deref())?;
        let cache = self.cache(&session);
        let key = (table.schema.clone(), table.name.clone());
        let owned = table.clone();
        let database = table.database.as_str();
        self.cached(
            request_id,
            &session,
            &cache,
            Some(database),
            |d| {
                d.per_db
                    .get(database)
                    .and_then(|c| c.tables.get(&key).cloned())
            },
            |d, v| {
                d.db(database).tables.insert(key.clone(), v);
            },
            move |conn| {
                Box::pin(async move { Self::introspector(&*conn)?.table_details(&owned).await })
            },
        )
        .await
    }

    pub async fn completion_catalog(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        database: &str,
        include_system: bool,
    ) -> Result<Arc<CompletionCatalog>, YadbeError> {
        Self::check_database(database)?;
        let session = Self::session(manager, connection_id)?;
        let cache = self.cache(&session);
        let db = database.to_owned();
        self.cached(
            request_id,
            &session,
            &cache,
            Some(database),
            |d| {
                d.per_db
                    .get(database)
                    .and_then(|c| c.catalogs.get(&include_system).cloned())
            },
            |d, v| {
                d.db(database).catalogs.insert(include_system, v);
            },
            move |conn| {
                Box::pin(async move {
                    Self::introspector(&*conn)?
                        .completion_catalog(&db, include_system)
                        .await
                        .map(Arc::new)
                })
            },
        )
        .await
    }

    /// The foreign keys referencing `table` (F-088), cached until a refresh of its database.
    pub async fn incoming_foreign_keys(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<IncomingForeignKeys, YadbeError> {
        Self::check_database(&table.database)?;
        let session = Self::session(manager, connection_id)?;
        Self::check_schema(&session, table.schema.as_deref())?;
        let cache = self.cache(&session);
        let key = (table.schema.clone(), table.name.clone());
        let owned = table.clone();
        let database = table.database.as_str();
        self.cached(
            request_id,
            &session,
            &cache,
            Some(database),
            |d| {
                d.per_db
                    .get(database)
                    .and_then(|c| c.incoming.get(&key).cloned())
            },
            |d, v| {
                d.db(database).incoming.insert(key.clone(), v);
            },
            move |conn| {
                Box::pin(async move {
                    Self::introspector(&*conn)?
                        .incoming_foreign_keys(&owned)
                        .await
                })
            },
        )
        .await
    }

    /// Drops `node` and everything below it from the cache, then emits `meta-refreshed`.
    pub fn refresh(&self, connection_id: &str, node: MetaNode) {
        self.drop_cached(connection_id, &node);
        self.emit(connection_id, node, MetaRefreshReason::Refresh);
    }

    fn drop_cached(&self, connection_id: &str, node: &MetaNode) {
        if let Some(cache) = lock(&self.caches).get(connection_id).cloned() {
            lock(&cache.data).invalidate(node);
            if *node == MetaNode::Connection {
                lock(&cache.extra).clear();
            }
        }
    }

    /// A "Script as" template for a table, from its (cached) details.
    pub async fn script(
        &self,
        manager: &ConnectionManager,
        connection_id: &str,
        table: &ObjectRef,
        kind: ScriptKind,
    ) -> Result<String, YadbeError> {
        let engine = Self::session(manager, connection_id)?.target().engine;
        let dialect = engine.dialect();
        if kind == ScriptKind::QualifiedName {
            return Ok(crate::db::meta::qualified_name(dialect, table));
        }
        let details = self
            .table_details(manager, None, connection_id, table)
            .await?;
        Ok(script(dialect, &details, kind))
    }
}

/// Forwards every event, and lets the metadata cache follow connection states (emptied
/// when the link drops, `meta-refreshed` once it is back, forgotten on close).
pub struct ObservingSink {
    pub inner: Arc<dyn EventSink>,
    pub meta: Arc<MetaService>,
}

impl EventSink for ObservingSink {
    fn emit(&self, event: BackendEvent) {
        let state = match &event {
            BackendEvent::ConnectionStateChanged(changed) => Some(changed.session.clone()),
            // The query runner announces a schema change: drop what the cache holds before
            // the frontend reads again.
            BackendEvent::MetaRefreshed(refreshed)
                if refreshed.reason == MetaRefreshReason::Ddl =>
            {
                self.meta
                    .drop_cached(&refreshed.connection_id, &refreshed.node);
                None
            }
            _ => None,
        };
        self.inner.emit(event);
        if let Some(info) = state {
            self.meta.on_state(&info);
        }
    }
}

#[cfg(test)]
#[path = "meta_cache_tests.rs"]
mod tests;
