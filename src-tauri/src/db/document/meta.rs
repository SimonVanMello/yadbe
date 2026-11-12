//! What the explorer shows of a document server: databases, collections (views, time
//! series), indexes, and the fields of a collection as a sample of its documents shows them
//! (an estimate: a field absent from the sample does not appear).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::ejson::{BsonType, type_of};
use crate::db::document::json::Json;

/// Documents read to guess the fields of a collection, by default and at most.
pub const DEFAULT_SAMPLE_SIZE: u32 = 200;
pub const MAX_SAMPLE_SIZE: u32 = 1000;
/// Nested paths are followed this deep (`a.b.c.d.e.f`).
const MAX_DEPTH: usize = 6;
/// A sample lists at most this many paths (wide or generated keys).
const MAX_FIELDS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocDatabase {
    pub name: String,
    /// Bytes on disk, as the server reports them.
    pub size_on_disk: Option<f64>,
    pub empty: bool,
    /// `admin`, `local`, `config`.
    pub system: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CollectionKind {
    Collection,
    View,
    Timeseries,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocCollection {
    pub name: String,
    pub kind: CollectionKind,
    /// `system.*` collections.
    pub system: bool,
    pub capped: bool,
    /// The source of a view.
    pub view_on: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocIndex {
    pub name: String,
    /// The key document, relaxed Extended JSON (`{"email":1}`).
    pub keys: String,
    pub unique: bool,
    pub sparse: bool,
    /// Has a `partialFilterExpression`.
    pub partial: bool,
    pub hidden: bool,
    /// TTL index: documents expire after this many seconds.
    pub expire_after_secs: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldTypeCount {
    #[serde(rename = "type")]
    pub ty: BsonType,
    /// Sampled documents where the field has this type (an array counts once per type).
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SampledField {
    /// Dotted path (`address.city`); fields of documents inside arrays use the array's path.
    pub path: String,
    /// The last part of the path.
    pub name: String,
    /// 0 for a top-level field.
    pub depth: u32,
    /// Sampled documents that have the field.
    pub present: u32,
    /// Types seen, most frequent first.
    pub types: Vec<FieldTypeCount>,
}

/// The fields of a collection, estimated from a sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldSample {
    /// Documents read (fewer than asked in a small collection).
    pub sampled: u32,
    pub fields: Vec<SampledField>,
    /// More paths than listed were seen.
    pub truncated: bool,
}

#[derive(Default)]
struct PathStats {
    order: usize,
    present: u32,
    types: HashMap<BsonType, u32>,
}

/// The field paths of `documents`: parents before their children, siblings in the order
/// they first appear (`_id` first).
pub fn sample_fields(documents: &[Json]) -> FieldSample {
    let mut stats: HashMap<String, PathStats> = HashMap::new();
    let mut truncated = false;
    for document in documents {
        let mut seen: Vec<(String, Vec<BsonType>)> = Vec::new();
        if let Some(entries) = document.as_object() {
            walk(entries, "", 0, &mut seen);
        }
        for (path, types) in seen {
            let next = stats.len();
            if !stats.contains_key(&path) && next >= MAX_FIELDS {
                truncated = true;
                continue;
            }
            let entry = stats.entry(path).or_insert_with(|| PathStats {
                order: next,
                ..PathStats::default()
            });
            entry.present += 1;
            let mut distinct = types;
            distinct.sort();
            distinct.dedup();
            for ty in distinct {
                *entry.types.entry(ty).or_default() += 1;
            }
        }
    }
    let mut children: HashMap<String, Vec<(usize, String)>> = HashMap::new();
    for (path, stat) in &stats {
        let rank = if path == "_id" { 0 } else { stat.order + 1 };
        children
            .entry(parent(path).to_owned())
            .or_default()
            .push((rank, path.clone()));
    }
    let mut ordered = Vec::with_capacity(stats.len());
    let mut stack: Vec<String> = Vec::new();
    let mut push_children = |parent: &str, stack: &mut Vec<String>| {
        if let Some(mut kids) = children.remove(parent) {
            kids.sort();
            stack.extend(kids.into_iter().rev().map(|(_, path)| path));
        }
    };
    push_children("", &mut stack);
    while let Some(path) = stack.pop() {
        push_children(&path, &mut stack);
        ordered.push(path);
    }
    let fields = ordered
        .into_iter()
        .filter_map(|path| {
            let stats = stats.remove(&path)?;
            let mut types: Vec<FieldTypeCount> = stats
                .types
                .into_iter()
                .map(|(ty, count)| FieldTypeCount { ty, count })
                .collect();
            types.sort_by(|a, b| b.count.cmp(&a.count).then(a.ty.cmp(&b.ty)));
            let depth = path.matches('.').count();
            Some(SampledField {
                name: path.rsplit('.').next().unwrap_or(&path).to_owned(),
                depth: u32::try_from(depth).unwrap_or(u32::MAX),
                present: stats.present,
                types,
                path,
            })
        })
        .collect();
    FieldSample {
        sampled: u32::try_from(documents.len()).unwrap_or(u32::MAX),
        fields,
        truncated,
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('.').map_or("", |(p, _)| p)
}

fn walk(
    entries: &[(String, Json)],
    prefix: &str,
    depth: usize,
    seen: &mut Vec<(String, Vec<BsonType>)>,
) {
    for (key, value) in entries {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let ty = type_of(value);
        match seen.iter_mut().find(|(p, _)| *p == path) {
            Some((_, types)) => types.push(ty),
            None => seen.push((path.clone(), vec![ty])),
        }
        if depth + 1 >= MAX_DEPTH {
            continue;
        }
        match (ty, value) {
            (BsonType::Object, Json::Object(children)) => walk(children, &path, depth + 1, seen),
            (BsonType::Array, Json::Array(items)) => {
                for item in items {
                    if let (BsonType::Object, Json::Object(children)) = (type_of(item), item) {
                        walk(children, &path, depth + 1, seen);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_paths_types_and_frequency() {
        let docs: Vec<Json> = [
            r#"{"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c3"},"name":"a","qty":{"$numberInt":"1"},"address":{"city":"Lyon"}}"#,
            r#"{"_id":{"$oid":"5f2b8c9e1c9d440000a1b2c4"},"name":null,"qty":{"$numberLong":"2"},"items":[{"sku":"x"},{"sku":"y","n":1}]}"#,
            r#"{"name":"c","_id":{"$numberInt":"3"}}"#,
        ]
        .iter()
        .map(|t| Json::parse(t).expect("json"))
        .collect();
        let sample = sample_fields(&docs);
        assert_eq!(sample.sampled, 3);
        let paths: Vec<&str> = sample.fields.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "_id",
                "name",
                "qty",
                "address",
                "address.city",
                "items",
                "items.sku",
                "items.n"
            ]
        );
        let field = |p: &str| sample.fields.iter().find(|f| f.path == p).expect(p);
        assert_eq!(field("_id").present, 3);
        assert_eq!(
            field("_id").types,
            vec![
                FieldTypeCount {
                    ty: BsonType::ObjectId,
                    count: 2
                },
                FieldTypeCount {
                    ty: BsonType::Int,
                    count: 1
                },
            ]
        );
        assert_eq!(field("qty").present, 2);
        assert_eq!(field("items.sku").present, 1, "counted once per document");
        assert_eq!(field("items.sku").depth, 1);
        assert_eq!(field("address.city").name, "city");
        assert!(!sample.truncated);
    }
}
