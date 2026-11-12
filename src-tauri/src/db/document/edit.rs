//! Edits of a collection's documents (M4-4, rule 10), planned without the driver: each
//! changed document becomes one targeted operation whose filter is the optimistic-concurrency
//! guard, so that `matchedCount == 1` means "the server still holds what the user saw".
//!
//! - **Fields** changed or unset: `updateOne({_id, $expr: <guards>}, {$set, $unset})`, only
//!   the touched paths written. Each path is guarded by the value the user saw there.
//! - **A document edited as JSON**: `replaceOne({_id, $expr: <the whole original>}, …)`.
//! - **Delete**: `deleteOne({_id, $expr: <the whole original>})`: a document changed since it
//!   was read is not deleted (the same rule as an SQL row, F-089), and the journal can insert
//!   back exactly what was deleted.
//! - **Insert**: `insertOne(doc)`, with an `_id` generated here when it has none (as the
//!   drivers do), so the journal knows which document to delete on a revert.
//!
//! Guards are aggregation expressions (`$expr`), not query predicates: a query predicate
//! matches an array that merely contains the value (`{a: 1}` matches `a: [1, 2]`) and treats
//! numbers of every type as equal. `$eq` between expressions compares whole values (an
//! embedded document field by field, in order; an array element by element) and `$type`
//! makes numbers type-exact (Int32 1 is not Double 1.0), at the value and at every number
//! inside it. A path is reached with `$getField` / `$arrayElemAt` behind type tests, so a
//! document whose shape changed fails the guard instead of failing the command.
//!
//! Known limits (the guard is BSON comparison plus number types): `0.0` vs `-0.0` and
//! Decimal128 `1.0` vs `1.00` compare equal; a symbol nested in a value compares equal to
//! the same string.

use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::ejson::{BsonType, canonical_double, parse_millis, type_of};
use crate::db::document::json::Json;
use crate::db::document::ops::{DocOp, Namespace};
use crate::db::document::shell::shell_text;
use crate::db::errors::YadbeError;

/// Type checks a single guard may hold (numbers inside the guarded values): beyond, the
/// document is too large to be checked type-exactly and the change is refused.
pub const MAX_TYPE_CHECKS: usize = 2_000;
/// Operations one apply may hold.
pub const MAX_EDITS: usize = 5_000;
/// The inverse a journal entry keeps at most (the documents a revert writes back): above, the
/// entry is journaled but cannot be reverted.
pub const MAX_INVERSE_BYTES: usize = 16 * 1024 * 1024;

/// One step of a path: a field name, or an array index.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum PathSeg {
    Index(u32),
    Field(String),
}

/// A field to set or unset in a document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldEdit {
    pub path: Vec<PathSeg>,
    /// What the user saw there, Extended JSON; `null`: the field was missing (not null).
    pub original: Option<String>,
    /// What to write, Extended JSON (canonical or relaxed); `null`: unset the field.
    pub value: Option<String>,
}

/// One change of a collection's documents. `id` and documents are Extended JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DocEdit {
    /// Sets and unsets fields of the document `id`.
    Update { id: String, fields: Vec<FieldEdit> },
    /// Replaces the document `id` (edited as JSON); `original` is the whole document as read.
    Replace {
        id: String,
        original: String,
        replacement: String,
    },
    /// Deletes the document `id`; `original` is the whole document as read.
    Delete { id: String, original: String },
    /// Inserts a document; an `_id` is generated when it has none.
    Insert { document: String },
}

/// The changes an apply sends, on one collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocChangeSet {
    pub database: String,
    pub collection: String,
    pub edits: Vec<DocEdit>,
}

/// What an operation does, for counts and conflicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DocOpKind {
    Update,
    Replace,
    Delete,
    Insert,
}

