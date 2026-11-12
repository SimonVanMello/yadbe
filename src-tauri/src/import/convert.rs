//! Text from a file → the value a column stores. Nothing is coerced silently: a value that
//! is not exactly of the column's type (a decimal for an integer column, a date with a time,
//! more decimals than the column keeps) is an issue, never a guess.

use super::json::is_valid_json;
use super::model::{ImportConvertOptions, ImportDecimalSeparator, ImportIssueKind};
use crate::db::meta::ColumnInfo;
use crate::db::value::{Value, ValueKind};
use crate::export::model::BinaryEncoding;

/// Converts the cells of one column.
#[derive(Debug, Clone)]
pub struct Converter {
    kind: ValueKind,
    nullable: bool,
    int_bounds: Option<(i128, i128)>,
    decimal: Option<(usize, usize)>,
    max_chars: Option<usize>,
    decimal_comma: bool,
    binary: BinaryEncoding,
}

/// `(precision, scale)` of `numeric(10,2)` / `decimal(18)`.
fn decimal_spec(type_name: &str) -> Option<(usize, usize)> {
    let open = type_name.find('(')?;
    let close = type_name[open..].find(')')? + open;
    let base = type_name[..open].trim();
    if !matches!(base, "numeric" | "decimal" | "dec" | "number") {
        return None;
    }
    let mut parts = type_name[open + 1..close].split(',');
    let precision = parts.next()?.trim().parse().ok()?;
    let scale = parts.next().map_or(Some(0), |s| s.trim().parse().ok())?;
    Some((precision, scale))
}

/// The length of `varchar(255)`, `character varying(20)`, `nchar(5)`.
fn max_chars(type_name: &str) -> Option<usize> {
    let open = type_name.find('(')?;
    let close = type_name[open..].find(')')? + open;
    let base = type_name[..open].trim();
    if !base.contains("char") {
        return None;
    }
    type_name[open + 1..close].trim().parse().ok()
}

/// Bounds common to every engine for the integer family: 64-bit (a smaller type is checked
/// by the server), 16-bit for `smallint`.
fn int_bounds(type_name: &str) -> (i128, i128) {
    let unsigned = type_name.contains("unsigned");
    let base = type_name
        .split(|c: char| c == '(' || c.is_whitespace())
        .next()
        .unwrap_or_default();
    let (low, high) = match base {
        "smallint" | "int2" | "smallserial" | "serial2" => {
            (i128::from(i16::MIN), i128::from(i16::MAX))
        }
        _ => (i128::from(i64::MIN), i128::from(i64::MAX)),
    };
    if unsigned {
        (0, high * 2 + 1)
    } else {
        (low, high)
    }
}

impl Converter {
    pub fn new(column: &ColumnInfo, options: &ImportConvertOptions) -> Self {
        let type_name = column.type_name.to_ascii_lowercase();
        Self {
            kind: column.kind,
            nullable: column.nullable,
            int_bounds: (column.kind == ValueKind::Int).then(|| int_bounds(&type_name)),
            decimal: (column.kind == ValueKind::Decimal)
                .then(|| decimal_spec(&type_name))
                .flatten(),
            max_chars: (column.kind == ValueKind::Text)
                .then(|| max_chars(&type_name))
                .flatten(),
            decimal_comma: options.decimal_separator == ImportDecimalSeparator::Comma,
            binary: options.binary,
        }
    }

    pub fn nullable(&self) -> bool {
        self.nullable
    }

