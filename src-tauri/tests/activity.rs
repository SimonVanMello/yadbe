//! The activity monitor (F-140, M3-11) on every engine available: a second connection running a
//! long statement shows up in the list, a blocked session names its blocker, and killing a
//! query or a session is observed on the victim and in the database. SQLite has no sessions.
//!
//! PostgreSQL, SQL Server and MySQL run when their `YADBE_TEST_*_URL` is set; what a test user
//! may not see (other users' statements, server state) is asserted as the note or the typed
//! error the monitor reports, and skipped with a notice when the test server cannot set it up.

mod common;

use std::sync::Arc;
use std::time::Duration;

use yadbe_lib::db::activity::{
    ActivityNote, ActivitySession, ActivitySnapshot, KillMode, KillRequest, SessionState,
};
use yadbe_lib::db::config::ConnectionDefinition;
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::driver::Connection;
use yadbe_lib::db::errors::{ErrorCode, YadbeError};
use yadbe_lib::events::{EventSink, RecordingSink};
use yadbe_lib::secrets::{MemoryKeychain, Secret, SecretStore};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::{MetaService, ObservingSink};
use yadbe_lib::session::statement_log::StatementLog;
use yadbe_lib::store::Store;

use common::{pg_url, unique_database};

// --- Harness --------------------------------------------------------------------------------

struct Harness {
    store: Arc<Store>,
    log: Arc<StatementLog>,
    meta: Arc<MetaService>,
    manager: ConnectionManager,
}

fn harness() -> Harness {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let secrets = Arc::new(SecretStore::new(Arc::new(MemoryKeychain::default())));
    let sink = Arc::new(RecordingSink::default());
    let meta = Arc::new(MetaService::new(sink.clone()));
    let observing: Arc<dyn EventSink> = Arc::new(ObservingSink {
        inner: sink,
        meta: Arc::clone(&meta),
    });
    let log = Arc::new(StatementLog::new(Arc::clone(&observing)));
    let manager = ConnectionManager::new(Arc::clone(&store), secrets, Arc::clone(&log), observing);
    Harness {
        store,
        log,
        meta,
        manager,
    }
}

impl Harness {
    async fn open(&self, def: &ConnectionDefinition, password: Option<Secret>) -> String {
        let saved = self
            .store
            .create_connection(&def.clone().normalized().expect("valid"))
            .expect("save");
        self.manager
            .connect(&saved.id, password)
            .await
            .expect("connect");
        saved.id
    }

    async fn snapshot(&self, id: &str) -> Result<ActivitySnapshot, YadbeError> {
        self.meta.activity(&self.manager, None, id).await
    }

    /// Polls the monitor until `done` holds for a snapshot; panics with the last one after 20 s.
    async fn wait_for(
        &self,
        id: &str,
        what: &str,
        done: impl Fn(&ActivitySnapshot) -> bool,
    ) -> ActivitySnapshot {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let snapshot = self.snapshot(id).await.expect("activity");
            if done(&snapshot) {
                return snapshot;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {what}; sessions: {:#?}",
                snapshot
                    .sessions
                    .iter()
                    .filter(|s| !s.system)
                    .collect::<Vec<_>>()
            );
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn kill(
        &self,
        id: &str,
        session: &ActivitySession,
        mode: KillMode,
    ) -> Result<String, YadbeError> {
        self.meta
            .kill_session(
                &self.manager,
                id,
                &KillRequest {
                    session_id: session.id.clone(),
                    fingerprint: session.fingerprint.clone(),
                    mode,
                },
            )
            .await
            .map(|outcome| outcome.statement)
    }

    fn logged(&self, needle: &str) -> bool {
        self.log
            .entries()
            .iter()
            .any(|entry| entry.sql.contains(needle))
    }
}

fn session_of<'a>(snapshot: &'a ActivitySnapshot, id: &str) -> Option<&'a ActivitySession> {
    snapshot.sessions.iter().find(|s| s.id == id)
}

/// What differs between engines in this test.
struct Kit {
    /// A statement that runs for 30 s unless stopped.
    long_sql: &'static str,
    /// A word the long statement's text contains, in lower case.
    long_word: &'static str,
    /// The connection's own session id.
    id_sql: &'static str,
    begin: &'static str,
    /// What the monitor's own statements look like in the log.
    monitor_word: &'static str,
    /// What a kill sends, for the log.
    terminate_word: &'static str,
    /// A table of two columns, `id` and `v`, qualified for this fixture, holding row 1.
    table: String,
    /// The engine reports a waiting session's wait and an open transaction without extra
    /// privileges on the test user.
    reports_waits: bool,
}

