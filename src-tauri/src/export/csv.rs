//! CSV writer (RFC 4180 quoting, configurable delimiter, quoting rule, NULL text, line ending
//! and byte order mark).

use std::borrow::Cow;

use super::encode::{RowEncoder, binary_text};
use super::model::{CsvOptions, CsvQuote};
use crate::db::value::{ColumnMeta, Value};

pub struct CsvEncoder {
    options: CsvOptions,
}

impl CsvEncoder {
    pub fn new(options: CsvOptions) -> Self {
        Self { options }
    }

    fn quoted(&self, text: &str) -> bool {
        let delimiter = char::from(self.options.delimiter.byte());
        text.is_empty() && self.options.null_text.is_empty()
            || text
                .chars()
                .any(|c| c == delimiter || c == '"' || c == '\n' || c == '\r')
    }

    fn push_text(&self, out: &mut Vec<u8>, text: &str, force: bool) {
        if force || self.quoted(text) {
            out.push(b'"');
            for part in text.split_inclusive('"') {
                out.extend_from_slice(part.as_bytes());
                if part.ends_with('"') {
                    out.push(b'"');
                }
            }
            out.push(b'"');
        } else {
            out.extend_from_slice(text.as_bytes());
        }
    }
}

/// Plain text of a cell, as a reader of the file would expect it.
pub(super) fn cell_text(value: &Value, binary: super::model::BinaryEncoding) -> Cow<'_, str> {
    match value {
        Value::Null | Value::Missing => Cow::Borrowed(""),
        Value::Bool(true) => Cow::Borrowed("true"),
        Value::Bool(false) => Cow::Borrowed("false"),
        Value::Array(_) => {
            let mut text = String::new();
            super::json::write_plain_array(value, binary, &mut text);
            Cow::Owned(text)
        }
        Value::Bytes(hex) => binary_text(hex, binary),
        Value::Int(s)
        | Value::Decimal(s)
        | Value::Float(s)
        | Value::Text(s)
        | Value::Date(s)
        | Value::Time(s)
        | Value::Timestamp(s)
        | Value::TimestampTz(s)
        | Value::Interval(s)
        | Value::Uuid(s)
        | Value::Json(s)
        | Value::Other(s)
        | Value::ObjectId(s) => Cow::Borrowed(s),
    }
}

fn is_numeric(value: &Value) -> bool {
    matches!(
        value,
        Value::Int(_) | Value::Decimal(_) | Value::Float(_) | Value::Bool(_)
    )
}

impl RowEncoder for CsvEncoder {
    fn begin(&mut self, columns: &[ColumnMeta], out: &mut Vec<u8>) {
        if self.options.bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        if self.options.header {
            let force =
                self.options.quote == CsvQuote::All || self.options.quote == CsvQuote::NonNumeric;
            for (index, column) in columns.iter().enumerate() {
                if index > 0 {
                    out.push(self.options.delimiter.byte());
                }
                self.push_text(out, &column.name, force);
            }
            out.extend_from_slice(self.options.line_ending.bytes());
        }
    }

    fn row(&mut self, row: &[Value], out: &mut Vec<u8>) {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                out.push(self.options.delimiter.byte());
            }
            if matches!(value, Value::Null) {
                out.extend_from_slice(self.options.null_text.as_bytes());
                continue;
            }
            let force = match self.options.quote {
                CsvQuote::Minimal => false,
                CsvQuote::All => true,
                CsvQuote::NonNumeric => !is_numeric(value),
            };
            let text = cell_text(value, self.options.binary);
            self.push_text(out, &text, force);
        }
        out.extend_from_slice(self.options.line_ending.bytes());
    }

    fn end(&mut self, _out: &mut Vec<u8>) {}
}
