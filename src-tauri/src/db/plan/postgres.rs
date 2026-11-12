//! PostgreSQL `EXPLAIN (FORMAT JSON [, ANALYZE, BUFFERS])`.

use serde_json::{Map, Value as Json};

use super::{Draft, PlanFact, PlanFormat, QueryPlan, finish, show, unreadable};
use crate::db::errors::YadbeError;

/// Keys read into the node's own fields (the rest become facts).
const MAPPED: &[&str] = &[
    "Node Type",
    "Plans",
    "Relation Name",
    "Schema",
    "Alias",
    "Index Name",
    "Plan Rows",
    "Actual Rows",
    "Actual Loops",
    "Total Cost",
    "Actual Total Time",
    "Parallel Aware",
    "Async Capable",
];

/// Conditions, in the order the detail line prefers them.
const CONDITIONS: &[&str] = &[
    "Index Cond",
    "Hash Cond",
    "Merge Cond",
    "Join Filter",
    "Recheck Cond",
    "Filter",
    "One-Time Filter",
    "TID Cond",
    "Sort Key",
    "Group Key",
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
        Json::Null | Json::Object(_) => None,
    }
}

fn num(node: &Map<String, Json>, key: &str) -> Option<f64> {
    node.get(key).and_then(Json::as_f64)
}

/// `Hash Join` with `Join Type: Left` reads `Hash Left Join`, as the text format writes it.
fn operation(node: &Map<String, Json>) -> String {
    let kind = node
        .get("Node Type")
        .and_then(Json::as_str)
        .unwrap_or("?")
        .to_owned();
    let join = node.get("Join Type").and_then(Json::as_str);
    let strategy = node.get("Strategy").and_then(Json::as_str);
    let mut out = match (kind.as_str(), join, strategy) {
        ("Nested Loop", Some(j), _) if j != "Inner" => format!("Nested Loop {j} Join"),
        (k, Some(j), _) if k.ends_with(" Join") && j != "Inner" => {
            format!("{} {j} Join", k.trim_end_matches(" Join"))
        }
        ("Aggregate", _, Some("Hashed")) => "HashAggregate".to_owned(),
        ("Aggregate", _, Some("Sorted")) => "GroupAggregate".to_owned(),
        ("Aggregate", _, Some("Mixed")) => "MixedAggregate".to_owned(),
        _ => kind,
    };
    if node.get("Parallel Aware").and_then(Json::as_bool) == Some(true) {
        out = format!("Parallel {out}");
    }
    out
}

fn plan_node(value: &Json, analyzed: bool) -> Option<Draft> {
    let node = value.as_object()?;
    let mut draft = Draft::new(operation(node));
    let relation = node.get("Relation Name").and_then(Json::as_str);
    draft.relation = relation.map(|name| match node.get("Schema").and_then(Json::as_str) {
        Some(schema) => format!("{schema}.{name}"),
        None => name.to_owned(),
    });
    if let (Some(alias), Some(name)) = (node.get("Alias").and_then(Json::as_str), relation)
        && alias != name
    {
        draft.fact("Alias", alias);
    }
    draft.index = node
        .get("Index Name")
        .and_then(Json::as_str)
        .map(str::to_owned);
    draft.detail = CONDITIONS
        .iter()
        .find_map(|key| node.get(*key).and_then(text).map(|t| format!("{key}: {t}")));
    draft.estimated_rows = num(node, "Plan Rows");
    draft.estimated_cost = num(node, "Total Cost");
    if analyzed {
        draft.loops = num(node, "Actual Loops");
        draft.actual_rows = num(node, "Actual Rows");
        // Per loop: the inclusive time of every loop is what the node cost.
        draft.actual_time_ms =
            num(node, "Actual Total Time").map(|t| t * draft.loops.unwrap_or(1.0));
    }
    for (key, value) in node {
        if MAPPED.contains(&key.as_str()) {
            continue;
        }
        // A zero count of blocks says nothing.
        if key.ends_with(" Blocks") && value.as_f64() == Some(0.0) {
            continue;
        }
        if let Some(text) = text(value) {
            draft.facts.push(PlanFact::new(key, text));
        }
    }
    draft.children = node
        .get("Plans")
        .and_then(Json::as_array)
        .map(|plans| {
            plans
                .iter()
                .filter_map(|p| plan_node(p, analyzed))
                .collect()
        })
        .unwrap_or_default();
    Some(draft)
}

