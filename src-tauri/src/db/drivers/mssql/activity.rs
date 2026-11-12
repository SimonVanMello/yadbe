//! SQL Server activity monitor (F-140): `sys.dm_exec_sessions`, `sys.dm_exec_requests`,
//! `sys.dm_tran_locks`, blocking through `blocking_session_id`. Without `VIEW SERVER STATE`
//! the server shows a login only its own session (and refuses the lock view), which reads
//! as an empty monitor: it is reported as `insufficientPrivilege` instead.
//!
//! The engine can only end a session (`KILL`): there is no cancel of another session's
//! statement.

use super::MssqlConnection;
use crate::db::activity::{
    ActivityFuture, ActivityMonitor, ActivitySnapshot, KillMode, KillOutcome, KillRequest, bool_of,
    bound_id, check_target, locks_from_rows, own_session, parse_session_id, session_from_row,
};
use crate::db::driver::{BoundFailure, SqlConnection};
use crate::db::errors::YadbeError;

const PRIVILEGE_SQL: &str = "\
SELECT CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') = 1
              OR HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER PERFORMANCE STATE') = 1
            THEN 1 ELSE 0 END";

const SESSIONS_SQL: &str = "\
SELECT CAST(s.session_id AS varchar(20)),
       CONVERT(varchar(30), s.login_time, 126),
       s.login_name,
       DB_NAME(COALESCE(r.database_id, s.database_id)),
       COALESCE(c.client_net_address, s.host_name),
       s.program_name,
       COALESCE(r.status, s.status),
       CASE WHEN s.is_user_process = 0 THEN 'other'
            WHEN r.session_id IS NOT NULL THEN 'active'
            WHEN s.open_transaction_count > 0 THEN 'idleInTransaction'
            ELSE 'idle' END,
       NULLIF(r.wait_type, ''),
       LEFT(CASE WHEN r.statement_start_offset IS NOT NULL
                 THEN SUBSTRING(t.text, r.statement_start_offset / 2 + 1,
                      (CASE WHEN r.statement_end_offset = -1 THEN DATALENGTH(t.text)
                            ELSE r.statement_end_offset END - r.statement_start_offset) / 2 + 1)
                 ELSE t.text END, 4001),
       CASE WHEN r.session_id IS NOT NULL THEN r.total_elapsed_time / 1000.0
            ELSE CAST(DATEDIFF_BIG(MILLISECOND, s.last_request_end_time, GETDATE()) AS float) / 1000.0 END,
       CAST(DATEDIFF_BIG(MILLISECOND, x.begin_time, GETDATE()) AS float) / 1000.0,
       CASE WHEN r.blocking_session_id > 0 AND r.blocking_session_id <> s.session_id
            THEN CAST(r.blocking_session_id AS varchar(20)) END,
       CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END,
       CASE WHEN s.is_user_process = 0 THEN 1 ELSE 0 END
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
LEFT JOIN (SELECT st.session_id, MIN(at.transaction_begin_time) AS begin_time
           FROM sys.dm_tran_session_transactions st
           JOIN sys.dm_tran_active_transactions at ON at.transaction_id = st.transaction_id
           GROUP BY st.session_id) x ON x.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t
ORDER BY s.session_id";

/// Locks of other sessions, those that wait first. Database-level shared locks are what every
/// connection holds on its own database: noise. A `KEY`, `PAGE` or `RID` lock names its table
/// through the partition of the connection's own database.
const LOCKS_SQL: &str = "\
SELECT TOP (1001)
       CAST(l.request_session_id AS varchar(20)),
       l.resource_type,
       l.request_mode,
       CASE WHEN l.request_status = 'GRANT' THEN 1 ELSE 0 END,
       CASE WHEN l.resource_type = 'OBJECT'
                 THEN OBJECT_SCHEMA_NAME(CAST(l.resource_associated_entity_id AS int), l.resource_database_id)
                      + '.' + OBJECT_NAME(CAST(l.resource_associated_entity_id AS int), l.resource_database_id)
            WHEN l.resource_type IN ('KEY', 'PAGE', 'RID') AND l.resource_database_id = DB_ID()
                 THEN (SELECT TOP (1) OBJECT_SCHEMA_NAME(p.object_id) + '.' + OBJECT_NAME(p.object_id)
                       FROM sys.partitions p WHERE p.hobt_id = l.resource_associated_entity_id)
       END