    /// `None` is `NULL`.
    pub fn convert(&self, cell: Option<&str>) -> Result<Value, ImportIssueKind> {
        let Some(text) = cell else {
            return if self.nullable {
                Ok(Value::Null)
            } else {
                Err(ImportIssueKind::NullNotAllowed)
            };
        };
        match self.kind {
            ValueKind::Text => self.text(text),
            ValueKind::Bool => bool_of(text.trim()).map(Value::Bool),
            ValueKind::Int => self.int(text.trim()),
            ValueKind::Decimal => self.decimal(text.trim()),
            ValueKind::Float => self.float(text.trim()),
            ValueKind::Bytes => self.bytes(text.trim()),
            ValueKind::Date => date_of(text.trim()).map(Value::Date),
            ValueKind::Time => time_of(text.trim()).map(Value::Time),
            ValueKind::Timestamp => timestamp_of(text.trim(), false).map(Value::Timestamp),
            ValueKind::TimestampTz => timestamp_of(text.trim(), true).map(Value::TimestampTz),
            ValueKind::Uuid => uuid_of(text.trim()).map(Value::Uuid),
            ValueKind::Json => {
                if is_valid_json(text) {
                    Ok(Value::Json(text.to_owned()))
                } else {
                    Err(ImportIssueKind::InvalidFormat)
                }
            }
            ValueKind::Interval => Ok(Value::Interval(text.trim().to_owned())),
            // Arrays, enums, geometry…: the server reads the text form.
            ValueKind::Array | ValueKind::Other => Ok(Value::Other(text.to_owned())),
        }
    }

    fn text(&self, text: &str) -> Result<Value, ImportIssueKind> {
        match self.max_chars {
            Some(max) if text.chars().count() > max => Err(ImportIssueKind::TooLong),
            _ => Ok(Value::Text(text.to_owned())),
        }
    }

    fn int(&self, text: &str) -> Result<Value, ImportIssueKind> {
        let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ImportIssueKind::InvalidFormat);
        }
        let value: i128 = text.parse().map_err(|_| ImportIssueKind::OutOfRange)?;
        if let Some((low, high)) = self.int_bounds
            && !(low..=high).contains(&value)
        {
            return Err(ImportIssueKind::OutOfRange);
        }
        Ok(Value::Int(value.to_string()))
    }

    /// The number with a dot, or `None` when the text is not written in the chosen
    /// notation.
    fn number_text(&self, text: &str) -> Option<String> {
        let normalized = if self.decimal_comma {
            if text.contains('.') {
                return None;
            }
            text.replace(',', ".")
        } else {
            if text.contains(',') {
                return None;
            }
            text.to_owned()
        };
        let body = normalized.strip_prefix(['+', '-']).unwrap_or(&normalized);
        let (mantissa, exponent) = match body.find(['e', 'E']) {
            Some(at) => (&body[..at], Some(&body[at + 1..])),
            None => (body, None),
        };
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let digits_ok = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
        if (whole.is_empty() && fraction.is_empty())
            || !digits_ok(whole)
            || !digits_ok(fraction)
            || (mantissa.contains('.') && fraction.is_empty() && whole.is_empty())
        {
            return None;
        }
        if let Some(exponent) = exponent {
            let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            if digits.is_empty() || !digits_ok(digits) {
                return None;
            }
        }
        Some(
            normalized
                .strip_prefix('+')
                .unwrap_or(&normalized)
                .to_owned(),
        )
    }

    fn decimal(&self, text: &str) -> Result<Value, ImportIssueKind> {
        let normalized = self
            .number_text(text)
            .ok_or(ImportIssueKind::InvalidFormat)?;
        if let Some((precision, scale)) = self.decimal
            && !normalized.contains(['e', 'E'])
        {
            let body = normalized.strip_prefix('-').unwrap_or(&normalized);
            let (whole, fraction) = body.split_once('.').unwrap_or((body, ""));
            let whole = whole.trim_start_matches('0');
            let fraction = fraction.trim_end_matches('0');
            if fraction.len() > scale {
                return Err(ImportIssueKind::TooManyDecimals);
            }
            if whole.len() + scale > precision {
                return Err(ImportIssueKind::OutOfRange);
            }
        }
        Ok(Value::Decimal(normalized))
    }

    fn float(&self, text: &str) -> Result<Value, ImportIssueKind> {
        let lower = text.to_ascii_lowercase();
        match lower.as_str() {
            "nan" => return Ok(Value::Float("NaN".to_owned())),
            "infinity" | "+infinity" | "inf" | "+inf" => {
                return Ok(Value::Float("Infinity".to_owned()));
            }
            "-infinity" | "-inf" => return Ok(Value::Float("-Infinity".to_owned())),
            _ => {}
        }
        let normalized = self
            .number_text(text)
            .ok_or(ImportIssueKind::InvalidFormat)?;
        match normalized.parse::<f64>() {
            Ok(parsed) if parsed.is_finite() => Ok(Value::Float(normalized)),
            Ok(_) => Err(ImportIssueKind::OutOfRange),
            Err(_) => Err(ImportIssueKind::InvalidFormat),
        }
    }

    fn bytes(&self, text: &str) -> Result<Value, ImportIssueKind> {
        let bytes = match self.binary {
            BinaryEncoding::Hex => {
                let hex = text
                    .strip_prefix("0x")
                    .or_else(|| text.strip_prefix("0X"))
                    .or_else(|| text.strip_prefix("\\x"))
                    .unwrap_or(text);
                unhex(hex)
            }
            BinaryEncoding::Base64 => unbase64(text),
        };
        bytes
            .map(|b| Value::bytes(&b))
            .ok_or(ImportIssueKind::InvalidFormat)
    }
}

