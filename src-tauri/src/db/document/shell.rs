//! Canonical Extended JSON written as mongosh literals (`ObjectId("…")`, `NumberInt(1)`,
//! `ISODate("…")`), for what the user reads before an apply and in the journal: the text runs
//! in mongosh and writes the same BSON types. Nothing here is ever sent to a server: the
//! operations travel as structured documents (rule 2).

use crate::db::document::ejson::{base64_decode, format_millis};
use crate::db::document::json::Json;

fn quoted(text: &str) -> String {
    Json::string(text).to_text()
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, as mongosh prints a date.
pub fn iso_millis(ms: i64) -> Option<String> {
    let text = format_millis(ms)?;
    let text = text.strip_suffix("+00")?.replacen(' ', "T", 1);
    Some(if text.contains('.') {
        format!("{text}Z")
    } else {
        format!("{text}.000Z")
    })
}

fn date_text(body: &Json) -> String {
    let millis = match body {
        Json::String(iso) => return format!("ISODate({})", quoted(iso)),
        Json::Number(n) => n.as_i64(),
        _ => body
            .get("$numberLong")
            .and_then(Json::as_str)
            .and_then(|t| t.parse().ok()),
    };
    match millis {
        Some(ms) => match iso_millis(ms) {
            Some(iso) => format!("ISODate({})", quoted(&iso)),
            None => format!("new Date({ms})"),
        },
        None => format!(
            "EJSON.deserialize({})",
            Json::object([("$date", body.clone())])
        ),
    }
}

fn binary_text(body: &Json) -> String {
    let base64 = body.get("base64").and_then(Json::as_str).unwrap_or("");
    let subtype = body.get("subType").and_then(Json::as_str).unwrap_or("00");
    if matches!(subtype, "04" | "4")
        && let Some(bytes) = base64_decode(base64)
        && bytes.len() == 16
    {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        return format!(
            "UUID(\"{}-{}-{}-{}-{}\")",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        );
    }
    let sub = u8::from_str_radix(subtype, 16).unwrap_or(0);
    format!("BinData({sub}, {})", quoted(base64))
}

/// The mongosh literal of a wrapped value (`{"$oid": …}`), `None` for a plain document.
fn wrapped(entries: &[(String, Json)]) -> Option<String> {
    let [(key, body)] = entries else {
        return None;
    };
    let text = body.as_str();
    Some(match (key.as_str(), text) {
        ("$oid", Some(hex)) => format!("ObjectId({})", quoted(hex)),
        ("$numberInt", Some(n)) => format!("NumberInt({n})"),
        ("$numberLong", Some(n)) => format!("NumberLong({})", quoted(n)),
        ("$numberDecimal", Some(n)) => format!("NumberDecimal({})", quoted(n)),
        ("$numberDouble", Some(n)) => match n {
            "NaN" | "-NaN" => "Double(NaN)".to_owned(),
            "Infinity" => "Double(Infinity)".to_owned(),
            "-Infinity" => "Double(-Infinity)".to_owned(),
            // mongosh writes a whole JavaScript number as an Int32: `Double` keeps the type.
            n if n.parse::<f64>().is_ok_and(|f| f.fract() == 0.0) => {
                format!("Double({})", n.trim_end_matches(".0"))
            }
            n => n.to_owned(),
        },
        ("$date", _) => date_text(body),
        ("$binary", _) => binary_text(body),
        ("$regularExpression", _) => format!(
            "RegExp({}, {})",
            quoted(body.get("pattern").and_then(Json::as_str).unwrap_or("")),
            quoted(body.get("options").and_then(Json::as_str).unwrap_or(""))
        ),
        ("$timestamp", _) => format!(
            "Timestamp({{ t: {}, i: {} }})",
            body.get("t").map_or_else(|| "0".to_owned(), Json::to_text),
            body.get("i").map_or_else(|| "0".to_owned(), Json::to_text)
        ),
        ("$minKey", _) => "MinKey()".to_owned(),
        ("$maxKey", _) => "MaxKey()".to_owned(),
        ("$code", Some(code)) => format!("Code({})", quoted(code)),
        ("$symbol" | "$undefined" | "$dbPointer" | "$uuid", _) => format!(
            "EJSON.deserialize({})",
            Json::object([(key.clone(), body.clone())])
        ),
        _ => return None,
    })
}

/// `value` (canonical or relaxed Extended JSON) as mongosh writes it.
pub fn shell_text(value: &Json) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Json, out: &mut String) {
    match value {
        Json::Object(entries) => {
            if let Some(text) = wrapped(entries) {
                out.push_str(&text);
                return;
            }
            if let [(a, code), (b, scope)] = entries.as_slice()
                && a == "$code"
                && b == "$scope"
            {
                out.push_str(&format!("Code({}, {})", code.to_text(), shell_text(scope)));
                return;
            }
            out.push('{');
            for (i, (key, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&quoted(key));
                out.push_str(": ");
                write(item, out);
            }
            out.push('}');
        }
        Json::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_text()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_typed_literals() {
        let doc = Json::parse(
            r#"{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"},"n":{"$numberInt":"5"},"l":{"$numberLong":"9007199254740993"},
            "d":{"$numberDouble":"2.0"},"f":{"$numberDouble":"2.5"},"x":{"$numberDouble":"NaN"},
            "m":{"$numberDecimal":"1.10"},"t":{"$date":{"$numberLong":"0"}},"s":"a\"b",
            "u":{"$binary":{"base64":"AAECAwQFBgcICQoLDA0ODw==","subType":"04"}},"a":[true,null]}"#,
        )
        .expect("json");
        assert_eq!(
            shell_text(&doc),
            r#"{"_id": ObjectId("64b7f0c2a1b2c3d4e5f60718"), "n": NumberInt(5), "l": NumberLong("9007199254740993"), "d": Double(2), "f": 2.5, "x": Double(NaN), "m": NumberDecimal("1.10"), "t": ISODate("1970-01-01T00:00:00.000Z"), "s": "a\"b", "u": UUID("00010203-0405-0607-0809-0a0b0c0d0e0f"), "a": [true, null]}"#
        );
    }
}
