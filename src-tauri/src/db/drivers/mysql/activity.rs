//! MySQL / MariaDB activity monitor (F-140): `information_schema.PROCESSLIST`, `INNODB_TRX`
//! and, where the server has them, `performance_schema.data_locks` / `data_lock_waits` for
//! locks and who blocks whom (MySQL 8; MariaDB has neither, so its monitor says locks are
//! unavailable). Without the `PROCESS` privilege the server shows a user only its own
//! threads: the snapshot says so.

use super::MysqlConnection;
use crate::db::activity::{
    ActivityFuture, ActivityMonitor, ActivityNote, ActivitySession, ActivitySnapshot, KillMode,
    KillOutcome, KillRequest, bound_id, check_target, locks_from_rows, parse_session_id,
    session_from_row, text_of,
};
use crate::db::driver::{BoundFailure, SqlConnection};
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::value::{QueryResult, Value};

/// `PROCESS` (or `SUPER`) lets a user see every thread.
const PRIVILEGE_SQL: &str = "\
SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES
WHERE PRIVILEGE_TYPE IN ('PROCESS', 'SUPER')
  AND GRANTEE = CONCAT('''', REPLACE(CURRENT_USER(), '@', '''@'''), '''')";

/// The thread list. `INNODB_TRX` (readable with `PROCESS`) tells which sleeping threads hold a
/// transaction open and since when. The application name is not in the process list.
const SESSIONS_SQL: &str = "\
SELECT CAST(p.ID AS CHAR),
       CONCAT(p.USER, '|', p.HOST),
       p.USER,
       p.DB,
       p.HOST,
       NULL,
       COALESCE(NULLIF(p.STATE, ''), p.COMMAND),
       CASE WHEN p.COMMAND = 'Sleep' AND t.trx_id IS NOT NULL THEN 'idleInTransaction'
            WHEN p.COMMAND = 'Sleep' THEN 'idle'
            WHEN p.COMMAND IN ('Query', 'Execute') THEN 'active'
            ELSE 'other' END,
       CASE WHEN t.trx_state = 'LOCK WAIT' THEN 'lock wait'
            WHEN p.STATE LIKE 'Waiting for%' THEN p.STATE END,
       LEFT(p.INFO, 4001),
       p.TIME,
       CASE WHEN t.trx_started IS NOT NULL
            THEN UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(t.trx_started) END,
       NULL,
       p.ID = CONNECTION_ID(),
       p.COMMAND IN ('Daemon', 'Binlog Dump', 'Binlog Dump GTID')
          OR p.USER IN ('system user', 'event_scheduler')
FROM information_schema.PROCESSLIST p
LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID
ORDER BY p.ID";

/// The same list without `INNODB_TRX`, which needs `PROCESS`.
const OWN_SESSIONS_SQL: &str = "\
SELECT CAST(p.ID AS CHAR),
       CONCAT(p.USER, '|', p.HOST),
       p.USER,
       p.DB,
       p.HOST,
       NULL,
       COALESCE(NULLIF(p.STATE, ''), p.COMMAND),
       CASE WHEN p.COMMAND = 'Sleep' THEN 'idle'
            WHEN p.COMMAND IN ('Query', 'Execute') THEN 'active'
            ELSE 'other' END,
       CASE WHEN p.STATE LIKE 'Waiting for%' THEN p.STATE END,
       LEFT(p.INFO, 4001),
       p.TIME,
       NULL,
       NULL,
       p.ID = CONNECTION_ID(),
       p.COMMAND IN ('Daemon', 'Binlog Dump', 'Binlog Dump GTID')
          OR p.USER IN ('system user', 'event_scheduler')
FROM information_schema.PROCESSLIST p
ORDER BY p.ID";

/// Who waits for whom, as process list ids.
const WAITS_SQL: &str = "\
SELECT DISTINCT CAST(rt.PROCESSLIST_ID AS CHAR), CAST(bt.PROCESSLIST_ID AS CHAR)
FROM performance_schema.data_lock_waits w
JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID
JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID";

/// One line per lock kind and object, not per locked record.
const LOCKS_SQL: &str = "\
SELECT x.sid, x.lock_type, x.lock_mode, x.granted, x.object FROM (
  SELECT DISTINCT CAST(t.PROCESSLIST_ID AS CHAR) AS sid, t.PROCESSLIST_ID AS pid,
         l.LOCK_TYPE AS lock_type, l.LOCK_MODE AS lock_mode,
         l.LOCK_STATUS = 'GRANTED' AS granted,
         CONCAT(l.OBJECT_SCHEMA, '.', l.OBJECT_NAME) AS object
  FROM performance_schema.data_locks l
  JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID
  WHERE t.PROCESSLIST_ID IS NOT NULL AND t.PROCESSLIST_ID <> CONNECTION_ID()) x
