//! Streaming execution of user statements: every result set of the statement (a `CALL`
//! returns several) with its rows pushed as they arrive, the server's `info` text and
//! warnings (`SHOW WARNINGS`, only when the server reports some) as notices, rows affected,
//! errors with their line, `KILL QUERY` cancellation.

use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Error as MyError, TextProtocol};
use tokio::time::Instant;

use super::decode::{self, Decoder};
use super::{Inner, decode_row};
use crate::db::driver::{ErrorLocation, ExecError, ExecEvent, ExecSender, ExecSummary, recorded};
use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value};
use crate::session::query_model::ServerMessage;

/// Rows per batch sent to the runner (one grid window).
const BATCH_ROWS: usize = 500;
/// A batch waits at most this long for more rows, so slow streams still show progress.
const BATCH_DELAY: Duration = Duration::from_millis(20);
const SHOW_WARNINGS_SQL: &str = "SHOW WARNINGS";

/// The line of a syntax error: `… near 'FROMM t' at line 2`.
pub(super) fn error_line(message: &str) -> Option<u32> {
    let (_, rest) = message.rsplit_once(" at line ")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|line| *line > 0)
}

pub(super) fn error_message(err: &mysql_async::ServerError) -> ServerMessage {
    ServerMessage {
        severity: "ERROR".to_owned(),
        code: Some(err.code.to_string()),
        message: err.message.clone(),
        detail: Some(format!("SQLSTATE {}", err.state)),
        hint: None,
    }
}

/// Why the stream stopped early.
enum Stop {
    Server(MyError),
    /// The runner is gone.
    Gone,
}

impl From<MyError> for Stop {
    fn from(err: MyError) -> Self {
        Stop::Server(err)
    }
}

async fn send(events: &ExecSender, event: ExecEvent) -> Result<(), Stop> {
    events.send(event).await.map_err(|_| Stop::Gone)
}

async fn flush(events: &ExecSender, batch: &mut Vec<Vec<Value>>) -> Result<(), Stop> {
    if batch.is_empty() {
        return Ok(());
    }
    let rows = std::mem::replace(batch, Vec::with_capacity(BATCH_ROWS));
    send(events, ExecEvent::Rows(rows)).await
}

fn info_notice(info: &str) -> ExecEvent {
    ExecEvent::Notice(ServerMessage {
        severity: "INFO".to_owned(),
        code: None,
        message: info.trim().to_owned(),
        detail: None,
        hint: None,
    })
}

/// What the statement did so far.
#[derive(Default)]
struct Outcome {
    affected: Option<u64>,
    /// The server reported warnings for at least one reply.
    warnings: bool,
}

async fn stream(
    result: &mut mysql_async::QueryResult<'_, '_, TextProtocol>,
    events: &ExecSender,
    outcome: &mut Outcome,
) -> Result<(), Stop> {
    while let Some(columns) = result.columns() {
        if columns.is_empty() {
            // A reply without result set: its counts are read before moving on.
            *outcome.affected.get_or_insert(0) += result.affected_rows();
            outcome.warnings |= result.warnings() > 0;
            let info = result.info().into_owned();
            if !info.trim().is_empty() {
                send(events, info_notice(&info)).await?;
            }
            result.next().await?;
            continue;
        }
        let (metas, decoders): (Vec<ColumnMeta>, Vec<Decoder>) =
            columns.iter().map(decode::column).unzip();
        send(events, ExecEvent::Columns(metas)).await?;
        let mut batch: Vec<Vec<Value>> = Vec::with_capacity(BATCH_ROWS);
        let mut deadline: Option<Instant> = None;
        loop {
            // The read is never dropped half-way: a partial batch is flushed while it waits.
            let next = result.next();
            let mut next = std::pin::pin!(next);
            let row = loop {
                tokio::select! {
                    biased;
                    row = &mut next => break row,
                    () = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                        flush(events, &mut batch).await?;
                        deadline = None;
                    }
                }
            };
            let row = match row {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(err) => {
                    flush(events, &mut batch).await?;
                    return Err(err.into());
                }
            };
            batch.push(decode_row(row, &decoders));
            if batch.len() >= BATCH_ROWS {
                flush(events, &mut batch).await?;
                deadline = None;
            } else if deadline.is_none() {
                deadline = Some(Instant::now() + BATCH_DELAY);
            }
        }
        flush(events, &mut batch).await?;
        // The last reply's terminator is still the connection's last OK packet.
        if result.columns().is_none() {
            outcome.warnings |= result.warnings() > 0;
        }
    }
    Ok(())
}

