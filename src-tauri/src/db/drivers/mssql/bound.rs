//! Statements yadbe authors with bound values (table browsing, edits), through
//! `sp_executesql` with the batch stream of the vendored tiberius (patch 7): row counts of
//! each statement, server messages, and the TDS Attention of the cancel handle.
//!
//! Every value is bound as `nvarchar` text; the dialect wraps the placeholders that need an
//! explicit conversion (binary, date and time types, varchar keys).

use std::borrow::Cow;

use futures_util::TryStreamExt;
use tiberius::{BatchItem, ColumnData, DoneKind, ServerMessage as TdsMessage, ToSql};

use super::MssqlConnection;
use super::decode::{self, Decoder};
use super::execute::{detail, server_message};
use crate::db::driver::{BoundFailure, BoundStatement};
use crate::db::edit_dialect::plain_text;
use crate::db::errors::{ConstraintKind, ConstraintViolation, YadbeError};
use crate::db::value::{ColumnMeta, QueryResult, Value};

/// Columns, their decoders and rows of one result set.
type ResultSet = (Vec<ColumnMeta>, Vec<Decoder>, Vec<Vec<Value>>);

/// A parameter sent as `nvarchar`.
struct NText(Option<String>);

impl ToSql for NText {
    fn to_sql(&self) -> ColumnData<'_> {
        ColumnData::String(self.0.as_deref().map(Cow::Borrowed))
    }
}

/// A query parameter (F-048) with the SQL Server type its value calls for: `bigint`,
/// `numeric(p,s)`, `float`, `bit`, else `nvarchar` (dates and times included: the server
/// converts the text where the parameter is compared or stored).
pub(super) fn user_param(value: &Value) -> ColumnData<'static> {
    let text = || ColumnData::String(plain_text(value).map(Cow::Owned));
    match value {
        Value::Null => ColumnData::String(None),
        Value::Bool(b) => ColumnData::Bit(Some(*b)),
        Value::Int(s) => s
            .parse::<i64>()
            .map_or_else(|_| text(), |v| ColumnData::I64(Some(v))),
        Value::Decimal(s) => numeric(s).map_or_else(text, |n| ColumnData::Numeric(Some(n))),
        Value::Float(s) => s
            .parse::<f64>()
            .map_or_else(|_| text(), |v| ColumnData::F64(Some(v))),
        _ => text(),
    }
}

/// `-12.345` as a `numeric(5,3)`; `None` past 38 digits.
fn numeric(text: &str) -> Option<tiberius::numeric::Numeric> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let all: String = format!("{whole}{fraction}");
    if all.is_empty() || all.len() > 38 || !all.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: i128 = all.parse().ok()?;
    let scale = u8::try_from(fraction.len()).ok()?;
    Some(tiberius::numeric::Numeric::new_with_scale(
        if negative { -value } else { value },
        scale,
    ))
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_owned()),
        other => plain_text(other),
    }
}

/// The `n`-th text between `quote`s of `message`.
fn quoted(message: &str, quote: char, n: usize) -> Option<String> {
    message
        .split(quote)
        .skip(1)
        .step_by(2)
        .nth(n)
        .map(str::to_owned)
}

/// The column named after `column '…'` in a message.
fn column_of(message: &str) -> Option<String> {
    let (_, rest) = message.split_once("column '")?;
    rest.split('\'').next().map(str::to_owned)
}

/// Conversion, overflow and truncation errors (`sys.messages`).
const INVALID_VALUE: [u32; 13] = [
    220, 232, 241, 242, 245, 295, 517, 8114, 8115, 8152, 8169, 2628, 9809,
];

fn violation(message: &TdsMessage) -> Option<ConstraintViolation> {
    let text = &message.message;
    let (kind, name, column) = match message.number {
        2627 => (ConstraintKind::Unique, quoted(text, '\'', 0), None),
        2601 => (ConstraintKind::Unique, quoted(text, '\'', 1), None),
        547 if text.contains("CHECK") => {
            (ConstraintKind::Check, quoted(text, '"', 0), column_of(text))
        }
        547 => (
            ConstraintKind::ForeignKey,
            quoted(text, '"', 0),
            column_of(text),
        ),
        515 => (ConstraintKind::NotNull, None, quoted(text, '\'', 0)),
        _ => return None,
    };
    Some(ConstraintViolation { kind, name, column })
}

fn failure(message: &TdsMessage) -> BoundFailure {
    let violation = violation(message);
    let detail = detail(message);
    let error = match &violation {
        Some(v) => YadbeError::constraint_violation(v).with_detail(&detail),
        None if INVALID_VALUE.contains(&message.number)
            || (9400..9500).contains(&message.number) =>
        {
            YadbeError::invalid_value(&detail)
        }
        // Invalid object name: the table was dropped or renamed since the tab read it.
        None if message.number == 208 => YadbeError::table_gone(&detail),
        // The database is read-only.
        None if message.number == 3906 => YadbeError::database_read_only().with_detail(&detail),
        None => YadbeError::query_failed(&detail),
    };
    BoundFailure {
        error,
        server: Some(Box::new(server_message(message))),
        violation: violation.map(Box::new),
    }
}

