//! MySQL and MariaDB plans: `EXPLAIN FORMAT=JSON` (both), `ANALYZE FORMAT=JSON` (MariaDB,
//! with `r_` actual figures) and the `EXPLAIN ANALYZE` tree text (MySQL 8.0.18+).

use serde_json::{Map, Value as Json};

use super::{Draft, PlanFact, PlanFormat, QueryPlan, finish, number, show, unreadable};
use crate::db::errors::YadbeError;

/// Operation objects of the JSON plan and how they read.
const OPERATIONS: &[(&str, &str)] = &[
    ("ordering_operation", "Order"),
    ("grouping_operation", "Group"),
    ("duplicates_removal", "Distinct"),
    ("windowing", "Window"),
    ("materialized_from_subquery", "Materialize"),
    ("filesort", "Sort"),
    ("read_sorted_file", "Read sorted file"),
    ("temporary_table", "Temporary table"),
    ("block-nl-join", "Block nested loop"),
    ("buffer_result", "Buffer result"),
];

/// Arrays of subqueries attached to a block or a table.
const SUBQUERIES: &[&str] = &[
    "attached_subqueries",
    "optimized_away_subqueries",
    "order_by_subqueries",
    "group_by_subqueries",
    "having_subqueries",
    "select_list_subqueries",
    "update_value_subqueries",
    "subqueries",
];

/// Keys of a table object read into fields, or noise.
const TABLE_MAPPED: &[&str] = &[
    "table_name",
    "access_type",
    "key",
    "attached_condition",
    "rows_examined_per_scan",
    "rows",
    "r_rows",
    "r_loops",
    "cost_info",
    "used_columns",
    "r_total_time_ms",
    "r_table_time_ms",
    "r_other_time_ms",
];

fn text(value: &Json) -> Option<String> {
    match value {
        Json::String(s) => Some(s.clone()),
        Json::Number(n) => n.as_f64().map(show),
        Json::Bool(b) => Some(b.to_string()),
        Json::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(text).collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        _ => None,
    }
}

/// Numbers come as JSON numbers or as strings (`"cost_info": {"read_cost": "1.16"}`).
fn num(object: &Map<String, Json>, key: &str) -> Option<f64> {
    match object.get(key)? {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => number(s),
        _ => None,
    }
}

fn access(kind: &str) -> &str {
    match kind {
        "ALL" => "Full table scan",
        "index" => "Full index scan",
        "range" => "Index range scan",
        "ref" => "Index lookup",
        "eq_ref" => "Unique index lookup",
        "ref_or_null" => "Index lookup or null",
        "const" | "system" => "Constant row",
        "fulltext" => "Full-text index",
        "index_merge" => "Index merge",
        "unique_subquery" => "Unique subquery",
        "index_subquery" => "Index subquery",
        other => other,
    }
}

/// Scalar facts of an object, without the keys already read.
fn facts(draft: &mut Draft, object: &Map<String, Json>, skip: &[&str]) {
    for (key, value) in object {
        if skip.contains(&key.as_str())
            || OPERATIONS.iter().any(|(k, _)| k == key)
            || SUBQUERIES.contains(&key.as_str())
            || matches!(
                key.as_str(),
                "query_block" | "table" | "nested_loop" | "union_result"
            )
        {
            continue;
        }
        if let Some(text) = text(value) {
            draft.facts.push(PlanFact::new(key, text));
        }
    }
}

fn actual(draft: &mut Draft, object: &Map<String, Json>, analyzed: bool) {
    if !analyzed {
        return;
    }
    draft.actual_rows = num(object, "r_rows");
    draft.loops = num(object, "r_loops");
    let own = match (
        num(object, "r_table_time_ms"),
        num(object, "r_other_time_ms"),
    ) {
        (None, None) => num(object, "r_total_time_ms"),
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    };
    draft.own_time = own;
    draft.actual_time_ms = num(object, "r_total_time_ms").or(own);
}

fn table(object: &Map<String, Json>, analyzed: bool) -> Draft {
    let kind = object
        .get("access_type")
        .and_then(Json::as_str)
        .unwrap_or("?");
    let mut draft = Draft::new(access(kind));
    draft.relation = object
        .get("table_name")
        .and_then(Json::as_str)
        .map(str::to_owned);
    draft.index = object.get("key").and_then(Json::as_str).map(str::to_owned);
    draft.detail = object.get("attached_condition").and_then(text);
    draft.estimated_rows = num(object, "rows_examined_per_scan").or_else(|| num(object, "rows"));
    if let Some(cost) = object.get("cost_info").and_then(Json::as_object) {
        draft.estimated_cost = num(cost, "prefix_cost");
        let own = num(cost, "read_cost").unwrap_or(0.0) + num(cost, "eval_cost").unwrap_or(0.0);
        draft.own_cost = Some(own);
        for key in ["read_cost", "eval_cost", "data_read_per_join"] {
            if let Some(value) = cost.get(key).and_then(text) {
                draft.fact(key, value);
            }
        }
    } else {
        draft.own_cost = Some(0.0);
    }
    if kind != "?" {
        draft.fact("access_type", kind);
    }
    actual(&mut draft, object, analyzed);
    facts(&mut draft, object, TABLE_MAPPED);
    draft.children = children(object, analyzed);
    draft
}

