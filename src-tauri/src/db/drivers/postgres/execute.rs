//! Streaming execution of user statements (M1-3): extended protocol with binary results,
//! rows pushed in batches, notices routed to the running statement, server errors with
//! their position.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{StreamExt, pin_mut};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_postgres::error::{DbError, ErrorPosition};
use tokio_postgres::types::ToSql;

use super::decode::{Raw, column_meta, decode};
use super::{PgConnection, classify_query};
use crate::db::driver::{ErrorLocation, ExecError, ExecEvent, ExecSender, ExecSummary};
use crate::db::errors::YadbeError;
use crate::db::value::Value;
use crate::session::query_model::ServerMessage;

/// Rows per batch sent to the runner (one grid window).
const BATCH_ROWS: usize = 500;
/// A batch waits at most this long for more rows, so slow streams still show progress.
const BATCH_DELAY: Duration = Duration::from_millis(20);

/// Where the connection task delivers notices: the running statement, if any.
#[derive(Default)]
pub(super) struct NoticeRoute(Mutex<Option<mpsc::UnboundedSender<ServerMessage>>>);

impl NoticeRoute {
    pub(super) fn deliver(&self, notice: &DbError) {
        let guard = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match guard.as_ref() {
            Some(sender) => {
                let _ = sender.send(server_message(notice));
            }
            None => tracing::debug!(message = notice.message(), "PostgreSQL notice"),
        }
    }

    fn set(&self, sender: Option<mpsc::UnboundedSender<ServerMessage>>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sender;
    }
}

/// Detaches the route when the statement ends, even when its future is dropped.
struct RouteGuard<'a>(&'a NoticeRoute);

impl Drop for RouteGuard<'_> {
    fn drop(&mut self) {
        self.0.set(None);
    }
}

pub(super) fn server_message(db: &DbError) -> ServerMessage {
    ServerMessage {
        severity: db.severity().to_owned(),
        code: Some(db.code().code().to_owned()),
        message: db.message().to_owned(),
        detail: db.detail().map(str::to_owned),
        hint: db.hint().map(str::to_owned),
    }
}

fn exec_error(err: &tokio_postgres::Error) -> ExecError {
    let Some(db) = err.as_db_error() else {
        return classify_query(err).into();
    };
    let location = match db.position() {
        Some(ErrorPosition::Original(position)) => usize::try_from(*position)
            .ok()
            .map(|p| ErrorLocation::Char(p.saturating_sub(1))),
        // Inside a function body: no position in the user's text.
        Some(ErrorPosition::Internal { .. }) | None => None,
    };
    let error = if db.code().code() == "57014" {
        YadbeError::cancelled().with_detail(db.message())
    } else {
        classify_query(err)
    };
    ExecError {
        error,
        server: Some(Box::new(server_message(db))),
        location,
    }
}

fn gone() -> ExecError {
    YadbeError::cancelled().into()
}

async fn send(events: &ExecSender, event: ExecEvent) -> Result<(), ExecError> {
    events.send(event).await.map_err(|_| gone())
}

async fn flush(events: &ExecSender, batch: &mut Vec<Vec<Value>>) -> Result<(), ExecError> {
    if batch.is_empty() {
        return Ok(());
    }
    let rows = std::mem::replace(batch, Vec::with_capacity(BATCH_ROWS));
    send(events, ExecEvent::Rows(rows)).await
}

impl PgConnection {
    pub(super) async fn execute_streaming(
        &self,
        sql: &str,
        events: ExecSender,
    ) -> Result<ExecSummary, ExecError> {
        let (sender, mut notices) = mpsc::unbounded_channel();
        self.notices.set(Some(sender));
        let guard = RouteGuard(&self.notices);
        let result = self.stream(sql, &events, &mut notices).await;
        drop(guard);
        // Notices sent just before the statement completed.
        while let Ok(notice) = notices.try_recv() {
            send(&events, ExecEvent::Notice(notice)).await?;
        }
        result
    }

    async fn stream(
        &self,
        sql: &str,
        events: &ExecSender,
        notices: &mut mpsc::UnboundedReceiver<ServerMessage>,
    ) -> Result<ExecSummary, ExecError> {
        let statement = self.client.prepare(sql).await.map_err(|e| exec_error(&e))?;
        let types: Vec<_> = statement
            .columns()
            .iter()
            .map(|c| c.type_().clone())
            .collect();
        if !types.is_empty() {
            let columns = statement
                .columns()
                .iter()
                .map(|c| column_meta(c.name(), c.type_()))
                .collect();
            send(events, ExecEvent::Columns(columns)).await?;
        }
        let stream = self
            .client
            .query_raw(&statement, std::iter::empty::<&(dyn ToSql + Sync)>())
            .await
            .map_err(|e| exec_error(&e))?;
        pin_mut!(stream);
        let mut batch: Vec<Vec<Value>> = Vec::with_capacity(BATCH_ROWS);
        let mut deadline: Option<Instant> = None;
        loop {
            tokio::select! {
                biased;
                Some(notice) = notices.recv() => {
                    flush(events, &mut batch).await?;
                    deadline = None;
                    send(events, ExecEvent::Notice(notice)).await?;
                }
                row = stream.next() => {
                    let Some(row) = row else { break };
                    let row = match row {
                        Ok(row) => row,
                        Err(err) => {
                            flush(events, &mut batch).await?;
                            return Err(exec_error(&err));
                        }
                    };
                    let mut values = Vec::with_capacity(types.len());
                    for (index, ty) in types.iter().enumerate() {
                        let raw: Option<Raw<'_>> = row
                            .try_get(index)
                            .map_err(|e| ExecError::from(YadbeError::internal(e.to_string())))?;
                        values.push(match raw {
                            None => Value::Null,
                            Some(Raw(bytes)) => decode(ty, bytes).map_err(|e| {
                                ExecError::from(YadbeError::internal(format!(
                                    "cannot decode a {} value: {e}",
                                    ty.name()
                                )))
                            })?,
                        });
                    }
                    batch.push(values);
                    if batch.len() >= BATCH_ROWS {
                        flush(events, &mut batch).await?;
                        deadline = None;
                    } else if deadline.is_none() {
                        deadline = Some(Instant::now() + BATCH_DELAY);
                    }
                }
                () = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    flush(events, &mut batch).await?;
                    deadline = None;
                }
            }
        }
        flush(events, &mut batch).await?;
        Ok(ExecSummary {
            rows_affected: if types.is_empty() {
                stream.rows_affected()
            } else {
                None
            },
        })
    }
}

/// Shared with the connection task.
pub(super) type SharedRoute = Arc<NoticeRoute>;