async fn scalar(conn: &dyn Connection, sql: &str) -> String {
    conn.query(sql, 1)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e:?}"))
        .scalar_text()
        .unwrap_or_else(|| panic!("{sql}: no value"))
}

type Running = tokio::task::JoinHandle<Result<(), YadbeError>>;

fn run_in_background(conn: &Arc<dyn Connection>, sql: String) -> Running {
    let conn = Arc::clone(conn);
    tokio::spawn(async move { conn.query(&sql, 0).await.map(|_| ()) })
}

async fn finished(running: Running, what: &str) -> Result<(), YadbeError> {
    tokio::time::timeout(Duration::from_secs(15), running)
        .await
        .unwrap_or_else(|_| panic!("{what}: the statement is still running"))
        .expect("task")
}

async fn raw(def: &ConnectionDefinition, password: Option<&Secret>) -> Arc<dyn Connection> {
    Arc::from(common::open(def, password).await.expect("connect"))
}

// --- The scenario ---------------------------------------------------------------------------

async fn scenario(
    kit: &Kit,
    def: &ConnectionDefinition,
    password: Option<Secret>,
    expect_cancel_of_query: bool,
) {
    let h = harness();
    let id = h.open(def, password.clone()).await;
    let mut read_only = def.clone();
    read_only.read_only = true;
    let read_only_id = h.open(&read_only, password.clone()).await;

    // 1. A second connection running a long statement is listed, as active, with its text.
    let victim = raw(def, password.as_ref()).await;
    let victim_id = scalar(&*victim, kit.id_sql).await;
    let running = run_in_background(&victim, kit.long_sql.to_owned());
    let snapshot = h
        .wait_for(&id, "the long statement to be listed", |s| {
            session_of(s, &victim_id).is_some_and(|v| v.state == SessionState::Active)
        })
        .await;
    let listed = session_of(&snapshot, &victim_id).expect("victim");
    assert!(
        listed
            .statement
            .as_deref()
            .is_some_and(|text| text.to_lowercase().contains(kit.long_word)),
        "{listed:#?}"
    );
    assert!(listed.running_secs.is_some_and(|secs| secs >= 0.0));
    assert!(!listed.is_self && !listed.system, "{listed:#?}");
    assert!(listed.user.is_some() && !listed.fingerprint.is_empty());
    let own: Vec<_> = snapshot.sessions.iter().filter(|s| s.is_self).collect();
    assert_eq!(own.len(), 1, "the monitor's own session is flagged once");
    assert!(
        h.logged(kit.monitor_word),
        "the monitor's reads are in the log"
    );

    // The monitor's own session cannot be killed from itself, and a session that is not the
    // one the list showed is refused; neither touches the victim.
    let err = h
        .kill(&id, own[0], KillMode::TerminateSession)
        .await
        .expect_err("self");
    assert_eq!(err.code, ErrorCode::InvalidArgument, "{err:?}");
    let mut stale = listed.clone();
    stale.fingerprint = "another session".into();
    let err = h
        .kill(&id, &stale, KillMode::TerminateSession)
        .await
        .expect_err("stale");
    assert_eq!(err.code, ErrorCode::SessionChanged, "{err:?}");
    // A read-only connection watches, and cannot kill.
    let watched = h
        .meta
        .activity(&h.manager, None, &read_only_id)
        .await
        .expect("a read-only connection can read the monitor");
    assert!(session_of(&watched, &victim_id).is_some());
    let err = h
        .meta
        .kill_session(
            &h.manager,
            &read_only_id,
            &KillRequest {
                session_id: victim_id.clone(),
                fingerprint: listed.fingerprint.clone(),
                mode: KillMode::TerminateSession,
            },
        )
        .await
        .expect_err("read-only");
    assert_eq!(err.code, ErrorCode::ReadOnlyViolation, "{err:?}");
    assert!(!running.is_finished());

    // 2. Cancel the query: the statement fails, the session stays (PostgreSQL, MySQL). SQL
    // Server has nothing but KILL.
    if expect_cancel_of_query {
        let sent = h
            .kill(&id, listed, KillMode::CancelQuery)
            .await
            .expect("cancel");
        assert!(sent.contains(&victim_id), "{sent}");
        // It ends well before its 30 s (MySQL's `SLEEP` answers 1 when interrupted, not an error).
        let started = std::time::Instant::now();
        let _ = finished(running, "after the cancel").await;
        assert!(started.elapsed() < Duration::from_secs(10));
        let snapshot = h
            .wait_for(&id, "the session to go back to idle", |s| {
                session_of(s, &victim_id).is_some_and(|v| v.state != SessionState::Active)
            })
            .await;
        assert!(session_of(&snapshot, &victim_id).is_some());
        // The same connection runs the next statement.
        assert_eq!(scalar(&*victim, "SELECT 1").await, "1");
    } else {
        let err = h
            .kill(&id, listed, KillMode::CancelQuery)
            .await
            .expect_err("no cancel");
        assert_eq!(err.code, ErrorCode::NotSupported, "{err:?}");
        assert!(!running.is_finished());
        h.kill(&id, listed, KillMode::TerminateSession)
            .await
            .expect("terminate");
        assert!(finished(running, "after the kill").await.is_err());
        let snapshot = h
            .wait_for(&id, "the killed session to disappear", |s| {
                session_of(s, &victim_id).is_none()
            })
            .await;
        assert!(session_of(&snapshot, &victim_id).is_none());
    }

    // 3. Terminate a session that runs a statement: the statement fails and the session is
    // gone from the list.
    let doomed = raw(def, password.as_ref()).await;
    let doomed_id = scalar(&*doomed, kit.id_sql).await;
    let running = run_in_background(&doomed, kit.long_sql.to_owned());
    let snapshot = h
        .wait_for(&id, "the second long statement", |s| {
            session_of(s, &doomed_id).is_some_and(|v| v.state == SessionState::Active)
        })
        .await;
    let sent = h
        .kill(
            &id,
            session_of(&snapshot, &doomed_id).expect("doomed"),
            KillMode::TerminateSession,
        )
        .await
        .expect("terminate");
    assert!(sent.contains(kit.terminate_word), "{sent}");
    assert!(sent.contains(&doomed_id), "{sent}");
    assert!(finished(running, "after the terminate").await.is_err());
    h.wait_for(&id, "the terminated session to disappear", |s| {
        session_of(s, &doomed_id).is_none()
    })
    .await;
    assert!(h.logged(kit.terminate_word), "the kill is in the log");
    // Killing it again: it is gone.
    let err = h
        .kill(
            &id,
            session_of(&snapshot, &doomed_id).expect("doomed"),
            KillMode::TerminateSession,
        )
        .await
        .expect_err("gone");
    assert_eq!(err.code, ErrorCode::SessionChanged, "{err:?}");

    // 4. A blocked session names its blocker; killing the blocker rolls its change back and
    // lets the blocked statement through.
    let blocker = raw(def, password.as_ref()).await;
    let blocker_id = scalar(&*blocker, kit.id_sql).await;
    let blocked = raw(def, password.as_ref()).await;
    let blocked_id = scalar(&*blocked, kit.id_sql).await;
    blocker.query(kit.begin, 0).await.expect("begin");
    blocker
        .query(&format!("UPDATE {} SET v = 1 WHERE id = 1", kit.table), 0)
        .await
        .expect("blocker update");
    let waiting = run_in_background(
        &blocked,
        format!("UPDATE {} SET v = 2 WHERE id = 1", kit.table),
    );
    // Without readable lock tables (MySQL for a user without `performance_schema` access) the
    // monitor cannot say who blocks whom; the test then only waits for the statement to run.
    let snapshot = h
        .wait_for(&id, "the blocked session", |s| {
            session_of(s, &blocked_id).is_some_and(|b| {
                b.blocked_by.contains(&blocker_id)
                    || (s.notes.contains(&ActivityNote::LocksUnavailable)
                        && b.state == SessionState::Active)
            })
        })
        .await;
    let waiting_session = session_of(&snapshot, &blocked_id).expect("blocked");
    if !snapshot.notes.contains(&ActivityNote::LocksUnavailable) {
        assert_eq!(
            waiting_session.blocked_by,
            std::slice::from_ref(&blocker_id)
        );
    }
    assert_eq!(waiting_session.state, SessionState::Active);
    let sees_transactions = !snapshot.notes.contains(&ActivityNote::OtherSessionsHidden);
    // `INNODB_TRX` is a cache the server refreshes every 100 ms: the open transaction shows
    // up a moment after the lock wait does.
    let snapshot = if kit.reports_waits || sees_transactions {
        h.wait_for(&id, "the blocker's open transaction", |s| {
            session_of(s, &blocker_id).is_some_and(|b| b.state == SessionState::IdleInTransaction)
        })
        .await
    } else {
        snapshot
    };
    let waiting_session = session_of(&snapshot, &blocked_id).expect("blocked");
    let holding_session = session_of(&snapshot, &blocker_id).expect("blocker");
    if kit.reports_waits || sees_transactions {
        assert_eq!(
            holding_session.state,
            SessionState::IdleInTransaction,
            "{holding_session:#?} notes {:?}",
            snapshot.notes
        );
        assert!(
            holding_session.transaction_secs.is_some(),
            "{holding_session:#?}"
        );
        assert!(
            waiting_session
                .wait
                .as_deref()
                .is_some_and(|w| !w.is_empty()),
            "{waiting_session:#?}"
        );
    }
    if snapshot.notes.contains(&ActivityNote::LocksUnavailable) {
        common::skip(
            "activity locks",
            "the test user cannot read performance_schema locks; locks not asserted",
        );
        assert!(snapshot.locks.is_empty());
    } else {
        assert!(
            snapshot
                .locks
                .iter()
                .any(|l| l.session_id == blocked_id && !l.granted),
            "the blocked session waits for a lock: {:#?}",
            snapshot.locks
        );
        assert!(
            snapshot
                .locks
                .iter()
                .any(|l| l.session_id == blocker_id && l.granted),
            "the blocker holds a lock: {:#?}",
            snapshot.locks
        );
    }
    assert!(!waiting.is_finished(), "still blocked");
    h.kill(&id, holding_session, KillMode::TerminateSession)
        .await
        .expect("kill the blocker");
    finished(waiting, "the blocked update after its blocker died")
        .await
        .expect("the blocked statement goes through");
    // The blocker's transaction was rolled back, the blocked update applied.
    assert_eq!(
        scalar(
            &*blocked,
            &format!("SELECT v FROM {} WHERE id = 1", kit.table)
        )
        .await,
        "2"
    );
    let snapshot = h
        .wait_for(&id, "the blocker to disappear", |s| {
            session_of(s, &blocker_id).is_none()
        })
        .await;
    assert!(
        session_of(&snapshot, &blocked_id).is_some_and(|b| b.blocked_by.is_empty()),
        "nothing blocks it any more"
    );
    assert!(
        blocker.query("SELECT 1", 1).await.is_err(),
        "the blocker's link is dead"
    );
}

