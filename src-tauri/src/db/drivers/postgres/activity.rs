//! PostgreSQL activity monitor (F-140): `pg_stat_activity`, `pg_locks` and
//! `pg_blocking_pids`. A user without `pg_read_all_stats` still sees who is connected, but the
//! server hides what the others run: the snapshot says so instead of showing empty statements.

use super::PgConnection;
use crate::db::activity::{
    ActivityFuture, ActivityMonitor, ActivityNote, ActivitySnapshot, KillMode, KillOutcome,
    KillRequest, bool_of, bound_id, check_target, locks_from_rows, parse_session_id,
    session_from_row,
};
use crate::db::driver::{BoundFailure, SqlConnection};
use crate::db::errors::YadbeError;
use crate::db::value::QueryResult;

/// Every session. One of another user, when the user lacks `pg_read_all_stats`, has no
/// `backend_type`: it is a background process when it has no database either.
const SESSIONS_SQL: &str = "\
SELECT a.pid::text,
       COALESCE(a.backend_start::text, ''),
       a.usename::text,
       a.datname::text,
       CASE WHEN a.client_addr IS NULL THEN NULL
            WHEN a.client_port IS NULL OR a.client_port < 0 THEN host(a.client_addr)
            ELSE host(a.client_addr) || ':' || a.client_port END,
       a.application_name::text,
       COALESCE(a.state, a.backend_type)::text,
       CASE WHEN a.state = 'active' THEN 'active'
            WHEN a.state = 'idle' THEN 'idle'
            WHEN a.state LIKE 'idle in transaction%' THEN 'idleInTransaction'
            ELSE 'other' END,
       CASE WHEN a.wait_event IS NULL THEN NULL
            ELSE a.wait_event_type || ': ' || a.wait_event END,
       NULLIF(NULLIF(left(a.query, 4001), ''), '<insufficient privilege>'),
       extract(epoch FROM clock_timestamp() - COALESCE(
           CASE WHEN a.state = 'active' THEN a.query_start ELSE a.state_change END,
           a.backend_start))::float8,
       extract(epoch FROM clock_timestamp() - a.xact_start)::float8,
       array_to_string(pg_blocking_pids(a.pid), ','),
       a.pid = pg_backend_pid(),
       (a.backend_type IS NOT NULL AND a.backend_type <> 'client backend')
           OR (a.backend_type IS NULL AND a.datname IS NULL)
FROM pg_stat_activity a
ORDER BY a.pid";

/// Locks of other sessions, those that wait first. `virtualxid` locks are every transaction's
/// own bookkeeping, never a reason to wait.
const LOCKS_SQL: &str = "\
SELECT l.pid::text,
       l.locktype::text,
       l.mode::text,
       l.granted,
       CASE WHEN l.relation IS NOT NULL THEN
                COALESCE((SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE c.oid = l.relation), 'oid ' || l.relation::text)
            WHEN l.transactionid IS NOT NULL THEN 'xid ' || l.transactionid::text
            WHEN l.locktype = 'advisory' THEN 'key ' || l.classid::text || ', ' || l.objid::text
       END
FROM pg_locks l
WHERE l.pid IS NOT NULL AND l.pid <> pg_backend_pid() AND l.locktype <> 'virtualxid'
ORDER BY l.granted, l.pid, l.locktype
LIMIT 1001";

/// Whether the user may read what other sessions run.
const VISIBILITY_SQL: &str = "\
SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') OR r.rolsuper
FROM pg_roles r WHERE r.rolname = current_user";

const TARGET_SQL: &str = "\
SELECT COALESCE(a.backend_start::text, ''), a.pid = pg_backend_pid()
FROM pg_stat_activity a WHERE a.pid = $1";

const CANCEL_SQL: &str = "SELECT pg_cancel_backend($1)";
const TERMINATE_SQL: &str = "SELECT pg_terminate_backend($1)";

/// SQLSTATE `insufficient_privilege`: not the owner of the session, not `pg_signal_backend`.
const INSUFFICIENT_PRIVILEGE: &str = "42501";

fn refused(failure: BoundFailure) -> YadbeError {
    let denied = failure
        .server
        .as_ref()
        .and_then(|server| server.code.as_deref())
        == Some(INSUFFICIENT_PRIVILEGE);
    if denied {
        YadbeError::insufficient_privilege(
            "The server refused to stop this session.",
            "Le serveur a refusé d'arrêter cette session.",
            "pg_signal_backend (or being the owner of the session)",
        )
        .with_detail(failure.error.detail.unwrap_or_default())
    } else {
        failure.error
    }
}

impl ActivityMonitor for PgConnection {
    fn activity(&self) -> ActivityFuture<'_, ActivitySnapshot> {
        Box::pin(async move {
            let (sessions, locks, visible) = futures_util::future::try_join3(
                SqlConnection::query(self, SESSIONS_SQL, usize::MAX),
                SqlConnection::query(self, LOCKS_SQL, usize::MAX),
                SqlConnection::query(self, VISIBILITY_SQL, 1),
            )
            .await?;
            let sees_all = visible.rows.first().is_some_and(|row| bool_of(row.first()));
            let (locks, locks_truncated) = locks_from_rows(&locks.rows);
            Ok(ActivitySnapshot {
                sessions: sessions
                    .rows
                    .iter()
                    .filter_map(|row| session_from_row(row))
                    .collect(),
                locks,
                locks_truncated,
                notes: if sees_all {
                    Vec::new()
                } else {
                    vec![ActivityNote::StatementsHidden]
                },
            })
        })
    }

    fn kill<'a>(&'a self, request: &'a KillRequest) -> ActivityFuture<'a, KillOutcome> {
        Box::pin(async move {
            let id = parse_session_id(&request.session_id)?;
            let found: QueryResult = self
                .query_bound(
                    &bound_id(
                        TARGET_SQL,
                        id,
                        TARGET_SQL.replace("$1", &id.to_string()),
                        true,
                    ),
                    1,
                )
                .await
                .map_err(refused)?;
            check_target(&found, request)?;
            let sql = match request.mode {
                KillMode::CancelQuery => CANCEL_SQL,
                KillMode::TerminateSession => TERMINATE_SQL,
            };
            let display = sql.replace("$1", &id.to_string());
            let done = self
                .query_bound(&bound_id(sql, id, display.clone(), true), 1)
                .await
                .map_err(refused)?;
            // `false`: the process is gone, or was not signalled.
            let signalled = done.rows.first().is_some_and(|row| bool_of(row.first()));
            if !signalled {
                return Err(YadbeError::session_changed());
            }
            Ok(KillOutcome { statement: display })
        })
    }
}