FROM sys.dm_tran_locks l
WHERE l.request_session_id <> @@SPID AND l.resource_type <> 'DATABASE'
ORDER BY CASE WHEN l.request_status = 'GRANT' THEN 1 ELSE 0 END, l.request_session_id";

const TARGET_SQL: &str = "\
SELECT CONVERT(varchar(30), login_time, 126), CASE WHEN session_id = @@SPID THEN 1 ELSE 0 END
FROM sys.dm_exec_sessions WHERE session_id = TRY_CAST(@P1 AS int)";

/// `KILL` takes no variable: the statement is built in the batch from the bound id, which the
/// caller has parsed as digits.
const KILL_SQL: &str = "DECLARE @kill nvarchar(40) = N'KILL ' + @P1; EXEC (@kill)";

/// Permission errors of a kill and of the monitor's views: 6004 (no `ALTER ANY CONNECTION`),
/// 300 / 297 / 229 (no `VIEW SERVER STATE`, no permission on the object).
const DENIED: [&str; 4] = ["6004", "300", "297", "229"];

fn refused(failure: BoundFailure) -> YadbeError {
    let code = failure
        .server
        .as_ref()
        .and_then(|server| server.code.clone())
        .unwrap_or_default();
    match code.as_str() {
        c if DENIED.contains(&c) => YadbeError::insufficient_privilege(
            "The server refused to end this session.",
            "Le serveur a refusé de terminer cette session.",
            "ALTER ANY CONNECTION",
        )
        .with_detail(failure.error.detail.unwrap_or_default()),
        // Not an active process id: it ended between the list and the kill.
        "6106" => YadbeError::session_changed(),
        "6104" => own_session(),
        _ => failure.error,
    }
}

impl ActivityMonitor for MssqlConnection {
    fn activity(&self) -> ActivityFuture<'_, ActivitySnapshot> {
        Box::pin(async move {
            let allowed = SqlConnection::query(self, PRIVILEGE_SQL, 1).await?;
            if !allowed.rows.first().is_some_and(|row| bool_of(row.first())) {
                return Err(YadbeError::insufficient_privilege(
                    "The database user cannot see other sessions.",
                    "L'utilisateur de la base ne peut pas voir les autres sessions.",
                    "VIEW SERVER STATE",
                ));
            }
            let (sessions, locks) = futures_util::future::try_join(
                SqlConnection::query(self, SESSIONS_SQL, usize::MAX),
                SqlConnection::query(self, LOCKS_SQL, usize::MAX),
            )
            .await?;
            let (locks, locks_truncated) = locks_from_rows(&locks.rows);
            Ok(ActivitySnapshot {
                sessions: sessions
                    .rows
                    .iter()
                    .filter_map(|row| session_from_row(row))
                    .collect(),
                locks,
                locks_truncated,
                notes: Vec::new(),
            })
        })
    }

    fn kill<'a>(&'a self, request: &'a KillRequest) -> ActivityFuture<'a, KillOutcome> {
        Box::pin(async move {
            if request.mode == KillMode::CancelQuery {
                return Err(YadbeError::not_supported(
                    "SQL Server cannot cancel another session's statement without ending the session.",
                    "SQL Server ne peut pas annuler l'instruction d'une autre session sans terminer la session.",
                ));
            }
            let id = parse_session_id(&request.session_id)?;
            let found = self
                .query_bound(
                    &bound_id(
                        TARGET_SQL,
                        id,
                        TARGET_SQL.replace("@P1", &id.to_string()),
                        true,
                    ),
                    1,
                )
                .await
                .map_err(refused)?;
            check_target(&found, request)?;
            let display = format!("KILL {id}");
            self.query_bound(&bound_id(KILL_SQL, id, display.clone(), false), 0)
                .await
                .map_err(refused)?;
            Ok(KillOutcome { statement: display })
        })
    }
}
