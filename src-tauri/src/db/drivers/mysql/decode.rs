//! MySQL / MariaDB column metadata and values → yadbe's `Value` model, losslessly.
//!
//! User statements and yadbe's own statements without parameters use the text protocol:
//! every value arrives as the server's text, kept as is for numbers, decimals and dates
//! (zero dates and `TIME` beyond 24 hours included). Bound statements use the binary
//! protocol: integers, floats, dates and times arrive typed and are written back in the
//! text protocol's form, with the column's fractional digits.

use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::{Column, Value as MyValue};

use crate::db::value::{ColumnMeta, Value, ValueKind, hex};

/// The `binary` character set: the column holds bytes, not text.
const BINARY_CHARSET: u16 = 63;

/// How the cells of one column are decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Decoder {
    /// `TINYINT(1)` / `BOOL` and `BIT(1)`: `0` / `1` as booleans, anything else as an
    /// integer.
    Bool {
        bit: bool,
    },
    Int,
    /// `BIT(n)`: big-endian bytes, as an unsigned integer.
    Bit,
    Decimal,
    Float,
    Double,
    Date,
    Time {
        decimals: u8,
    },
    Timestamp {
        decimals: u8,
    },
    Year,
    Text,
    Bytes,
    Json,
    /// Spatial types, `VECTOR` and anything unknown: shown as hexadecimal, read-only.
    Other,
}

fn binary(column: &Column) -> bool {
    column.character_set() == BINARY_CHARSET
}

fn unsigned(column: &Column) -> &'static str {
    if column.flags().contains(ColumnFlags::UNSIGNED_FLAG) {
        " unsigned"
    } else {
        ""
    }
}

/// Fractional-second digits of a temporal column (0 to 6; the server sends 31 for "not
/// fixed", e.g. an expression).
fn fsp(column: &Column) -> u8 {
    match column.decimals() {
        d @ 0..=6 => d,
        _ => 0,
    }
}

fn with_fsp(name: &str, decimals: u8) -> String {
    if decimals > 0 {
        format!("{name}({decimals})")
    } else {
        name.to_owned()
    }
}

