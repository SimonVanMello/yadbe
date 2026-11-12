//! Streaming execution of user batches (M1-7): result sets and rows pushed as they arrive,
//! `PRINT` / `RAISERROR` messages as notices in order, row counts summed, errors with
//! their line in the batch, cancellation through the batch's TDS Attention.

use std::time::Duration;

use futures_util::StreamExt;
use tiberius::{BatchItem, ColumnData, DoneKind, ServerMessage as TdsMessage};
use tokio::time::Instant;

use super::MssqlConnection;
use super::decode::{self, Decoder};
use crate::db::driver::{
    BoundStatement, ColumnOrigin, Connection, ErrorLocation, ExecError, ExecEvent, ExecSender,
    ExecSummary, Explained, recorded,
};
use crate::db::errors::{YadbeError, from_mssql_query_error};
use crate::db::params::ParamStatement;
use crate::db::plan::RawPlan;
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

pub(super) fn server_message(message: &TdsMessage) -> ServerMessage {
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

/// Where the columns of a batch's first result set come from (F-087): the server describes
/// the batch without running it; browse mode names the base table of each column.
const DESCRIBE_SQL: &str = "EXEC sys.sp_describe_first_result_set @tsql = @P1, @params = @P2, @browse_information_mode = 1";

/// The declared type of a query parameter, as the batch is described with it.
fn declared_type(value: &Value) -> String {
    match value {
        Value::Bool(_) => "bit".to_owned(),
        Value::Int(_) => "bigint".to_owned(),
        Value::Float(_) => "float".to_owned(),
        Value::Decimal(s) => {
            let scale = s.split_once('.').map_or(0, |(_, f)| f.len()).min(38);
            format!("decimal(38, {scale})")
        }
        _ => "nvarchar(max)".to_owned(),
    }
}

impl MssqlConnection {
    /// Where each column of `statement`'s first result set comes from, as
    /// `sp_describe_first_result_set` says; the hidden key columns browse mode adds are left
    /// out. Recorded in the statement log like any metadata query.
    pub(super) async fn column_origins(
        &self,
        statement: &ParamStatement,
    ) -> Result<Vec<Option<ColumnOrigin>>, YadbeError> {
        let declared = statement
            .params
            .iter()
            .map(|p| format!("{} {}", p.name, declared_type(&p.value)))
            .collect::<Vec<_>>()
            .join(", ");
        let params = vec![
            Value::Text(statement.sql.clone()),
            if declared.is_empty() {
                Value::Null
            } else {
                Value::Text(declared)
            },
        ];
        let dialect = crate::db::dialect::Engine::Mssql.dialect();
        let display = DESCRIBE_SQL
            .replace("@P1", &dialect.literal(&params[0]))
            .replace("@P2", &dialect.literal(&params[1]));
        let described = self
            .query_bound(
                &BoundStatement {
                    sql: DESCRIBE_SQL.to_owned(),
                    params,
                    display,
                    returns_rows: true,
                },
                usize::MAX,
            )
            .await
            .map_err(|f| f.error)?;
        let at = |name: &str| described.columns.iter().position(|c| c.name == name);
        let (Some(hidden), Some(ordinal), Some(database), Some(schema), Some(table), Some(column)) = (
            at("is_hidden"),
            at("column_ordinal"),
            at("source_database"),
            at("source_schema"),
            at("source_table"),
            at("source_column"),
        ) else {
            return Err(YadbeError::internal(
                "unexpected sp_describe_first_result_set columns",
            ));
        };
        let text = |row: &[Value], i: usize| match row.get(i) {
            Some(Value::Text(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        let mut columns: Vec<(i64, Option<ColumnOrigin>)> = described
            .rows
            .iter()
            .filter(|row| !matches!(row.get(hidden), Some(Value::Bool(true))))
            .map(|row| {
                let position = match row.get(ordinal) {
                    Some(Value::Int(n)) => n.parse().unwrap_or(i64::MAX),
                    _ => i64::MAX,
                };
                let origin = (|| {
                    Some(ColumnOrigin {
                        database: text(row, database),
                        schema: Some(text(row, schema)?),
                        table: text(row, table)?,
                        column: text(row, column)?,
                    })
                })();
                (position, origin)
            })
            .collect();
        columns.sort_by_key(|(position, _)| *position);
        Ok(columns.into_iter().map(|(_, origin)| origin).collect())
    }

    /// Runs a user batch. With query parameters (F-048), the batch goes through
    /// `sp_executesql` as written, each parameter declared under its own `@name`.
    pub(super) async fn execute_streaming(
        &self,
        sql: &str,
        params: Vec<(String, ColumnData<'static>)>,
        events: ExecSender,
    ) -> Result<ExecSummary, ExecError> {
        let attention = self.current_attention();
        let mut guard = self.client.lock().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| ExecError::from(self.closed()))?;
        let mut outcome = Outcome::default();
        let streamed = {
            let stream = if params.is_empty() {
                client.batch(sql, Some(attention)).await
            } else {
                client.rpc_batch_named(sql, params, Some(attention)).await
            }
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
                error: from_mssql_query_error(error.number, &detail(&error))
                    .unwrap_or_else(|| YadbeError::query_failed(detail(&error))),
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

/// The column SQL Server names the plan of `SET STATISTICS XML` / `SET SHOWPLAN_XML`.
const SHOWPLAN_COLUMN: &str = "Microsoft SQL Server 2005 XML Showplan";

impl MssqlConnection {
    /// The plan of a user batch (F-053): showplan XML, estimated (`SET SHOWPLAN_XML ON`:
    /// nothing runs) or actual (`SET STATISTICS XML ON`: the batch runs, its own result sets
    /// are read and dropped). The `SET` statements are always switched back off.
    pub(super) async fn explain(
        &self,
        statement: &ParamStatement,
        analyze: bool,
    ) -> Result<Explained, ExecError> {
        let (on, off) = if analyze {
            ("SET STATISTICS XML ON", "SET STATISTICS XML OFF")
        } else {
            ("SET SHOWPLAN_XML ON", "SET SHOWPLAN_XML OFF")
        };
        Connection::query(self, on, 0).await?;
        let mut failure = None;
        let rows_of = |plans: &Vec<String>| u64::try_from(plans.len()).ok();
        let read = recorded(&*self.recorder, &statement.sql, rows_of, async {
            self.read_plans(statement).await.map_err(|e| {
                let error = e.error.clone();
                failure = Some(e);
                error
            })
        })
        .await;
        let reset = Connection::query(self, off, 0).await;
        let plans = read.map_err(|error| failure.unwrap_or_else(|| error.into()))?;
        reset?;
        Ok(Explained {
            raw: RawPlan::ShowplanXml(plans),
            sent: format!("{on}\n{}\n{off}", statement.sql),
        })
    }

    /// Runs the batch and keeps the showplan documents it returns.
    async fn read_plans(&self, statement: &ParamStatement) -> Result<Vec<String>, ExecError> {
        let params = statement
            .params
            .iter()
            .map(|p| (p.name.clone(), super::bound::user_param(&p.value)))
            .collect::<Vec<_>>();
        let attention = self.current_attention();
        let mut guard = self.client.lock().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| ExecError::from(self.closed()))?;
        let mut plans = Vec::new();
        let mut error: Option<TdsMessage> = None;
        let mut cancelled = false;
        let streamed: Result<(), ExecError> = async {
            let mut stream = if params.is_empty() {
                client.batch(statement.sql.as_str(), Some(attention)).await
            } else {
                client
                    .rpc_batch_named(statement.sql.as_str(), params, Some(attention))
                    .await
            }
            .map_err(|e| ExecError::from(self.failed(&e)))?;
            let mut collecting = false;
            let mut decoders: Vec<Decoder> = Vec::new();
            while let Some(item) = stream.next().await {
                match item.map_err(|e| ExecError::from(self.failed(&e)))? {
                    BatchItem::Metadata(meta) => {
                        collecting = meta.metadata.len() == 1
                            && meta.metadata[0].col_name == SHOWPLAN_COLUMN;
                        decoders = meta
                            .metadata
                            .iter()
                            .map(|c| decode::column_meta(c).1)
                            .collect();
                    }
                    BatchItem::Row(row) if collecting => {
                        if let Some((data, &decoder)) = row.into_iter().zip(&decoders).next()
                            && let Value::Text(xml) | Value::Other(xml) =
                                decode::decode(data, decoder)
                        {
                            plans.push(xml);
                        }
                    }
                    BatchItem::Done(done) if done.attention => cancelled = true,
                    BatchItem::Message(message) if message.error && error.is_none() => {
                        error = Some(message);
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        .await;
        self.track_transaction(client);
        drop(guard);
        streamed?;
        if cancelled {
            return Err(YadbeError::cancelled().into());
        }
        if let Some(error) = error {
            return Err(ExecError {
                error: from_mssql_query_error(error.number, &detail(&error))
                    .unwrap_or_else(|| YadbeError::query_failed(detail(&error))),
                server: Some(Box::new(server_message(&error))),
                location: None,
            });
        }
        Ok(plans)
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
