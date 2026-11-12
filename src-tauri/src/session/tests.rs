//! Session life cycle on a scripted driver: reconnection policy, closing, cancellation.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::db::config::{AuthMethod, sample_definition};
use crate::db::driver::{
    Backend, BoxFuture, CancelHandle, ConnectRequest, Driver, Link, LinkSignal, LinkWatch,
    SqlConnection,
};
use crate::db::engine::Engine;
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::value::QueryResult;
use crate::events::{BackendEvent, RecordingSink};
use crate::secrets::{MemoryKeychain, SecretStore};
use crate::session::statement_log::StatementLog;
use crate::store::Store;

/// Connects after `delay`, failing with the scripted errors first.
#[derive(Default)]
struct FakeDriver {
    failures: Mutex<VecDeque<YadbeError>>,
    links: Mutex<Vec<LinkSignal>>,
    attempts: AtomicU32,
    /// Keep-alive pings its connections received.
    keep_alives: Arc<AtomicU32>,
    delay: Duration,
}

impl FakeDriver {
    fn fail_next(&self, errors: impl IntoIterator<Item = YadbeError>) {
        self.failures.lock().expect("lock").extend(errors);
    }

    /// Drops the link of the last connection, as a server going away would.
    fn drop_link(&self) {
        if let Some(signal) = self.links.lock().expect("lock").last() {
            signal.lost();
        }
    }
}

struct FakeConnection(LinkWatch, Arc<AtomicU32>);
struct NoCancel;

impl CancelHandle for NoCancel {
    fn cancel(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async { Ok(()) })
    }
}

impl Link for FakeConnection {
    fn server_version(&self) -> &str {
        "Fake 1.0"
    }

    fn ping(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        Box::pin(async { Ok(()) })
    }

    fn keep_alive(&self) -> BoxFuture<'_, Result<(), YadbeError>> {
        self.1.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn link(&self) -> LinkWatch {
        self.0.clone()
    }

    fn cancel_handle(&self) -> Arc<dyn CancelHandle> {
        Arc::new(NoCancel)
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

impl SqlConnection for FakeConnection {
    fn query<'a>(&'a self, _: &'a str, _: usize) -> BoxFuture<'a, Result<QueryResult, YadbeError>> {
        Box::pin(async {
            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected: None,
                truncated: false,
            })
        })
    }
}

impl Driver for FakeDriver {
    fn engine(&self) -> Engine {
        Engine::Postgres
    }

    fn connect<'a>(
        &'a self,
        _request: ConnectRequest<'a>,
    ) -> BoxFuture<'a, Result<Backend, YadbeError>> {
        Box::pin(async move {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            if let Some(error) = self.failures.lock().expect("lock").pop_front() {
                return Err(error);
            }
            let (signal, watch) = LinkWatch::new();
            self.links.lock().expect("lock").push(signal);
            Ok(Backend::Sql(Arc::new(FakeConnection(
                watch,
                Arc::clone(&self.keep_alives),
            ))))
        })
    }
}

struct Fixture {
    manager: Arc<ConnectionManager>,
    driver: Arc<FakeDriver>,
    sink: Arc<RecordingSink>,
    id: String,
}

fn fixture(delay: Duration) -> Fixture {
    fixture_with(delay, None)
}

/// `keep_alive_secs`: the connection's keep-alive setting.
fn fixture_with(delay: Duration, keep_alive_secs: Option<u32>) -> Fixture {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let mut def = sample_definition(Engine::Postgres);
    def.auth = AuthMethod::None;
    def.keep_alive_secs = keep_alive_secs;
    let id = store.create_connection(&def).expect("save").id;
    let sink = Arc::new(RecordingSink::default());
    let driver = Arc::new(FakeDriver {
        delay,
        ..FakeDriver::default()
    });
    let manager = ConnectionManager::new(
        store,
        Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default()))),
        Arc::new(StatementLog::new(sink.clone())),
        sink.clone(),
    )
    .with_driver(driver.clone())
    .with_config(SessionConfig {
        reconnect_delays: vec![Duration::from_millis(10); 3],
    });
    Fixture {
        manager: Arc::new(manager),
        driver,
        sink,
        id,
    }
}

impl Fixture {
    fn infos(&self) -> Vec<SessionInfo> {
        self.sink
            .events()
            .into_iter()
            .filter_map(|e| match e {
                BackendEvent::ConnectionStateChanged(e) => Some(e.session),
                _ => None,
            })
            .collect()
    }

    fn states(&self) -> Vec<ConnectionState> {
        self.infos().into_iter().map(|i| i.state).collect()
    }

