//! Binary PostgreSQL values → the common `Value` model, without precision loss.

use std::error::Error;

use postgres_protocol::types as proto;
use tokio_postgres::types::{FromSql, Kind, Type};

use crate::db::value::{ColumnMeta, Value, ValueKind, format_float, hex};

type BoxError = Box<dyn Error + Sync + Send>;

/// The raw bytes of any column, decoded by [`decode`].
pub struct Raw<'a>(pub &'a [u8]);

impl<'a> FromSql<'a> for Raw<'a> {
    fn from_sql(_ty: &Type, raw: &'a [u8]) -> Result<Self, BoxError> {
        Ok(Raw(raw))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

pub fn column_meta(name: &str, ty: &Type) -> ColumnMeta {
    ColumnMeta {
        name: name.to_owned(),
        type_name: ty.name().to_owned(),
        kind: kind_of(ty),
    }
}

pub fn kind_of(ty: &Type) -> ValueKind {
    match ty.kind() {
        Kind::Array(_) => return ValueKind::Array,
        Kind::Enum(_) => return ValueKind::Text,
        Kind::Domain(base) => return kind_of(base),
        _ => {}
    }
    match *ty {
        Type::BOOL => ValueKind::Bool,
        Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => ValueKind::Int,
        Type::NUMERIC | Type::MONEY => ValueKind::Decimal,
        Type::FLOAT4 | Type::FLOAT8 => ValueKind::Float,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::CHAR | Type::UNKNOWN => {
            ValueKind::Text
        }
        Type::BYTEA => ValueKind::Bytes,
        Type::DATE => ValueKind::Date,
        Type::TIME | Type::TIMETZ => ValueKind::Time,
        Type::TIMESTAMP => ValueKind::Timestamp,
        Type::TIMESTAMPTZ => ValueKind::TimestampTz,
        Type::INTERVAL => ValueKind::Interval,
        Type::UUID => ValueKind::Uuid,
        Type::JSON | Type::JSONB => ValueKind::Json,
        _ => ValueKind::Other,
    }
}

fn utf8(raw: &[u8]) -> Result<String, BoxError> {
    Ok(std::str::from_utf8(raw)?.to_owned())
}

/// Decodes one non-null value of type `ty`.
pub fn decode(ty: &Type, raw: &[u8]) -> Result<Value, BoxError> {
    match ty.kind() {
        Kind::Array(element) => return decode_array(element, raw),
        Kind::Enum(_) => return Ok(Value::Text(utf8(raw)?)),
        Kind::Domain(base) => return decode(base, raw),
        _ => {}
    }
    Ok(match *ty {
        Type::BOOL => Value::Bool(proto::bool_from_sql(raw)?),
        Type::INT2 => Value::int(proto::int2_from_sql(raw)?),
        Type::INT4 => Value::int(proto::int4_from_sql(raw)?),
        Type::INT8 => Value::int(proto::int8_from_sql(raw)?),
        Type::OID => Value::int(proto::oid_from_sql(raw)?),
        Type::FLOAT4 => Value::Float(format_float(f64::from(proto::float4_from_sql(raw)?))),
        Type::FLOAT8 => Value::float(proto::float8_from_sql(raw)?),
        Type::NUMERIC => Value::Decimal(numeric(raw)?),
        Type::MONEY => Value::Decimal(money(proto::int8_from_sql(raw)?)),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            Value::Text(utf8(raw)?)
        }
        Type::CHAR => Value::Text(String::from_utf8_lossy(raw).into_owned()),
        Type::BYTEA => Value::bytes(raw),
        Type::DATE => Value::Date(date(proto::date_from_sql(raw)?)),
        Type::TIME => Value::Time(time_of_day(proto::time_from_sql(raw)?)),
        Type::TIMETZ => Value::Time(time_tz(raw)?),
        Type::TIMESTAMP => Value::Timestamp(timestamp(proto::timestamp_from_sql(raw)?, false)),
        Type::TIMESTAMPTZ => Value::TimestampTz(timestamp(proto::timestamp_from_sql(raw)?, true)),
        Type::INTERVAL => Value::Interval(interval(raw)?),
        Type::UUID => Value::Uuid(uuid(proto::uuid_from_sql(raw)?)),
        Type::JSON => Value::Json(utf8(raw)?),
        // jsonb: a version byte (1), then the text.
        Type::JSONB => Value::Json(utf8(raw.get(1..).unwrap_or_default())?),
        Type::INET | Type::CIDR => Value::Other(inet(raw)?),
        Type::XML => Value::Other(utf8(raw)?),
        _ => other(raw),
    })
}

