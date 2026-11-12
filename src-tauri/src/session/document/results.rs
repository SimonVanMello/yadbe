//! Documents into the result store (rule 8): a grid result whose columns are the top-level
//! fields (the union over the documents, in the order they first appear, `_id` first), and
//! a one-column result holding each whole document as canonical Extended JSON.

use std::collections::HashMap;

use crate::db::document::ejson::{BsonType, kind_of_type, to_value, type_of};
use crate::db::document::json::Json;
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::document::model::DocumentResult;
use crate::session::query_model::{ResultStatus, ResultSummary};
use crate::session::result_store::ResultStore;

/// A result has at most this many columns; further fields show in the documents view only.
const MAX_COLUMNS: usize = 500;

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The grid columns of `documents`, with the BSON types seen in each.
fn columns_of(documents: &[Json]) -> Vec<(String, Vec<BsonType>)> {
    let mut order: Vec<String> = Vec::new();
    let mut types: HashMap<String, Vec<BsonType>> = HashMap::new();
    for document in documents {
        for (key, value) in document.as_object().unwrap_or(&[]) {
            let seen = types.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                Vec::new()
            });
            let ty = type_of(value);
            if !seen.contains(&ty) {
                seen.push(ty);
            }
        }
    }
    if let Some(at) = order.iter().position(|k| k == "_id") {
        let id = order.remove(at);
        order.insert(0, id);
    }
    order.truncate(MAX_COLUMNS);
    order
        .into_iter()
        .map(|key| {
            let seen = types.remove(&key).unwrap_or_default();
            (key, seen)
        })
        .collect()
}

fn column_meta(name: String, types: &[BsonType]) -> ColumnMeta {
    let present: Vec<BsonType> = types
        .iter()
        .copied()
        .filter(|t| *t != BsonType::Null)
        .collect();
    let kinds: Vec<ValueKind> = present.iter().map(|t| kind_of_type(*t)).collect();
    let kind = match kinds.first() {
        Some(first) if kinds.iter().all(|k| k == first) => *first,
        Some(_) => ValueKind::Json,
        None => ValueKind::Text,
    };
    let type_name = match present.as_slice() {
        [] => String::new(),
        [one] => one.alias().to_owned(),
        many => many
            .iter()
            .map(|t| t.alias())
            .collect::<Vec<_>>()
            .join(" | "),
    };
    ColumnMeta {
        name,
        type_name,
        kind,
    }
}

/// Stores `documents` as a grid result and a documents result.
pub fn store_documents(store: &ResultStore, documents: &[Json]) -> DocumentResult {
    let columns = columns_of(documents);
    let grid = store.create(
        columns
            .iter()
            .map(|(name, types)| column_meta(name.clone(), types))
            .collect(),
    );
    let whole = store.create(vec![ColumnMeta {
        name: "document".to_owned(),
        type_name: "object".to_owned(),
        kind: ValueKind::Json,
    }]);
    for chunk in documents.chunks(500) {
        let rows: Vec<Vec<Value>> = chunk
            .iter()
            .map(|document| {
                columns
                    .iter()
                    .map(|(name, _)| document.get(name).map_or(Value::Missing, to_value))
                    .collect()
            })
            .collect();
        grid.append(rows);
        whole.append(
            chunk
                .iter()
                .map(|document| vec![Value::Json(document.to_text())])
                .collect(),
        );
    }
    DocumentResult {
        result: ResultSummary {
            result_id: grid.id(),
            statement_index: 0,
            columns: grid.columns().to_vec(),
            row_count: to_u32(grid.row_count()),
            status: ResultStatus::Complete,
            paused_by: None,
            bytes: to_u32(grid.bytes().saturating_add(whole.bytes())),
            truncated: false,
        },
        documents_id: whole.id(),
        count: to_u32(documents.len()),
    }
}

/// Whole documents `offset .. offset + limit` of a documents result, canonical Extended JSON.
pub fn documents_window(
    store: &ResultStore,
    documents_id: u32,
    offset: u32,
    limit: u32,
) -> Result<Vec<String>, crate::db::errors::YadbeError> {
    let whole = store.get(documents_id)?;
    Ok(whole
        .rows(offset as usize, limit as usize)
        .into_iter()
        .map(|row| match row.into_iter().next() {
            Some(Value::Json(text)) => text,
            _ => "{}".to_owned(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_columns_are_the_union_with_missing_fields() {
        let docs: Vec<Json> = [
            r#"{"name":"a","_id":{"$oid":"5f2b8c9e1c9d440000a1b2c3"},"qty":{"$numberInt":"1"}}"#,
            r#"{"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c4"},"qty":null,"tags":["x"]}"#,
            r#"{"_id":{"$numberInt":"7"},"qty":{"$numberLong":"2"}}"#,
        ]
        .iter()
        .map(|t| Json::parse(t).expect("json"))
        .collect();
        let store = ResultStore::default();
        let result = store_documents(&store, &docs);
        let names: Vec<&str> = result
            .result
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, ["_id", "name", "qty", "tags"]);
        let qty = &result.result.columns[2];
        assert_eq!(
            (qty.kind, qty.type_name.as_str()),
            (ValueKind::Int, "int | long")
        );
        let id = &result.result.columns[0];
        assert_eq!(id.kind, ValueKind::Json, "ObjectId and int: mixed");
        let grid = store.get(result.result.result_id).expect("grid");
        assert_eq!(grid.rows(0, 3)[1][1], Value::Missing, "no name");
        assert_eq!(grid.rows(0, 3)[1][2], Value::Null, "qty is null");
        assert_eq!(
            grid.rows(0, 3)[0][0],
            Value::ObjectId("5f2b8c9e1c9d440000a1b2c3".into())
        );
        let whole = documents_window(&store, result.documents_id, 1, 10).expect("window");
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[0], docs[1].to_text());
        assert_eq!(result.count, 3);
    }
}