/// The type name and decoder of a result column.
pub(super) fn column(column: &Column) -> (ColumnMeta, Decoder) {
    use ColumnType::*;
    let flags = column.flags();
    let (type_name, kind, decoder) = match column.column_type() {
        MYSQL_TYPE_TINY if column.column_length() == 1 => (
            format!("tinyint(1){}", unsigned(column)),
            ValueKind::Bool,
            Decoder::Bool { bit: false },
        ),
        MYSQL_TYPE_TINY => (
            format!("tinyint{}", unsigned(column)),
            ValueKind::Int,
            Decoder::Int,
        ),
        MYSQL_TYPE_SHORT => (
            format!("smallint{}", unsigned(column)),
            ValueKind::Int,
            Decoder::Int,
        ),
        MYSQL_TYPE_INT24 => (
            format!("mediumint{}", unsigned(column)),
            ValueKind::Int,
            Decoder::Int,
        ),
        MYSQL_TYPE_LONG => (
            format!("int{}", unsigned(column)),
            ValueKind::Int,
            Decoder::Int,
        ),
        MYSQL_TYPE_LONGLONG => (
            format!("bigint{}", unsigned(column)),
            ValueKind::Int,
            Decoder::Int,
        ),
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => {
            // The display length counts the sign (signed) and the point (scale > 0).
            let scale = u32::from(column.decimals());
            let length = column.column_length();
            let precision = length
                .saturating_sub(u32::from(scale > 0))
                .saturating_sub(u32::from(!flags.contains(ColumnFlags::UNSIGNED_FLAG)));
            (
                format!("decimal({precision},{scale}){}", unsigned(column)),
                ValueKind::Decimal,
                Decoder::Decimal,
            )
        }
        MYSQL_TYPE_FLOAT => (
            format!("float{}", unsigned(column)),
            ValueKind::Float,
            Decoder::Float,
        ),
        MYSQL_TYPE_DOUBLE => (
            format!("double{}", unsigned(column)),
            ValueKind::Float,
            Decoder::Double,
        ),
        MYSQL_TYPE_NULL => ("null".to_owned(), ValueKind::Text, Decoder::Text),
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => ("date".to_owned(), ValueKind::Date, Decoder::Date),
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => (
            with_fsp("time", fsp(column)),
            ValueKind::Time,
            Decoder::Time {
                decimals: fsp(column),
            },
        ),
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => (
            with_fsp("datetime", fsp(column)),
            ValueKind::Timestamp,
            Decoder::Timestamp {
                decimals: fsp(column),
            },
        ),
        // Shown in the session time zone, like every MySQL client: a wall-clock value.
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => (
            with_fsp("timestamp", fsp(column)),
            ValueKind::Timestamp,
            Decoder::Timestamp {
                decimals: fsp(column),
            },
        ),
        MYSQL_TYPE_YEAR => ("year".to_owned(), ValueKind::Int, Decoder::Year),
        MYSQL_TYPE_BIT if column.column_length() == 1 => (
            "bit(1)".to_owned(),
            ValueKind::Bool,
            Decoder::Bool { bit: true },
        ),
        MYSQL_TYPE_BIT => (
            format!("bit({})", column.column_length()),
            ValueKind::Int,
            Decoder::Bit,
        ),
        MYSQL_TYPE_JSON => ("json".to_owned(), ValueKind::Json, Decoder::Json),
        MYSQL_TYPE_ENUM => ("enum".to_owned(), ValueKind::Text, Decoder::Text),
        MYSQL_TYPE_SET => ("set".to_owned(), ValueKind::Text, Decoder::Text),
        MYSQL_TYPE_STRING if flags.contains(ColumnFlags::ENUM_FLAG) => {
            ("enum".to_owned(), ValueKind::Text, Decoder::Text)
        }
        MYSQL_TYPE_STRING if flags.contains(ColumnFlags::SET_FLAG) => {
            ("set".to_owned(), ValueKind::Text, Decoder::Text)
        }
        MYSQL_TYPE_STRING if binary(column) => {
            ("binary".to_owned(), ValueKind::Bytes, Decoder::Bytes)
        }
        MYSQL_TYPE_STRING => ("char".to_owned(), ValueKind::Text, Decoder::Text),
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING if binary(column) => {
            ("varbinary".to_owned(), ValueKind::Bytes, Decoder::Bytes)
        }
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => {
            ("varchar".to_owned(), ValueKind::Text, Decoder::Text)
        }
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB
            if binary(column) =>
        {
            ("blob".to_owned(), ValueKind::Bytes, Decoder::Bytes)
        }
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            ("text".to_owned(), ValueKind::Text, Decoder::Text)
        }
        MYSQL_TYPE_GEOMETRY => ("geometry".to_owned(), ValueKind::Other, Decoder::Other),
        MYSQL_TYPE_VECTOR => ("vector".to_owned(), ValueKind::Other, Decoder::Other),
        _ => (String::new(), ValueKind::Other, Decoder::Other),
    };
    (
        ColumnMeta {
            name: column.name_str().into_owned(),
            type_name,
            kind,
        },
        decoder,
    )
}

/// The shortest text that reads back as the same `f32` (`FLOAT` columns).
fn format_f32(value: f32) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        let text = format!("{value:?}");
        match text.strip_suffix(".0") {
            Some(integral) => integral.to_owned(),
            None => text,
        }
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `HH:MM:SS[.ffffff]` (or `-HHH:…`) with the column's fractional digits.
fn time_text(negative: bool, days: u32, h: u8, m: u8, s: u8, micros: u32, decimals: u8) -> String {
    let hours = u64::from(days) * 24 + u64::from(h);
    let mut out = format!(
        "{}{hours:02}:{m:02}:{s:02}",
        if negative { "-" } else { "" }
    );
    push_fraction(&mut out, micros, decimals);
    out
}

fn push_fraction(out: &mut String, micros: u32, decimals: u8) {
    if decimals > 0 {
        let digits = format!("{micros:06}");
        out.push('.');
        out.push_str(&digits[..usize::from(decimals.min(6))]);
    }
}

fn date_text(y: u16, mo: u8, d: u8) -> String {
    format!("{y:04}-{mo:02}-{d:02}")
}

/// Big-endian bytes as an unsigned integer (`BIT` columns, at most 64 bits).
fn bits(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte))
}