/// A type yadbe does not decode: its bytes as text when they are printable (most extension
/// types send text), as hexadecimal otherwise.
fn other(raw: &[u8]) -> Value {
    match std::str::from_utf8(raw) {
        Ok(text) if !text.chars().any(|c| c.is_control() && !c.is_whitespace()) => {
            Value::Other(text.to_owned())
        }
        _ => Value::Other(format!("\\x{}", hex(raw))),
    }
}

fn decode_array(element: &Type, raw: &[u8]) -> Result<Value, BoxError> {
    use fallible_iterator::FallibleIterator as _;
    use postgres_protocol::types::ArrayDimension;

    let array = proto::array_from_sql(raw)?;
    let dims: Vec<ArrayDimension> = array.dimensions().collect()?;
    let mut flat = Vec::new();
    let mut values = array.values();
    while let Some(value) = values.next()? {
        flat.push(match value {
            None => Value::Null,
            Some(bytes) => decode(element, bytes)?,
        });
    }
    // Nest the flat values along the dimensions, innermost last.
    let mut items = flat;
    for dim in dims.iter().skip(1).rev() {
        let len = usize::try_from(dim.len).unwrap_or(0).max(1);
        let mut grouped = Vec::with_capacity(items.len() / len);
        let mut iter = items.into_iter().peekable();
        while iter.peek().is_some() {
            grouped.push(Value::Array(iter.by_ref().take(len).collect()));
        }
        items = grouped;
    }
    Ok(Value::Array(items))
}

/// Binary `numeric`: digits in base 10 000, a weight (position of the first digit) and a
/// display scale.
pub fn numeric(raw: &[u8]) -> Result<String, BoxError> {
    let header = |i: usize| -> Result<u16, BoxError> {
        let bytes = raw.get(i..i + 2).ok_or("numeric: truncated")?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    };
    let ndigits = usize::from(header(0)?);
    #[allow(clippy::cast_possible_wrap)]
    let weight = header(2)? as i16;
    let sign = header(4)?;
    let dscale = usize::from(header(6)?);
    match sign {
        0xC000 => return Ok("NaN".to_owned()),
        0xD000 => return Ok("Infinity".to_owned()),
        0xF000 => return Ok("-Infinity".to_owned()),
        _ => {}
    }
    let mut digits = Vec::with_capacity(ndigits);
    for i in 0..ndigits {
        digits.push(header(8 + 2 * i)?);
    }
    let digit = |index: i32| -> u16 {
        usize::try_from(index)
            .ok()
            .and_then(|i| digits.get(i).copied())
            .unwrap_or(0)
    };
    let weight = i32::from(weight);
    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    if weight < 0 {
        out.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 {
                out.push_str(&digit(i).to_string());
            } else {
                out.push_str(&format!("{:04}", digit(i)));
            }
        }
    }
    if dscale > 0 {
        let mut fraction = String::with_capacity(dscale + 4);
        let mut index = weight + 1;
        while fraction.len() < dscale {
            fraction.push_str(&format!("{:04}", digit(index)));
            index += 1;
        }
        fraction.truncate(dscale);
        out.push('.');
        out.push_str(&fraction);
    }
    Ok(out)
}