// --- PostgreSQL -----------------------------------------------------------------------------

/// Statements to run when the guard goes.
struct Cleanup {
    engine: Engine,
    url: String,
    statements: Vec<String>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let engine = self.engine;
        let url = self.url.clone();
        let statements = std::mem::take(&mut self.statements);
        // A runtime of its own: the test's runtime may be shutting down.
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                let (def, password) = match engine {
                    Engine::Postgres => common::pg_definition(&url),
                    _ => common::from_url(&url),
                };
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    for sql in statements {
                        if let Err(err) = conn.query(&sql, 0).await {
                            common::skip("cleaning up", &format!("{sql}: {err:?}"));
                        }
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

#[tokio::test]
async fn postgres_activity() {
    let Some(url) = pg_url("postgres_activity") else {
        return;
    };
    let table = unique_database("m311").to_lowercase();
    let (def, password) = common::pg_definition(&url);
    let setup = raw(&def, password.as_ref()).await;
    setup
        .query(
            &format!("CREATE TABLE \"{table}\" (id int PRIMARY KEY, v int NOT NULL)"),
            0,
        )
        .await
        .expect("table");
    let _cleanup = Cleanup {
        engine: Engine::Postgres,
        url: url.clone(),
        statements: vec![format!("DROP TABLE IF EXISTS \"{table}\"")],
    };
    setup
        .query(&format!("INSERT INTO \"{table}\" VALUES (1, 0)"), 0)
        .await
        .expect("row");
    let kit = Kit {
        long_sql: "SELECT pg_sleep(30)",
        long_word: "pg_sleep",
        id_sql: "SELECT pg_backend_pid()",
        begin: "BEGIN",
        monitor_word: "pg_stat_activity",
        terminate_word: "pg_terminate_backend",
        table: format!("\"{table}\""),
        reports_waits: true,
    };
    scenario(&kit, &def, password, true).await;
}

/// A role that may not read other roles' statements sees them hidden, and the monitor says so.
#[tokio::test]
async fn postgres_hides_what_other_roles_run() {
    let Some(url) = pg_url("postgres_hides_what_other_roles_run") else {
        return;
    };
    let role = unique_database("m311r").to_lowercase();
    let (admin_def, admin_password) = common::pg_definition(&url);
    let admin = raw(&admin_def, admin_password.as_ref()).await;
    let create = format!("CREATE ROLE \"{role}\" LOGIN PASSWORD 'probe-pw-1'");
    if let Err(err) = admin.query(&create, 0).await {
        common::skip(
            "postgres_hides_what_other_roles_run",
            &format!("the test user cannot create roles: {:?}", err.detail),
        );
        return;
    }
    let _cleanup = Cleanup {
        engine: Engine::Postgres,
        url: url.clone(),
        statements: vec![format!("DROP ROLE IF EXISTS \"{role}\"")],
    };
    // The monitor is the new role; the long statement belongs to the test user.
    let mut limited = admin_def.clone();
    limited.username.clone_from(&role);
    let limited_password = Some(Secret::new("probe-pw-1"));
    let h = harness();
    let id = h.open(&limited, limited_password).await;
    let victim = raw(&admin_def, admin_password.as_ref()).await;
    let victim_id = scalar(&*victim, "SELECT pg_backend_pid()").await;
    let running = run_in_background(&victim, "SELECT pg_sleep(30)".into());
    let snapshot = h
        .wait_for(&id, "the other role's session", |s| {
            session_of(s, &victim_id).is_some()
        })
        .await;
    assert!(
        snapshot.notes.contains(&ActivityNote::StatementsHidden),
        "{:?}",
        snapshot.notes
    );
    let seen = session_of(&snapshot, &victim_id).expect("listed");
    assert_eq!(
        seen.statement, None,
        "the statement stays hidden: {seen:#?}"
    );
    assert!(
        !seen.system,
        "a hidden client session is not taken for a background one"
    );
    // It cannot stop what it does not own either: the server's refusal is explained.
    let err = h
        .kill(&id, seen, KillMode::TerminateSession)
        .await
        .expect_err("not allowed");
    assert_eq!(err.code, ErrorCode::InsufficientPrivilege, "{err:?}");
    assert!(!running.is_finished());
    victim.close().await;
    let _ = finished(running, "after the victim closed").await;
}

// --- SQL Server -----------------------------------------------------------------------------

struct MssqlDatabase {
    url: String,
    name: String,
}

impl Drop for MssqlDatabase {
    fn drop(&mut self) {
        let url = self.url.clone();
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Runtime::new() else {
                return;
            };
            rt.block_on(async {
                let (def, password) = common::from_url(&url);
                if let Ok(conn) = common::open(&def, password.as_ref()).await {
                    let sql = format!(
                        "ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]"
                    );
                    if let Err(err) = conn.query(&sql, 0).await {
                        common::skip("cleaning up", &format!("{sql}: {err:?}"));
                    }
                    conn.close().await;
                }
            });
        })
        .join();
    }
}