/// A change made exact: values canonical, the inserted `_id` known. What the inverse and the
/// conflicts are computed from.
#[derive(Debug, Clone, PartialEq)]
pub enum Exact {
    Update {
        id: Json,
        /// Path, value seen (`None`: missing), value written (`None`: unset).
        fields: Vec<(Vec<PathSeg>, Option<Json>, Option<Json>)>,
    },
    Replace {
        id: Json,
        original: Json,
        replacement: Json,
    },
    Delete {
        id: Json,
        original: Json,
    },
    Insert {
        document: Json,
    },
}

impl Exact {
    pub fn kind(&self) -> DocOpKind {
        match self {
            Exact::Update { .. } => DocOpKind::Update,
            Exact::Replace { .. } => DocOpKind::Replace,
            Exact::Delete { .. } => DocOpKind::Delete,
            Exact::Insert { .. } => DocOpKind::Insert,
        }
    }

    pub fn id(&self) -> Json {
        match self {
            Exact::Update { id, .. } | Exact::Replace { id, .. } | Exact::Delete { id, .. } => {
                id.clone()
            }
            Exact::Insert { document } => document.get("_id").cloned().unwrap_or(Json::Null),
        }
    }

    /// Back to the wire form (canonical texts).
    pub fn to_edit(&self) -> DocEdit {
        let text = |j: &Json| j.to_text();
        match self {
            Exact::Update { id, fields } => DocEdit::Update {
                id: text(id),
                fields: fields
                    .iter()
                    .map(|(path, original, value)| FieldEdit {
                        path: path.clone(),
                        original: original.as_ref().map(text),
                        value: value.as_ref().map(text),
                    })
                    .collect(),
            },
            Exact::Replace {
                id,
                original,
                replacement,
            } => DocEdit::Replace {
                id: text(id),
                original: text(original),
                replacement: text(replacement),
            },
            Exact::Delete { id, original } => DocEdit::Delete {
                id: text(id),
                original: text(original),
            },
            Exact::Insert { document } => DocEdit::Insert {
                document: text(document),
            },
        }
    }

    /// The change that undoes this one once applied, guarded by what it left.
    pub fn inverse(&self) -> Exact {
        match self {
            Exact::Update { id, fields } => Exact::Update {
                id: id.clone(),
                fields: fields
                    .iter()
                    .map(|(path, seen, written)| (path.clone(), written.clone(), seen.clone()))
                    .collect(),
            },
            Exact::Replace {
                id,
                original,
                replacement,
            } => Exact::Replace {
                id: id.clone(),
                original: replacement.clone(),
                replacement: original.clone(),
            },
            Exact::Delete { original, .. } => Exact::Insert {
                document: original.clone(),
            },
            Exact::Insert { document } => Exact::Delete {
                id: document.get("_id").cloned().unwrap_or(Json::Null),
                original: document.clone(),
            },
        }
    }
}

/// One operation of a plan.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    /// Index of the change in the change set.
    pub edit: usize,
    pub exact: Exact,
    pub op: DocOp,
}

fn invalid(en: impl Into<String>, fr: impl Into<String>) -> YadbeError {
    YadbeError::invalid_argument(en, fr)
}

// --- Values ---------------------------------------------------------------------------------

/// The wrapper key of an Extended JSON value (`$oid`, `$numberInt`…), if `json` is one.
fn wrapper_key(json: &Json) -> Option<&str> {
    match json.as_object()? {
        [(key, _)] if key.starts_with('$') => Some(key),
        [(a, _), (b, _)] if a == "$code" && b == "$scope" => Some("$code"),
        _ => None,
    }
}

const NUMBER_WRAPPERS: &[&str] = &[
    "$numberInt",
    "$numberLong",
    "$numberDouble",
    "$numberDecimal",
];

