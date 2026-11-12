//! Canonical Extended JSON v2 (the lossless text form of BSON) and the cells of the grid.
//!
//! A document leaves the driver as canonical Extended JSON ([`Json`]); everything above the
//! driver reads it here, without the driver crate: the BSON type of a value, its cell
//! ([`Value`]) and back. Mapping (NOSQL.md 4.2): ObjectId → `ObjectId`, Date → `TimestampTz`,
//! Decimal128 → `Decimal`, Int32 / Int64 → `Int`, Double → `Float`, generic binary → `Bytes`,
//! UUID binary → `Uuid`, documents, arrays and the rarer types → `Json` (canonical text).
//! Int32 and Int64 share `Int`: [`to_ejson`] takes the original type as a hint, so a value
//! written back keeps its type.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::json::Json;
use crate::db::errors::YadbeError;
use crate::db::value::{Value, ValueKind, format_float, hex};

/// The BSON types, named as MongoDB's `$type` aliases.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum BsonType {
    Double,
    String,
    Object,
    Array,
    BinData,
    Undefined,
    ObjectId,
    Bool,
    Date,
    Null,
    Regex,
    DbPointer,
    Javascript,
    Symbol,
    JavascriptWithScope,
    Int,
    Timestamp,
    Long,
    Decimal,
    MinKey,
    MaxKey,
}

impl BsonType {
    /// The `$type` alias (`objectId`, `long`…), also the type name of a grid column.
    pub fn alias(self) -> &'static str {
        match self {
            BsonType::Double => "double",
            BsonType::String => "string",
            BsonType::Object => "object",
            BsonType::Array => "array",
            BsonType::BinData => "binData",
            BsonType::Undefined => "undefined",
            BsonType::ObjectId => "objectId",
            BsonType::Bool => "bool",
            BsonType::Date => "date",
            BsonType::Null => "null",
            BsonType::Regex => "regex",
            BsonType::DbPointer => "dbPointer",
            BsonType::Javascript => "javascript",
            BsonType::Symbol => "symbol",
            BsonType::JavascriptWithScope => "javascriptWithScope",
            BsonType::Int => "int",
            BsonType::Timestamp => "timestamp",
            BsonType::Long => "long",
            BsonType::Decimal => "decimal",
            BsonType::MinKey => "minKey",
            BsonType::MaxKey => "maxKey",
        }
    }
}

/// The Extended JSON wrapper `{"$key": body}` a value is, if it is one.
fn wrapper(json: &Json) -> Option<(&str, &Json)> {
    let entries = json.as_object()?;
    match entries {
        [(key, body)] if key.starts_with('$') => Some((key, body)),
        // Code with scope is the only two-key wrapper.
        [(a, body), (b, _)] if a == "$code" && b == "$scope" => Some(("$codeWithScope", body)),
        [(a, _), (b, body)] if a == "$scope" && b == "$code" => Some(("$codeWithScope", body)),
        _ => None,
    }
}

/// The BSON type of an Extended JSON value (canonical or relaxed).
pub fn type_of(json: &Json) -> BsonType {
    match json {
        Json::Null => BsonType::Null,
        Json::Bool(_) => BsonType::Bool,
        Json::String(_) => BsonType::String,
        Json::Array(_) => BsonType::Array,
        Json::Number(n) => match n.as_i64() {
            Some(i) if i32::try_from(i).is_ok() => BsonType::Int,
            Some(_) => BsonType::Long,
            None => BsonType::Double,
        },
        Json::Object(_) => match wrapper(json).map(|(key, _)| key) {
            Some("$oid") => BsonType::ObjectId,
            Some("$numberInt") => BsonType::Int,
            Some("$numberLong") => BsonType::Long,
            Some("$numberDouble") => BsonType::Double,
            Some("$numberDecimal") => BsonType::Decimal,
            Some("$date") => BsonType::Date,
            Some("$binary" | "$uuid") => BsonType::BinData,
            Some("$regularExpression") => BsonType::Regex,
            Some("$timestamp") => BsonType::Timestamp,
            Some("$minKey") => BsonType::MinKey,
            Some("$maxKey") => BsonType::MaxKey,
            Some("$symbol") => BsonType::Symbol,
            Some("$code") => BsonType::Javascript,
            Some("$codeWithScope") => BsonType::JavascriptWithScope,
            Some("$undefined") => BsonType::Undefined,
            Some("$dbPointer") => BsonType::DbPointer,
            _ => BsonType::Object,
        },
    }
}

