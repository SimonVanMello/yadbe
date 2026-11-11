//! Query plans (F-053): one typed plan-tree model for every engine, parsed from the
//! engine's native form (PostgreSQL `EXPLAIN (FORMAT JSON)`, SQL Server showplan XML,
//! MySQL `EXPLAIN FORMAT=JSON` / `EXPLAIN ANALYZE` trees, MariaDB `ANALYZE FORMAT=JSON`,
//! SQLite `EXPLAIN QUERY PLAN` rows).
//!
//! Nodes cross the IPC flat, in pre-order, each with its parent and depth. Each node gets a
//! `weight`: its share of the plan's own work (actual time when the plan ran, estimated cost
//! otherwise), which the UI uses to highlight the costly nodes.

mod mssql;
mod mysql;
mod postgres;
mod sqlite;
mod xml;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;

pub use sqlite::SqlitePlanRow;

/// The form the engine gave its plan in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlanFormat {
    /// `EXPLAIN (FORMAT JSON)`.
    PostgresJson,
    /// Showplan XML (`SET SHOWPLAN_XML` / `SET STATISTICS XML`).
    ShowplanXml,
    /// `EXPLAIN FORMAT=JSON` (MySQL), `EXPLAIN` / `ANALYZE FORMAT=JSON` (MariaDB).
    MysqlJson,
    /// `EXPLAIN ANALYZE` tree text (MySQL 8.0.18+).
    MysqlTree,
    /// `EXPLAIN QUERY PLAN` rows.
    SqliteRows,
}

/// What the plan's weights measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlanWeightBasis {
    /// Actual time of each node, its children's left out.
    Time,
    /// Estimated cost of each node, its children's left out.
    Cost,
    /// No measure from the engine: full scans and temporary sorts count (SQLite).
    Heuristic,
    /// Nothing to weigh.
    None,
}

/// A labelled property of a node, as the engine names it (never translated).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanFact {
    pub label: String,
    pub value: String,
}

impl PlanFact {
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
        }
    }
}

/// One operation of a plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    /// Position in `nodes` (pre-order).
    pub id: u32,
    pub parent: Option<u32>,
    pub depth: u32,
    /// `Seq Scan`, `Hash Join`, `Clustered Index Seek`, `SCAN orders`…
    pub operation: String,
    /// The table or view it reads.
    pub relation: Option<String>,
    pub index: Option<String>,
    /// Its main condition (index condition, filter, join condition…).
    pub detail: Option<String>,
    /// Rows the planner expected (per loop).
    pub estimated_rows: Option<f64>,
    /// Rows it produced (per loop, as the engine reports them).
    pub actual_rows: Option<f64>,
    /// How many times it ran.
    pub loops: Option<f64>,
    /// Estimated cost of the node and everything under it, in the engine's units.
    pub estimated_cost: Option<f64>,
    /// Time it took with everything under it, all loops, in milliseconds.
    pub actual_time_ms: Option<f64>,
    /// Its share of the plan's own work (0 to 1): see `QueryPlan::weight_basis`.
    pub weight: f64,
    /// Everything else the engine says about it.
    pub facts: Vec<PlanFact>,
}

/// A parsed plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    pub format: PlanFormat,
    /// Actual rows and times are known: the statement ran.
    pub analyzed: bool,
    pub weight_basis: PlanWeightBasis,
    /// Pre-order; roots have no parent (a SQL Server batch has one per statement).
    pub nodes: Vec<PlanNode>,
    /// Plan-wide figures: planning and execution time, total cost…
    pub summary: Vec<PlanFact>,
    /// The plan as the engine sent it (JSON pretty-printed).
    pub raw: String,
}

/// A plan as a driver read it from the engine.
#[derive(Debug, Clone, PartialEq)]
pub enum RawPlan {
    PostgresJson(String),
    /// One document per statement of the batch.
    ShowplanXml(Vec<String>),
    MysqlJson(String),
    MysqlTree(String),
    SqliteRows(Vec<SqlitePlanRow>),
}

/// A node while it is being built, before it is flattened.
#[derive(Debug, Default, Clone)]
pub(crate) struct Draft {
    pub operation: String,
    pub relation: Option<String>,
    pub index: Option<String>,
    pub detail: Option<String>,
    pub estimated_rows: Option<f64>,
    pub actual_rows: Option<f64>,
    pub loops: Option<f64>,
    /// Inclusive estimated cost.
    pub estimated_cost: Option<f64>,
    /// Inclusive actual time, all loops.
    pub actual_time_ms: Option<f64>,
    /// The node's own cost when the engine gives it directly (else inclusive minus children).
    pub own_cost: Option<f64>,
    /// The node's own time when the engine gives it directly.
    pub own_time: Option<f64>,
    /// Weight without a measure (SQLite).
    pub heuristic: f64,
    pub facts: Vec<PlanFact>,
    pub children: Vec<Draft>,
}

impl Draft {
    pub fn new(operation: impl Into<String>) -> Self {
        Self {
            operation: operation.into(),
            ..Self::default()
        }
    }

    pub fn fact(&mut self, label: impl Into<String>, value: impl Into<String>) {
        let value = value.into();
        if !value.is_empty() {
            self.facts.push(PlanFact::new(label, value));
        }
    }

