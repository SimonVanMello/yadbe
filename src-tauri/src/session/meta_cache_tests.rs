//! `MetaService` on a scripted driver: caching, cancellation with the native cancel,
//! invalidation and announcement around a dropped link.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::db::config::{AuthMethod, sample_definition};
use crate::db::dialect::Engine;
use crate::db::driver::{
    BoxFuture, CancelHandle, ConnectRequest, Connection, Driver, LinkSignal, LinkWatch,
};
use crate::db::errors::ErrorCode;
use crate::db::introspect::{Introspector, MetaFuture};
use crate::db::meta::{CompletionCatalog, ObjectCount};
use crate::db::value::QueryResult;
use crate::events::{EventSink, RecordingSink};
use crate::secrets::{MemoryKeychain, SecretStore};
use crate::session::SessionConfig;
use crate::session::statement_log::StatementLog;
use crate::store::Store;

#[derive(Default)]
struct Probe {
    reads: AtomicU32,
    cancels: AtomicU32,
    /// `databases()` never answers (until cancelled).
    hang: AtomicBool,
    links: Mutex<Vec<LinkSignal>>,
}

struct FakeConnection {
    probe: Arc<Probe>,
    link: LinkWatch,
}

struct FakeCancel(Arc<Probe>);

impl CancelHandle for FakeCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        self.0.cancels.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

impl Connection for FakeConnection {
    fn server_version(&self) -> &str {
        "Fake 1.0"
    }
    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async { Ok(()) })
    }
    fn query<'a>(&'a self, _: &'a str, _: usize) -> BoxFuture<'a, Result<QueryResult, YadbeError>> {
        Box::pin(async { Err(YadbeError::not_implemented()) })
    }
    fn link(&self) -> LinkWatch {
        self.link.clone()
    }
    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        Arc::new(FakeCancel(Arc::clone(&self.probe)))
    }
    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn introspector(&self) -> Option<&dyn Introspector> {
        Some(self)
    }
}

impl Introspector for FakeConnection {
    fn databases(&self) -> MetaFuture<'_, Vec<DatabaseInfo>> {
        Box::pin(async move {
            self.probe.reads.fetch_add(1, Ordering::SeqCst);
            if self.probe.hang.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            Ok(vec![DatabaseInfo {
                name: "main".into(),
                current: true,
                system: false,
                accessible: true,
                comment: None,
            }])
        })
    }
    fn schemas<'a>(&'a self, _: &'a str) -> MetaFuture<'a, Vec<SchemaInfo>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn object_counts<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
    ) -> MetaFuture<'a, Vec<ObjectCount>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn objects<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: ObjectKind,
    ) -> MetaFuture<'a, Vec<ObjectInfo>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn table_details<'a>(&'a self, table: &'a ObjectRef) -> MetaFuture<'a, TableDetails> {
        Box::pin(async move { Err(YadbeError::object_not_found(&table.name)) })
    }
    fn completion_catalog<'a>(&'a self, _: &'a str, _: bool) -> MetaFuture<'a, CompletionCatalog> {
        Box::pin(async { Err(YadbeError::not_implemented()) })
    }
}

struct FakeDriver(Arc<Probe>);

impl Driver for FakeDriver {
    fn engine(&self) -> Engine {
        Engine::Sqlite
    }
    fn connect<'a>(
        &'a self,
        _: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Box<dyn Connection>, YadbeError>> {
        Box::pin(async move {
            let (signal, link) = LinkWatch::new();
            self.0.links.lock().expect("lock").push(signal);
            Ok(Box::new(FakeConnection {
                probe: Arc::clone(&self.0),
                link,
            }) as Box<dyn Connection>)
        })
    }
}

struct Fixture {
    meta: Arc<MetaService>,
    manager: ConnectionManager,
    sink: Arc<RecordingSink>,
    probe: Arc<Probe>,
    id: String,
}