/// Decodes one cell, whichever protocol it came from.
pub(super) fn decode(value: MyValue, decoder: Decoder) -> Value {
    match value {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(bytes) => from_bytes(&bytes, decoder),
        MyValue::Int(n) => from_int(i128::from(n), decoder),
        MyValue::UInt(n) => from_int(i128::from(n), decoder),
        MyValue::Float(f) => Value::Float(format_f32(f)),
        MyValue::Double(f) => match decoder {
            // A `FLOAT` column read through an expression the server widened.
            Decoder::Float => Value::Float(format_f32(f as f32)),
            _ => Value::float(f),
        },
        MyValue::Date(y, mo, d, h, mi, s, micros) => match decoder {
            Decoder::Date => Value::Date(date_text(y, mo, d)),
            Decoder::Timestamp { decimals } => {
                let mut out = format!("{} {h:02}:{mi:02}:{s:02}", date_text(y, mo, d));
                push_fraction(&mut out, micros, decimals);
                Value::Timestamp(out)
            }
            _ => {
                let mut out = format!("{} {h:02}:{mi:02}:{s:02}", date_text(y, mo, d));
                push_fraction(&mut out, micros, if micros > 0 { 6 } else { 0 });
                Value::Other(out)
            }
        },
        MyValue::Time(negative, days, h, m, s, micros) => {
            let decimals = match decoder {
                Decoder::Time { decimals } => decimals,
                _ if micros > 0 => 6,
                _ => 0,
            };
            Value::Time(time_text(negative, days, h, m, s, micros, decimals))
        }
    }
}

fn from_int(n: i128, decoder: Decoder) -> Value {
    match decoder {
        Decoder::Bool { .. } if n == 0 || n == 1 => Value::Bool(n == 1),
        _ => Value::Int(n.to_string()),
    }
}

fn from_bytes(bytes: &[u8], decoder: Decoder) -> Value {
    match decoder {
        Decoder::Bool { bit: true } => {
            let n = bits(bytes);
            if n <= 1 {
                Value::Bool(n == 1)
            } else {
                Value::Int(n.to_string())
            }
        }
        Decoder::Bool { bit: false } => match bytes {
            b"0" => Value::Bool(false),
            b"1" => Value::Bool(true),
            other => Value::Int(text(other)),
        },
        Decoder::Int => Value::Int(text(bytes)),
        Decoder::Bit => Value::Int(bits(bytes).to_string()),
        // `YEAR` arrives as `0000` for the zero year.
        Decoder::Year => {
            let digits = text(bytes);
            let trimmed = digits.trim_start_matches('0');
            Value::Int(if trimmed.is_empty() { "0" } else { trimmed }.to_owned())
        }
        Decoder::Decimal => Value::Decimal(text(bytes)),
        Decoder::Float => {
            let raw = text(bytes);
            match raw.parse::<f32>() {
                Ok(f) => Value::Float(format_f32(f)),
                Err(_) => Value::Float(raw),
            }
        }
        Decoder::Double => {
            let raw = text(bytes);
            match raw.parse::<f64>() {
                Ok(f) => Value::float(f),
                Err(_) => Value::Float(raw),
            }
        }
        Decoder::Date => Value::Date(text(bytes)),
        Decoder::Time { .. } => Value::Time(text(bytes)),
        Decoder::Timestamp { .. } => Value::Timestamp(text(bytes)),
        Decoder::Text => Value::Text(text(bytes)),
        Decoder::Json => Value::Json(text(bytes)),
        Decoder::Bytes | Decoder::Other => match decoder {
            Decoder::Bytes => Value::bytes(bytes),
            _ => Value::Other(hex(bytes)),
        },
    }
}

