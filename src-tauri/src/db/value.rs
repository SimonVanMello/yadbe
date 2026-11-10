//! The one value model every driver decodes into. Lossless over the IPC: integers, decimals,
//! floats and date / time values cross as strings, binary data as hexadecimal.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A cell value. Serialized as `{ "kind": "int", "value": "42" }` (`{ "kind": "null" }`
/// for `NULL`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Value {
    Null,
    Bool(bool),
    /// Any integer width, in decimal (64-bit values exceed JavaScript's safe integers).
    Int(String),
    /// Exact numeric, as written by the engine (`NaN`, `Infinity` included).
    Decimal(String),
    /// Floating point in shortest round-trip form; `NaN`, `Infinity`, `-Infinity`.
    Float(String),
    Text(String),
    /// Binary data as lowercase hexadecimal.
    Bytes(String),
    /// `YYYY-MM-DD` (with ` BC` for negative years), or `infinity` / `-infinity`.
    Date(String),
    /// `HH:MM:SS[.ffffff]`, with an offset for `time with time zone`.
    Time(String),
    /// `YYYY-MM-DD HH:MM:SS[.ffffff]`, without zone.
    Timestamp(String),
    /// `YYYY-MM-DD HH:MM:SS[.ffffff]+00` (UTC).
    TimestampTz(String),
    /// The engine's interval text (`1 year 2 mons 3 days 04:05:06`).
    Interval(String),
    Uuid(String),
    /// JSON text exactly as stored (numbers keep their precision).
    Json(String),
    Array(Vec<Value>),
    /// A type yadbe does not decode, in its text form (read-only in the grid).
    Other(String),
}

impl Value {
    pub fn int(value: impl ToString) -> Value {
        Value::Int(value.to_string())
    }

    pub fn float(value: f64) -> Value {
        Value::Float(format_float(value))
    }

    pub fn bytes(value: &[u8]) -> Value {
        Value::Bytes(hex(value))
    }
}

pub fn format_float(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        // `{:?}` is the shortest representation that parses back to the same value, with an
        // exponent for very large or small magnitudes (`{}` would print 300 digits for 1e300).
        let text = format!("{value:?}");
        match text.strip_suffix(".0") {
            Some(integral) => integral.to_owned(),
            None => text,
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Logical family of a column, for alignment, formatting and editors. Per-cell values may
/// still differ (SQLite columns are dynamically typed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Bool,
    Int,
    Decimal,
    Float,
    Text,
    Bytes,
    Date,
    Time,
    Timestamp,
    TimestampTz,
    Interval,
    Uuid,
    Json,
    Array,
    Other,
}

/// A column of a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// The engine's type name (`int8`, `varchar`, `numeric`…); empty when unknown.
    pub type_name: String,
    pub kind: ValueKind,
}

/// A fully buffered result: the simple path used by yadbe's own statements. User queries
/// stream into the result store instead (M1-3).
#[derive(Debug, Clone, PartialEq)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    /// Rows changed by a DML statement, when the engine reports it.
    pub rows_affected: Option<u64>,
    /// More rows were available than the requested maximum.
    pub truncated: bool,
}

impl QueryResult {
    /// The first column of the first row, as text (`SHOW server_version`, `SELECT 1`…).
    pub fn scalar_text(&self) -> Option<String> {
        match self.rows.first()?.first()? {
            Value::Null => None,
            Value::Bool(b) => Some(b.to_string()),
            Value::Array(_) => None,
            Value::Int(s)
            | Value::Decimal(s)
            | Value::Float(s)
            | Value::Text(s)
            | Value::Bytes(s)
            | Value::Date(s)
            | Value::Time(s)
            | Value::Timestamp(s)
            | Value::TimestampTz(s)
            | Value::Interval(s)
            | Value::Uuid(s)
            | Value::Json(s)
            | Value::Other(s) => Some(s.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_adjacently_tagged_with_strings_for_numbers() {
        let row = vec![
            Value::Null,
            Value::int(i64::MAX),
            Value::Decimal("12345678901234567890.123".into()),
            Value::float(f64::NAN),
            Value::float(0.1),
            Value::bytes(&[0, 255, 16]),
            Value::Array(vec![Value::Bool(true)]),
        ];
        let json = serde_json::to_value(&row).expect("serializes");
        assert_eq!(json[0], serde_json::json!({ "kind": "null" }));
        assert_eq!(
            json[1],
            serde_json::json!({ "kind": "int", "value": "9223372036854775807" })
        );
        assert_eq!(json[2]["value"], "12345678901234567890.123");
        assert_eq!(json[3]["value"], "NaN");
        assert_eq!(json[4]["value"], "0.1");
        assert_eq!(json[5]["value"], "00ff10");
        assert_eq!(
            json[6],
            serde_json::json!({ "kind": "array", "value": [{ "kind": "bool", "value": true }] })
        );
        let back: Vec<Value> = serde_json::from_value(json).expect("deserializes");
        assert_eq!(back[1], row[1]);
    }

    #[test]
    fn formats_special_floats() {
        assert_eq!(format_float(f64::INFINITY), "Infinity");
        assert_eq!(format_float(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(format_float(1e300), "1e300");
        assert_eq!(format_float(-2.5), "-2.5");
        assert_eq!(format_float(3.0), "3");
        assert_eq!(format_float(1e-7), "1e-7");
    }
}