async fn fixture() -> Fixture {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let mut def = sample_definition(Engine::Sqlite);
    def.auth = AuthMethod::None;
    let id = store.create_connection(&def).expect("save").id;
    let sink = Arc::new(RecordingSink::default());
    let meta = Arc::new(MetaService::new(sink.clone()));
    let observing: Arc<dyn EventSink> = Arc::new(ObservingSink {
        inner: sink.clone(),
        meta: Arc::clone(&meta),
    });
    let probe = Arc::new(Probe::default());
    let manager = ConnectionManager::new(
        store,
        Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default()))),
        Arc::new(StatementLog::new(Arc::clone(&observing))),
        observing,
    )
    .with_driver(Arc::new(FakeDriver(Arc::clone(&probe))))
    .with_config(SessionConfig {
        reconnect_delays: vec![Duration::from_millis(5); 3],
    });
    manager.connect(&id, None).await.expect("connect");
    Fixture {
        meta,
        manager,
        sink,
        probe,
        id,
    }
}

fn refreshed(sink: &RecordingSink) -> Vec<MetaRefreshed> {
    sink.events()
        .into_iter()
        .filter_map(|e| match e {
            BackendEvent::MetaRefreshed(r) => Some(r),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn caches_until_refreshed() {
    let f = fixture().await;
    for _ in 0..3 {
        f.meta
            .databases(&f.manager, None, &f.id)
            .await
            .expect("databases");
    }
    assert_eq!(f.probe.reads.load(Ordering::SeqCst), 1);
    f.meta.refresh(&f.id, MetaNode::Connection);
    f.meta
        .databases(&f.manager, None, &f.id)
        .await
        .expect("databases");
    assert_eq!(f.probe.reads.load(Ordering::SeqCst), 2);
    assert_eq!(refreshed(&f.sink).len(), 1);
    // A refresh below the databases keeps them.
    f.meta.refresh(
        &f.id,
        MetaNode::Database {
            database: "main".into(),
        },
    );
    f.meta
        .databases(&f.manager, None, &f.id)
        .await
        .expect("databases");
    assert_eq!(f.probe.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cancels_with_the_native_mechanism() {
    let f = fixture().await;
    f.probe.hang.store(true, Ordering::SeqCst);
    let call = f.meta.databases(&f.manager, Some("r1"), &f.id);
    let cancel = async {
        while f.probe.reads.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        f.meta.cancel("r1");
    };
    let (result, ()) = tokio::join!(call, cancel);
    assert_eq!(result.expect_err("cancelled").code, ErrorCode::Cancelled);
    assert_eq!(f.probe.cancels.load(Ordering::SeqCst), 1);
    // Unknown ids are ignored; nothing was cached.
    f.meta.cancel("r1");
    f.probe.hang.store(false, Ordering::SeqCst);
    f.meta
        .databases(&f.manager, None, &f.id)
        .await
        .expect("databases");
    assert_eq!(f.probe.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_dropped_link_empties_the_cache_and_is_announced_once_back() {
    let f = fixture().await;
    f.meta
        .databases(&f.manager, None, &f.id)
        .await
        .expect("databases");
    if let Some(signal) = f.probe.links.lock().expect("lock").last() {
        signal.lost();
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while refreshed(&f.sink).is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "no meta-refreshed");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(refreshed(&f.sink)[0].reason, MetaRefreshReason::Reconnected);
    f.meta
        .databases(&f.manager, None, &f.id)
        .await
        .expect("databases");
    assert_eq!(f.probe.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn refuses_unknown_kinds_and_wrong_schemas() {
    let f = fixture().await;
    let views = f
        .meta
        .objects(&f.manager, None, &f.id, "main", None, ObjectKind::Sequence)
        .await
        .expect("no sequences on SQLite");
    assert!(views.is_empty());
    let error = f
        .meta
        .objects(
            &f.manager,
            None,
            &f.id,
            "main",
            Some("x"),
            ObjectKind::Table,
        )
        .await
        .expect_err("no schemas");
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    let error = f
        .meta
        .schemas(&f.manager, None, &f.id, "")
        .await
        .expect_err("database required");
    assert_eq!(error.code, ErrorCode::InvalidArgument);
}