/// `json` in canonical Extended JSON: plain numbers typed as the driver types them (Int32
/// when they fit, else Int64; a fraction or an exponent makes a Double) and relaxed dates
/// made exact, so that what is guarded, sent and journaled is one value.
pub fn canonical(json: &Json) -> Result<Json, YadbeError> {
    Ok(match json {
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => match i32::try_from(i) {
                Ok(small) => Json::object([("$numberInt", Json::String(small.to_string()))]),
                Err(_) => Json::object([("$numberLong", Json::String(i.to_string()))]),
            },
            (None, Some(f)) => canonical_double(f),
            _ => {
                return Err(invalid(
                    format!("The number {n} is out of range."),
                    format!("Le nombre {n} est hors limites."),
                ));
            }
        },
        Json::Array(items) => Json::Array(items.iter().map(canonical).collect::<Result<_, _>>()?),
        Json::Object(entries) => match wrapper_key(json) {
            Some("$date") => match entries.first().map(|(_, body)| body) {
                Some(Json::String(iso)) => Json::object([(
                    "$date",
                    Json::object([("$numberLong", Json::String(parse_millis(iso)?.to_string()))]),
                )]),
                Some(Json::Number(n)) => Json::object([(
                    "$date",
                    Json::object([("$numberLong", Json::String(n.to_string()))]),
                )]),
                _ => json.clone(),
            },
            Some(_) => json.clone(),
            None => Json::Object(
                entries
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), canonical(v)?)))
                    .collect::<Result<_, YadbeError>>()?,
            ),
        },
        other => other.clone(),
    })
}

/// Parses an Extended JSON text into its canonical form.
pub fn parse_value(text: &str) -> Result<Json, YadbeError> {
    canonical(&Json::parse(text)?)
}

fn parse_document(text: &str, what_en: &str, what_fr: &str) -> Result<Json, YadbeError> {
    let doc = parse_value(text)?;
    if doc.as_object().is_none() || wrapper_key(&doc).is_some() {
        return Err(invalid(
            format!("The {what_en} must be a document ({{ … }})."),
            format!("{what_fr} doit être un document ({{ … }})."),
        ));
    }
    Ok(doc)
}

/// The value at `path` in `doc`, `None` when missing. Wrapped values are leaves.
pub fn value_at<'a>(doc: &'a Json, path: &[PathSeg]) -> Option<&'a Json> {
    let mut current = doc;
    for seg in path {
        current = match (seg, current) {
            (PathSeg::Field(name), Json::Object(entries)) if wrapper_key(current).is_none() => {
                &entries.iter().find(|(k, _)| k == name)?.1
            }
            (PathSeg::Index(i), Json::Array(items)) => items.get(*i as usize)?,
            _ => return None,
        };
    }
    Some(current)
}

/// The numbers inside `value` (itself included), with their path from it and their type.
fn numbers(value: &Json, prefix: &mut Vec<PathSeg>, out: &mut Vec<(Vec<PathSeg>, BsonType)>) {
    match value {
        Json::Number(_) => out.push((prefix.clone(), type_of(value))),
        Json::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                prefix.push(PathSeg::Index(u32::try_from(i).unwrap_or(u32::MAX)));
                numbers(item, prefix, out);
                prefix.pop();
            }
        }
        Json::Object(entries) => match wrapper_key(value) {
            Some(key) if NUMBER_WRAPPERS.contains(&key) => {
                out.push((prefix.clone(), type_of(value)));
            }
            Some(_) => {}
            None => {
                for (name, item) in entries {
                    prefix.push(PathSeg::Field(name.clone()));
                    numbers(item, prefix, out);
                    prefix.pop();
                }
            }
        },
        _ => {}
    }
}

// --- Guards ---------------------------------------------------------------------------------

fn simple_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('$') && !name.contains('.')
}

fn field_name(name: &str) -> Json {
    if name.starts_with('$') {
        Json::object([("$literal", Json::string(name))])
    } else {
        Json::string(name)
    }
}

fn get_field(name: &str, input: Json) -> Json {
    Json::object([(
        "$getField",
        Json::object([("field", field_name(name)), ("input", input)]),
    )])
}

