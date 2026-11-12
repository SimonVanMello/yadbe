//! BSON ↔ canonical Extended JSON ([`Json`], which keeps the order of keys). The `bson`
//! crate's own conversion goes through `serde_json::Map`, which sorts keys in this build:
//! documents and arrays are walked here, and only the scalar wrappers (`{"$date": …}`) go
//! through the crate.

use mongodb::bson::{Bson, Document, JavaScriptCodeWithScope};

use crate::db::document::json::Json;
use crate::db::errors::YadbeError;

/// The keys that make an object an Extended JSON value rather than a document. Query
/// operators (`$gt`, `$regex`, `$type`…) are documents.
const WRAPPERS: &[&str] = &[
    "$oid",
    "$symbol",
    "$numberInt",
    "$numberLong",
    "$numberDouble",
    "$numberDecimal",
    "$binary",
    "$uuid",
    "$code",
    "$timestamp",
    "$regularExpression",
    "$dbPointer",
    "$date",
    "$minKey",
    "$maxKey",
    "$undefined",
];

pub fn bson_to_json(value: Bson) -> Json {
    match value {
        Bson::Document(doc) => document_to_json(doc),
        Bson::Array(items) => Json::Array(items.into_iter().map(bson_to_json).collect()),
        Bson::JavaScriptCodeWithScope(JavaScriptCodeWithScope { code, scope }) => Json::object([
            ("$code", Json::String(code)),
            ("$scope", document_to_json(scope)),
        ]),
        Bson::String(s) => Json::String(s),
        Bson::Boolean(b) => Json::Bool(b),
        Bson::Null => Json::Null,
        other => Json::from_value(other.into_canonical_extjson()),
    }
}

pub fn document_to_json(doc: Document) -> Json {
    Json::Object(doc.into_iter().map(|(k, v)| (k, bson_to_json(v))).collect())
}

fn invalid(detail: impl std::fmt::Display) -> YadbeError {
    YadbeError::invalid_argument(
        "This is not a valid MongoDB document (Extended JSON).",
        "Ce n'est pas un document MongoDB valide (Extended JSON).",
    )
    .with_detail(detail.to_string())
}

fn is_wrapper(entries: &[(String, Json)]) -> bool {
    match entries {
        [(key, _)] => WRAPPERS.contains(&key.as_str()),
        [(a, _), (b, _)] => (a == "$code" && b == "$scope") || (a == "$scope" && b == "$code"),
        _ => false,
    }
}

/// A value from canonical or relaxed Extended JSON. Plain integers are Int32 when they fit,
/// else Int64; numbers with a fraction or an exponent are doubles (relaxed rules).
pub fn json_to_bson(json: &Json) -> Result<Bson, YadbeError> {
    Ok(match json {
        Json::Null => Bson::Null,
        Json::Bool(b) => Bson::Boolean(*b),
        Json::String(s) => Bson::String(s.clone()),
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => match i32::try_from(i) {
                Ok(small) => Bson::Int32(small),
                Err(_) => Bson::Int64(i),
            },
            (None, Some(f)) => Bson::Double(f),
            _ => return Err(invalid(format!("number out of range: {n}"))),
        },
        Json::Array(items) => {
            Bson::Array(items.iter().map(json_to_bson).collect::<Result<_, _>>()?)
        }
        Json::Object(entries) if is_wrapper(entries) => {
            if let [(a, code), (b, scope)] = entries.as_slice() {
                let (code, scope) = if a == "$code" {
                    (code, scope)
                } else {
                    (scope, code)
                };
                let _ = b;
                return Ok(Bson::JavaScriptCodeWithScope(JavaScriptCodeWithScope {
                    code: code
                        .as_str()
                        .ok_or_else(|| invalid("$code must be a string"))?
                        .to_owned(),
                    scope: json_to_document(scope)?,
                }));
            }
            Bson::try_from(json.clone().into_value()).map_err(invalid)?
        }
        Json::Object(entries) => Bson::Document(entries_to_document(entries)?),
    })
}

fn entries_to_document(entries: &[(String, Json)]) -> Result<Document, YadbeError> {
    let mut doc = Document::new();
    for (key, value) in entries {
        doc.insert(key.clone(), json_to_bson(value)?);
    }
    Ok(doc)
}

/// A document (an object that is not an Extended JSON value).
pub fn json_to_document(json: &Json) -> Result<Document, YadbeError> {
    match json {
        Json::Object(entries) if !is_wrapper(entries) => entries_to_document(entries),
        _ => Err(invalid("a document (JSON object) is expected")),
    }
}

#[cfg(test)]
mod tests {
    use mongodb::bson::{
        Binary, DateTime, Decimal128, JavaScriptCodeWithScope, Timestamp, doc, oid::ObjectId,
        spec::BinarySubtype,
    };

    use super::*;
    use crate::db::document::ejson::{to_ejson, to_value, type_of};

