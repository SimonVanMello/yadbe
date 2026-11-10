//! Streaming execution of user batches (M1-7): result sets and rows pushed as they arrive,
//! `PRINT` / `RAISERROR` messages as notices in order, row counts summed, errors with
//! their line in the batch, cancellation through the batch's TDS Attention.

use std::time::Duration;

use futures_util::StreamExt;
use tiberius::{BatchItem, DoneKind, ServerMessage as TdsMessage};
use tokio::time::Instant;

use super::MssqlConnection;
use super::decode::{self, Decoder};
use crate::db::driver::{ErrorLocation, ExecError, ExecEvent, ExecSender, ExecSummary};
use crate::db::errors::YadbeError;
use crate::db::value::Value;
use crate::session::query_model::ServerMessage;

/// Rows per batch sent to the runner (one grid window).
const BATCH_ROWS: usize = 500;
/// A batch waits at most this long for more rows, so slow streams still show progress.
const BATCH_DELAY: Duration = Duration::from_millis(20);

/// `Msg 208, Level 16, State 1, Line 2` plus the text, as SQL Server tools print it.
pub(super) fn detail(message: &TdsMessage) -> String {
    let mut out = format!(
        "Msg {}, Level {}, State {}",
        message.number, message.class, message.state
    );
    if !message.procedure.is_empty() {
        out.push_str(&format!(", Procedure {}", message.procedure));
    }
    out.push_str(&format!(", Line {}\n{}", message.line, message.message));
    out
}

fn severity(message: &TdsMessage) -> &'static str {
    match (message.error, message.class) {
        (true, _) => "ERROR",
        (false, 0) => "INFO",
        (false, _) => "WARNING",
    }
}

fn server_message(message: &TdsMessage) -> ServerMessage {
    ServerMessage {
        severity: severity(message).to_owned(),
        code: Some(message.number.to_string()),
        message: message.message.clone(),
        detail: (!message.procedure.is_empty())
            .then(|| format!("Procedure {}, line {}", message.procedure, message.line)),
        hint: None,
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

/// What the batch did so far.
#[derive(Default)]
struct Outcome {
    /// The first error; later ones become notices.
    error: Option<TdsMessage>,
    affected: Option<u64>,
    cancelled: bool,
}

impl MssqlConnection {
    pub(super) async fn execute_streaming(
        &self,
        sql: &str,
        events: ExecSender,
    ) -> Result<ExecSummary, ExecError> {
        let attention = self.current_attention();
        let mut guard = self.client.lock().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| ExecError::from(self.closed()))?;
        let mut outcome = Outcome::default();
        let streamed = {
            let stream = client
                .batch(sql, Some(attention))
                .await
                .map_err(|e| ExecError::from(self.failed(&e)));
            match stream {
                Ok(mut stream) => self.stream(&mut stream, &events, &mut outcome).await,
                Err(err) => Err(err),
            }
        };
        self.track_transaction(client);
        drop(guard);
        streamed?;
        if outcome.cancelled {
            return Err(YadbeError::cancelled().into());
        }
        if let Some(error) = outcome.error {
            let location = error
                .procedure
                .is_empty()
                .then_some(ErrorLocation::Line(error.line))
                .filter(|_| error.line > 0);
            return Err(ExecError {
                error: YadbeError::query_failed(detail(&error)),
                server: Some(Box::new(server_message(&error))),
                location,
            });
        }
        Ok(ExecSummary {
            rows_affected: outcome.affected,
        })
    }

    async fn stream(
        &self,
        stream: &mut tiberius::BatchStream<'_>,
        events: &ExecSender,
        outcome: &mut Outcome,
    ) -> Result<(), ExecError> {
        let mut decoders: Vec<Decoder> = Vec::new();
        let mut batch: Vec<Vec<Value>> = Vec::with_capacity(BATCH_ROWS);
        let mut deadline: Option<Instant> = None;
        // A result set is open: its DONE counts rows returned, not affected.
        let mut open_result = false;
        loop {
            let item = tokio::select! {
                biased;
                item = stream.next() => item,
                () = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    flush(events, &mut batch).await?;
                    deadline = None;
                    continue;
                }
            };
            let Some(item) = item else { break };
            let item = match item {
                Ok(item) => item,
                Err(err) => {
                    flush(events, &mut batch).await?;
                    return Err(self.failed(&err).into());
                }
            };
            match item {
                BatchItem::Metadata(meta) => {
                    flush(events, &mut batch).await?;
                    deadline = None;
                    open_result = true;
                    let (columns, column_decoders): (Vec<_>, Vec<_>) =
                        meta.metadata.iter().map(decode::column_meta).unzip();
                    decoders = column_decoders;
                    send(events, ExecEvent::Columns(columns)).await?;
                }
                BatchItem::Row(row) => {
                    if outcome.cancelled {
                        continue;
                    }
                    let values = row
                        .into_iter()
                        .zip(&decoders)
                        .map(|(data, &decoder)| decode::decode(data, decoder))
                        .collect();
                    batch.push(values);
                    if batch.len() >= BATCH_ROWS {
                        flush(events, &mut batch).await?;
                        deadline = None;
                    } else if deadline.is_none() {
                        deadline = Some(Instant::now() + BATCH_DELAY);
                    }
                }
                BatchItem::Done(done) => {
                    if done.attention {
                        outcome.cancelled = true;
                    } else if !open_result
                        && done.kind != DoneKind::Proc
                        && let Some(rows) = done.rows
                    {
                        *outcome.affected.get_or_insert(0) += rows;
                    }
                    if done.kind != DoneKind::Proc {
                        open_result = false;
                    }
                }
                BatchItem::Message(message) => {
                    flush(events, &mut batch).await?;
                    deadline = None;
                    if message.error && outcome.error.is_none() {
                        outcome.error = Some(message);
                    } else {
                        send(events, ExecEvent::Notice(server_message(&message))).await?;
                    }
                }
            }
        }
        flush(events, &mut batch).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(error: bool, class: u8, procedure: &str) -> TdsMessage {
        TdsMessage {
            error,
            number: 208,
            state: 1,
            class,
            message: "Invalid object name 'nowhere'.".into(),
            server: "sql".into(),
            procedure: procedure.into(),
            line: 2,
        }
    }

    #[test]
    fn formats_messages_like_sql_server_tools() {
        assert_eq!(
            detail(&message(true, 16, "")),
            "Msg 208, Level 16, State 1, Line 2\nInvalid object name 'nowhere'."
        );
        assert_eq!(
            detail(&message(true, 16, "p")),
            "Msg 208, Level 16, State 1, Procedure p, Line 2\nInvalid object name 'nowhere'."
        );
        let notice = server_message(&message(false, 0, ""));
        assert_eq!(notice.severity, "INFO");
        assert_eq!(notice.code.as_deref(), Some("208"));
        assert_eq!(server_message(&message(false, 10, "")).severity, "WARNING");
    }
}
