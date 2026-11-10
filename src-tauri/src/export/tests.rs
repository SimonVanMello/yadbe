use super::encode::{RowEncoder, encoder};
use super::model::{
    BinaryEncoding, CsvDelimiter, CsvOptions, CsvQuote, ExportFormat, JsonLayout, JsonNumbers,
    JsonOptions, LineEnding,
};
use crate::db::value::{ColumnMeta, Value, ValueKind};

fn column(name: &str) -> ColumnMeta {
    ColumnMeta {
        name: name.into(),
        type_name: String::new(),
        kind: ValueKind::Text,
    }
}

fn encode(format: &ExportFormat, names: &[&str], rows: &[Vec<Value>]) -> Vec<u8> {
    let columns: Vec<_> = names.iter().map(|n| column(n)).collect();
    let mut encoder: Box<dyn RowEncoder> = encoder(format);
    let mut out = Vec::new();
    encoder.begin(&columns, &mut out);
    for row in rows {
        encoder.row(row, &mut out);
    }
    encoder.end(&mut out);
    out
}

fn csv(options: CsvOptions, names: &[&str], rows: &[Vec<Value>]) -> String {
    String::from_utf8(encode(&ExportFormat::Csv { options }, names, rows)).expect("utf-8")
}

fn json(options: JsonOptions, names: &[&str], rows: &[Vec<Value>]) -> String {
    String::from_utf8(encode(&ExportFormat::Json { options }, names, rows)).expect("utf-8")
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

#[test]
fn csv_quotes_delimiters_quotes_and_line_breaks() {
    let out = csv(
        CsvOptions::default(),
        &["a", "b,c"],
        &[
            vec![text("plain"), text("x,y")],
            vec![text("say \"hi\""), text("two\nlines")],
            vec![text("é😀"), text("cr\rhere")],
        ],
    );
    assert_eq!(
        out,
        "a,\"b,c\"\nplain,\"x,y\"\n\"say \"\"hi\"\"\",\"two\nlines\"\né😀,\"cr\rhere\"\n"
    );
}

#[test]
fn csv_tells_null_from_empty_and_honors_the_null_text() {
    let rows = [vec![Value::Null, text(""), Value::Int("0".into())]];
    assert_eq!(
        csv(CsvOptions::default(), &["a", "b", "c"], &rows),
        "a,b,c\n,\"\",0\n"
    );
    let options = CsvOptions {
        null_text: "NULL".into(),
        ..CsvOptions::default()
    };
    assert_eq!(csv(options, &["a", "b", "c"], &rows), "a,b,c\nNULL,,0\n");
}

#[test]
fn csv_options_delimiter_header_line_ending_and_bom() {
    let options = CsvOptions {
        delimiter: CsvDelimiter::Semicolon,
        header: false,
        line_ending: LineEnding::Crlf,
        bom: true,
        ..CsvOptions::default()
    };
    let out = csv(options, &["a", "b"], &[vec![text("1;2"), text("3,4")]]);
    assert_eq!(out, "\u{feff}\"1;2\";3,4\r\n");
    let tab = CsvOptions {
        delimiter: CsvDelimiter::Tab,
        ..CsvOptions::default()
    };
    assert_eq!(
        csv(tab, &["a", "b"], &[vec![text("x\ty"), text("z")]]),
        "a\tb\n\"x\ty\"\tz\n"
    );
}

#[test]
fn csv_quote_rules() {
    let rows = [vec![
        text("t"),
        Value::Int("1".into()),
        Value::Bool(true),
        Value::Null,
    ]];
    let all = CsvOptions {
        quote: CsvQuote::All,
        ..CsvOptions::default()
    };
    assert_eq!(
        csv(all, &["a", "b", "c", "d"], &rows),
        "\"a\",\"b\",\"c\",\"d\"\n\"t\",\"1\",\"true\",\n"
    );
    let non_numeric = CsvOptions {
        quote: CsvQuote::NonNumeric,
        ..CsvOptions::default()
    };
    assert_eq!(
        csv(non_numeric, &["a", "b", "c", "d"], &rows),
        "\"a\",\"b\",\"c\",\"d\"\n\"t\",1,true,\n"
    );
}

#[test]
fn csv_writes_binary_arrays_and_exact_numbers() {
    let rows = [vec![
        Value::bytes(&[0, 255, 16]),
        Value::Array(vec![Value::int(1), Value::Null, Value::Text("a,b".into())]),
        Value::Decimal("12345678901234567890.123456789".into()),
        Value::Int("9223372036854775807".into()),
    ]];
    assert_eq!(
        csv(CsvOptions::default(), &["b", "a", "d", "i"], &rows),
        "b,a,d,i\n00ff10,\"[1,null,\"\"a,b\"\"]\",12345678901234567890.123456789,9223372036854775807\n"
    );
    let base64 = CsvOptions {
        binary: BinaryEncoding::Base64,
        ..CsvOptions::default()
    };
    assert!(csv(base64, &["b", "a", "d", "i"], &rows).starts_with("b,a,d,i\nAP8Q,"));
}

#[test]
fn json_array_has_one_object_per_line() {
    let out = json(
        JsonOptions::default(),
        &["id", "name"],
        &[
            vec![Value::int(1), text("a\"b\n")],
            vec![Value::Null, Value::Bool(false)],
        ],
    );
    assert_eq!(
        out,
        "[\n{\"id\":1,\"name\":\"a\\\"b\\n\"},\n{\"id\":null,\"name\":false}\n]\n"
    );
    serde_json::from_str::<serde_json::Value>(&out).expect("valid json");
    let empty = json(JsonOptions::default(), &["id"], &[]);
    assert_eq!(empty, "[]\n");
}

#[test]
fn ndjson_has_no_enclosing_array() {
    let options = JsonOptions {
        layout: JsonLayout::Ndjson,
        ..JsonOptions::default()
    };
    let out = json(
        options,
        &["a"],
        &[vec![Value::int(1)], vec![Value::Text("x".into())]],
    );
    assert_eq!(out, "{\"a\":1}\n{\"a\":\"x\"}\n");
}

#[test]
fn json_numbers_are_numbers_only_when_exact() {
    let rows = [vec![
        Value::Int("9007199254740992".into()),
        Value::Int("9007199254740993".into()),
        Value::Int("-42".into()),
        Value::Decimal("123456789012345".into()),
        Value::Decimal("12345678901234567890.123".into()),
        Value::Decimal("1.50".into()),
        Value::Decimal("NaN".into()),
        Value::Float("0.1".into()),
        Value::Float("1e300".into()),
        Value::Float("Infinity".into()),
        Value::Decimal(".5".into()),
    ]];
    let names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    let out = json(JsonOptions::default(), &names, &rows);
    let parsed: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    let object = &parsed[0];
    assert!(object["a"].is_number());
    assert_eq!(object["b"], "9007199254740993");
    assert_eq!(object["c"], -42);
    assert!(object["d"].is_number());
    assert_eq!(object["e"], "12345678901234567890.123");
    assert!(out.contains("\"f\":1.50"), "scale kept: {out}");
    assert_eq!(object["g"], "NaN");
    assert!(object["h"].is_number() && object["i"].is_number());
    assert_eq!(object["j"], "Infinity");
    assert_eq!(object["k"], ".5");
    let strings = JsonOptions {
        numbers: JsonNumbers::Strings,
        ..JsonOptions::default()
    };
    let forced = json(strings, &names, &rows);
    let parsed: serde_json::Value = serde_json::from_str(&forced).expect("valid json");
    assert_eq!(parsed[0]["a"], "9007199254740992");
    assert_eq!(parsed[0]["h"], "0.1");
}

#[test]
fn json_binary_json_arrays_and_dates() {
    let rows = [vec![
        Value::bytes(&[0, 255, 16]),
        Value::Json("{ \"a\" : [1, 12345678901234567890.5],\n \"s\": \"x y\" }".into()),
        Value::Json("not json".into()),
        Value::Array(vec![Value::int(1), Value::Null, Value::Array(vec![])]),
        Value::Date("2025-01-31".into()),
    ]];
    let names = ["b", "j", "bad", "arr", "d"];
    let out = json(JsonOptions::default(), &names, &rows);
    assert!(out.contains("\"b\":\"00ff10\""));
    assert!(
        out.contains("\"j\":{\"a\":[1,12345678901234567890.5],\"s\":\"x y\"}"),
        "{out}"
    );
    assert!(out.contains("\"bad\":\"not json\""));
    assert!(out.contains("\"arr\":[1,null,[]]"));
    assert!(out.contains("\"d\":\"2025-01-31\""));
    let base64 = JsonOptions {
        binary: BinaryEncoding::Base64,
        ..JsonOptions::default()
    };
    assert!(json(base64, &names, &rows).contains("\"b\":\"AP8Q\""));
}

#[test]
fn ndjson_keeps_json_cells_on_one_line() {
    let options = JsonOptions {
        layout: JsonLayout::Ndjson,
        ..JsonOptions::default()
    };
    let out = json(
        options,
        &["j"],
        &[vec![Value::Json("{\n  \"a\": 1\n}".into())]],
    );
    assert_eq!(out, "{\"j\":{\"a\":1}}\n");
}