    /// One value of every BSON type, the edge cases included.
    fn every_type() -> Document {
        doc! {
            "_id": ObjectId::parse_str("5f2b8c9e1c9d440000a1b2c3").expect("oid"),
            "double": 1.5,
            "double_whole": 3.0,
            "double_neg_zero": -0.0,
            "double_inf": f64::INFINITY,
            "double_nan": f64::NAN,
            "double_tiny": 5e-324,
            "double_huge": 1e300,
            "string": "héllo",
            "object": { "z": 1, "a": { "deep": [1_i64, "x"] } },
            "array": [1, "two", { "three": 3 }],
            "binary": Binary { subtype: BinarySubtype::Generic, bytes: vec![0, 255, 16] },
            "uuid": Binary { subtype: BinarySubtype::Uuid, bytes: (0..16).collect() },
            "binary_user": Binary { subtype: BinarySubtype::UserDefined(0x80), bytes: vec![1, 2] },
            "undefined": Bson::Undefined,
            "bool": true,
            "date": DateTime::from_millis(1_700_000_000_123),
            "date_before_epoch": DateTime::from_millis(-1),
            "date_far": DateTime::from_millis(253_402_300_800_000),
            "null": Bson::Null,
            "regex": Bson::try_from(serde_json::json!({
                "$regularExpression": { "pattern": "^a", "options": "im" }
            }))
            .expect("regex"),
            "code": Bson::JavaScriptCode("x = 1".into()),
            "symbol": Bson::Symbol("sym".into()),
            "code_scope": JavaScriptCodeWithScope { code: "y".into(), scope: doc! { "b": 1, "a": 2 } },
            "int32": 42_i32,
            "int32_min": i32::MIN,
            "int64_small": 5_i64,
            "int64_max": i64::MAX,
            "timestamp": Timestamp { time: 1, increment: 2 },
            "decimal": "12345678901234567890.123".parse::<Decimal128>().expect("decimal"),
            "min": Bson::MinKey,
            "max": Bson::MaxKey,
        }
    }

    fn same(a: &Bson, b: &Bson) -> bool {
        match (a, b) {
            (Bson::Double(x), Bson::Double(y)) => {
                (x.is_nan() && y.is_nan()) || x.to_bits() == y.to_bits()
            }
            (Bson::Document(x), Bson::Document(y)) => {
                x.len() == y.len()
                    && x.iter()
                        .zip(y.iter())
                        .all(|((ka, va), (kb, vb))| ka == kb && same(va, vb))
            }
            (Bson::Array(x), Bson::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
            }
            _ => a == b,
        }
    }

    /// BSON → canonical Extended JSON text → BSON gives the same document, field order and
    /// types included.
    #[test]
    fn documents_round_trip_through_canonical_text() {
        let original = Bson::Document(every_type());
        let text = bson_to_json(original.clone()).to_text();
        let back = json_to_bson(&Json::parse(&text).expect("json")).expect("bson");
        assert!(same(&original, &back), "{text}");
        assert!(text.starts_with(r#"{"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c3"},"double":"#));
        assert!(
            text.contains(r#""object":{"z":{"$numberInt":"1"},"a":"#),
            "{text}"
        );
    }

    /// Every top-level value → grid cell → value with its type → the same BSON value: what an
    /// edit writes back is what was read.
    #[test]
    fn cells_round_trip_to_the_same_bson() {
        for (key, value) in every_type() {
            let json = bson_to_json(value.clone());
            let cell = to_value(&json);
            let back = to_ejson(&cell, Some(type_of(&json)))
                .expect("converts")
                .expect("present");
            let bson = json_to_bson(&back).expect("bson");
            assert!(
                same(&value, &bson),
                "{key}: {value:?} → {cell:?} → {bson:?}"
            );
        }
    }

    #[test]
    fn relaxed_input_and_query_operators() {
        let json = Json::parse(
            r#"{"n":1,"big":3000000000,"f":1.5,"when":{"$date":"2024-01-02T00:00:00Z"},"q":{"$gt":5},"r":{"$regex":"^a"}}"#,
        )
        .expect("json");
        let doc = json_to_document(&json).expect("doc");
        assert_eq!(doc.get("n"), Some(&Bson::Int32(1)));
        assert_eq!(doc.get("big"), Some(&Bson::Int64(3_000_000_000)));
        assert_eq!(doc.get("f"), Some(&Bson::Double(1.5)));
        assert!(matches!(doc.get("when"), Some(Bson::DateTime(_))));
        assert_eq!(doc.get("q"), Some(&Bson::Document(doc! { "$gt": 5 })));
        assert_eq!(doc.get("r"), Some(&Bson::Document(doc! { "$regex": "^a" })));
        assert!(json_to_document(&Json::parse("[1]").expect("json")).is_err());
        assert!(
            json_to_document(&Json::parse(r#"{"$oid":"5f2b8c9e1c9d440000a1b2c3"}"#).expect("json"))
                .is_err()
        );
    }
}
