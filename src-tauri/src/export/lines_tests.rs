//! The JSON Lines writer: grid rows as objects, whole MongoDB documents and search hits.

use super::encode::{RowEncoder, encoder};
use super::model::{
    BinaryEncoding, DocumentLines, ExportFormat, ExtendedJsonMode, JsonLinesOptions, JsonNumbers,
};
use crate::db::document::json::Json;
use crate::db::value::{ColumnMeta, Value, ValueKind};

fn encode(options: JsonLinesOptions, names: &[&str], rows: &[Vec<Value>]) -> String {
    let columns: Vec<_> = names
        .iter()
        .map(|name| ColumnMeta {
            name: (*name).into(),
            type_name: String::new(),
            kind: ValueKind::Text,
        })
        .collect();
    let mut writer: Box<dyn RowEncoder> =
        encoder(&ExportFormat::JsonLines { options }).expect("a known format");
    let mut out = Vec::new();
    writer.begin(&columns, &mut out);
    for row in rows {
        writer.row(row, &mut out);
    }
    writer.end(&mut out);
    String::from_utf8(out).expect("utf-8")
}

fn documents(mode: DocumentLines) -> JsonLinesOptions {
    JsonLinesOptions {
        numbers: JsonNumbers::Auto,
        binary: BinaryEncoding::Hex,
        documents: Some(mode),
    }
}

fn doc(text: &str) -> Vec<Value> {
    vec![Value::Json(text.into())]
}

#[test]
fn rows_are_objects_one_per_line() {
    let out = encode(
        JsonLinesOptions::default(),
        &["id", "name"],
        &[
            vec![Value::Int("1".into()), Value::Text("a\nb".into())],
            vec![Value::Int("2".into()), Value::Null],
        ],
    );
    assert_eq!(
        out,
        "{\"id\":1,\"name\":\"a\\nb\"}\n{\"id\":2,\"name\":null}\n"
    );
}

#[test]
fn an_empty_result_is_an_empty_file() {
    assert_eq!(encode(JsonLinesOptions::default(), &["a"], &[]), "");
}

#[test]
fn canonical_documents_keep_every_type_and_the_order_of_fields() {
    let text = r#"{"z":{"$numberInt":"1"},"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c3"},"when":{"$date":{"$numberLong":"0"}}}"#;
    let out = encode(
        documents(DocumentLines::Mongo {
            extended_json: ExtendedJsonMode::Canonical,
        }),
        &["document"],
        &[doc(text)],
    );
    assert_eq!(out, format!("{text}\n"));
}

#[test]
fn relaxed_documents_use_plain_numbers_and_iso_dates() {
    let out = encode(
        documents(DocumentLines::Mongo {
            extended_json: ExtendedJsonMode::Relaxed,
        }),
        &["document"],
        &[doc(
            r#"{"n":{"$numberLong":"7"},"when":{"$date":{"$numberLong":"1700000000123"}}}"#,
        )],
    );
    assert_eq!(
        out,
        "{\"n\":7,\"when\":{\"$date\":\"2023-11-14T22:13:20.123Z\"}}\n"
    );
}

#[test]
fn search_hits_write_their_source_with_the_id_and_index_when_asked() {
    let hit = r#"{"_index":"orders","_id":"7","_score":1.0,"_source":{"total":12.5,"_id":"mine"}}"#;
    let line = |include_id, include_index| {
        encode(
            documents(DocumentLines::Search {
                include_id,
                include_index,
            }),
            &["document"],
            &[doc(hit)],
        )
    };
    assert_eq!(line(false, false), "{\"total\":12.5,\"_id\":\"mine\"}\n");
    assert_eq!(
        line(true, true),
        "{\"_index\":\"orders\",\"total\":12.5,\"_id\":\"mine\"}\n",
        "a field of the source is never overwritten"
    );
    let no_clash = r#"{"_index":"orders","_id":"7","_source":{"total":1}}"#;
    let out = encode(
        documents(DocumentLines::Search {
            include_id: true,
            include_index: true,
        }),
        &["document"],
        &[doc(no_clash)],
    );
    assert_eq!(out, "{\"_index\":\"orders\",\"_id\":\"7\",\"total\":1}\n");
}

#[test]
fn every_line_is_valid_json_even_for_what_is_not_an_object() {
    let out = encode(
        documents(DocumentLines::Mongo {
            extended_json: ExtendedJsonMode::Canonical,
        }),
        &["document"],
        &[doc("[1, 2]"), doc("not json\nat all")],
    );
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "{out}");
    for line in lines {
        assert!(Json::parse(line).is_ok(), "{line}");
    }
}