impl MssqlConnection {
    pub(super) async fn run_bound(
        &self,
        statement: &BoundStatement,
        max_rows: usize,
    ) -> Result<QueryResult, BoundFailure> {
        let texts: Vec<NText> = statement.params.iter().map(|v| NText(text_of(v))).collect();
        let params: Vec<&dyn ToSql> = texts.iter().map(|t| t as &dyn ToSql).collect();
        let attention = self.current_attention();
        let mut guard = self.client.lock().await;
        let client = guard.as_mut().ok_or_else(|| self.closed())?;
        let mut sets: Vec<ResultSet> = Vec::new();
        let mut truncated = false;
        let mut last_count: Option<u64> = None;
        let mut error: Option<TdsMessage> = None;
        let mut cancelled = false;
        let mut open_result = false;
        let streamed: Result<(), YadbeError> = async {
            let mut stream = client
                .rpc_batch(statement.sql.as_str(), &params, Some(attention))
                .await
                .map_err(|e| self.failed(&e))?;
            while let Some(item) = stream.try_next().await.map_err(|e| self.failed(&e))? {
                match item {
                    BatchItem::Metadata(meta) => {
                        open_result = true;
                        let (columns, decoders) =
                            meta.metadata.iter().map(decode::column_meta).unzip();
                        sets.push((columns, decoders, Vec::new()));
                    }
                    BatchItem::Row(row) => {
                        let Some((_, decoders, rows)) = sets.last_mut() else {
                            continue;
                        };
                        if rows.len() == max_rows {
                            truncated = true;
                            continue;
                        }
                        rows.push(
                            row.into_iter()
                                .zip(decoders.iter())
                                .map(|(data, &d)| decode::decode(data, d))
                                .collect(),
                        );
                    }
                    BatchItem::Done(done) => {
                        if done.attention {
                            cancelled = true;
                        } else if done.kind != DoneKind::Proc {
                            // Triggers report their statements first: the last count is the
                            // statement's own.
                            if !open_result && let Some(rows) = done.rows {
                                last_count = Some(rows);
                            }
                            open_result = false;
                        }
                    }
                    BatchItem::Message(message) if message.error => {
                        error.get_or_insert(message);
                    }
                    BatchItem::Message(message) => {
                        tracing::debug!(message = message.message, "SQL Server message");
                    }
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
        if let Some(message) = error {
            return Err(failure(&message));
        }
        // The rows of the last result set: an `INSERT … ; SELECT …` reads its row back last.
        let (columns, _, rows) = sets.pop().unwrap_or_default();
        Ok(QueryResult {
            rows_affected: if statement.returns_rows {
                None
            } else {
                last_count
            },
            columns,
            rows,
            truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(number: u32, text: &str) -> TdsMessage {
        TdsMessage {
            error: true,
            number,
            state: 1,
            class: 14,
            message: text.into(),
            server: "sql".into(),
            procedure: String::new(),
            line: 1,
        }
    }

    #[test]
    fn reads_constraint_names_from_messages() {
        let unique = violation(&message(
            2627,
            "Violation of UNIQUE KEY constraint 'uq_email'. Cannot insert duplicate key in object 'dbo.users'. The duplicate key value is (a@b).",
        ));
        assert_eq!(unique.and_then(|v| v.name).as_deref(), Some("uq_email"));
        let index = violation(&message(
            2601,
            "Cannot insert duplicate key row in object 'dbo.users' with unique index 'ix_login'. The duplicate key value is (x).",
        ));
        assert_eq!(index.and_then(|v| v.name).as_deref(), Some("ix_login"));
        let check = violation(&message(
            547,
            "The UPDATE statement conflicted with the CHECK constraint \"ck_qty\". The conflict occurred in database \"db\", table \"dbo.items\", column 'qty'.",
        ))
        .expect("check");
        assert_eq!(check.kind, ConstraintKind::Check);
        assert_eq!(check.name.as_deref(), Some("ck_qty"));
        assert_eq!(check.column.as_deref(), Some("qty"));
        let fk = violation(&message(
            547,
            "The DELETE statement conflicted with the REFERENCE constraint \"fk_items_order\". The conflict occurred in database \"db\", table \"dbo.items\", column 'order_id'.",
        ))
        .expect("fk");
        assert_eq!(fk.kind, ConstraintKind::ForeignKey);
        let null = violation(&message(
            515,
            "Cannot insert the value NULL into column 'name', table 'db.dbo.users'; column does not allow nulls. UPDATE fails.",
        ))
        .expect("not null");
        assert_eq!(null.column.as_deref(), Some("name"));
        assert_eq!(
            failure(&message(245, "Conversion failed")).error.code,
            crate::db::errors::ErrorCode::InvalidValue
        );
    }
}