/// The grid kind a BSON type is shown as.
pub fn kind_of_type(ty: BsonType) -> ValueKind {
    match ty {
        BsonType::Double => ValueKind::Float,
        BsonType::String => ValueKind::Text,
        BsonType::Bool => ValueKind::Bool,
        BsonType::Int | BsonType::Long => ValueKind::Int,
        BsonType::Decimal => ValueKind::Decimal,
        BsonType::Date => ValueKind::TimestampTz,
        BsonType::ObjectId => ValueKind::ObjectId,
        BsonType::BinData => ValueKind::Bytes,
        _ => ValueKind::Json,
    }
}

// --- Dates ----------------------------------------------------------------------------------

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `YYYY-MM-DD HH:MM:SS[.mmm]+00` for milliseconds since the epoch, when the year has four
/// digits; `None` beyond (such a date stays Extended JSON, which holds it exactly).
pub fn format_millis(ms: i64) -> Option<String> {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    if !(1..=9999).contains(&year) {
        return None;
    }
    let (secs, millis) = (rest / 1000, rest % 1000);
    let (h, m, s) = (secs / 3600, secs / 60 % 60, secs % 60);
    let fraction = if millis == 0 {
        String::new()
    } else {
        format!(".{millis:03}")
    };
    Some(format!(
        "{year:04}-{month:02}-{day:02} {h:02}:{m:02}:{s:02}{fraction}+00"
    ))
}

fn invalid_value(what: &str, text: &str) -> YadbeError {
    YadbeError::invalid_argument(
        format!("“{text}” is not a valid {what}."),
        format!("« {text} » n'est pas un(e) {what} valide."),
    )
}

/// Milliseconds since the epoch of `YYYY-MM-DD[( |T)HH:MM[:SS[.fff]]][Z|±HH[:MM]]`.
pub fn parse_millis(text: &str) -> Result<i64, YadbeError> {
    let bad = || invalid_value("date", text);
    let trimmed = text.trim();
    let (date, time) = match trimmed.split_once([' ', 'T']) {
        Some((date, time)) => (date, time.trim()),
        None => (trimmed, ""),
    };
    let mut parts = date.splitn(3, '-');
    let num = |part: Option<&str>| -> Result<i64, YadbeError> {
        part.and_then(|p| p.parse::<i64>().ok()).ok_or_else(bad)
    };
    let (year, month, day) = (num(parts.next())?, num(parts.next())?, num(parts.next())?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(bad());
    }
    let (clock, offset_minutes) = split_offset(time).ok_or_else(bad)?;
    let mut millis = 0_i64;
    if !clock.is_empty() {
        let (hms, fraction) = clock.split_once('.').unwrap_or((clock, ""));
        let mut fields = hms.split(':');
        let h = num(fields.next())?;
        let m = num(fields.next())?;
        let s = fields.next().map_or(Ok(0), |p| num(Some(p)))?;
        if fields.next().is_some() || h > 23 || m > 59 || s > 60 {
            return Err(bad());
        }
        let digits: String = fraction.chars().take(3).collect();
        if !fraction.chars().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        let ms = if digits.is_empty() {
            0
        } else {
            format!("{digits:0<3}").parse::<i64>().map_err(|_| bad())?
        };
        millis = ((h * 60 + m) * 60 + s) * 1000 + ms;
    }
    Ok(days_from_civil(year, month, day) * 86_400_000 + millis - offset_minutes * 60_000)
}

/// The clock part and its offset in minutes (`Z`, `+00`, `+02:00`, `-0530`).
fn split_offset(time: &str) -> Option<(&str, i64)> {
    if let Some(clock) = time.strip_suffix(['Z', 'z']) {
        return Some((clock, 0));
    }
    let Some(at) = time.rfind(['+', '-']) else {
        return Some((time, 0));
    };
    let (clock, offset) = time.split_at(at);
    let sign = if offset.starts_with('-') { -1 } else { 1 };
    let digits: String = offset[1..].chars().filter(|c| *c != ':').collect();
    if !digits.chars().all(|c| c.is_ascii_digit()) || !(2..=4).contains(&digits.len()) {
        return None;
    }
    let hours: i64 = digits.get(..2)?.parse().ok()?;
    let minutes: i64 = digits
        .get(2..)
        .filter(|m| !m.is_empty())
        .map_or(Some(0), |m| m.parse().ok())?;
    Some((clock.trim_end(), sign * (hours * 60 + minutes)))
}