/// The kind of a catalog column type (`information_schema.COLUMNS`): `DATA_TYPE` and the
/// full `COLUMN_TYPE` (`tinyint(1)`, `bit(1)`, `int unsigned`).
pub(super) fn kind_of_type(data_type: &str, column_type: &str) -> ValueKind {
    let column_type = column_type.to_ascii_lowercase();
    match data_type.to_ascii_lowercase().as_str() {
        "tinyint" if column_type.starts_with("tinyint(1)") => ValueKind::Bool,
        "bit" if column_type == "bit(1)" => ValueKind::Bool,
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "bit" | "year" => {
            ValueKind::Int
        }
        "decimal" | "numeric" | "dec" | "fixed" => ValueKind::Decimal,
        "float" | "double" | "real" | "double precision" => ValueKind::Float,
        "date" => ValueKind::Date,
        "time" => ValueKind::Time,
        "datetime" | "timestamp" => ValueKind::Timestamp,
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set" => {
            ValueKind::Text
        }
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            ValueKind::Bytes
        }
        "json" => ValueKind::Json,
        // MariaDB's UUID / INET types read as text.
        "uuid" => ValueKind::Uuid,
        "inet4" | "inet6" => ValueKind::Text,
        _ => ValueKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_protocol_values_stay_exact() {
        assert_eq!(
            from_bytes(b"18446744073709551615", Decoder::Int),
            Value::Int("18446744073709551615".into())
        );
        assert_eq!(
            from_bytes(b"12345678901234567890.0001", Decoder::Decimal),
            Value::Decimal("12345678901234567890.0001".into())
        );
        assert_eq!(
            from_bytes(b"0.1", Decoder::Float),
            Value::Float("0.1".into())
        );
        assert_eq!(
            from_bytes(b"3.4028234663852886e38", Decoder::Double),
            Value::Float("3.4028234663852886e38".into())
        );
        assert_eq!(
            from_bytes(b"0000-00-00 00:00:00", Decoder::Timestamp { decimals: 0 }),
            Value::Timestamp("0000-00-00 00:00:00".into())
        );
        assert_eq!(
            from_bytes(b"-838:59:59.000000", Decoder::Time { decimals: 6 }),
            Value::Time("-838:59:59.000000".into())
        );
        assert_eq!(from_bytes(b"0000", Decoder::Year), Value::Int("0".into()));
        assert_eq!(
            from_bytes(b"1", Decoder::Bool { bit: false }),
            Value::Bool(true)
        );
        assert_eq!(
            from_bytes(b"7", Decoder::Bool { bit: false }),
            Value::Int("7".into())
        );
        assert_eq!(
            from_bytes(&[0x01], Decoder::Bool { bit: true }),
            Value::Bool(true)
        );
        assert_eq!(
            from_bytes(&[0x01, 0x02], Decoder::Bit),
            Value::Int("258".into())
        );
        assert_eq!(
            from_bytes(&[0, 255], Decoder::Bytes),
            Value::Bytes("00ff".into())
        );
    }

    #[test]
    fn binary_protocol_values_match_the_text_forms() {
        assert_eq!(
            decode(
                MyValue::Date(2025, 2, 28, 12, 34, 56, 789_000),
                Decoder::Timestamp { decimals: 3 }
            ),
            Value::Timestamp("2025-02-28 12:34:56.789".into())
        );
        assert_eq!(
            decode(MyValue::Date(0, 0, 0, 0, 0, 0, 0), Decoder::Date),
            Value::Date("0000-00-00".into())
        );
        assert_eq!(
            decode(
                MyValue::Time(true, 34, 22, 59, 59, 0),
                Decoder::Time { decimals: 0 }
            ),
            Value::Time("-838:59:59".into())
        );
        assert_eq!(
            decode(MyValue::UInt(u64::MAX), Decoder::Int),
            Value::Int("18446744073709551615".into())
        );
        assert_eq!(
            decode(MyValue::Float(0.1), Decoder::Float),
            Value::Float("0.1".into())
        );
        assert_eq!(
            decode(MyValue::Int(0), Decoder::Bool { bit: false }),
            Value::Bool(false)
        );
    }

    #[test]
    fn catalog_types_map_to_kinds() {
        assert_eq!(kind_of_type("tinyint", "tinyint(1)"), ValueKind::Bool);
        assert_eq!(
            kind_of_type("tinyint", "tinyint(4) unsigned"),
            ValueKind::Int
        );
        assert_eq!(kind_of_type("bit", "bit(8)"), ValueKind::Int);
        assert_eq!(kind_of_type("decimal", "decimal(10,2)"), ValueKind::Decimal);
        assert_eq!(kind_of_type("geometry", "point"), ValueKind::Other);
        assert_eq!(kind_of_type("longblob", "longblob"), ValueKind::Bytes);
    }
}
