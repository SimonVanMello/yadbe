//! TDS values → the common `Value` model, without precision loss: exact decimals and money,
//! date / time values with all their fractional digits, `datetimeoffset` with its offset.
//! `sql_variant` and CLR types (`hierarchyid`, `geography`…) degrade to text and are
//! flagged `other` (read-only).

use tiberius::numeric::Numeric;
use tiberius::time::{Date, DateTime, DateTime2, DateTimeOffset, SmallDateTime, Time};
use tiberius::{ColumnData, FixedLenType, MetaDataColumn, TypeInfo, VarLenType};

use crate::db::value::{ColumnMeta, Value, ValueKind, format_float};

/// How the cells of one column are decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decoder {
    Plain,
    /// `sql_variant`: the value's own type varies per row; shown as text.
    Variant,
    /// CLR user-defined type: raw bytes only, shown as `0x…`.
    Udt,
}

pub fn column_meta(column: &MetaDataColumn<'_>) -> (ColumnMeta, Decoder) {
    let ty = &column.base.ty;
    let decoder = match ty {
        TypeInfo::Udt(_) => Decoder::Udt,
        TypeInfo::VarLenSized(cx) if cx.r#type() == VarLenType::SSVariant => Decoder::Variant,
        _ => Decoder::Plain,
    };
    (
        ColumnMeta {
            name: column.col_name.to_string(),
            type_name: type_name(ty),
            kind: kind_of(ty),
        },
        decoder,
    )
}

/// `n` characters of an `n`-byte or (`nchar`) `2n`-byte length; `max` for PLP types.
fn length(len: usize, unicode: bool) -> String {
    if len == 0xFFFF {
        "max".to_owned()
    } else if unicode {
        (len / 2).to_string()
    } else {
        len.to_string()
    }
}

/// The type as SQL Server writes it (`nvarchar(200)`, `decimal(10,2)`, `datetime2(7)`).
pub fn type_name(ty: &TypeInfo) -> String {
    match ty {
        TypeInfo::FixedLen(fixed) => match fixed {
            FixedLenType::Null => "null",
            FixedLenType::Int1 => "tinyint",
            FixedLenType::Bit => "bit",
            FixedLenType::Int2 => "smallint",
            FixedLenType::Int4 => "int",
            FixedLenType::Int8 => "bigint",
            FixedLenType::Datetime4 => "smalldatetime",
            FixedLenType::Float4 => "real",
            FixedLenType::Float8 => "float",
            FixedLenType::Money => "money",
            FixedLenType::Money4 => "smallmoney",
            FixedLenType::Datetime => "datetime",
        }
        .to_owned(),
        TypeInfo::VarLenSized(cx) => {
            let len = cx.len();
            match cx.r#type() {
                VarLenType::Intn => match len {
                    1 => "tinyint",
                    2 => "smallint",
                    8 => "bigint",
                    _ => "int",
                }
                .to_owned(),
                VarLenType::Bitn => "bit".to_owned(),
                VarLenType::Floatn => if len == 4 { "real" } else { "float" }.to_owned(),
                VarLenType::Money => if len == 4 { "smallmoney" } else { "money" }.to_owned(),
                VarLenType::Datetimen => if len == 4 {
                    "smalldatetime"
                } else {
                    "datetime"
                }
                .to_owned(),
                VarLenType::Daten => "date".to_owned(),
                VarLenType::Timen => format!("time({len})"),
                VarLenType::Datetime2 => format!("datetime2({len})"),
                VarLenType::DatetimeOffsetn => format!("datetimeoffset({len})"),
                VarLenType::Guid => "uniqueidentifier".to_owned(),
                VarLenType::BigVarBin => format!("varbinary({})", length(len, false)),
                VarLenType::BigVarChar => format!("varchar({})", length(len, false)),
                VarLenType::BigBinary => format!("binary({})", length(len, false)),
                VarLenType::BigChar => format!("char({})", length(len, false)),
                VarLenType::NVarchar => format!("nvarchar({})", length(len, true)),
                VarLenType::NChar => format!("nchar({})", length(len, true)),
                VarLenType::Text => "text".to_owned(),
                VarLenType::NText => "ntext".to_owned(),
                VarLenType::Image => "image".to_owned(),
                VarLenType::SSVariant => "sql_variant".to_owned(),
                VarLenType::Xml => "xml".to_owned(),
                VarLenType::Udt => "udt".to_owned(),
                VarLenType::Decimaln => "decimal".to_owned(),
                VarLenType::Numericn => "numeric".to_owned(),
            }
        }
        TypeInfo::VarLenSizedPrecision {
            ty,
            precision,
            scale,
            ..
        } => {
            let name = if *ty == VarLenType::Numericn {
                "numeric"
            } else {
                "decimal"
            };
            format!("{name}({precision},{scale})")
        }
        TypeInfo::Xml { .. } => "xml".to_owned(),
        TypeInfo::Udt(udt) => udt.type_name.clone(),
    }
}