fn bool_of(text: &str) -> Result<bool, ImportIssueKind> {
    match text.to_ascii_lowercase().as_str() {
        "true" | "t" | "yes" | "y" | "1" | "on" => Ok(true),
        "false" | "f" | "no" | "n" | "0" | "off" => Ok(false),
        _ => Err(ImportIssueKind::InvalidFormat),
    }
}

fn unhex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) || !hex.is_ascii() {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

fn unbase64(text: &str) -> Option<Vec<u8>> {
    let body = text.trim_end_matches('=');
    if text.len() - body.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut buffer, mut bits) = (0_u32, 0_u32);
    for byte in body.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    if bits >= 6 {
        return None;
    }
    Some(out)
}

fn leap(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// `YYYY-MM-DD`, a real calendar day.
fn date_of(text: &str) -> Result<String, ImportIssueKind> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = text.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(ImportIssueKind::InvalidFormat);
    }
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return Err(ImportIssueKind::InvalidFormat);
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap(year) => 29,
        2 => 28,
        _ => return Err(ImportIssueKind::InvalidFormat),
    };
    if year == 0 || day == 0 || day > days {
        return Err(ImportIssueKind::InvalidFormat);
    }
    Ok(text.to_owned())
}

/// `HH:MM[:SS[.f]]`, normalized to carry seconds.
fn time_of(text: &str) -> Result<String, ImportIssueKind> {
    let (clock, fraction) = match text.split_once('.') {
        Some((clock, fraction)) => (clock, Some(fraction)),
        None => (text, None),
    };
    let mut parts = clock.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else {
        return Err(ImportIssueKind::InvalidFormat);
    };
    let s = parts.next().unwrap_or("00");
    if parts.next().is_some() {
        return Err(ImportIssueKind::InvalidFormat);
    }
    let two = |part: &str, max: u32| {
        part.len() == 2
            && part.bytes().all(|b| b.is_ascii_digit())
            && part.parse::<u32>().is_ok_and(|n| n <= max)
    };
    if !two(h, 23) || !two(m, 59) || !two(s, 59) {
        return Err(ImportIssueKind::InvalidFormat);
    }
    if let Some(fraction) = fraction
        && (fraction.is_empty()
            || fraction.len() > 9
            || !fraction.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(ImportIssueKind::InvalidFormat);
    }
    Ok(match fraction {
        Some(f) => format!("{h}:{m}:{s}.{f}"),
        None => format!("{h}:{m}:{s}"),
    })
}

/// A UTC offset (`Z`, `+02:00`, `-0530`, `+02`) as `+HH:MM`.
fn zone_of(text: &str) -> Result<String, ImportIssueKind> {
    if text == "Z" || text == "z" {
        return Ok("+00:00".to_owned());
    }
    let sign = text.chars().next().filter(|c| matches!(c, '+' | '-'));
    let Some(sign) = sign else {
        return Err(ImportIssueKind::InvalidFormat);
    };
    let rest = &text[1..];
    let (h, m) = match rest.len() {
        2 => (rest, "00"),
        4 => (&rest[..2], &rest[2..]),
        5 if rest.as_bytes()[2] == b':' => (&rest[..2], &rest[3..]),
        _ => return Err(ImportIssueKind::InvalidFormat),
    };
    let valid = |p: &str, max: u32| {
        p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u32>().is_ok_and(|n| n <= max)
    };
    if !valid(h, 14) || !valid(m, 59) {
        return Err(ImportIssueKind::InvalidFormat);
    }
    Ok(format!("{sign}{h}:{m}"))
}