pub(super) fn parse(text: &str, analyzed: bool) -> Result<QueryPlan, YadbeError> {
    let json: Json =
        serde_json::from_str(text).map_err(|e| unreadable("PostgreSQL", e.to_string()))?;
    // One entry per statement (a rule can turn one statement into several).
    let entries = match &json {
        Json::Array(items) => items.iter().collect::<Vec<_>>(),
        other => vec![other],
    };
    let mut roots = Vec::new();
    let mut summary = Vec::new();
    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };
        if let Some(root) = object.get("Plan").and_then(|p| plan_node(p, analyzed)) {
            if summary.is_empty()
                && let Some(cost) = root.estimated_cost
            {
                summary.push(PlanFact::new("Total Cost", show(cost)));
            }
            roots.push(root);
        }
        for key in ["Planning Time", "Execution Time"] {
            if let Some(value) = object.get(key).and_then(Json::as_f64) {
                summary.push(PlanFact::new(key, format!("{} ms", show(value))));
            }
        }
        if let Some(triggers) = object.get("Triggers").and_then(Json::as_array) {
            for trigger in triggers {
                let name = trigger.get("Trigger Name").and_then(self::text);
                let time = trigger.get("Time").and_then(Json::as_f64);
                if let (Some(name), Some(time)) = (name, time) {
                    summary.push(PlanFact::new(
                        format!("Trigger {name}"),
                        format!("{} ms", show(time)),
                    ));
                }
            }
        }
    }
    if roots.is_empty() {
        return Err(unreadable("PostgreSQL", "no \"Plan\" in the output"));
    }
    let raw = serde_json::to_string_pretty(&json).unwrap_or_else(|_| text.to_owned());
    Ok(finish(
        PlanFormat::PostgresJson,
        analyzed,
        roots,
        summary,
        raw,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::plan::PlanWeightBasis;

    #[test]
    fn reads_an_analyzed_plan() {
        let plan = parse(include_str!("fixtures/pg_analyze.json"), true).expect("plan");
        assert_eq!(plan.weight_basis, PlanWeightBasis::Time);
        assert_eq!(plan.nodes[0].operation, "Limit");
        assert!(plan.nodes[0].parent.is_none());
        let scan_b = plan
            .nodes
            .iter()
            .find(|n| n.relation.as_deref() == Some("b"))
            .expect("scan of b");
        assert_eq!(scan_b.operation, "Seq Scan");
        assert_eq!(scan_b.actual_rows, Some(20000.0));
        assert!(scan_b.actual_time_ms.is_some_and(|t| t > 0.0));
        let join = plan
            .nodes
            .iter()
            .find(|n| n.operation.contains("Join"))
            .expect("join");
        assert!(
            join.detail
                .as_deref()
                .is_some_and(|d| d.starts_with("Hash Cond:"))
        );
        let total: f64 = plan.nodes.iter().map(|n| n.weight).sum();
        assert!((total - 1.0).abs() < 1e-6, "{total}");
        assert!(plan.summary.iter().any(|f| f.label == "Execution Time"));
        // Every node's parent comes before it.
        for node in &plan.nodes {
            if let Some(parent) = node.parent {
                assert!(parent < node.id);
                assert_eq!(plan.nodes[parent as usize].depth + 1, node.depth);
            }
        }
    }

    #[test]
    fn reads_an_estimated_plan() {
        let plan = parse(include_str!("fixtures/pg_estimated.json"), false).expect("plan");
        assert_eq!(plan.weight_basis, PlanWeightBasis::Cost);
        assert!(!plan.analyzed);
        assert!(plan.nodes.iter().all(|n| n.actual_rows.is_none()));
        assert!(plan.nodes.iter().any(|n| n.operation == "Append"));
        assert!(plan.nodes.iter().any(|n| n.index.is_some()));
        assert!(plan.raw.contains("\"Node Type\""));
    }

    #[test]
    fn rejects_what_is_not_a_plan() {
        assert!(parse("[{}]", false).is_err());
        assert!(parse("not json", false).is_err());
    }
}