    fn own(&self, basis: PlanWeightBasis) -> f64 {
        let children =
            |f: fn(&Draft) -> Option<f64>| self.children.iter().filter_map(f).sum::<f64>();
        let value = match basis {
            PlanWeightBasis::Time => self.own_time.or_else(|| {
                self.actual_time_ms
                    .map(|t| t - children(|c| c.actual_time_ms))
            }),
            PlanWeightBasis::Cost => self.own_cost.or_else(|| {
                self.estimated_cost
                    .map(|c| c - children(|c| c.estimated_cost))
            }),
            PlanWeightBasis::Heuristic => Some(self.heuristic),
            PlanWeightBasis::None => None,
        };
        value.filter(|v| v.is_finite()).unwrap_or(0.0).max(0.0)
    }

    fn any(&self, test: &dyn Fn(&Draft) -> bool) -> bool {
        test(self) || self.children.iter().any(|c| c.any(test))
    }
}

/// Flattens drafts into the IPC model and weighs them.
pub(crate) fn finish(
    format: PlanFormat,
    analyzed: bool,
    roots: Vec<Draft>,
    summary: Vec<PlanFact>,
    raw: String,
) -> QueryPlan {
    let has = |test: &dyn Fn(&Draft) -> bool| roots.iter().any(|r| r.any(test));
    let basis = if analyzed && has(&|d| d.actual_time_ms.is_some() || d.own_time.is_some()) {
        PlanWeightBasis::Time
    } else if has(&|d| d.estimated_cost.is_some() || d.own_cost.is_some()) {
        PlanWeightBasis::Cost
    } else if has(&|d| d.heuristic > 0.0) {
        PlanWeightBasis::Heuristic
    } else {
        PlanWeightBasis::None
    };
    let mut nodes = Vec::new();
    let mut owns = Vec::new();
    fn walk(
        draft: Draft,
        parent: Option<u32>,
        depth: u32,
        basis: PlanWeightBasis,
        nodes: &mut Vec<PlanNode>,
        owns: &mut Vec<f64>,
    ) {
        let id = u32::try_from(nodes.len()).unwrap_or(u32::MAX);
        owns.push(draft.own(basis));
        nodes.push(PlanNode {
            id,
            parent,
            depth,
            operation: draft.operation,
            relation: draft.relation,
            index: draft.index,
            detail: draft.detail,
            estimated_rows: draft.estimated_rows,
            actual_rows: draft.actual_rows,
            loops: draft.loops,
            estimated_cost: draft.estimated_cost,
            actual_time_ms: draft.actual_time_ms,
            weight: 0.0,
            facts: draft.facts,
        });
        for child in draft.children {
            walk(child, Some(id), depth + 1, basis, nodes, owns);
        }
    }
    for root in roots {
        walk(root, None, 0, basis, &mut nodes, &mut owns);
    }
    let total: f64 = owns.iter().sum();
    if total > 0.0 {
        for (node, own) in nodes.iter_mut().zip(owns) {
            node.weight = (own / total).clamp(0.0, 1.0);
        }
    }
    QueryPlan {
        format,
        analyzed,
        weight_basis: basis,
        nodes,
        summary,
        raw,
    }
}

/// Parses what a driver read into the model.
pub fn parse(raw: RawPlan, analyzed: bool) -> Result<QueryPlan, YadbeError> {
    match raw {
        RawPlan::PostgresJson(text) => postgres::parse(&text, analyzed),
        RawPlan::ShowplanXml(documents) => mssql::parse(&documents, analyzed),
        RawPlan::MysqlJson(text) => mysql::parse_json(&text, analyzed),
        RawPlan::MysqlTree(text) => Ok(mysql::parse_tree(&text)),
        RawPlan::SqliteRows(rows) => Ok(sqlite::parse(&rows)),
    }
}

/// A plan the engine sent that yadbe cannot read.
pub(crate) fn unreadable(what: &str, detail: impl AsRef<str>) -> YadbeError {
    YadbeError::internal(format!("cannot read the {what} plan: {}", detail.as_ref()))
}

/// A number as JSON or XML gives it.
pub(crate) fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `12.5` → `12.5`, `3.0` → `3`.
pub(crate) fn show(value: f64) -> String {
    crate::db::value::format_float(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_are_shares_of_own_work() {
        let mut root = Draft::new("Join");
        root.estimated_cost = Some(100.0);
        let mut a = Draft::new("Scan a");
        a.estimated_cost = Some(70.0);
        let mut b = Draft::new("Scan b");
        b.estimated_cost = Some(10.0);
        root.children = vec![a, b];
        let plan = finish(
            PlanFormat::PostgresJson,
            false,
            vec![root],
            vec![],
            String::new(),
        );
        assert_eq!(plan.weight_basis, PlanWeightBasis::Cost);
        let weights: Vec<f64> = plan.nodes.iter().map(|n| n.weight).collect();
        assert_eq!(weights, [0.2, 0.7, 0.1]);
        assert_eq!(plan.nodes[2].parent, Some(0));
        assert_eq!(plan.nodes[2].depth, 1);
    }
}