fn money(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (H. Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

/// PostgreSQL's epoch (2000-01-01) in days since 1970-01-01.
const PG_EPOCH_DAYS: i64 = 10_957;
const MICROS_PER_DAY: i64 = 86_400_000_000;

fn format_date(days_since_pg_epoch: i64) -> String {
    let (year, month, day) = civil_from_days(days_since_pg_epoch + PG_EPOCH_DAYS);
    if year <= 0 {
        format!("{:04}-{month:02}-{day:02} BC", 1 - year)
    } else {
        format!("{year:04}-{month:02}-{day:02}")
    }
}

pub fn date(days: i32) -> String {
    match days {
        i32::MAX => "infinity".to_owned(),
        i32::MIN => "-infinity".to_owned(),
        days => format_date(i64::from(days)),
    }
}

/// `HH:MM:SS[.ffffff]`, trailing zeros of the fraction removed (PostgreSQL's style).
pub fn time_of_day(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let frac = micros.rem_euclid(1_000_000);
    let mut out = format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    );
    if frac != 0 {
        let fraction = format!("{frac:06}");
        out.push('.');
        out.push_str(fraction.trim_end_matches('0'));
    }
    out
}

fn offset(seconds_east: i32) -> String {
    let sign = if seconds_east < 0 { '-' } else { '+' };
    let abs = seconds_east.unsigned_abs();
    let (h, m, s) = (abs / 3600, (abs / 60) % 60, abs % 60);
    match (m, s) {
        (0, 0) => format!("{sign}{h:02}"),
        (_, 0) => format!("{sign}{h:02}:{m:02}"),
        _ => format!("{sign}{h:02}:{m:02}:{s:02}"),
    }
}

fn time_tz(raw: &[u8]) -> Result<String, BoxError> {
    let bytes: [u8; 12] = raw.try_into().map_err(|_| "timetz: bad length")?;
    let micros = i64::from_be_bytes(bytes[..8].try_into()?);
    // Stored as seconds west of UTC.
    let zone = i32::from_be_bytes(bytes[8..].try_into()?);
    Ok(format!("{}{}", time_of_day(micros), offset(-zone)))
}

pub fn timestamp(micros: i64, utc: bool) -> String {
    match micros {
        i64::MAX => return "infinity".to_owned(),
        i64::MIN => return "-infinity".to_owned(),
        _ => {}
    }
    let days = micros.div_euclid(MICROS_PER_DAY);
    let time = time_of_day(micros.rem_euclid(MICROS_PER_DAY));
    let date = format_date(days);
    // The era suffix goes after the time, like PostgreSQL.
    let (date, era) = match date.strip_suffix(" BC") {
        Some(d) => (d.to_owned(), " BC"),
        None => (date, ""),
    };
    let zone = if utc { "+00" } else { "" };
    format!("{date} {time}{zone}{era}")
}

fn plural(n: i64, unit: &str, units: &str) -> String {
    // PostgreSQL's rule: singular for exactly 1 (`-1 days`).
    format!("{n} {}", if n == 1 { unit } else { units })
}

/// PostgreSQL's default interval style: `1 year 2 mons 3 days 04:05:06`.
pub fn interval(raw: &[u8]) -> Result<String, BoxError> {
    let bytes: [u8; 16] = raw.try_into().map_err(|_| "interval: bad length")?;
    let micros = i64::from_be_bytes(bytes[..8].try_into()?);
    let days = i64::from(i32::from_be_bytes(bytes[8..12].try_into()?));
    let months = i64::from(i32::from_be_bytes(bytes[12..].try_into()?));
    let mut parts = Vec::new();
    let (years, mons) = (months / 12, months % 12);
    if years != 0 {
        parts.push(plural(years, "year", "years"));
    }
    if mons != 0 {
        parts.push(plural(mons, "mon", "mons"));
    }
    if days != 0 {
        parts.push(plural(days, "day", "days"));
    }
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        let abs = micros.unsigned_abs();
        let secs = abs / 1_000_000;
        let frac = abs % 1_000_000;
        let mut time = format!(
            "{sign}{:02}:{:02}:{:02}",
            secs / 3600,
            (secs / 60) % 60,
            secs % 60
        );
        if frac != 0 {
            time.push('.');
            time.push_str(format!("{frac:06}").trim_end_matches('0'));
        }
        parts.push(time);
    }
    Ok(parts.join(" "))
}

