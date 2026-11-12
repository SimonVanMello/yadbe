//! JSON that keeps the order of an object's keys. A MongoDB command is a document whose first
//! key names the command, and a document's fields have an order the user sees: `serde_json`'s
//! own `Map` sorts its keys (the `preserve_order` feature is off in this build), so documents
//! cross the document family as this type instead, in Extended JSON.

use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::db::errors::YadbeError;

/// A JSON value; objects keep their keys in the order they were written.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// Parses JSON text (no Extended JSON interpretation: `{"$oid": …}` stays an object).
    pub fn parse(text: &str) -> Result<Json, YadbeError> {
        serde_json::from_str(text).map_err(|err| {
            YadbeError::invalid_argument("This is not valid JSON.", "Ce n'est pas du JSON valide.")
                .with_detail(err.to_string())
        })
    }

    /// An object from its entries.
    pub fn object<K: Into<String>>(entries: impl IntoIterator<Item = (K, Json)>) -> Json {
        Json::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    pub fn string(text: impl Into<String>) -> Json {
        Json::String(text.into())
    }

    pub fn int(value: i64) -> Json {
        Json::Number(value.into())
    }

    /// An empty object.
    pub fn empty() -> Json {
        Json::Object(Vec::new())
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(text) => Some(text),
            _ => None,
        }
    }

    /// The value of `key` in an object (the first one, keys are not checked for unicity).
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.as_object()?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// Whether this is an object without keys.
    pub fn is_empty_object(&self) -> bool {
        matches!(self, Json::Object(entries) if entries.is_empty())
    }

    /// The JSON text, compact.
    pub fn to_text(&self) -> String {
        // Writing an in-memory tree to a string cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Canonical Extended JSON as relaxed Extended JSON (the MongoDB specification's second
    /// form): Int32, Int64 and finite Double as plain numbers, dates from 1970 to 9999 as ISO 8601
    /// strings. Everything else (ObjectId, Decimal128, dates out of that range, `NaN`…) keeps its
    /// canonical form, so the text still reads back as the same BSON values, apart from the
    /// number types the relaxed form folds together.
    pub fn to_relaxed(&self) -> Json {
        match self {
            Json::Object(entries) => {
                if let [(key, value)] = entries.as_slice()
                    && let Some(plain) = relaxed_wrapper(key, value)
                {
                    return plain;
                }
                // A date outside the relaxed range keeps its milliseconds, wrapped.
                if let [(key, _)] = entries.as_slice()
                    && key == "$date"
                {
                    return self.clone();
                }
                Json::Object(
                    entries
                        .iter()
                        .map(|(k, v)| (k.clone(), v.to_relaxed()))
                        .collect(),
                )
            }
            Json::Array(items) => Json::Array(items.iter().map(Json::to_relaxed).collect()),
            other => other.clone(),
        }
    }

    /// From a `serde_json` value (whose objects are already sorted by key).
    pub fn from_value(value: serde_json::Value) -> Json {
        match value {
            serde_json::Value::Null => Json::Null,
            serde_json::Value::Bool(b) => Json::Bool(b),
            serde_json::Value::Number(n) => Json::Number(n),
            serde_json::Value::String(s) => Json::String(s),
            serde_json::Value::Array(items) => {
                Json::Array(items.into_iter().map(Json::from_value).collect())
            }
            serde_json::Value::Object(map) => Json::Object(
                map.into_iter()
                    .map(|(k, v)| (k, Json::from_value(v)))
                    .collect(),
            ),
        }
    }

    /// To a `serde_json` value; key order is lost in objects (only for small Extended JSON
    /// wrappers such as `{"$date": …}`, where it does not matter).
    pub fn into_value(self) -> serde_json::Value {
        match self {
            Json::Null => serde_json::Value::Null,
            Json::Bool(b) => serde_json::Value::Bool(b),
            Json::Number(n) => serde_json::Value::Number(n),
            Json::String(s) => serde_json::Value::String(s),
            Json::Array(items) => {
                serde_json::Value::Array(items.into_iter().map(Json::into_value).collect())
            }
            Json::Object(entries) => serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k, v.into_value()))
                    .collect(),
            ),
        }
    }
}