ORDER BY x.granted, x.pid
LIMIT 1001";

const TARGET_SQL: &str = "\
SELECT CONCAT(USER, '|', HOST), ID = CONNECTION_ID()
FROM information_schema.PROCESSLIST WHERE ID = ?";

const CANCEL_SQL: &str = "KILL QUERY ?";
const TERMINATE_SQL: &str = "KILL ?";

/// 1227: needs `CONNECTION_ADMIN` / `SUPER`; 1095: not the owner of the thread; 1044 / 1142:
/// no access to the schema or table.
const DENIED: [&str; 4] = ["1227", "1095", "1044", "1142"];

fn refused(failure: BoundFailure) -> YadbeError {
    let code = failure
        .server
        .as_ref()
        .and_then(|server| server.code.clone())
        .unwrap_or_default();
    match code.as_str() {
        c if DENIED.contains(&c) => YadbeError::insufficient_privilege(
            "The server refused to stop this thread.",
            "Le serveur a refusé d'arrêter ce thread.",
            "CONNECTION_ADMIN (or being the user of the thread)",
        )
        .with_detail(failure.error.detail.unwrap_or_default()),
        // Unknown thread id: it ended between the list and the kill.
        "1094" => YadbeError::session_changed(),
        _ => failure.error,
    }
}

/// An optional read: a refusal or a missing table (MariaDB, privileges) is `None`, anything
/// else (a dropped link, a cancel) still fails.
fn optional(result: Result<QueryResult, YadbeError>) -> Result<Option<QueryResult>, YadbeError> {
    match result {
        Ok(rows) => Ok(Some(rows)),
        Err(err) if matches!(err.code, ErrorCode::QueryFailed | ErrorCode::ObjectNotFound) => {
            tracing::debug!(error = %err, "performance_schema locks are not readable");
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

/// Adds the blockers `WAITS_SQL` found to the sessions they block.
fn apply_waits(sessions: &mut [ActivitySession], waits: &QueryResult) {
    for row in &waits.rows {
        let (Some(waiting), Some(blocker)) = (text_of(row.first()), text_of(row.get(1))) else {
            continue;
        };
        if waiting == blocker {
            continue;
        }
        if let Some(session) = sessions.iter_mut().find(|s| s.id == waiting)
            && !session.blocked_by.contains(&blocker)
        {
            session.blocked_by.push(blocker);
        }
    }
}

impl ActivityMonitor for MysqlConnection {
    fn activity(&self) -> ActivityFuture<'_, ActivitySnapshot> {
        Box::pin(async move {
            let privileged = SqlConnection::query(self, PRIVILEGE_SQL, 1)
                .await?
                .rows
                .first()
                .and_then(|row| row.first())
                .is_some_and(|count| !matches!(count, Value::Int(n) if n == "0"));
            let sessions = SqlConnection::query(
                self,
                if privileged {
                    SESSIONS_SQL
                } else {
                    OWN_SESSIONS_SQL
                },
                usize::MAX,
            )
            .await?;
            let mut sessions: Vec<ActivitySession> = sessions
                .rows
                .iter()
                .filter_map(|row| session_from_row(row))
                .collect();
            let mut notes = Vec::new();
            if !privileged {
                notes.push(ActivityNote::OtherSessionsHidden);
            }
            let waits = optional(SqlConnection::query(self, WAITS_SQL, usize::MAX).await)?;
            let locks = optional(SqlConnection::query(self, LOCKS_SQL, usize::MAX).await)?;
            let (locks, locks_truncated) = match (waits, locks) {
                (Some(waits), Some(locks)) => {
                    apply_waits(&mut sessions, &waits);
                    locks_from_rows(&locks.rows)
                }
                _ => {
                    notes.push(ActivityNote::LocksUnavailable);
                    (Vec::new(), false)
                }
            };
            Ok(ActivitySnapshot {
                sessions,
                locks,
                locks_truncated,
                notes,
            })
        })
    }

    fn kill<'a>(&'a self, request: &'a KillRequest) -> ActivityFuture<'a, KillOutcome> {
        Box::pin(async move {
            let id = parse_session_id(&request.session_id)?;
            let found = self
                .query_bound(
                    &bound_id(
                        TARGET_SQL,
                        id,
                        TARGET_SQL.replace('?', &id.to_string()),
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
            let display = sql.replace('?', &id.to_string());
            self.query_bound(&bound_id(sql, id, display.clone(), false), 0)
                .await
                .map_err(refused)?;
            Ok(KillOutcome { statement: display })
        })
    }
}