fn uuid(bytes: [u8; 16]) -> String {
    let h = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

fn inet(raw: &[u8]) -> Result<String, BoxError> {
    let value = proto::inet_from_sql(raw)?;
    let full = if value.addr().is_ipv4() { 32 } else { 128 };
    Ok(if value.netmask() == full {
        value.addr().to_string()
    } else {
        format!("{}/{}", value.addr(), value.netmask())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numeric_bytes(weight: i16, sign: u16, dscale: u16, digits: &[u16]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(u16::try_from(digits.len()).expect("len").to_be_bytes());
        out.extend(weight.to_be_bytes());
        out.extend(sign.to_be_bytes());
        out.extend(dscale.to_be_bytes());
        for d in digits {
            out.extend(d.to_be_bytes());
        }
        out
    }

    #[test]
    fn decodes_numeric() {
        let n = |w, s, d, digits: &[u16]| numeric(&numeric_bytes(w, s, d, digits)).expect("ok");
        assert_eq!(n(0, 0, 0, &[]), "0");
        assert_eq!(n(0, 0, 2, &[129, 9000]), "129.90");
        assert_eq!(n(1, 0x4000, 0, &[1, 0]), "-10000");
        assert_eq!(n(-1, 0, 4, &[5]), "0.0005");
        assert_eq!(n(-2, 0, 6, &[1200]), "0.000012");
        assert_eq!(
            n(4, 0, 3, &[1234, 5678, 9012, 3456, 7890, 1230]),
            "12345678901234567890.123"
        );
        assert_eq!(n(0, 0xC000, 0, &[]), "NaN");
    }

    #[test]
    fn formats_dates_and_times() {
        assert_eq!(date(0), "2000-01-01");
        assert_eq!(date(-1), "1999-12-31");
        assert_eq!(date(9_190), "2025-02-28");
        assert_eq!(date(i32::MAX), "infinity");
        assert_eq!(date(-730_119), "0001-01-01");
        assert_eq!(date(-730_120), "0001-12-31 BC");
        assert_eq!(time_of_day(0), "00:00:00");
        assert_eq!(time_of_day(45_296_500_000), "12:34:56.5");
        assert_eq!(timestamp(0, false), "2000-01-01 00:00:00");
        assert_eq!(timestamp(-1, true), "1999-12-31 23:59:59.999999+00");
        assert_eq!(timestamp(i64::MIN, false), "-infinity");
        assert_eq!(offset(19_800), "+05:30");
        assert_eq!(offset(-3600), "-01");
    }

    #[test]
    fn formats_intervals() {
        let bytes = |micros: i64, days: i32, months: i32| {
            let mut v = micros.to_be_bytes().to_vec();
            v.extend(days.to_be_bytes());
            v.extend(months.to_be_bytes());
            v
        };
        assert_eq!(interval(&bytes(0, 0, 0)).expect("ok"), "00:00:00");
        assert_eq!(
            interval(&bytes(14_706_000_000, 3, 14)).expect("ok"),
            "1 year 2 mons 3 days 04:05:06"
        );
        assert_eq!(
            interval(&bytes(-3_600_000_000, 1, 0)).expect("ok"),
            "1 day -01:00:00"
        );
        assert_eq!(interval(&bytes(0, -2, -1)).expect("ok"), "-1 mons -2 days");
    }

    #[test]
    fn other_types_fall_back_to_text_or_hex() {
        assert_eq!(other(b"POINT(1 2)"), Value::Other("POINT(1 2)".into()));
        assert_eq!(other(&[1, 2, 0xff]), Value::Other("\\x0102ff".into()));
    }
}
