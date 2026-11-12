//! Search hits as grid rows: the columns are `_index`, `_id`, `_score`, then the fields of
//! `_source` flattened to dotted paths (`customer.name`), the union over the hits in the order
//! they first appear. Arrays stay whole (one JSON cell); a field a hit lacks is `missing`.

use std::collections::HashMap;

use crate::db::document::json::Json;
use crate::db::value::{ColumnMeta, Value, ValueKind};

/// A result has at most this many columns; further fields show in the documents view only.
pub const MAX_COLUMNS: usize = 500;

/// The metadata columns, before the fields of `_source`.
pub const META_COLUMNS: [&str; 3] = ["_index", "_id", "_score"];

/// The JSON type of a value, as a column's type when no mapping says better.
fn json_type(value: &Json) -> &'static str {
    match value {
        Json::Null => "null",
        Json::Bool(_) => "boolean",
        Json::Number(n) if n.is_f64() => "double",
        Json::Number(_) => "long",
        Json::String(_) => "string",
        Json::Array(_) => "array",
        Json::Object(_) => "object",
    }
}

fn kind_of(value: &Json) -> Option<ValueKind> {
    match value {
        Json::Null => None,
        Json::Bool(_) => Some(ValueKind::Bool),
        Json::Number(n) if n.is_f64() => Some(ValueKind::Float),
        Json::Number(_) => Some(ValueKind::Int),
        Json::String(_) => Some(ValueKind::Text),
        Json::Array(_) | Json::Object(_) => Some(ValueKind::Json),
    }
}

/// A JSON value as a grid cell: 64-bit integers stay exact (as text).
pub fn to_cell(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => match n.as_f64() {
            Some(_) if n.is_f64() => Value::Float(n.to_string()),
            _ => Value::Int(n.to_string()),
        },
        Json::String(s) => Value::Text(s.clone()),
        Json::Array(_) | Json::Object(_) => Value::Json(value.to_text()),
    }
}

/// `_source` flattened: each leaf (or array, or empty object) with its dotted path.
pub fn flatten(source: &Json) -> Vec<(String, &Json)> {
    fn walk<'a>(prefix: &str, value: &'a Json, out: &mut Vec<(String, &'a Json)>) {
        match value {
            Json::Object(entries) if !entries.is_empty() => {
                for (key, child) in entries {
                    let path = if prefix.is_empty() {
                        key.clone()
                    } else {
                        format!("{prefix}.{key}")
                    };
                    walk(&path, child, out);
                }
            }
            _ => out.push((prefix.to_owned(), value)),
        }
    }
    let mut out = Vec::new();
    if let Json::Object(entries) = source {
        for (key, child) in entries {
            walk(key, child, &mut out);
        }
    }
    out
}

/// The cells of one hit, by column name.
fn cells_of(hit: &Json) -> HashMap<String, &Json> {
    let mut cells: HashMap<String, &Json> = HashMap::new();
    for meta in META_COLUMNS {
        if let Some(value) = hit.get(meta) {
            cells.insert(meta.to_owned(), value);
        }
    }
    if let Some(source) = hit.get("_source") {
        for (path, value) in flatten(source) {
            cells.entry(path).or_insert(value);
        }
    }
    cells
}

/// Grid columns and rows of `hits`. `types` gives a field's mapping type when known (an
/// index tab), shown instead of the JSON types seen.
pub fn hit_rows(
    hits: &[Json],
    types: &HashMap<String, String>,
) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    let mut order: Vec<String> = META_COLUMNS.iter().map(|m| (*m).to_owned()).collect();
    let mut seen: HashMap<String, (Vec<&'static str>, Vec<ValueKind>)> = HashMap::new();
    let per_hit: Vec<HashMap<String, &Json>> = hits.iter().map(cells_of).collect();
    for (hit, cells) in hits.iter().zip(&per_hit) {
        let mut paths: Vec<&String> = Vec::new();
        for meta in META_COLUMNS {
            if let Some((key, _)) = cells.get_key_value(meta) {
                paths.push(key);
            }
        }
        if let Some(source) = hit.get("_source") {
            for (path, _) in flatten(source) {
                if let Some((key, _)) = cells.get_key_value(&path) {
                    paths.push(key);
                }
            }
        }
        for path in paths {
            let value = cells[path];
            let entry = seen.entry(path.clone()).or_insert_with(|| {
                if !order.contains(path) {
                    order.push(path.clone());
                }
                (Vec::new(), Vec::new())
            });
            let ty = json_type(value);
            if ty != "null" && !entry.0.contains(&ty) {
                entry.0.push(ty);
            }
            if let Some(kind) = kind_of(value)
                && !entry.1.contains(&kind)
            {
                entry.1.push(kind);
            }
        }
    }
    order.truncate(MAX_COLUMNS);
    let columns = order
        .iter()
        .map(|name| {
            let (json_types, kinds) = seen.get(name).cloned().unwrap_or_default();
            let kind = match kinds.as_slice() {
                [] => ValueKind::Text,
                [one] => *one,
                many if many
                    .iter()
                    .all(|k| matches!(k, ValueKind::Int | ValueKind::Float)) =>
                {
                    ValueKind::Float
                }
                _ => ValueKind::Json,
            };
            let type_name = types
                .get(name)
                .cloned()
                .unwrap_or_else(|| json_types.join(" | "));
            ColumnMeta {
                name: name.clone(),
                type_name,
                kind,
            }
        })
        .collect();
    let rows = per_hit
        .iter()
        .map(|cells| {
            order
                .iter()
                .map(|name| cells.get(name).map_or(Value::Missing, |v| to_cell(v)))
                .collect()
        })
        .collect();
    (columns, rows)
}