pub fn kind_of(ty: &TypeInfo) -> ValueKind {
    match ty {
        TypeInfo::FixedLen(fixed) => match fixed {
            FixedLenType::Null => ValueKind::Other,
            FixedLenType::Bit => ValueKind::Bool,
            FixedLenType::Int1 | FixedLenType::Int2 | FixedLenType::Int4 | FixedLenType::Int8 => {
                ValueKind::Int
            }
            FixedLenType::Float4 | FixedLenType::Float8 => ValueKind::Float,
            FixedLenType::Money | FixedLenType::Money4 => ValueKind::Decimal,
            FixedLenType::Datetime4 | FixedLenType::Datetime => ValueKind::Timestamp,
        },
        TypeInfo::VarLenSized(cx) => match cx.r#type() {
            VarLenType::Intn => ValueKind::Int,
            VarLenType::Bitn => ValueKind::Bool,
            VarLenType::Floatn => ValueKind::Float,
            VarLenType::Money | VarLenType::Decimaln | VarLenType::Numericn => ValueKind::Decimal,
            VarLenType::Datetimen | VarLenType::Datetime2 => ValueKind::Timestamp,
            VarLenType::Daten => ValueKind::Date,
            VarLenType::Timen => ValueKind::Time,
            VarLenType::DatetimeOffsetn => ValueKind::TimestampTz,
            VarLenType::Guid => ValueKind::Uuid,
            VarLenType::BigVarBin | VarLenType::BigBinary | VarLenType::Image => ValueKind::Bytes,
            VarLenType::BigVarChar
            | VarLenType::BigChar
            | VarLenType::NVarchar
            | VarLenType::NChar
            | VarLenType::Text
            | VarLenType::NText
            | VarLenType::Xml => ValueKind::Text,
            VarLenType::SSVariant | VarLenType::Udt => ValueKind::Other,
        },
        TypeInfo::VarLenSizedPrecision { .. } => ValueKind::Decimal,
        TypeInfo::Xml { .. } => ValueKind::Text,
        TypeInfo::Udt(_) => ValueKind::Other,
    }
}

/// One cell.
pub fn decode(data: ColumnData<'static>, decoder: Decoder) -> Value {
    let value = plain(data);
    match (decoder, value) {
        (_, Value::Null) => Value::Null,
        (Decoder::Plain, value) => value,
        (Decoder::Udt, Value::Bytes(hex)) => Value::Other(format!("0x{}", hex.to_uppercase())),
        (_, value) => Value::Other(text_of(value)),
    }
}

/// The text a `sql_variant` shows: its value as SQL Server would convert it.
fn text_of(value: Value) -> String {
    match value {
        Value::Null | Value::Missing => String::new(),
        Value::Bool(b) => if b { "1" } else { "0" }.to_owned(),
        Value::Bytes(hex) => format!("0x{}", hex.to_uppercase()),
        Value::Array(_) => String::new(),
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
        | Value::ObjectId(s) => s,
    }
}

