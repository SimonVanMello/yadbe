//! Statements yadbe authors with bound values (table browsing, edits): server-side prepared
//! statements, binary protocol.
//!
//! A prepared statement holds one statement only, so an authored script (`INSERT …;
//! SELECT … WHERE id = LAST_INSERT_ID()`, the read-back of an inserted row) is split here
//! and run statement by statement on the same connection, each with its own share of the
//! parameters. The rows returned are those of the last result set.

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Error as MyError, Params, Value as MyValue};

use super::execute::error_message;
use super::{Drained, Inner, drain, server_detail};
use crate::db::dialect::{Dialect, MysqlDialect};
use crate::db::driver::{BoundFailure, BoundStatement};
use crate::db::edit_dialect::plain_text;
use crate::db::errors::{ConstraintKind, ConstraintViolation, YadbeError, from_mysql_query_error};
use crate::db::split::{TokenKind, split, tokenize};
use crate::db::value::{QueryResult, Value};

/// A bound value as sent to the server. Integers go as integers (MySQL compares a string
/// with an integer column as floating point, which loses 64-bit keys); everything else as
/// text, which the server converts to the column's type, and bytes as bytes.
pub(super) fn param(value: &Value) -> MyValue {
    match value {
        Value::Null => MyValue::NULL,
        Value::Bool(b) => MyValue::Int(i64::from(*b)),
        Value::Int(text) => text
            .parse::<i64>()
            .map(MyValue::Int)
            .or_else(|_| text.parse::<u64>().map(MyValue::UInt))
            .unwrap_or_else(|_| MyValue::Bytes(text.as_bytes().to_vec())),
        Value::Bytes(hex) => MyValue::Bytes(unhex(hex).unwrap_or_else(|| hex.as_bytes().to_vec())),
        other => MyValue::Bytes(plain_text(other).unwrap_or_default().into_bytes()),
    }
}

fn unhex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The statements of an authored script with the parameters each one takes.
fn statements(sql: &str, params: &[Value]) -> Result<Vec<(String, Vec<MyValue>)>, YadbeError> {
    let syntax = MysqlDialect.syntax();
    let mut out = Vec::new();
    let mut next = 0;
    for statement in split(sql, &syntax) {
        let text = &sql[statement.range()];
        let count = tokenize(text, &syntax)
            .iter()
            .filter(|t| t.kind == TokenKind::Punct && &text[t.start..t.end] == "?")
            .count();
        let taken = params
            .get(next..next + count)
            .ok_or_else(|| YadbeError::internal("more placeholders than bound values"))?;
        next += count;
        out.push((text.to_owned(), taken.iter().map(param).collect()));
    }
    if next != params.len() {
        return Err(YadbeError::internal("more bound values than placeholders"));
    }
    Ok(out)
}

/// The text between the `n`-th pair of `quote`s of `message`.
fn quoted(message: &str, quote: char, n: usize) -> Option<String> {
    message
        .split(quote)
        .skip(1)
        .step_by(2)
        .nth(n)
        .map(str::to_owned)
}

/// The identifier after `marker` in a message: `CONSTRAINT \`fk_x\`` → `fk_x`.
fn after(message: &str, marker: &str) -> Option<String> {
    let (_, rest) = message.split_once(marker)?;
    quoted(rest, '`', 0)
}

/// Value conversion, range and length errors (strict mode), and invalid JSON.
const INVALID_VALUE: [u16; 12] = [
    1264, 1265, 1292, 1366, 1367, 1406, 1411, 1690, 1918, 3140, 3156, 4078,
];

fn violation(err: &mysql_async::ServerError) -> Option<ConstraintViolation> {
    let text = &err.message;
    let (kind, name, column) = match err.code {
        // Duplicate entry 'x' for key 'table.key' (MySQL 8), 'key' (MariaDB).
        1062 | 1586 => {
            let key = quoted(text, '\'', 1);
            let name = key.map(|k| match k.split_once('.') {
                Some((_, name)) => name.to_owned(),
                None => k,
            });
            (ConstraintKind::Unique, name, None)
        }
        // Cannot add or update a child row / delete a parent row: a foreign key constraint
        // fails (`db`.`t`, CONSTRAINT `fk` FOREIGN KEY (`col`) REFERENCES …).
        1451 | 1452 | 1216 | 1217 => (
            ConstraintKind::ForeignKey,
            after(text, "CONSTRAINT "),
            after(text, "FOREIGN KEY ("),
        ),
        // Check constraint 'name' is violated (MySQL).
        3819 => (ConstraintKind::Check, quoted(text, '\'', 0), None),
        // CONSTRAINT `name` failed for `db`.`t` (MariaDB).
        4025 => (ConstraintKind::Check, after(text, "CONSTRAINT "), None),
        // Column 'x' cannot be null; Field 'x' doesn't have a default value.
        1048 | 1364 => (ConstraintKind::NotNull, None, quoted(text, '\'', 0)),
        _ => return None,
    };
    Some(ConstraintViolation { kind, name, column })
}