/// The rows of a tabular answer: ES|QL (`columns` + `values`) or SQL (`columns` + `rows`).
pub fn table_rows(response: &Json) -> Option<(Vec<ColumnMeta>, Vec<Vec<Value>>)> {
    let columns = response.get("columns")?.as_array()?;
    let rows = response
        .get("values")
        .or_else(|| response.get("rows"))?
        .as_array()?;
    let metas: Vec<ColumnMeta> = columns
        .iter()
        .map(|column| {
            let type_name = column
                .get("type")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned();
            let kind = match type_name.as_str() {
                "long" | "integer" | "short" | "byte" | "unsigned_long" | "counter_long"
                | "counter_integer" => ValueKind::Int,
                "double" | "float" | "half_float" | "scaled_float" | "counter_double" => {
                    ValueKind::Float
                }
                "boolean" => ValueKind::Bool,
                _ => ValueKind::Text,
            };
            ColumnMeta {
                name: column
                    .get("name")
                    .and_then(Json::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                type_name,
                kind,
            }
        })
        .collect();
    let values = rows
        .iter()
        .map(|row| {
            let cells = row.as_array().unwrap_or(&[]);
            (0..metas.len())
                .map(|i| cells.get(i).map_or(Value::Null, to_cell))
                .collect()
        })
        .collect();
    Some((metas, values))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hits_flatten_into_the_union_of_their_fields() {
        let hits: Vec<Json> = [
            r#"{"_index":"o","_id":"1","_score":1.0,"_source":{"name":"a","customer":{"id":9007199254740993,"tags":["x"]}}}"#,
            r#"{"_index":"o","_id":"2","_score":null,"_source":{"price":12.5,"customer":{}}}"#,
        ]
        .iter()
        .map(|t| Json::parse(t).expect("json"))
        .collect();
        let mut types = HashMap::new();
        types.insert("price".to_owned(), "scaled_float".to_owned());
        let (columns, rows) = hit_rows(&hits, &types);
        let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "_index",
                "_id",
                "_score",
                "name",
                "customer.id",
                "customer.tags",
                "price",
                "customer"
            ]
        );
        assert_eq!(rows[0][4], Value::Int("9007199254740993".into()), "exact");
        assert_eq!(rows[0][5], Value::Json(r#"["x"]"#.into()));
        assert_eq!(rows[1][3], Value::Missing);
        assert_eq!(rows[1][2], Value::Null);
        assert_eq!(rows[1][6], Value::Float("12.5".into()));
        assert_eq!(columns[6].type_name, "scaled_float");
        assert_eq!(columns[4].kind, ValueKind::Int);
        assert_eq!(columns[2].kind, ValueKind::Float);
    }

    #[test]
    fn esql_and_sql_answers_are_tables() {
        let esql = Json::parse(
            r#"{"columns":[{"name":"n","type":"long"},{"name":"s","type":"keyword"}],"values":[[1,"a"],[2,null]]}"#,
        )
        .expect("json");
        let (columns, rows) = table_rows(&esql).expect("a table");
        assert_eq!(columns[0].kind, ValueKind::Int);
        assert_eq!(rows[1], [Value::Int("2".into()), Value::Null]);
        let sql = Json::parse(r#"{"columns":[{"name":"x","type":"text"}],"rows":[["t"]]}"#)
            .expect("json");
        assert_eq!(
            table_rows(&sql).expect("a table").1[0][0],
            Value::Text("t".into())
        );
        assert!(table_rows(&Json::parse(r#"{"hits":{}}"#).expect("json")).is_none());
    }
}