fn block(object: &Map<String, Json>, analyzed: bool) -> Draft {
    let label = match object.get("select_id").and_then(text) {
        Some(id) => format!("Query block #{id}"),
        None => "Query block".to_owned(),
    };
    let mut draft = Draft::new(label);
    if let Some(cost) = object.get("cost_info").and_then(Json::as_object) {
        draft.estimated_cost = num(cost, "query_cost");
    }
    draft.own_cost = Some(0.0);
    if analyzed {
        draft.actual_time_ms = num(object, "r_total_time_ms");
        draft.loops = num(object, "r_loops");
        draft.own_time = Some(0.0);
    }
    facts(
        &mut draft,
        object,
        &["select_id", "cost_info", "r_total_time_ms", "r_loops"],
    );
    draft.children = children(object, analyzed);
    draft
}

fn operation(label: &str, object: &Map<String, Json>, analyzed: bool) -> Draft {
    let mut draft = Draft::new(label);
    let sort_cost = object
        .get("cost_info")
        .and_then(Json::as_object)
        .and_then(|c| num(c, "sort_cost"));
    draft.own_cost = Some(sort_cost.unwrap_or(0.0));
    if let Some(cost) = sort_cost {
        draft.fact("sort_cost", show(cost));
    }
    if analyzed {
        draft.loops = num(object, "r_loops");
        draft.actual_rows = num(object, "r_output_rows").or_else(|| num(object, "r_rows"));
        draft.own_time = Some(num(object, "r_total_time_ms").unwrap_or(0.0));
        draft.actual_time_ms = num(object, "r_total_time_ms");
    }
    draft.detail = object
        .get("sort_key")
        .or_else(|| object.get("having_condition"))
        .and_then(text);
    facts(
        &mut draft,
        object,
        &[
            "cost_info",
            "r_loops",
            "r_total_time_ms",
            "r_output_rows",
            "r_rows",
            "sort_key",
        ],
    );
    draft.children = children(object, analyzed);
    draft
}

/// The operations under an object, in the order the engine wrote them.
fn children(object: &Map<String, Json>, analyzed: bool) -> Vec<Draft> {
    let mut out = Vec::new();
    for (key, value) in object {
        let key = key.as_str();
        match (key, value) {
            ("query_block", Json::Object(o)) => out.push(block(o, analyzed)),
            ("table", Json::Object(o)) => out.push(table(o, analyzed)),
            ("nested_loop", Json::Array(items)) => {
                let tables: Vec<Draft> = items
                    .iter()
                    .filter_map(Json::as_object)
                    .flat_map(|item| children(item, analyzed))
                    .collect();
                if tables.len() > 1 {
                    let mut join = Draft::new("Nested loop");
                    join.own_cost = Some(0.0);
                    if analyzed {
                        join.own_time = Some(0.0);
                    }
                    join.children = tables;
                    out.push(join);
                } else {
                    out.extend(tables);
                }
            }
            ("union_result", Json::Object(o)) => {
                let mut union = operation("Union", o, analyzed);
                union.detail = o.get("table_name").and_then(text);
                let specs = o
                    .get("query_specifications")
                    .or_else(|| o.get("query_blocks"))
                    .and_then(Json::as_array);
                for spec in specs.into_iter().flatten().filter_map(Json::as_object) {
                    union.children.extend(children(spec, analyzed));
                }
                out.push(union);
            }
            (_, Json::Object(o)) => {
                if let Some((_, label)) = OPERATIONS.iter().find(|(k, _)| *k == key) {
                    out.push(operation(label, o, analyzed));
                }
            }
            (_, Json::Array(items)) if SUBQUERIES.contains(&key) => {
                for item in items.iter().filter_map(Json::as_object) {
                    let mut subquery = Draft::new("Subquery");
                    subquery.own_cost = Some(0.0);
                    if analyzed {
                        subquery.own_time = Some(0.0);
                    }
                    for flag in ["dependent", "cacheable"] {
                        if item.get(flag).and_then(Json::as_bool) == Some(true) {
                            subquery.fact(flag, "true");
                        }
                    }
                    subquery.children = children(item, analyzed);
                    out.push(subquery);
                }
            }
            _ => {}
        }
    }
    out
}

