//! The tools of the activity monitor and of EF Core awareness (M3-11): sessions and locks
//! (F-140), the migrations timeline (F-143). A child module of `meta_cache`: it shares the
//! service's cancellable `run`, so `cancel_meta_request` stops a refresh of the monitor too.
//!
//! The monitor reads and kills on the session's own shared connection, never on the one it
//! acts on: the drivers refuse the monitor's own session, and every other session (a query
//! tab's dedicated connection included) is fair game once the user confirms. Nothing is
//! cached: a snapshot shows the server as it is now.

use super::*;
use crate::db::activity::{ActivitySnapshot, KillMode, KillOutcome, KillRequest};
use crate::db::ef::{self, EfMigrations, MAX_MIGRATIONS};
use crate::db::value::Value;

impl MetaService {
    /// Sessions, locks and who blocks whom, on the session's shared connection.
    pub async fn activity(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
    ) -> Result<ActivitySnapshot, YadbeError> {
        let session = Self::session(manager, connection_id)?;
        Self::check_activity(&session)?;
        let conn = session.connection()?;
        self.run(request_id, &conn, async {
            monitor(&*conn)?.activity().await
        })
        .await
    }

    /// Cancels the statement of a session or ends it. Refused on a read-only connection: a kill
    /// changes what other people's transactions do, which a read-only connection promises not
    /// to (the spec does not say otherwise).
    pub async fn kill_session(
        &self,
        manager: &ConnectionManager,
        connection_id: &str,
        request: &KillRequest,
    ) -> Result<KillOutcome, YadbeError> {
        let session = Self::session(manager, connection_id)?;
        Self::check_activity(&session)?;
        if session.target().read_only {
            return Err(YadbeError::read_only_violation(match request.mode {
                KillMode::CancelQuery => "cancelling a session's query",
                KillMode::TerminateSession => "ending a session",
            }));
        }
        let capabilities = session.target().engine.dialect().capabilities();
        if request.mode == KillMode::CancelQuery && !capabilities.activity_cancel_query {
            return Err(YadbeError::not_supported(
                format!(
                    "{} cannot cancel another session's statement without ending the session.",
                    session.target().engine.dialect().label()
                ),
                format!(
                    "{} ne peut pas annuler l'instruction d'une autre session sans terminer la session.",
                    session.target().engine.dialect().label()
                ),
            ));
        }
        let conn = session.connection()?;
        self.run(None, &conn, async { monitor(&*conn)?.kill(request).await })
            .await
    }

    /// The migrations recorded in an EF Core history table (F-143), oldest first.
    pub async fn ef_migrations(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<EfMigrations, YadbeError> {
        let session = Self::session(manager, connection_id)?;
        Self::check_database(&table.database)?;
        Self::check_schema(&session, table.schema.as_deref())?;
        if !ef::is_history_table(&table.name) {
            return Err(YadbeError::invalid_argument(
                format!(
                    "\"{}\" is not an EF Core migrations history table.",
                    table.name
                ),
                format!(
                    "« {} » n'est pas une table d'historique des migrations EF Core.",
                    table.name
                ),
            ));
        }
        let cache = self.cache(&session);
        let conn = self
            .connection_for(&session, &cache, Some(&table.database))
            .await?;
        let sql = ef::history_statement(session.target().engine.dialect(), table);
        let result = self
            .run(request_id, &conn, async {
                // One more than the cap tells whether there was more.
                conn.query(&sql, MAX_MIGRATIONS + 1).await
            })
            .await
            .map_err(|err| missing_history(err, table))?;
        let truncated = result.rows.len() > MAX_MIGRATIONS || result.truncated;
        let migrations = result
            .rows
            .into_iter()
            .take(MAX_MIGRATIONS)
            .filter_map(|row| {
                let id = crate::db::activity::nonempty_of(row.first())?;
                let version = match row.get(1) {
                    Some(Value::Null) | None => None,
                    other => crate::db::activity::text_of(other),
                };
                Some(ef::migration(id, version))
            })
            .collect();
        Ok(EfMigrations {
            table: table.clone(),
            migrations,
            truncated,
        })
    }

    fn check_activity(session: &ConnectionSession) -> Result<(), YadbeError> {
        let dialect = session.target().engine.dialect();
        if dialect.capabilities().activity_monitor {
            return Ok(());
        }
        Err(YadbeError::not_supported(
            format!("{} has no sessions to watch.", dialect.label()),
            format!("{} n'a pas de sessions à surveiller.", dialect.label()),
        ))
    }
}

fn monitor(conn: &dyn Connection) -> Result<&dyn crate::db::activity::ActivityMonitor, YadbeError> {
    conn.activity().ok_or_else(YadbeError::not_implemented)
}

/// A history table that vanished (dropped since the explorer listed it) is `objectNotFound`.
fn missing_history(err: YadbeError, table: &ObjectRef) -> YadbeError {
    use crate::db::errors::ErrorCode;
    if err.code == ErrorCode::QueryFailed {
        let detail = err.detail.as_deref().unwrap_or_default().to_lowercase();
        if detail.contains("does not exist")
            || detail.contains("no such table")
            || detail.contains("invalid object name")
            || detail.contains("doesn't exist")
        {
            let name = match &table.schema {
                Some(schema) => format!("{schema}.{}", table.name),
                None => table.name.clone(),
            };
            return YadbeError::object_not_found(&name);
        }
    }
    err
}
