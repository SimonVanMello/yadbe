//! JSON writer: an array of objects (one per line) or NDJSON.
//!
//! Numbers keep the lossless strings of the value model unless a JSON reader reproduces them
//! exactly: integers within 2^53 and decimals of at most 15 significant digits become JSON
//! numbers, everything else stays a string.

use serde::de::IgnoredAny;

use super::encode::{RowEncoder, binary_text};
use super::model::{BinaryEncoding, JsonLayout, JsonNumbers, JsonOptions};
use crate::db::value::{ColumnMeta, Value};

const MAX_SAFE_INTEGER: u128 = 1 << 53;

pub struct JsonEncoder {
    options: JsonOptions,
    names: Vec<String>,
    rows: u64,
}

impl JsonEncoder {
    pub fn new(options: JsonOptions) -> Self {
        Self {
            options,
            names: Vec::new(),
            rows: 0,
        }
    }
}

fn push_string(out: &mut String, text: &str) {
    // Serializing a string cannot fail.
    out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| String::from("\"\"")));
}

/// `-?digits[.digits][e[+-]digits]`, the JSON number grammar.
pub(super) fn is_json_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = usize::from(bytes.first() == Some(&b'-'));
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int = digits(i);
    if int == 0 || (int > 1 && bytes[i] == b'0') {
        return false;
    }
    i += int;
    if bytes.get(i) == Some(&b'.') {
        let frac = digits(i + 1);
        if frac == 0 {
            return false;
        }
        i += 1 + frac;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == bytes.len()
}

pub(super) fn significant_digits(text: &str) -> usize {
    let mantissa = text.split(['e', 'E']).next().unwrap_or(text);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    digits.trim_matches('0').len()
}

pub(super) fn int_is_exact(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    is_json_number(text)
        && digits
            .parse::<u128>()
            .is_ok_and(|magnitude| magnitude <= MAX_SAFE_INTEGER)
}

/// Removes the whitespace between tokens, keeping what is inside strings.
fn minify_json(text: &str, out: &mut String) {
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
}

pub(super) fn write_value(
    value: &Value,
    numbers: JsonNumbers,
    binary: BinaryEncoding,
    out: &mut String,
) {
    let numeric = numbers == JsonNumbers::Auto;
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(s) if numeric && int_is_exact(s) => out.push_str(s),
        Value::Decimal(s) if numeric && is_json_number(s) && significant_digits(s) <= 15 => {
            out.push_str(s);
        }
        // The shortest round-trip form of a double is exact by construction.
        Value::Float(s) if numeric && is_json_number(s) => out.push_str(s),
        Value::Json(s) if serde_json::from_str::<IgnoredAny>(s).is_ok() => minify_json(s, out),
        Value::Bytes(hex) => push_string(out, &binary_text(hex, binary)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, numbers, binary, out);
            }
            out.push(']');
        }
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
        | Value::Other(s) => push_string(out, s),
    }
}

/// An array cell as text for CSV: the same JSON, numbers as written by the engine.
pub(super) fn write_plain_array(value: &Value, binary: BinaryEncoding, out: &mut String) {
    write_value(value, JsonNumbers::Auto, binary, out);
}

impl RowEncoder for JsonEncoder {
    fn begin(&mut self, columns: &[ColumnMeta], out: &mut Vec<u8>) {
        self.names = columns
            .iter()
            .map(|c| {
                let mut key = String::new();
                push_string(&mut key, &c.name);
                key
            })
            .collect();
        if self.options.layout == JsonLayout::Array {
            out.extend_from_slice(b"[");
        }
    }

    fn row(&mut self, row: &[Value], out: &mut Vec<u8>) {
        let mut line = String::new();
        match self.options.layout {
            JsonLayout::Array => line.push_str(if self.rows == 0 { "\n" } else { ",\n" }),
            JsonLayout::Ndjson => {}
        }
        line.push('{');
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            line.push_str(self.names.get(index).map_or("\"\"", String::as_str));
            line.push(':');
            write_value(value, self.options.numbers, self.options.binary, &mut line);
        }
        line.push('}');
        if self.options.layout == JsonLayout::Ndjson {
            line.push('\n');
        }
        out.extend_from_slice(line.as_bytes());
        self.rows += 1;
    }

    fn end(&mut self, out: &mut Vec<u8>) {
        if self.options.layout == JsonLayout::Array {
            out.extend_from_slice(if self.rows == 0 { b"]\n" } else { b"\n]\n" });
        }
    }
}