fn eq(a: Json, b: Json) -> Json {
    Json::object([("$eq", Json::Array(vec![a, b]))])
}

fn type_is(expr: Json, ty: &str) -> Json {
    eq(Json::object([("$type", expr)]), Json::string(ty))
}

/// One step down from `parent`: a field of a document, an element of an array; missing when
/// `parent` is not of that shape (never an error).
fn step(parent: Json, seg: &PathSeg) -> Json {
    let p = || Json::string("$$p");
    let body = match seg {
        PathSeg::Field(name) => Json::object([(
            "$cond",
            Json::Array(vec![
                type_is(p(), "object"),
                get_field(name, p()),
                Json::string("$$REMOVE"),
            ]),
        )]),
        PathSeg::Index(i) => Json::object([(
            "$cond",
            Json::Array(vec![
                Json::object([("$isArray", p())]),
                Json::object([(
                    "$arrayElemAt",
                    Json::Array(vec![p(), Json::int(i64::from(*i))]),
                )]),
                Json::string("$$REMOVE"),
            ]),
        )]),
    };
    Json::object([(
        "$let",
        Json::object([("vars", Json::object([("p", parent)])), ("in", body)]),
    )])
}

/// The expression of the value at `path` below `base` (`None`: the document itself).
fn path_expr(base: Option<Json>, path: &[PathSeg]) -> Json {
    let mut iter = path.iter();
    let mut expr = match base {
        Some(base) => base,
        None => match iter.next() {
            Some(PathSeg::Field(name)) if simple_name(name) => Json::string(format!("${name}")),
            Some(PathSeg::Field(name)) => get_field(name, Json::string("$$CURRENT")),
            Some(seg @ PathSeg::Index(_)) => step(Json::string("$$CURRENT"), seg),
            None => return Json::string("$$ROOT"),
        },
    };
    for seg in iter {
        expr = step(expr, seg);
    }
    expr
}

fn literal(value: &Json) -> Json {
    Json::object([("$literal", value.clone())])
}

/// The checks that the value at `path` is still `seen` (`None`: missing), type-exact.
fn guard_checks(path: &[PathSeg], seen: Option<&Json>, out: &mut Vec<Json>) {
    let expr = || path_expr(None, path);
    let Some(value) = seen else {
        out.push(type_is(expr(), "missing"));
        return;
    };
    out.push(eq(expr(), literal(value)));
    if !path.is_empty() {
        out.push(type_is(expr(), type_of(value).alias()));
    }
    let mut found = Vec::new();
    numbers(value, &mut Vec::new(), &mut found);
    for (sub, ty) in found {
        if sub.is_empty() {
            continue;
        }
        let full: Vec<PathSeg> = path.iter().chain(sub.iter()).cloned().collect();
        out.push(type_is(path_expr(None, &full), ty.alias()));
    }
}

fn guarded_filter(id: &Json, checks: Vec<Json>) -> Result<Json, YadbeError> {
    if checks.len() > MAX_TYPE_CHECKS {
        return Err(invalid(
            format!(
                "This change would need {} checks to be guarded type-exactly (at most {MAX_TYPE_CHECKS}): the document holds too many numbers. Change fewer fields at a time.",
                checks.len()
            ),
            format!(
                "Cette modification demanderait {} vérifications pour être protégée au type près (au plus {MAX_TYPE_CHECKS}) : le document contient trop de nombres. Modifiez moins de champs à la fois.",
                checks.len()
            ),
        ));
    }
    let mut entries = vec![("_id".to_owned(), id.clone())];
    match checks.len() {
        0 => {}
        1 => entries.push((
            "$expr".to_owned(),
            checks.into_iter().next().unwrap_or(Json::Bool(true)),
        )),
        _ => entries.push((
            "$expr".to_owned(),
            Json::object([("$and", Json::Array(checks))]),
        )),
    }
    Ok(Json::Object(entries))
}