    async fn settle(&self, count: usize) {
        for _ in 0..500 {
            if self.states().len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("only {:?}", self.states());
    }
}

use ConnectionState::{Closed, Connected, Connecting, Lost, Reconnecting};

#[tokio::test]
async fn reconnects_once_the_server_is_back() {
    let f = fixture(Duration::ZERO);
    f.manager.connect(&f.id, None).await.expect("connect");
    f.driver
        .fail_next([YadbeError::connection_refused("db", 5432)]);
    f.driver.drop_link();
    f.settle(6).await;
    assert_eq!(
        f.states(),
        vec![
            Connecting,
            Connected,
            Lost,
            Reconnecting,
            Reconnecting,
            Connected
        ]
    );
    let infos = f.infos();
    assert_eq!(infos[4].reconnect_attempt, Some(2));
    assert_eq!(infos.last().map(|i| i.state), Some(Connected));
    assert_eq!(f.driver.attempts.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn gives_up_after_the_last_attempt_and_connect_starts_over() {
    let f = fixture(Duration::ZERO);
    f.manager.connect(&f.id, None).await.expect("connect");
    f.driver
        .fail_next((0..3).map(|_| YadbeError::connection_refused("db", 5432)));
    f.driver.drop_link();
    // connecting, connected, lost, 3 × reconnecting, lost
    f.settle(7).await;
    let infos = f.infos();
    let last = infos.last().expect("last");
    assert_eq!(last.state, Lost);
    assert_eq!(last.reconnect_attempt, Some(3));
    assert_eq!(
        last.error.as_ref().map(|e| e.code),
        Some(ErrorCode::ConnectionRefused)
    );
    assert_eq!(f.manager.sessions()[0].state, Lost);
    let session = f.manager.session(&f.id).expect("session");
    assert_eq!(
        session.query("SELECT 1", 1).await.map_err(|e| e.code).err(),
        Some(ErrorCode::NotConnected)
    );

    let info = f.manager.connect(&f.id, None).await.expect("by hand");
    assert_eq!(info.state, Connected);
}

#[tokio::test]
async fn a_non_transient_failure_stops_reconnecting() {
    let f = fixture(Duration::ZERO);
    f.manager.connect(&f.id, None).await.expect("connect");
    f.driver.fail_next([YadbeError::auth_failed("app")]);
    f.driver.drop_link();
    f.settle(5).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        f.states(),
        vec![Connecting, Connected, Lost, Reconnecting, Lost]
    );
    assert_eq!(f.driver.attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn disconnect_aborts_a_connection_attempt() {
    let f = fixture(Duration::from_secs(30));
    let manager = Arc::clone(&f.manager);
    let id = f.id.clone();
    let connecting = tokio::spawn(async move { manager.connect(&id, None).await });
    f.settle(1).await;
    f.manager.disconnect(&f.id).await;
    let result = tokio::time::timeout(Duration::from_secs(2), connecting)
        .await
        .expect("aborted promptly")
        .expect("join");
    assert_eq!(result.map_err(|e| e.code).err(), Some(ErrorCode::Cancelled));
    assert_eq!(f.states(), vec![Connecting, Closed]);
    assert!(f.manager.sessions().is_empty());
}

#[tokio::test]
async fn disconnect_stops_reconnecting() {
    let f = fixture(Duration::ZERO);
    f.manager.connect(&f.id, None).await.expect("connect");
    f.driver
        .fail_next((0..3).map(|_| YadbeError::connection_refused("db", 5432)));
    f.driver.drop_link();
    f.settle(3).await;
    f.manager.disconnect(&f.id).await;
    let count = f.states().len();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(f.states().last(), Some(&Closed));
    assert_eq!(f.states().len(), count, "no event after closing");
}

#[tokio::test]
async fn pings_an_idle_connection_at_its_keep_alive_interval_until_it_closes() {
    let f = fixture_with(Duration::ZERO, Some(1));
    f.manager.connect(&f.id, None).await.expect("connect");
    let pings = || f.driver.keep_alives.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(pings(), 0, "not before the interval");
    tokio::time::sleep(Duration::from_millis(1_800)).await;
    assert!((2..=3).contains(&pings()), "{}", pings());
    f.manager.disconnect(&f.id).await;
    let after_close = pings();
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(pings(), after_close, "a closed session pings nothing");
}

#[tokio::test]
async fn a_keep_alive_of_zero_pings_nothing() {
    let f = fixture_with(Duration::ZERO, Some(0));
    f.manager.connect(&f.id, None).await.expect("connect");
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(f.driver.keep_alives.load(Ordering::SeqCst), 0);
}