pub(super) fn parse_json(text: &str, analyzed: bool) -> Result<QueryPlan, YadbeError> {
    let json: Json = serde_json::from_str(text).map_err(|e| unreadable("MySQL", e.to_string()))?;
    let object = json
        .as_object()
        .ok_or_else(|| unreadable("MySQL", "the plan is not a JSON object"))?;
    let roots = children(object, analyzed);
    if roots.is_empty() {
        return Err(unreadable("MySQL", "no \"query_block\" in the output"));
    }
    let mut summary = Vec::new();
    if let Some(cost) = roots[0].estimated_cost {
        summary.push(PlanFact::new("query_cost", show(cost)));
    }
    if analyzed && let Some(time) = roots[0].actual_time_ms {
        summary.push(PlanFact::new(
            "r_total_time_ms",
            format!("{} ms", show(time)),
        ));
    }
    let raw = serde_json::to_string_pretty(&json).unwrap_or_else(|_| text.to_owned());
    Ok(finish(PlanFormat::MysqlJson, analyzed, roots, summary, raw))
}

/// One `(…)` group at the end of a tree line: `(cost=1.25 rows=10)`.
fn figures(group: &str) -> Vec<(&str, &str)> {
    group
        .split_whitespace()
        .filter_map(|pair| pair.split_once('='))
        .collect()
}

/// `Index lookup on b using a_id (a_id=a.id)` → relation `b`, index `a_id`, detail.
fn describe(draft: &mut Draft, text: &str) {
    if let Some((name, rest)) = text.split_once(": ")
        && !name.contains('(')
        && name.len() <= 40
    {
        draft.operation = name.to_owned();
        draft.detail = Some(rest.to_owned());
        return;
    }
    if let Some(at) = text.find(" on ") {
        let rest = &text[at + 4..];
        let mut words = rest.split_whitespace();
        draft.relation = words.next().map(str::to_owned);
        let after: Vec<&str> = words.collect();
        if after.first() == Some(&"using") {
            draft.index = after.get(1).map(|w| (*w).to_owned());
        }
        if let Some(open) = rest.find('(') {
            draft.detail = Some(rest[open..].to_owned());
        }
        draft.operation = text[..at].to_owned();
        return;
    }
    draft.operation = text.to_owned();
}

