//! JSON Lines writer: one JSON value per line, no enclosing array.
//!
//! Rows of a grid are written as objects, by the same code as the JSON format's NDJSON layout.
//! When the source holds whole documents (the `document` column of a MongoDB or search result)
//! each document is written as it is: canonical or relaxed Extended JSON for MongoDB, the raw
//! `_source` for search, never flattened into columns.

use super::encode::RowEncoder;
use super::json::JsonEncoder;
use super::model::{DocumentLines, ExtendedJsonMode, JsonLayout, JsonLinesOptions, JsonOptions};
use crate::db::document::json::Json;
use crate::db::value::{ColumnMeta, Value};

pub struct JsonLinesEncoder {
    documents: Option<DocumentLines>,
    rows: JsonEncoder,
}

impl JsonLinesEncoder {
    pub fn new(options: JsonLinesOptions) -> Self {
        Self {
            documents: options.documents,
            rows: JsonEncoder::new(JsonOptions {
                layout: JsonLayout::Ndjson,
                numbers: options.numbers,
                binary: options.binary,
            }),
        }
    }
}

/// The line of one document, `None` when its text is not a JSON object (then it is written as
/// it came, on one line).
fn document_line(text: &str, mode: DocumentLines) -> Option<String> {
    let json = Json::parse(text).ok()?;
    json.as_object()?;
    Some(match mode {
        DocumentLines::Mongo {
            extended_json: ExtendedJsonMode::Canonical,
        } => json.to_text(),
        DocumentLines::Mongo {
            extended_json: ExtendedJsonMode::Relaxed,
        } => json.to_relaxed().to_text(),
        DocumentLines::Search {
            include_id,
            include_index,
        } => source_of(&json, include_id, include_index).to_text(),
    })
}

/// A hit's `_source`, with `_index` and `_id` before its own fields when asked (a field the
/// source already has under that name is kept as the source wrote it).
fn source_of(hit: &Json, include_id: bool, include_index: bool) -> Json {
    let Some(Json::Object(source)) = hit.get("_source") else {
        // A hit without `_source` (stored fields only): the hit itself.
        return hit.clone();
    };
    let mut entries: Vec<(String, Json)> = Vec::with_capacity(source.len() + 2);
    for (include, name) in [(include_index, "_index"), (include_id, "_id")] {
        if include
            && !source.iter().any(|(key, _)| key == name)
            && let Some(value) = hit.get(name)
        {
            entries.push((name.to_owned(), value.clone()));
        }
    }
    entries.extend(source.iter().cloned());
    Json::Object(entries)
}

impl RowEncoder for JsonLinesEncoder {
    fn begin(&mut self, columns: &[ColumnMeta], out: &mut Vec<u8>) {
        self.rows.begin(columns, out);
    }

    fn row(&mut self, row: &[Value], out: &mut Vec<u8>) {
        let Some(mode) = self.documents else {
            self.rows.row(row, out);
            return;
        };
        let text = match row.first() {
            Some(Value::Json(text) | Value::Text(text)) => text.as_str(),
            _ => "null",
        };
        let line = document_line(text, mode).unwrap_or_else(|| {
            // Not an object: keep it valid, on one line.
            Json::parse(text).map_or_else(|_| Json::string(text).to_text(), |json| json.to_text())
        });
        out.extend_from_slice(line.as_bytes());
        out.push(b'\n');
    }

    fn end(&mut self, out: &mut Vec<u8>) {
        self.rows.end(out);
    }
}