/// `YYYY-MM-DD[ T]HH:MM[:SS[.f]][zone]`; a date alone is midnight.
fn timestamp_of(text: &str, with_zone: bool) -> Result<String, ImportIssueKind> {
    let (date, rest) = match text.find(['T', ' ']) {
        Some(at) => (&text[..at], Some(text[at + 1..].trim())),
        None => (text, None),
    };
    let date = date_of(date)?;
    let Some(rest) = rest else {
        return Ok(format!("{date} 00:00:00"));
    };
    let zone_at = rest.find(['Z', 'z', '+']).or_else(|| {
        // A minus after the time is an offset, never inside the clock.
        rest.find('-')
    });
    let (clock, zone) = match zone_at {
        Some(at) => (rest[..at].trim_end(), Some(rest[at..].trim())),
        None => (rest, None),
    };
    let clock = time_of(clock)?;
    match (zone, with_zone) {
        (Some(_), false) => Err(ImportIssueKind::UnexpectedTimeZone),
        (Some(zone), true) => Ok(format!("{date} {clock}{}", zone_of(zone)?)),
        (None, _) => Ok(format!("{date} {clock}")),
    }
}

fn uuid_of(text: &str) -> Result<String, ImportIssueKind> {
    let body = text
        .strip_prefix('{')
        .and_then(|t| t.strip_suffix('}'))
        .unwrap_or(text);
    let compact: String = body.chars().filter(|c| *c != '-').collect();
    let grouped = body.contains('-');
    if compact.len() != 32
        || !compact.bytes().all(|b| b.is_ascii_hexdigit())
        || (grouped && body.len() != 36)
        || (grouped && [8, 13, 18, 23].iter().any(|&i| body.as_bytes()[i] != b'-'))
    {
        return Err(ImportIssueKind::InvalidFormat);
    }
    let lower = compact.to_ascii_lowercase();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &lower[..8],
        &lower[8..12],
        &lower[12..16],
        &lower[16..20],
        &lower[20..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(type_name: &str, kind: ValueKind, nullable: bool) -> ColumnInfo {
        ColumnInfo {
            name: "c".into(),
            ordinal: 1,
            type_name: type_name.into(),
            kind,
            nullable,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            primary_key: false,
            foreign_key: false,
        }
    }

    fn conv(type_name: &str, kind: ValueKind) -> Converter {
        Converter::new(
            &column(type_name, kind, true),
            &ImportConvertOptions::default(),
        )
    }

    fn ok(c: &Converter, text: &str) -> Value {
        c.convert(Some(text))
            .unwrap_or_else(|e| panic!("{text:?}: {e:?}"))
    }

    #[test]
    fn null_follows_nullability() {
        assert_eq!(conv("int", ValueKind::Int).convert(None), Ok(Value::Null));
        let required = Converter::new(
            &column("int", ValueKind::Int, false),
            &ImportConvertOptions::default(),
        );
        assert_eq!(required.convert(None), Err(ImportIssueKind::NullNotAllowed));
    }

    #[test]
    fn integers_are_exact() {
        let c = conv("integer", ValueKind::Int);
        assert_eq!(ok(&c, " 42 "), Value::int(42));
        assert_eq!(ok(&c, "+007"), Value::int(7));
        assert_eq!(ok(&c, "-9223372036854775808"), Value::int(i64::MIN));
        assert_eq!(c.convert(Some("1.0")), Err(ImportIssueKind::InvalidFormat));
        assert_eq!(c.convert(Some("1e3")), Err(ImportIssueKind::InvalidFormat));
        assert_eq!(c.convert(Some("")), Err(ImportIssueKind::InvalidFormat));
        assert_eq!(
            c.convert(Some("9223372036854775808")),
            Err(ImportIssueKind::OutOfRange)
        );
        let small = conv("smallint", ValueKind::Int);
        assert_eq!(
            small.convert(Some("40000")),
            Err(ImportIssueKind::OutOfRange)
        );
        let unsigned = conv("bigint unsigned", ValueKind::Int);
        assert_eq!(
            ok(&unsigned, "18446744073709551615"),
            Value::int("18446744073709551615")
        );
        assert_eq!(
            unsigned.convert(Some("-1")),
            Err(ImportIssueKind::OutOfRange)
        );
    }

    #[test]
    fn decimals_respect_precision_scale_and_notation() {
        let c = conv("numeric(10,2)", ValueKind::Decimal);
        assert_eq!(ok(&c, "12.50"), Value::Decimal("12.50".into()));
        assert_eq!(ok(&c, "-0.5"), Value::Decimal("-0.5".into()));
        assert_eq!(
            ok(&c, "12.500"),
            Value::Decimal("12.500".into()),
            "zeros past the scale are no loss"
        );
        assert_eq!(
            c.convert(Some("12.505")),
            Err(ImportIssueKind::TooManyDecimals)
        );
        assert_eq!(
            c.convert(Some("123456789.00")),
            Err(ImportIssueKind::OutOfRange)
        );
        assert_eq!(c.convert(Some("1,5")), Err(ImportIssueKind::InvalidFormat));
        assert_eq!(c.convert(Some("abc")), Err(ImportIssueKind::InvalidFormat));
        assert_eq!(c.convert(Some(".")), Err(ImportIssueKind::InvalidFormat));
        let comma = Converter::new(
            &column("decimal(10,2)", ValueKind::Decimal, true),
            &ImportConvertOptions {
                decimal_separator: ImportDecimalSeparator::Comma,
                ..ImportConvertOptions::default()
            },
        );
        assert_eq!(ok(&comma, "1234,5"), Value::Decimal("1234.5".into()));
        assert_eq!(
            comma.convert(Some("1.5")),
            Err(ImportIssueKind::InvalidFormat)
        );
        let any = conv("numeric", ValueKind::Decimal);
        assert_eq!(
            ok(&any, "12345678901234567890.123456789"),
            Value::Decimal("12345678901234567890.123456789".into())
        );
    }

    #[test]
    fn floats_booleans_and_uuids() {
        let f = conv("double precision", ValueKind::Float);
        assert_eq!(ok(&f, "1e-3"), Value::Float("1e-3".into()));
        assert_eq!(ok(&f, "NaN"), Value::Float("NaN".into()));
        assert_eq!(ok(&f, "-inf"), Value::Float("-Infinity".into()));
        assert_eq!(f.convert(Some("1e999")), Err(ImportIssueKind::OutOfRange));
        let b = conv("boolean", ValueKind::Bool);
        for yes in ["true", "T", "YES", "1", "on"] {
            assert_eq!(ok(&b, yes), Value::Bool(true));
        }
        for no in ["false", "f", "No", "0", "OFF"] {
            assert_eq!(ok(&b, no), Value::Bool(false));
        }
        assert_eq!(
            b.convert(Some("maybe")),
            Err(ImportIssueKind::InvalidFormat)
        );
        let u = conv("uuid", ValueKind::Uuid);
        assert_eq!(
            ok(&u, "{123E4567-E89B-12D3-A456-426614174000}"),
            Value::Uuid("123e4567-e89b-12d3-a456-426614174000".into())
        );
        assert_eq!(
            ok(&u, "123e4567e89b12d3a456426614174000"),
            Value::Uuid("123e4567-e89b-12d3-a456-426614174000".into())
        );
        assert_eq!(
            u.convert(Some("123e4567-e89b-12d3-a456-42661417400")),
            Err(ImportIssueKind::InvalidFormat)
        );
    }

    #[test]
    fn dates_and_times_are_strict() {
        let d = conv("date", ValueKind::Date);
        assert_eq!(ok(&d, "2024-02-29"), Value::Date("2024-02-29".into()));
        for bad in [
            "2023-02-29",
            "2024-13-01",
            "31/01/2024",
            "2024-1-5",
            "2024-01-31 10:00:00",
            "",
        ] {
            assert_eq!(
                d.convert(Some(bad)),
                Err(ImportIssueKind::InvalidFormat),
                "{bad}"
            );
        }
        let t = conv("time", ValueKind::Time);
        assert_eq!(ok(&t, "08:30"), Value::Time("08:30:00".into()));
        assert_eq!(
            ok(&t, "23:59:59.123456"),
            Value::Time("23:59:59.123456".into())
        );
        assert_eq!(
            t.convert(Some("24:00:00")),
            Err(ImportIssueKind::InvalidFormat)
        );
        let ts = conv("timestamp", ValueKind::Timestamp);
        assert_eq!(
            ok(&ts, "2024-01-31T10:20:30"),
            Value::Timestamp("2024-01-31 10:20:30".into())
        );
        assert_eq!(
            ok(&ts, "2024-01-31"),
            Value::Timestamp("2024-01-31 00:00:00".into())
        );
        assert_eq!(
            ts.convert(Some("2024-01-31 10:20:30+02:00")),
            Err(ImportIssueKind::UnexpectedTimeZone)
        );
        assert_eq!(
            ts.convert(Some("2024-01-31 10:20:30Z")),
            Err(ImportIssueKind::UnexpectedTimeZone)
        );
        let tz = conv("timestamptz", ValueKind::TimestampTz);
        assert_eq!(
            ok(&tz, "2024-01-31T10:20:30Z"),
            Value::TimestampTz("2024-01-31 10:20:30+00:00".into())
        );
        assert_eq!(
            ok(&tz, "2024-01-31 10:20:30.5-0530"),
            Value::TimestampTz("2024-01-31 10:20:30.5-05:30".into())
        );
        assert_eq!(
            ok(&tz, "2024-01-31 10:20:30"),
            Value::TimestampTz("2024-01-31 10:20:30".into())
        );
        assert_eq!(
            tz.convert(Some("yesterday")),
            Err(ImportIssueKind::InvalidFormat)
        );
    }

    #[test]
    fn text_length_json_and_binary() {
        let t = conv("character varying(3)", ValueKind::Text);
        assert_eq!(ok(&t, "été"), Value::Text("été".into()));
        assert_eq!(t.convert(Some("quatre")), Err(ImportIssueKind::TooLong));
        assert_eq!(
            ok(&conv("text", ValueKind::Text), " keeps  spaces "),
            Value::Text(" keeps  spaces ".into())
        );
        assert_eq!(
            ok(&conv("nvarchar(max)", ValueKind::Text), "x"),
            Value::Text("x".into())
        );
        let j = conv("jsonb", ValueKind::Json);
        assert_eq!(ok(&j, "{\"a\": [1]}"), Value::Json("{\"a\": [1]}".into()));
        assert_eq!(
            j.convert(Some("{a: 1}")),
            Err(ImportIssueKind::InvalidFormat)
        );
        let hex = conv("bytea", ValueKind::Bytes);
        assert_eq!(ok(&hex, "0xDEAD"), Value::bytes(&[0xde, 0xad]));
        assert_eq!(ok(&hex, "\\x00ff"), Value::bytes(&[0, 255]));
        assert_eq!(
            hex.convert(Some("abc")),
            Err(ImportIssueKind::InvalidFormat)
        );
        let b64 = Converter::new(
            &column("blob", ValueKind::Bytes, true),
            &ImportConvertOptions {
                binary: BinaryEncoding::Base64,
                ..ImportConvertOptions::default()
            },
        );
        assert_eq!(ok(&b64, "3q0="), Value::bytes(&[0xde, 0xad]));
        assert_eq!(
            ok(&b64, "3q2+7w=="),
            Value::bytes(&[0xde, 0xad, 0xbe, 0xef])
        );
        assert_eq!(
            b64.convert(Some("3q0*")),
            Err(ImportIssueKind::InvalidFormat)
        );
    }
}