#[tokio::test]
async fn mssql_activity() {
    let Some(url) = common::mssql_url("mssql_activity") else {
        return;
    };
    let name = unique_database("m311");
    let (mut def, password) = common::from_url(&url);
    let master = raw(&def, password.as_ref()).await;
    master
        .query(&format!("CREATE DATABASE [{name}]"), 0)
        .await
        .expect("database");
    let _guard = MssqlDatabase {
        url: url.clone(),
        name: name.clone(),
    };
    def.database.clone_from(&name);
    let setup = raw(&def, password.as_ref()).await;
    setup
        .query("CREATE TABLE dbo.t (id int PRIMARY KEY, v int NOT NULL)", 0)
        .await
        .expect("table");
    setup
        .query("INSERT INTO dbo.t VALUES (1, 0)", 0)
        .await
        .expect("row");
    let kit = Kit {
        long_sql: "WAITFOR DELAY '00:00:30'",
        long_word: "waitfor",
        id_sql: "SELECT @@SPID",
        begin: "BEGIN TRANSACTION",
        monitor_word: "dm_exec_sessions",
        terminate_word: "KILL ",
        table: "dbo.t".into(),
        reports_waits: true,
    };
    scenario(&kit, &def, password, false).await;
}

/// A login without `VIEW SERVER STATE` gets an explained error, not an empty list.
#[tokio::test]
async fn mssql_without_view_server_state_is_an_error() {
    let Some(url) = common::mssql_url("mssql_without_view_server_state_is_an_error") else {
        return;
    };
    let login = unique_database("m311l");
    let (def, password) = common::from_url(&url);
    let admin = raw(&def, password.as_ref()).await;
    if let Err(err) = admin
        .query(
            &format!(
                "CREATE LOGIN [{login}] WITH PASSWORD = 'Yadbe-probe-pw1', CHECK_POLICY = OFF"
            ),
            0,
        )
        .await
    {
        common::skip(
            "mssql_without_view_server_state_is_an_error",
            &format!("the test user cannot create logins: {:?}", err.detail),
        );
        return;
    }
    let _cleanup = Cleanup {
        engine: Engine::Mssql,
        url: url.clone(),
        statements: vec![format!("DROP LOGIN [{login}]")],
    };
    let mut limited = def.clone();
    limited.username.clone_from(&login);
    let h = harness();
    let id = h.open(&limited, Some(Secret::new("Yadbe-probe-pw1"))).await;
    let err = h.snapshot(&id).await.expect_err("no privilege");
    assert_eq!(err.code, ErrorCode::InsufficientPrivilege, "{err:?}");
    assert!(err.message.en.contains("VIEW SERVER STATE"), "{err:?}");
    assert!(err.message.fr.contains("VIEW SERVER STATE"), "{err:?}");
}