impl fmt::Display for Json {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_text())
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => serializer.serialize_unit(),
            Json::Bool(b) => serializer.serialize_bool(*b),
            Json::Number(n) => n.serialize(serializer),
            Json::String(s) => serializer.serialize_str(s),
            Json::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Json, E> {
        Ok(Json::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Json, E> {
        Ok(Json::Number(v.into()))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Json, E> {
        Ok(Json::Number(v.into()))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Json, E> {
        serde_json::Number::from_f64(v)
            .map(Json::Number)
            .ok_or_else(|| E::custom("a number JSON cannot hold"))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Json, E> {
        Ok(Json::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Json, E> {
        Ok(Json::String(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            entries.push((key, value));
        }
        Ok(Json::Object(entries))
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

/// The relaxed form of a one-key canonical wrapper, `None` when it stays as it is.
fn relaxed_wrapper(key: &str, value: &Json) -> Option<Json> {
    match (key, value) {
        ("$numberInt" | "$numberLong", Json::String(n)) => n.parse::<i64>().ok().map(Json::int),
        ("$numberDouble", Json::String(n)) => n
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Json::Number),
        ("$date", Json::Object(inner)) => match inner.as_slice() {
            [(k, Json::String(ms))] if k == "$numberLong" => {
                let iso = iso_date(ms.parse::<i64>().ok()?)?;
                Some(Json::object([("$date", Json::string(iso))]))
            }
            _ => None,
        },
        _ => None,
    }
}

/// `1970-01-01T00:00:00.000Z` for milliseconds since the epoch, `None` outside years 1970 to 9999
/// (where the relaxed form keeps the milliseconds).
fn iso_date(millis: i64) -> Option<String> {
    if millis < 0 {
        return None;
    }
    let days = millis.div_euclid(86_400_000);
    let in_day = millis.rem_euclid(86_400_000);
    // Civil date from a day count (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    if year > 9999 {
        return None;
    }
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_order_of_keys() {
        let text = r#"{"find":"orders","filter":{"z":1,"a":[true,null,"x",1.5]},"$db":"shop"}"#;
        let json = Json::parse(text).expect("parses");
        assert_eq!(json.to_text(), text);
        assert_eq!(
            json.as_object().map(|e| e[0].0.as_str()),
            Some("find"),
            "the command name stays first"
        );
        assert_eq!(
            json.get("filter").and_then(|f| f.get("z")),
            Some(&Json::int(1))
        );
    }

    #[test]
    fn invalid_text_is_a_typed_error() {
        let err = Json::parse("{ find: ").expect_err("not JSON");
        assert_eq!(err.code, crate::db::errors::ErrorCode::InvalidArgument);
        assert!(err.detail.is_some());
    }

    #[test]
    fn large_integers_stay_exact() {
        let json = Json::parse("[9223372036854775807, -9223372036854775808, 18446744073709551615]")
            .expect("parses");
        assert_eq!(
            json.to_text(),
            "[9223372036854775807,-9223372036854775808,18446744073709551615]"
        );
    }

    #[test]
    fn relaxed_form_folds_numbers_and_dates() {
        let canonical = Json::parse(
            r#"{"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c3"},"n":{"$numberInt":"-3"},"big":{"$numberLong":"9007199254740993"},"d":{"$numberDouble":"1.5"},"nan":{"$numberDouble":"NaN"},"when":{"$date":{"$numberLong":"1700000000123"}},"old":{"$date":{"$numberLong":"-1"}},"tags":[{"$numberInt":"1"}]}"#,
        )
        .expect("parses");
        assert_eq!(
            canonical.to_relaxed().to_text(),
            r#"{"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c3"},"n":-3,"big":9007199254740993,"d":1.5,"nan":{"$numberDouble":"NaN"},"when":{"$date":"2023-11-14T22:13:20.123Z"},"old":{"$date":{"$numberLong":"-1"}},"tags":[1]}"#
        );
    }
}