fn whole_guard(id: &Json, original: &Json) -> Result<Json, YadbeError> {
    let mut checks = Vec::new();
    guard_checks(&[], Some(original), &mut checks);
    guarded_filter(id, checks)
}

// --- Plan -----------------------------------------------------------------------------------

fn dotted(path: &[PathSeg]) -> String {
    path.iter()
        .map(|seg| match seg {
            PathSeg::Field(name) => name.clone(),
            PathSeg::Index(i) => i.to_string(),
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// The path as the user reads it (`items.0.sku`).
pub fn path_text(path: &[PathSeg]) -> String {
    dotted(path)
}

fn check_path(
    path: &[PathSeg],
    seen: Option<&Json>,
    value: Option<&Json>,
) -> Result<(), YadbeError> {
    let shown = dotted(path);
    match path.first() {
        None => {
            return Err(invalid(
                "A field to change has an empty path.",
                "Un champ à modifier a un chemin vide.",
            ));
        }
        Some(PathSeg::Field(name)) if name == "_id" => {
            return Err(invalid(
                "The _id of a document cannot be changed: duplicate the document and delete the old one instead.",
                "L'_id d'un document ne peut pas être modifié : dupliquez le document puis supprimez l'ancien.",
            ));
        }
        Some(PathSeg::Index(_)) => {
            return Err(invalid(
                "A document's path starts with a field name.",
                "Le chemin d'un document commence par un nom de champ.",
            ));
        }
        Some(PathSeg::Field(_)) => {}
    }
    if path
        .iter()
        .any(|seg| matches!(seg, PathSeg::Field(name) if !simple_name(name)))
    {
        return Err(invalid(
            format!(
                "“{shown}” cannot be changed field by field (a name is empty, holds a dot or starts with $): edit the document as JSON."
            ),
            format!(
                "« {shown} » ne peut pas être modifié champ par champ (un nom est vide, contient un point ou commence par $) : modifiez le document en JSON."
            ),
        ));
    }
    if matches!(path.last(), Some(PathSeg::Index(_))) && (seen.is_none() || value.is_none()) {
        return Err(invalid(
            format!(
                "“{shown}”: an array element is changed in place; to add or remove elements, change the whole array."
            ),
            format!(
                "« {shown} » : un élément de tableau se modifie sur place ; pour ajouter ou retirer des éléments, modifiez le tableau entier."
            ),
        ));
    }
    Ok(())
}

fn prefix_of(a: &[PathSeg], b: &[PathSeg]) -> bool {
    a.len() <= b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}

fn plan_update(
    ns: &Namespace,
    id: Json,
    fields: &[FieldEdit],
) -> Result<(Exact, DocOp), YadbeError> {
    let mut exact = Vec::with_capacity(fields.len());
    for field in fields {
        let seen = field.original.as_deref().map(parse_value).transpose()?;
        let value = field.value.as_deref().map(parse_value).transpose()?;
        check_path(&field.path, seen.as_ref(), value.as_ref())?;
        exact.push((field.path.clone(), seen, value));
    }
    for (i, (a, _, _)) in exact.iter().enumerate() {
        for (b, _, _) in exact.iter().skip(i + 1) {
            if prefix_of(a, b) || prefix_of(b, a) {
                return Err(invalid(
                    format!(
                        "“{}” and “{}” overlap: change one of them only.",
                        dotted(a),
                        dotted(b)
                    ),
                    format!(
                        "« {} » et « {} » se recouvrent : n'en modifiez qu'un.",
                        dotted(a),
                        dotted(b)
                    ),
                ));
            }
        }
    }
    let mut checks = Vec::new();
    let mut set = Vec::new();
    let mut unset = Vec::new();
    for (path, seen, value) in &exact {
        guard_checks(path, seen.as_ref(), &mut checks);
        // A new field goes into a document that must still be one ($set would otherwise
        // fail on a value, or create the document where it had been removed).
        if seen.is_none() && path.len() > 1 {
            checks.push(type_is(path_expr(None, &path[..path.len() - 1]), "object"));
        }
        match value {
            Some(value) => set.push((dotted(path), value.clone())),
            None => unset.push((dotted(path), Json::string(""))),
        }
    }
    let mut update = Vec::new();
    if !set.is_empty() {
        update.push(("$set".to_owned(), Json::Object(set)));
    }
    if !unset.is_empty() {
        update.push(("$unset".to_owned(), Json::Object(unset)));
    }
    let op = DocOp::Update {
        ns: ns.clone(),
        filter: guarded_filter(&id, checks)?,
        update: Json::Object(update),
        many: false,
        upsert: false,
        array_filters: None,
    };
    Ok((Exact::Update { id, fields: exact }, op))
}

/// `doc` with `_id` first, set to `id` when it has none; refused when it has another one.
fn with_id(doc: Json, id: &Json) -> Result<Json, YadbeError> {
    let Json::Object(mut entries) = doc else {
        return Ok(doc);
    };
    match entries.iter().position(|(k, _)| k == "_id") {
        Some(at) => {
            if entries[at].1 != *id {
                return Err(invalid(
                    "The _id of a document cannot be changed: duplicate the document and delete the old one instead.",
                    "L'_id d'un document ne peut pas être modifié : dupliquez le document puis supprimez l'ancien.",
                ));
            }
            let entry = entries.remove(at);
            entries.insert(0, entry);
        }
        None => entries.insert(0, ("_id".to_owned(), id.clone())),
    }
    Ok(Json::Object(entries))
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A new ObjectId as the drivers make one: seconds since the epoch, five random bytes, a
/// counter.
pub fn new_object_id() -> Json {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX));
    let random = *uuid::Uuid::new_v4().as_bytes();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut bytes = Vec::with_capacity(12);
    bytes.extend_from_slice(&seconds.to_be_bytes());
    bytes.extend_from_slice(&random[..5]);
    bytes.extend_from_slice(&counter.to_be_bytes()[1..]);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Json::object([("$oid", Json::String(hex))])
}

fn parse_id(text: &str) -> Result<Json, YadbeError> {
    let id = parse_value(text)?;
    if matches!(id, Json::Array(_)) {
        return Err(invalid(
            "A document's _id cannot be an array.",
            "L'_id d'un document ne peut pas être un tableau.",
        ));
    }
    Ok(id)
}

/// The operations of a change set, in order, one per change (an update without any field
/// is dropped). `new_id` makes the `_id` of an inserted document that has none.
pub fn plan(
    set: &DocChangeSet,
    new_id: &mut dyn FnMut() -> Json,
) -> Result<Vec<Planned>, YadbeError> {
    if set.edits.len() > MAX_EDITS {
        return Err(invalid(
            format!("At most {MAX_EDITS} documents can be changed at once."),
            format!("Au plus {MAX_EDITS} documents peuvent être modifiés à la fois."),
        ));
    }
    let ns = Namespace::new(set.database.clone(), set.collection.clone());
    let mut planned = Vec::with_capacity(set.edits.len());
    for (index, edit) in set.edits.iter().enumerate() {
        let (exact, op) = match edit {
            DocEdit::Update { id, fields } => {
                if fields.is_empty() {
                    continue;
                }
                plan_update(&ns, parse_id(id)?, fields)?
            }
            DocEdit::Replace {
                id,
                original,
                replacement,
            } => {
                let id = parse_id(id)?;
                let original = with_id(
                    parse_document(original, "original document", "Le document d'origine")?,
                    &id,
                )?;
                let replacement = with_id(
                    parse_document(replacement, "new document", "Le nouveau document")?,
                    &id,
                )?;
                let op = DocOp::Replace {
                    ns: ns.clone(),
                    filter: whole_guard(&id, &original)?,
                    replacement: replacement.clone(),
                    upsert: false,
                };
                (
                    Exact::Replace {
                        id,
                        original,
                        replacement,
                    },
                    op,
                )
            }
            DocEdit::Delete { id, original } => {
                let id = parse_id(id)?;
                let original = with_id(
                    parse_document(original, "deleted document", "Le document supprimé")?,
                    &id,
                )?;
                let op = DocOp::Delete {
                    ns: ns.clone(),
                    filter: whole_guard(&id, &original)?,
                    many: false,
                };
                (Exact::Delete { id, original }, op)
            }
            DocEdit::Insert { document } => {
                let document = parse_document(document, "new document", "Le nouveau document")?;
                let id = document.get("_id").cloned().unwrap_or_else(&mut *new_id);
                let document = with_id(document, &id)?;
                let op = DocOp::Insert {
                    ns: ns.clone(),
                    documents: vec![document.clone()],
                    ordered: true,
                };
                (Exact::Insert { document }, op)
            }
        };
        planned.push(Planned {
            edit: index,
            exact,
            op,
        });
    }
    Ok(planned)
}

/// The change set that undoes `applied` (in the order they ran), each guarded by what it left.
pub fn inverse(set: &DocChangeSet, applied: &[&Planned]) -> DocChangeSet {
    DocChangeSet {
        database: set.database.clone(),
        collection: set.collection.clone(),
        edits: applied
            .iter()
            .rev()
            .map(|p| p.exact.inverse().to_edit())
            .collect(),
    }
}

// --- Preview --------------------------------------------------------------------------------

/// The operation as mongosh writes it, on the collection variable `coll`.
pub fn shell_op(op: &DocOp) -> String {
    match op {
        DocOp::Update { filter, update, .. } => format!(
            "coll.updateOne({}, {})",
            shell_text(filter),
            shell_text(update)
        ),
        DocOp::Replace {
            filter,
            replacement,
            ..
        } => format!(
            "coll.replaceOne({}, {})",
            shell_text(filter),
            shell_text(replacement)
        ),
        DocOp::Delete { filter, .. } => format!("coll.deleteOne({})", shell_text(filter)),
        DocOp::Insert { documents, .. } => match documents.as_slice() {
            [one] => format!("coll.insertOne({})", shell_text(one)),
            many => format!(
                "coll.insertMany({})",
                shell_text(&Json::Array(many.to_vec()))
            ),
        },
        other => other.display(),
    }
}

/// What a line of the preview is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DocLineRole {
    /// Session, transaction and collection lines.
    Control,
    /// A write, checked to touch exactly one document.
    Write,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocPreviewLine {
    pub text: String,
    pub role: DocLineRole,
    /// The change the write comes from.
    pub edit: Option<u32>,
}

/// The lines a session that runs the plan types in mongosh.
pub fn preview_lines(ns: &Namespace, planned: &[Planned], atomic: bool) -> Vec<DocPreviewLine> {
    let control = |text: String| DocPreviewLine {
        text,
        role: DocLineRole::Control,
        edit: None,
    };
    let mut lines = Vec::with_capacity(planned.len() + 4);
    let names = format!(
        "getDatabase({}).getCollection({})",
        Json::string(ns.database.clone()).to_text(),
        Json::string(ns.collection.clone()).to_text()
    );
    if atomic {
        lines.push(control(
            "const session = db.getMongo().startSession()".into(),
        ));
        lines.push(control("session.startTransaction()".into()));
        lines.push(control(format!("const coll = session.{names}")));
    } else {
        lines.push(control(format!(
            "const coll = db.getSiblingDB({}).getCollection({})",
            Json::string(ns.database.clone()).to_text(),
            Json::string(ns.collection.clone()).to_text()
        )));
    }
    for p in planned {
        lines.push(DocPreviewLine {
            text: shell_op(&p.op),
            role: DocLineRole::Write,
            edit: u32::try_from(p.edit).ok(),
        });
    }
    if atomic {
        lines.push(control("session.commitTransaction()".into()));
    }
    lines
}

// --- Conflicts ------------------------------------------------------------------------------

/// Why an operation matched no document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DocConflictKind {
    /// The document changed on the server since it was read.
    Changed,
    /// The document is gone.
    Deleted,
    /// A document with this `_id` already exists (insert).
    Exists,
}

/// A path whose value differs from what the change was planned on.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocConflictField {
    pub path: Vec<PathSeg>,
    /// Canonical Extended JSON; `null`: missing.
    pub seen: Option<String>,
    pub now: Option<String>,
    pub yours: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocConflict {
    /// Index of the change in the change set.
    pub edit: u32,
    pub kind: DocConflictKind,
    /// The document's `_id`, canonical Extended JSON.
    pub id: String,
    /// What differs; empty when the difference is elsewhere (field order, a number's type
    /// deep in a value).
    pub fields: Vec<DocConflictField>,
    /// The document on the server now, canonical; `null` when gone.
    pub current: Option<String>,
}

/// The conflict of `planned` given the document the server holds now (`None`: gone).
pub fn conflict_of(planned: &Planned, current: Option<&Json>) -> DocConflict {
    let text = |j: Option<&Json>| j.map(Json::to_text);
    let kind = match (&planned.exact, current) {
        (Exact::Insert { .. }, _) => DocConflictKind::Exists,
        (_, None) => DocConflictKind::Deleted,
        _ => DocConflictKind::Changed,
    };
    let mut fields = Vec::new();
    if let Some(current) = current {
        match &planned.exact {
            Exact::Update { fields: edits, .. } => {
                for (path, seen, written) in edits {
                    let now = value_at(current, path);
                    if now != seen.as_ref() {
                        fields.push(DocConflictField {
                            path: path.clone(),
                            seen: text(seen.as_ref()),
                            now: text(now),
                            yours: text(written.as_ref()),
                        });
                    }
                }
            }
            Exact::Replace { original, .. } | Exact::Delete { original, .. } => {
                let yours = match &planned.exact {
                    Exact::Replace { replacement, .. } => Some(replacement),
                    _ => None,
                };
                let mut names: Vec<&str> = Vec::new();
                for doc in [original, current] {
                    for (k, _) in doc.as_object().unwrap_or(&[]) {
                        if !names.contains(&k.as_str()) {
                            names.push(k);
                        }
                    }
                }
                for name in names {
                    let path = vec![PathSeg::Field(name.to_owned())];
                    let (seen, now) = (value_at(original, &path), value_at(current, &path));
                    if seen != now {
                        fields.push(DocConflictField {
                            path: path.clone(),
                            seen: text(seen),
                            now: text(now),
                            yours: yours.and_then(|y| value_at(y, &path)).map(Json::to_text),
                        });
                    }
                }
            }
            Exact::Insert { .. } => {}
        }
    }
    DocConflict {
        edit: u32::try_from(planned.edit).unwrap_or(u32::MAX),
        kind,
        id: planned.exact.id().to_text(),
        fields,
        current: text(current),
    }
}

/// Changes, insertions and deletions of a plan, for the journal.
pub fn counts(planned: &[&Planned]) -> (u32, u32, u32) {
    let count = |kinds: &[DocOpKind]| {
        u32::try_from(
            planned
                .iter()
                .filter(|p| kinds.contains(&p.exact.kind()))
                .count(),
        )
        .unwrap_or(u32::MAX)
    };
    (
        count(&[DocOpKind::Update, DocOpKind::Replace]),
        count(&[DocOpKind::Insert]),
        count(&[DocOpKind::Delete]),
    )
}

#[cfg(test)]
#[path = "edit_tests.rs"]
mod tests;