fn plain(data: ColumnData<'static>) -> Value {
    match data {
        ColumnData::U8(v) => v.map_or(Value::Null, Value::int),
        ColumnData::I16(v) => v.map_or(Value::Null, Value::int),
        ColumnData::I32(v) => v.map_or(Value::Null, Value::int),
        ColumnData::I64(v) => v.map_or(Value::Null, Value::int),
        ColumnData::F32(v) => v.map_or(Value::Null, |f| Value::Float(format_f32(f))),
        ColumnData::F64(v) => v.map_or(Value::Null, Value::float),
        ColumnData::Bit(v) => v.map_or(Value::Null, Value::Bool),
        ColumnData::String(v) => v.map_or(Value::Null, |s| Value::Text(s.into_owned())),
        // SQL Server prints GUIDs in upper case.
        ColumnData::Guid(v) => v.map_or(Value::Null, |u| {
            Value::Uuid(u.hyphenated().to_string().to_uppercase())
        }),
        ColumnData::Binary(v) => v.map_or(Value::Null, |b| Value::bytes(&b)),
        ColumnData::Numeric(v) => v.map_or(Value::Null, |n| Value::Decimal(numeric(n))),
        ColumnData::Xml(v) => v.map_or(Value::Null, |x| Value::Text(x.into_owned().into_string())),
        ColumnData::DateTime(v) => v.map_or(Value::Null, |d| Value::Timestamp(datetime(d))),
        ColumnData::SmallDateTime(v) => {
            v.map_or(Value::Null, |d| Value::Timestamp(small_datetime(d)))
        }
        ColumnData::Time(v) => v.map_or(Value::Null, |t| Value::Time(time(t))),
        ColumnData::Date(v) => v.map_or(Value::Null, |d| Value::Date(date(d))),
        ColumnData::DateTime2(v) => v.map_or(Value::Null, |d| Value::Timestamp(datetime2(d))),
        ColumnData::DateTimeOffset(v) => {
            v.map_or(Value::Null, |d| Value::TimestampTz(datetime_offset(d)))
        }
    }
}

/// Shortest text that reads back as the same `real` (not the `float` widening of it).
fn format_f32(value: f32) -> String {
    if !value.is_finite() {
        return format_float(f64::from(value));
    }
    let text = format!("{value:?}");
    match text.strip_suffix(".0") {
        Some(integral) => integral.to_owned(),
        None => text,
    }
}