pub(super) fn parse_tree(text: &str) -> QueryPlan {
    // Drafts by depth: the open ancestors of the next line.
    let mut stack: Vec<(usize, Draft)> = Vec::new();
    let mut roots: Vec<Draft> = Vec::new();
    let close = |stack: &mut Vec<(usize, Draft)>, roots: &mut Vec<Draft>, depth: usize| {
        while stack.last().is_some_and(|(d, _)| *d >= depth) {
            if let Some((_, done)) = stack.pop() {
                match stack.last_mut() {
                    Some((_, parent)) => parent.children.push(done),
                    None => roots.push(done),
                }
            }
        }
    };
    let mut analyzed = false;
    for line in text.lines() {
        let Some(arrow) = line.find("-> ") else {
            continue;
        };
        let depth = line[..arrow].chars().count() / 4;
        let mut body = line[arrow + 3..].trim_end();
        let mut draft = Draft::new("");
        // Figure groups at the end, right to left.
        while let Some(open) = body.rfind(" (") {
            let group = &body[open + 2..];
            let Some(inner) = group.strip_suffix(')') else {
                break;
            };
            if let Some(rest) = inner.strip_prefix("actual time=") {
                analyzed = true;
                let mut parts = figures(inner);
                if let Some((first, last)) = rest
                    .split_whitespace()
                    .next()
                    .and_then(|t| t.split_once(".."))
                {
                    draft.fact("first row", format!("{first} ms"));
                    parts.retain(|(k, _)| *k != "time");
                    let loops = parts
                        .iter()
                        .find(|(k, _)| *k == "loops")
                        .and_then(|(_, v)| number(v))
                        .unwrap_or(1.0);
                    draft.actual_time_ms = number(last).map(|t| t * loops);
                }
                for (key, value) in parts {
                    match key {
                        "rows" => draft.actual_rows = number(value),
                        "loops" => draft.loops = number(value),
                        _ => {}
                    }
                }
            } else if inner.starts_with("cost=") || inner.starts_with("rows=") {
                for (key, value) in figures(inner) {
                    match key {
                        "cost" => draft.estimated_cost = number(value),
                        "rows" => draft.estimated_rows = number(value),
                        _ => {}
                    }
                }
            } else if inner == "never executed" {
                analyzed = true;
                draft.fact("never executed", "true");
            } else {
                break;
            }
            body = body[..open].trim_end();
        }
        describe(&mut draft, body.trim());
        close(&mut stack, &mut roots, depth);
        stack.push((depth, draft));
    }
    close(&mut stack, &mut roots, 0);
    finish(
        PlanFormat::MysqlTree,
        analyzed,
        roots,
        Vec::new(),
        text.trim_end().to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::plan::PlanWeightBasis;

    #[test]
    fn reads_an_estimated_json_plan() {
        let plan = parse_json(include_str!("fixtures/mysql_estimated.json"), false).expect("plan");
        assert_eq!(plan.weight_basis, PlanWeightBasis::Cost);
        let ops: Vec<&str> = plan.nodes.iter().map(|n| n.operation.as_str()).collect();
        assert_eq!(
            ops,
            [
                "Query block #1",
                "Order",
                "Group",
                "Nested loop",
                "Full table scan",
                "Index lookup"
            ]
        );
        let scan = &plan.nodes[4];
        assert_eq!(scan.relation.as_deref(), Some("a"));
        assert_eq!(scan.estimated_rows, Some(2000.0));
        assert!(
            scan.detail
                .as_deref()
                .is_some_and(|d| d.contains("like 'x1%'"))
        );
        assert_eq!(plan.nodes[5].index.as_deref(), Some("a_id"));
        // The costly table is the lookup (read + eval = 273.52 of 475.02).
        assert!(plan.nodes[5].weight > plan.nodes[4].weight);
        assert_eq!(plan.summary[0], PlanFact::new("query_cost", "475.02"));
    }

    #[test]
    fn reads_unions_and_materialized_subqueries() {
        let plan = parse_json(include_str!("fixtures/mysql_union.json"), false).expect("plan");
        assert_eq!(plan.nodes[0].operation, "Query block");
        assert_eq!(plan.nodes[1].operation, "Union");
        assert!(plan.nodes.iter().any(|n| n.operation == "Materialize"));
        assert!(
            plan.nodes
                .iter()
                .any(|n| n.relation.as_deref() == Some("plan_b"))
        );
    }

    #[test]
    fn reads_an_explain_analyze_tree() {
        let plan = parse_tree(include_str!("fixtures/mysql_analyze.txt"));
        assert!(plan.analyzed);
        assert_eq!(plan.weight_basis, PlanWeightBasis::Time);
        assert_eq!(plan.nodes.len(), 8);
        assert_eq!(plan.nodes[0].operation, "Limit");
        assert_eq!(plan.nodes[0].detail.as_deref(), Some("10 row(s)"));
        let lookup = &plan.nodes[7];
        assert_eq!(lookup.operation, "Covering index lookup");
        assert_eq!(lookup.relation.as_deref(), Some("b"));
        assert_eq!(lookup.index.as_deref(), Some("a_id"));
        assert_eq!(lookup.loops, Some(1111.0));
        assert_eq!(lookup.depth, 5);
        assert_eq!(plan.nodes[6].relation.as_deref(), Some("a"));
        assert_eq!(plan.nodes[6].estimated_rows, Some(2000.0));
        assert_eq!(plan.nodes[6].parent, Some(5));
    }

    #[test]
    fn reads_a_mariadb_analyze_plan() {
        // As MariaDB 10.11 / 11.x writes it (`ANALYZE FORMAT=JSON`).
        let text = r#"{
          "query_optimization": {"r_total_time_ms": 0.12},
          "query_block": {
            "select_id": 1,
            "r_loops": 1,
            "r_total_time_ms": 3.5,
            "filesort": {
              "sort_key": "o.total desc",
              "r_loops": 1,
              "r_total_time_ms": 0.9,
              "r_output_rows": 10,
              "temporary_table": {
                "table": {
                  "table_name": "o",
                  "access_type": "ALL",
                  "loops": 1,
                  "r_loops": 1,
                  "rows": 1000,
                  "r_rows": 1000,
                  "cost": 0.17,
                  "r_table_time_ms": 1.8,
                  "r_other_time_ms": 0.3,
                  "filtered": 100,
                  "r_filtered": 42.5,
                  "attached_condition": "o.total > 10"
                }
              }
            }
          }
        }"#;
        let plan = parse_json(text, true).expect("plan");
        assert_eq!(plan.weight_basis, PlanWeightBasis::Time);
        let scan = plan
            .nodes
            .iter()
            .find(|n| n.relation.as_deref() == Some("o"))
            .expect("scan");
        assert_eq!(scan.actual_rows, Some(1000.0));
        assert!(scan.weight > 0.6, "{}", scan.weight);
        assert!(scan.facts.iter().any(|f| f.label == "r_filtered"));
        let sort = plan
            .nodes
            .iter()
            .find(|n| n.operation == "Sort")
            .expect("sort");
        assert_eq!(sort.detail.as_deref(), Some("o.total desc"));
    }
}