// --- MySQL ----------------------------------------------------------------------------------

#[tokio::test]
async fn mysql_activity() {
    let Some(url) = common::mysql_url("mysql_activity") else {
        return;
    };
    let guard = common::MysqlDatabase::create(&url, "m311").await;
    let (def, password) = guard.definition();
    let setup = raw(&def, password.as_ref()).await;
    setup
        .query(
            "CREATE TABLE t (id int PRIMARY KEY, v int NOT NULL) ENGINE=InnoDB",
            0,
        )
        .await
        .expect("table");
    setup
        .query("INSERT INTO t VALUES (1, 0)", 0)
        .await
        .expect("row");
    let kit = Kit {
        long_sql: "SELECT SLEEP(30)",
        long_word: "sleep",
        id_sql: "SELECT CONNECTION_ID()",
        begin: "START TRANSACTION",
        monitor_word: "PROCESSLIST",
        terminate_word: "KILL ",
        table: "t".into(),
        // Without `PROCESS` the server hides `INNODB_TRX`, so a sleeping transaction reads as idle.
        reports_waits: false,
    };
    scenario(&kit, &def, password, true).await;
}

// --- SQLite ---------------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_has_no_sessions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("a.sqlite");
    rusqlite::Connection::open(&path).expect("create");
    let mut def = common::blank(Engine::Sqlite, "file");
    def.file_path = path.display().to_string();
    let h = harness();
    let id = h.open(&def, None).await;
    let err = h.snapshot(&id).await.expect_err("no sessions");
    assert_eq!(err.code, ErrorCode::NotSupported, "{err:?}");
    let err = h
        .meta
        .kill_session(
            &h.manager,
            &id,
            &KillRequest {
                session_id: "1".into(),
                fingerprint: String::new(),
                mode: KillMode::TerminateSession,
            },
        )
        .await
        .expect_err("no sessions");
    assert_eq!(err.code, ErrorCode::NotSupported, "{err:?}");
    let caps = Engine::Sqlite.dialect().capabilities();
    assert!(!caps.activity_monitor && !caps.activity_cancel_query);
    assert!(
        Engine::Postgres
            .dialect()
            .capabilities()
            .activity_cancel_query
    );
    assert!(!Engine::Mssql.dialect().capabilities().activity_cancel_query);
}