// --- Base64 and UUIDs -----------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(B64[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0_u32;
    let mut bits = 0;
    for c in text.bytes() {
        if c == b'=' {
            break;
        }
        let v = B64.iter().position(|&d| d == c)?;
        acc = (acc << 6) | u32::try_from(v).ok()?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn format_uuid(bytes: &[u8]) -> String {
    let h = hex(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

// --- Doubles --------------------------------------------------------------------------------

/// A double as canonical Extended JSON writes it (`{"$numberDouble": "1.0"}`), or a plain
/// number for a subnormal one, as the driver does.
pub fn canonical_double(value: f64) -> Json {
    let text = if value.is_nan() {
        if value.is_sign_negative() {
            "-NaN"
        } else {
            "NaN"
        }
        .to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else if value == 0.0 {
        if value.is_sign_negative() {
            "-0.0"
        } else {
            "0.0"
        }
        .to_owned()
    } else if value.is_normal() {
        let mut text = value.to_string();
        if value.fract() == 0.0 {
            text.push_str(".0");
        }
        text
    } else {
        return serde_json::Number::from_f64(value).map_or(Json::Null, Json::Number);
    };
    Json::object([("$numberDouble", Json::String(text))])
}

fn parse_double(text: &str) -> Option<f64> {
    match text {
        "NaN" | "-NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        other => other.parse().ok(),
    }
}

// --- Cells ----------------------------------------------------------------------------------

/// The cell of a value read from the server (canonical Extended JSON).
pub fn to_value(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::Text(s.clone()),
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => Value::int(i),
            (None, Some(f)) if n.is_f64() => Value::float(f),
            _ => Value::Int(n.to_string()),
        },
        Json::Array(_) => Value::Json(json.to_text()),
        Json::Object(_) => {
            let scalar = wrapper(json).and_then(|(key, body)| match (key, body) {
                ("$oid", Json::String(hex)) => Some(Value::ObjectId(hex.clone())),
                ("$numberInt" | "$numberLong", Json::String(n)) => Some(Value::Int(n.clone())),
                ("$numberDecimal", Json::String(d)) => Some(Value::Decimal(d.clone())),
                ("$numberDouble", Json::String(d)) => parse_double(d).map(Value::float),
                ("$date", body) => date_millis(body)
                    .and_then(format_millis)
                    .map(Value::TimestampTz),
                ("$binary", body) => binary_value(body),
                ("$uuid", Json::String(uuid)) => Some(Value::Uuid(uuid.clone())),
                _ => None,
            });
            scalar.unwrap_or_else(|| Value::Json(json.to_text()))
        }
    }
}

/// The milliseconds of a `$date` body: `{"$numberLong": "…"}` (canonical) or an ISO string
/// (relaxed).
fn date_millis(body: &Json) -> Option<i64> {
    match body {
        Json::String(iso) => parse_millis(iso).ok(),
        Json::Number(n) => n.as_i64(),
        _ => body.get("$numberLong")?.as_str()?.parse().ok(),
    }
}

fn binary_value(body: &Json) -> Option<Value> {
    let bytes = base64_decode(body.get("base64")?.as_str()?)?;
    match body.get("subType")?.as_str()? {
        "00" | "0" => Some(Value::bytes(&bytes)),
        "04" | "4" if bytes.len() == 16 => Some(Value::Uuid(format_uuid(&bytes))),
        _ => None,
    }
}

/// The canonical Extended JSON of a cell, for writing it back. `hint`: the BSON type the
/// value had (an edited cell keeps its type); `None` for a new value, which then takes the
/// natural type of its cell. `Ok(None)` for a missing field (nothing to write).
pub fn to_ejson(value: &Value, hint: Option<BsonType>) -> Result<Option<Json>, YadbeError> {
    let json = match value {
        Value::Missing => return Ok(None),
        Value::Null => Json::Null,
        Value::Bool(b) => Json::Bool(*b),
        Value::Text(s) | Value::Interval(s) | Value::Time(s) | Value::Other(s) => {
            Json::String(s.clone())
        }
        Value::Int(text) => int_ejson(text, hint)?,
        Value::Decimal(text) => Json::object([("$numberDecimal", Json::String(text.clone()))]),
        Value::Float(text) => {
            let value = parse_double(text).ok_or_else(|| invalid_value("number", text))?;
            canonical_double(value)
        }
        Value::Date(text) | Value::Timestamp(text) | Value::TimestampTz(text) => {
            date_ejson(parse_millis(text)?)
        }
        Value::ObjectId(hex) => {
            if hex.len() != 24 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(invalid_value("ObjectId", hex));
            }
            Json::object([("$oid", Json::String(hex.to_ascii_lowercase()))])
        }
        Value::Bytes(text) => {
            let bytes = unhex(text).ok_or_else(|| invalid_value("hexadecimal value", text))?;
            binary_ejson(&bytes, "00")
        }
        Value::Uuid(text) => {
            let digits: String = text.chars().filter(|c| *c != '-').collect();
            let bytes = unhex(&digits)
                .filter(|b| b.len() == 16)
                .ok_or_else(|| invalid_value("UUID", text))?;
            binary_ejson(&bytes, "04")
        }
        Value::Json(text) => Json::parse(text)?,
        Value::Array(items) => Json::Array(
            items
                .iter()
                .filter_map(|item| to_ejson(item, None).transpose())
                .collect::<Result<_, _>>()?,
        ),
    };
    Ok(Some(json))
}

fn date_ejson(ms: i64) -> Json {
    Json::object([(
        "$date",
        Json::object([("$numberLong", Json::String(ms.to_string()))]),
    )])
}

fn binary_ejson(bytes: &[u8], subtype: &str) -> Json {
    Json::object([(
        "$binary",
        Json::object([
            ("base64", Json::String(base64_encode(bytes))),
            ("subType", Json::String(subtype.to_owned())),
        ]),
    )])
}

fn int_ejson(text: &str, hint: Option<BsonType>) -> Result<Json, YadbeError> {
    let wrap = |key: &str, n: String| Json::object([(key, Json::String(n))]);
    match hint {
        Some(BsonType::Double) => {
            let value = parse_double(text).ok_or_else(|| invalid_value("number", text))?;
            Ok(canonical_double(value))
        }
        Some(BsonType::Decimal) => Ok(wrap("$numberDecimal", text.to_owned())),
        _ => {
            let n: i64 = text
                .trim()
                .parse()
                .map_err(|_| invalid_value("64-bit integer", text))?;
            let int32 = i32::try_from(n);
            match (hint, int32) {
                (Some(BsonType::Long), _) | (_, Err(_)) => Ok(wrap("$numberLong", n.to_string())),
                (_, Ok(n)) => Ok(wrap("$numberInt", n.to_string())),
            }
        }
    }
}

/// `format_float` re-exported for the driver's tests: a double's cell text.
pub fn float_text(value: f64) -> String {
    format_float(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Json {
        Json::parse(text).expect("json")
    }

    #[test]
    fn dates_round_trip_through_their_cell_text() {
        for ms in [
            0_i64,
            1,
            -1,
            1_700_000_000_123,
            -62_135_596_800_000, // 0001-01-01
            253_402_300_799_999, // 9999-12-31 23:59:59.999
            951_782_400_000,     // 2000-02-29
        ] {
            let text = format_millis(ms).expect("in range");
            assert_eq!(parse_millis(&text).expect("parses"), ms, "{text}");
        }
        assert_eq!(format_millis(0).as_deref(), Some("1970-01-01 00:00:00+00"));
        assert_eq!(
            format_millis(1_700_000_000_123).as_deref(),
            Some("2023-11-14 22:13:20.123+00")
        );
        assert_eq!(format_millis(253_402_300_800_000), None, "year 10000");
        assert_eq!(
            parse_millis("2024-03-01T10:00:00+02:00").expect("offset"),
            parse_millis("2024-03-01 08:00:00Z").expect("utc")
        );
    }

    #[test]
    fn base64_round_trips() {
        for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\x00\xff\x10"] {
            assert_eq!(base64_decode(&base64_encode(bytes)).as_deref(), Some(bytes));
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
    }

    /// Every canonical value maps to a cell and back to the same canonical value when the
    /// original type is given (the edit path's hint).
    #[test]
    fn cells_round_trip_with_their_type() {
        let canonical = [
            r#"{"$oid":"5f2b8c9e1c9d440000a1b2c3"}"#,
            r#"{"$numberInt":"42"}"#,
            r#"{"$numberInt":"-2147483648"}"#,
            r#"{"$numberLong":"5"}"#,
            r#"{"$numberLong":"-9223372036854775808"}"#,
            r#"{"$numberDouble":"1.5"}"#,
            r#"{"$numberDouble":"-0.0"}"#,
            r#"{"$numberDouble":"3.0"}"#,
            r#"{"$numberDouble":"Infinity"}"#,
            r#"{"$numberDouble":"-Infinity"}"#,
            r#"{"$numberDouble":"NaN"}"#,
            r#"{"$numberDecimal":"12345678901234567890.123"}"#,
            r#"{"$date":{"$numberLong":"1700000000123"}}"#,
            r#"{"$date":{"$numberLong":"-1"}}"#,
            r#"{"$binary":{"base64":"AP8Q","subType":"00"}}"#,
            r#"{"$binary":{"base64":"EjRWeJASNFZ4kBI0VniQEg==","subType":"04"}}"#,
            r#""text""#,
            "true",
            "null",
            r#"{"a":{"$numberInt":"1"},"b":[{"$numberLong":"2"}]}"#,
            r#"[{"$numberInt":"1"},"x"]"#,
            r#"{"$regularExpression":{"pattern":"^a","options":"i"}}"#,
            r#"{"$timestamp":{"t":1,"i":2}}"#,
            r#"{"$minKey":1}"#,
            r#"{"$maxKey":1}"#,
            r#"{"$binary":{"base64":"AQI=","subType":"80"}}"#,
            r#"{"$date":{"$numberLong":"253402300800000"}}"#,
            r#"{"$code":"x = 1"}"#,
            r#"{"$symbol":"s"}"#,
            r#"{"$undefined":true}"#,
        ];
        for text in canonical {
            let json = parse(text);
            let ty = type_of(&json);
            let value = to_value(&json);
            let back = to_ejson(&value, Some(ty))
                .expect("converts")
                .expect("present");
            assert_eq!(back, json, "{text} → {value:?}");
            assert_eq!(type_of(&back), ty, "{text}");
        }
    }

    #[test]
    fn types_and_cells_of_values() {
        assert_eq!(type_of(&parse(r#"{"$numberLong":"1"}"#)), BsonType::Long);
        assert_eq!(
            type_of(&parse(r#"{"$oid":"x","other":1}"#)),
            BsonType::Object
        );
        assert_eq!(type_of(&parse("12")), BsonType::Int);
        assert_eq!(type_of(&parse("12000000000")), BsonType::Long);
        assert_eq!(type_of(&parse("1.5")), BsonType::Double);
        assert_eq!(
            to_value(&parse(r#"{"$date":"2024-01-02T03:04:05Z"}"#)),
            Value::TimestampTz("2024-01-02 03:04:05+00".into())
        );
        assert_eq!(
            to_value(&parse(
                r#"{"$binary":{"base64":"EjRWeJASNFZ4kBI0VniQEg==","subType":"04"}}"#
            )),
            Value::Uuid("12345678-9012-3456-7890-123456789012".into())
        );
        // New values without a type: the natural one.
        assert_eq!(
            to_ejson(&Value::int(7), None).expect("ok"),
            Some(parse(r#"{"$numberInt":"7"}"#))
        );
        assert_eq!(
            to_ejson(&Value::int(1_i64 << 40), None).expect("ok"),
            Some(parse(r#"{"$numberLong":"1099511627776"}"#))
        );
        assert_eq!(to_ejson(&Value::Missing, None).expect("ok"), None);
        assert!(to_ejson(&Value::ObjectId("zz".into()), None).is_err());
    }
}