/// `value / 10^scale`, written exactly.
pub fn numeric(n: Numeric) -> String {
    let scale = usize::from(n.scale());
    let value = n.value();
    let digits = value.unsigned_abs().to_string();
    let sign = if value < 0 { "-" } else { "" };
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let padded = format!("{digits:0>width$}", width = scale + 1);
    let (int, frac) = padded.split_at(padded.len() - scale);
    format!("{sign}{int}.{frac}")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (H. Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    // `m` is 1..=12 and `d` 1..=31 by construction.
    (
        y,
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// 0001-01-01 and 1900-01-01, in days since 1970-01-01.
const DAYS_TO_0001: i64 = -719_162;
const DAYS_TO_1900: i64 = -25_567;

fn ymd(days_since_1970: i64) -> String {
    let (y, m, d) = civil_from_days(days_since_1970);
    format!("{y:04}-{m:02}-{d:02}")
}

fn date(d: Date) -> String {
    ymd(DAYS_TO_0001 + i64::from(d.days()))
}

/// `HH:MM:SS` plus `digits` fractional digits of `fraction` (a count of 10^-digits s).
fn clock(seconds: u64, fraction: u64, digits: u8) -> String {
    let (h, m, s) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if digits == 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        let width = usize::from(digits);
        format!("{h:02}:{m:02}:{s:02}.{fraction:0width$}")
    }
}

fn time(t: Time) -> String {
    let scale = t.scale();
    let unit = 10_u64.pow(u32::from(scale));
    clock(t.increments() / unit, t.increments() % unit, scale)
}

fn datetime2(d: DateTime2) -> String {
    format!("{} {}", date(d.date()), time(d.time()))
}

/// `datetime`: 1/300 s ticks, shown to the millisecond like SQL Server does.
fn datetime(d: DateTime) -> String {
    let ticks = u64::from(d.seconds_fragments());
    let seconds = ticks / 300;
    let millis = ((ticks % 300) * 10 + 1) / 3;
    format!(
        "{} {}",
        ymd(DAYS_TO_1900 + i64::from(d.days())),
        clock(seconds, millis, 3)
    )
}

/// `smalldatetime`: minutes.
fn small_datetime(d: SmallDateTime) -> String {
    let minutes = u64::from(d.seconds_fragments());
    format!(
        "{} {}",
        ymd(DAYS_TO_1900 + i64::from(d.days())),
        clock(minutes * 60, 0, 0)
    )
}

/// The local time with its offset (`2025-02-28 14:34:56.7890000+02:00`): the wire carries
/// UTC plus the offset, and the offset is part of the value.
fn datetime_offset(d: DateTimeOffset) -> String {
    let utc = d.datetime2();
    let offset = i64::from(d.offset());
    let scale = utc.time().scale();
    let unit = 10_u64.pow(u32::from(scale));
    let utc_seconds = (utc.time().increments() / unit) as i64;
    let fraction = utc.time().increments() % unit;
    let days = DAYS_TO_0001 + i64::from(utc.date().days());
    let local = days * 86_400 + utc_seconds + offset * 60;
    let (local_days, local_seconds) = (local.div_euclid(86_400), local.rem_euclid(86_400));
    let sign = if offset < 0 { '-' } else { '+' };
    let abs = offset.unsigned_abs();
    format!(
        "{} {}{sign}{:02}:{:02}",
        ymd(local_days),
        clock(local_seconds.unsigned_abs(), fraction, scale),
        abs / 60,
        abs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_numerics_exactly() {
        assert_eq!(numeric(Numeric::new_with_scale(123_456, 2)), "1234.56");
        assert_eq!(numeric(Numeric::new_with_scale(-5, 3)), "-0.005");
        assert_eq!(numeric(Numeric::new_with_scale(42, 0)), "42");
        assert_eq!(
            numeric(Numeric::new_with_scale(
                99_999_999_999_999_999_999_999_999_999_999_999_999,
                10
            )),
            "9999999999999999999999999999.9999999999"
        );
    }

    #[test]
    fn writes_dates_and_times() {
        assert_eq!(date(Date::new(0)), "0001-01-01");
        assert_eq!(date(Date::new(3_652_058)), "9999-12-31");
        assert_eq!(ymd(DAYS_TO_1900), "1900-01-01");
        // 23:59:59.997 is the last datetime tick of a day.
        assert_eq!(
            datetime(DateTime::new(-53_690, 25_919_999)),
            "1753-01-01 23:59:59.997"
        );
        assert_eq!(
            small_datetime(SmallDateTime::new(1, 61)),
            "1900-01-02 01:01:00"
        );
        assert_eq!(time(Time::new(452_961_234_567, 7)), "12:34:56.1234567");
        assert_eq!(time(Time::new(5, 0)), "00:00:05");
        let utc = DateTime2::new(Date::new(0), Time::new(30 * 60 * 10, 1));
        assert_eq!(
            datetime_offset(DateTimeOffset::new(utc, -60)),
            "0000-12-31 23:30:00.0-01:00"
        );
        let utc = DateTime2::new(Date::new(739_309), Time::new(12 * 3600, 0));
        assert_eq!(
            datetime_offset(DateTimeOffset::new(utc, 330)),
            "2025-02-28 17:30:00+05:30"
        );
    }

    #[test]
    fn degrades_variants_and_udts_to_text() {
        assert_eq!(
            decode(ColumnData::I32(Some(7)), Decoder::Variant),
            Value::Other("7".into())
        );
        assert_eq!(
            decode(
                ColumnData::Binary(Some(vec![0x58, 0xab].into())),
                Decoder::Udt
            ),
            Value::Other("0x58AB".into())
        );
        assert_eq!(decode(ColumnData::I32(None), Decoder::Variant), Value::Null);
        assert_eq!(format_f32(0.1), "0.1");
        assert_eq!(format_f32(3.0), "3");
    }
}
