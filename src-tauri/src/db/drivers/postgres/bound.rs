//! Statements yadbe authors with bound values (table browsing, edits). Every value is sent in
//! the text format: the server infers each parameter's type from where it is used (the
//! column it is written into or compared with) and reads the text with that type's input
//! function, which is exact for every type, enums, domains and extension types included.

use std::error::Error;

use tokio_postgres::types::private::BytesMut;
use tokio_postgres::types::{Format, IsNull, ToSql, Type, to_sql_checked};

use super::classify_query;
use super::execute::server_message;
use crate::db::driver::BoundFailure;
use crate::db::edit_dialect::pg_text;
use crate::db::errors::{ConstraintKind, ConstraintViolation, YadbeError};
use crate::db::value::Value;

/// Why a statement failed: the server (or the link), or a value yadbe could not decode.
pub(super) enum PgFailure {
    Server(tokio_postgres::Error),
    Decode(YadbeError),
}

impl From<tokio_postgres::Error> for PgFailure {
    fn from(err: tokio_postgres::Error) -> Self {
        PgFailure::Server(err)
    }
}

/// A parameter sent as text, whatever type the server gave it.
#[derive(Debug)]
pub(super) struct TextParam(Option<String>);

impl TextParam {
    pub(super) fn of(value: &Value) -> Self {
        TextParam(pg_text(value))
    }
}

impl ToSql for TextParam {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        match &self.0 {
            None => Ok(IsNull::Yes),
            Some(text) => {
                out.extend_from_slice(text.as_bytes());
                Ok(IsNull::No)
            }
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    to_sql_checked!();
}

/// A failed statement: broken constraints with their name and column, conversion failures
/// (SQLSTATE class 22) as `invalidValue`.
pub(super) fn failure(err: &tokio_postgres::Error) -> BoundFailure {
    let base = classify_query(err);
    let Some(db) = err.as_db_error() else {
        return base.into();
    };
    let code = db.code().code();
    let kind = match code {
        "23505" => Some(ConstraintKind::Unique),
        "23503" => Some(ConstraintKind::ForeignKey),
        "23514" => Some(ConstraintKind::Check),
        "23502" => Some(ConstraintKind::NotNull),
        "23P01" => Some(ConstraintKind::Exclusion),
        _ => None,
    };
    let violation = kind.map(|kind| ConstraintViolation {
        kind,
        name: db.constraint().map(str::to_owned),
        column: db.column().map(str::to_owned),
    });
    let detail = base.detail.clone().unwrap_or_default();
    let error = match (&violation, code) {
        (Some(violation), _) => YadbeError::constraint_violation(violation).with_detail(&detail),
        (None, "57014") => YadbeError::cancelled().with_detail(db.message()),
        (None, "25006") => YadbeError::read_only_violation("").with_detail(&detail),
        // undefined_table: the table of a table tab was dropped or renamed.
        (None, "42P01") => YadbeError::table_gone(&detail),
        (None, c) if c.starts_with("22") => YadbeError::invalid_value(&detail),
        _ => base,
    };
    BoundFailure {
        error,
        server: Some(Box::new(server_message(db))),
        violation: violation.map(Box::new),
    }
}