fn failure(inner: &Inner, err: &MyError) -> BoundFailure {
    let MyError::Server(server) = err else {
        return BoundFailure::from(inner.failed(err));
    };
    let violation = violation(server);
    let detail = server_detail(server);
    let error = match &violation {
        Some(v) => YadbeError::constraint_violation(v).with_detail(&detail),
        None if INVALID_VALUE.contains(&server.code) => YadbeError::invalid_value(&detail),
        None => from_mysql_query_error(server.code, &detail)
            .unwrap_or_else(|| super::classify_query(err)),
    };
    BoundFailure {
        error,
        server: Some(Box::new(error_message(server))),
        violation: violation.map(Box::new),
    }
}

pub(super) async fn run_one(
    conn: &mut Conn,
    sql: &str,
    params: Vec<MyValue>,
    max_rows: usize,
) -> Result<Drained, MyError> {
    if params.is_empty() {
        let mut result = conn.query_iter(sql).await?;
        drain(&mut result, max_rows).await
    } else {
        let mut result = conn.exec_iter(sql, Params::Positional(params)).await?;
        drain(&mut result, max_rows).await
    }
}

impl Inner {
    pub(super) async fn run_bound(
        &self,
        statement: &BoundStatement,
        max_rows: usize,
    ) -> Result<QueryResult, BoundFailure> {
        let parts = statements(&statement.sql, &statement.params)?;
        let (mut guard, running) = self.lock().await?;
        let conn = guard.as_mut().ok_or_else(|| self.closed())?;
        let mut last_set = None;
        let mut last_count = None;
        let mut failed = None;
        for (sql, params) in parts {
            match run_one(conn, &sql, params, max_rows).await {
                Ok(drained) => {
                    if drained.affected.is_some() {
                        last_count = drained.affected;
                    }
                    if let Some(set) = drained.sets.into_iter().last() {
                        last_set = Some(set);
                    }
                }
                Err(err) => {
                    failed = Some(err);
                    break;
                }
            }
        }
        let killed = running.killed();
        drop(running);
        self.track_transaction(conn).await;
        drop(guard);
        if let Some(err) = failed {
            return Err(failure(self, &err));
        }
        if killed {
            return Err(YadbeError::cancelled().into());
        }
        let (columns, rows, truncated) = match last_set {
            Some(set) => (set.columns, set.rows, set.truncated),
            None => (Vec::new(), Vec::new(), false),
        };
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

    fn server(code: u16, message: &str) -> mysql_async::ServerError {
        mysql_async::ServerError {
            code,
            message: message.into(),
            state: "23000".into(),
        }
    }

    #[test]
    fn splits_authored_scripts_with_their_parameters() {
        let parts = statements(
            "INSERT INTO `a;b` (`x?`, `y`) VALUES (?, '?;'); SELECT `id` FROM `a;b` WHERE `id` = LAST_INSERT_ID() AND `k` = ?",
            &[Value::Text("v".into()), Value::int(7)],
        )
        .expect("split");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].1, [MyValue::Bytes(b"v".to_vec())]);
        assert_eq!(parts[1].1, [MyValue::Int(7)]);
        assert!(statements("SELECT ?", &[]).is_err());
        assert!(statements("SELECT 1", &[Value::Null]).is_err());
    }

    #[test]
    fn binds_integers_as_integers_and_bytes_as_bytes() {
        assert_eq!(
            param(&Value::Int("18446744073709551615".into())),
            MyValue::UInt(u64::MAX)
        );
        assert_eq!(param(&Value::Int("-5".into())), MyValue::Int(-5));
        assert_eq!(param(&Value::Bool(true)), MyValue::Int(1));
        assert_eq!(
            param(&Value::bytes(&[0, 255])),
            MyValue::Bytes(vec![0, 255])
        );
        assert_eq!(
            param(&Value::Decimal("1.50".into())),
            MyValue::Bytes(b"1.50".to_vec())
        );
    }

    #[test]
    fn reads_constraint_names_from_messages() {
        let unique = violation(&server(
            1062,
            "Duplicate entry 'a@b' for key 'customers.customers_email_key'",
        ))
        .expect("unique");
        assert_eq!(unique.name.as_deref(), Some("customers_email_key"));
        let maria = violation(&server(1062, "Duplicate entry 'a@b' for key 'email'")).expect("u");
        assert_eq!(maria.name.as_deref(), Some("email"));
        let fk = violation(&server(
            1452,
            "Cannot add or update a child row: a foreign key constraint fails (`shop`.`orders`, \
             CONSTRAINT `orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`))",
        ))
        .expect("fk");
        assert_eq!(fk.kind, ConstraintKind::ForeignKey);
        assert_eq!(fk.name.as_deref(), Some("orders_customer_fk"));
        assert_eq!(fk.column.as_deref(), Some("customer_id"));
        let check = violation(&server(
            3819,
            "Check constraint 'products_price_check' is violated.",
        ))
        .expect("check");
        assert_eq!(check.name.as_deref(), Some("products_price_check"));
        let maria_check = violation(&server(
            4025,
            "CONSTRAINT `products_price_check` failed for `shop`.`products`",
        ))
        .expect("check");
        assert_eq!(maria_check.name.as_deref(), Some("products_price_check"));
        let null = violation(&server(1048, "Column 'email' cannot be null")).expect("null");
        assert_eq!(null.kind, ConstraintKind::NotNull);
        assert_eq!(null.column.as_deref(), Some("email"));
    }
}