/// `SHOW WARNINGS` rows (`Level`, `Code`, `Message`) as notices.
fn warning_notices(rows: Vec<Vec<Value>>) -> Vec<ServerMessage> {
    let text = |value: Option<&Value>| match value {
        Some(Value::Text(s) | Value::Int(s)) => Some(s.clone()),
        _ => None,
    };
    rows.into_iter()
        .map(|row| ServerMessage {
            severity: text(row.first())
                .unwrap_or_else(|| "Warning".to_owned())
                .to_ascii_uppercase(),
            code: text(row.get(1)),
            message: text(row.get(2)).unwrap_or_default(),
            detail: None,
            hint: None,
        })
        .collect()
}

impl Inner {
    async fn show_warnings(&self, conn: &mut Conn) -> Vec<ServerMessage> {
        let read = recorded(
            &*self.recorder,
            SHOW_WARNINGS_SQL,
            |r: &Vec<Vec<Value>>| u64::try_from(r.len()).ok(),
            async {
                let mut result = conn
                    .query_iter(SHOW_WARNINGS_SQL)
                    .await
                    .map_err(|e| self.failed(&e))?;
                let drained = super::drain(&mut result, 1000)
                    .await
                    .map_err(|e| self.failed(&e))?;
                Ok(drained
                    .sets
                    .into_iter()
                    .next()
                    .map(|set| set.rows)
                    .unwrap_or_default())
            },
        )
        .await;
        match read {
            Ok(rows) => warning_notices(rows),
            Err(err) => {
                tracing::debug!(error = ?err, "SHOW WARNINGS failed");
                Vec::new()
            }
        }
    }

    pub(super) async fn execute_streaming(
        &self,
        sql: &str,
        events: ExecSender,
    ) -> Result<ExecSummary, ExecError> {
        let (mut guard, running) = self.lock().await?;
        let conn = guard
            .as_mut()
            .ok_or_else(|| ExecError::from(self.closed()))?;
        let mut outcome = Outcome::default();
        let streamed = match conn.query_iter(sql).await {
            Ok(mut result) => stream(&mut result, &events, &mut outcome).await,
            Err(err) => Err(Stop::Server(err)),
        };
        drop(running);
        if streamed.is_ok() && outcome.warnings {
            for notice in self.show_warnings(conn).await {
                // The runner may be gone already: the statement succeeded all the same.
                let _ = events.send(ExecEvent::Notice(notice)).await;
            }
        }
        self.track_transaction(conn).await;
        drop(guard);
        match streamed {
            Ok(()) => Ok(ExecSummary {
                rows_affected: outcome.affected,
            }),
            Err(Stop::Gone) => Err(YadbeError::cancelled().into()),
            Err(Stop::Server(MyError::Server(server))) => {
                let error = super::classify_query(&MyError::Server(server.clone()));
                Err(ExecError {
                    error,
                    location: error_line(&server.message).map(ErrorLocation::Line),
                    server: Some(Box::new(error_message(&server))),
                })
            }
            Err(Stop::Server(err)) => Err(self.failed(&err).into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::server_detail;
    use super::*;

    #[test]
    fn reads_the_line_of_syntax_errors() {
        assert_eq!(
            error_line(
                "You have an error in your SQL syntax; check the manual that corresponds to your \
                 MySQL server version for the right syntax to use near 'FROMM t' at line 2"
            ),
            Some(2)
        );
        assert_eq!(error_line("Table 'db.t' doesn't exist"), None);
        let server = mysql_async::ServerError {
            code: 1146,
            message: "Table 'shop.nowhere' doesn't exist".into(),
            state: "42S02".into(),
        };
        assert_eq!(
            server_detail(&server),
            "ERROR 1146 (42S02): Table 'shop.nowhere' doesn't exist"
        );
        assert_eq!(error_message(&server).code.as_deref(), Some("1146"));
    }

    #[test]
    fn warnings_become_notices() {
        let notices = warning_notices(vec![vec![
            Value::Text("Warning".into()),
            Value::Int("1365".into()),
            Value::Text("Division by 0".into()),
        ]]);
        assert_eq!(notices[0].severity, "WARNING");
        assert_eq!(notices[0].code.as_deref(), Some("1365"));
        assert_eq!(notices[0].message, "Division by 0");
    }
}
