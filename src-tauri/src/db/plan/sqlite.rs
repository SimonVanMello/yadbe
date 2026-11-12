//! SQLite `EXPLAIN QUERY PLAN`: rows of `(id, parent, detail)`. SQLite gives no cost or
//! row estimate, so weights are a heuristic: a full scan weighs most, a temporary B-tree
//! (sort, distinct) half, an index search little.

use super::{Draft, PlanFormat, QueryPlan, finish};

/// One row of `EXPLAIN QUERY PLAN`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlitePlanRow {
    pub id: i64,
    pub parent: i64,
    pub detail: String,
}

fn heuristic(detail: &str) -> f64 {
    let upper = detail.to_ascii_uppercase();
    if upper.starts_with("SCAN ") {
        if upper.contains(" USING ") { 0.5 } else { 1.0 }
    } else if upper.starts_with("USE TEMP B-TREE") {
        0.5
    } else if upper.starts_with("SEARCH ") {
        0.1
    } else {
        0.0
    }
}

fn draft(row: &SqlitePlanRow) -> Draft {
    let detail = row.detail.trim();
    let mut draft = Draft::new(detail);
    let mut words = detail.split_whitespace();
    let verb = words.next().unwrap_or_default().to_ascii_uppercase();
    if verb == "SCAN" || verb == "SEARCH" {
        draft.relation = words.next().map(str::to_owned);
        let rest: Vec<&str> = detail.split_whitespace().collect();
        if let Some(at) = rest.iter().position(|w| w.eq_ignore_ascii_case("INDEX")) {
            draft.index = rest.get(at + 1).map(|w| (*w).to_owned());
        } else if detail.to_ascii_uppercase().contains("INTEGER PRIMARY KEY") {
            draft.index = Some("INTEGER PRIMARY KEY".to_owned());
        }
        if let Some(open) = detail.find('(') {
            draft.detail = Some(detail[open..].to_owned());
        }
    }
    draft.heuristic = heuristic(detail);
    draft
}

fn attach(rows: &[SqlitePlanRow], parent: i64) -> Vec<Draft> {
    rows.iter()
        .filter(|row| row.parent == parent && row.id != parent)
        .map(|row| {
            let mut node = draft(row);
            node.children = attach(rows, row.id);
            node
        })
        .collect()
}

pub(super) fn parse(rows: &[SqlitePlanRow]) -> QueryPlan {
    let known: std::collections::HashSet<i64> = rows.iter().map(|r| r.id).collect();
    // Roots: parent 0, or a parent SQLite did not list.
    let mut roots = Vec::new();
    for row in rows {
        if row.parent == 0 || !known.contains(&row.parent) {
            let mut node = draft(row);
            node.children = attach(rows, row.id);
            roots.push(node);
        }
    }
    let raw = render(rows);
    finish(PlanFormat::SqliteRows, false, roots, Vec::new(), raw)
}

/// The rows as the `sqlite3` shell prints them (`QUERY PLAN`, `|--`, `` `-- ``).
fn render(rows: &[SqlitePlanRow]) -> String {
    let mut out = String::from("QUERY PLAN");
    fn walk(rows: &[SqlitePlanRow], parent: i64, prefix: &str, out: &mut String) {
        let children: Vec<&SqlitePlanRow> = rows
            .iter()
            .filter(|r| r.parent == parent && r.id != parent)
            .collect();
        for (i, row) in children.iter().enumerate() {
            let last = i + 1 == children.len();
            out.push('\n');
            out.push_str(prefix);
            out.push_str(if last { "`--" } else { "|--" });
            out.push_str(&row.detail);
            let next = format!("{prefix}{}", if last { "   " } else { "|  " });
            walk(rows, row.id, &next, out);
        }
    }
    walk(rows, 0, "", &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::plan::PlanWeightBasis;

    fn row(id: i64, parent: i64, detail: &str) -> SqlitePlanRow {
        SqlitePlanRow {
            id,
            parent,
            detail: detail.to_owned(),
        }
    }

    #[test]
    fn builds_the_tree_and_weighs_full_scans() {
        // `EXPLAIN QUERY PLAN SELECT … FROM orders o JOIN customers c ON … WHERE o.id IN
        // (SELECT …) ORDER BY o.total` on SQLite 3.46.
        let rows = vec![
            row(3, 0, "SCAN o"),
            row(5, 0, "LIST SUBQUERY 1"),
            row(7, 5, "SCAN items USING COVERING INDEX items_order"),
            row(15, 0, "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"),
            row(20, 0, "USE TEMP B-TREE FOR ORDER BY"),
        ];
        let plan = parse(&rows);
        assert_eq!(plan.weight_basis, PlanWeightBasis::Heuristic);
        assert_eq!(plan.nodes.len(), 5);
        assert_eq!(plan.nodes[0].relation.as_deref(), Some("o"));
        assert_eq!(plan.nodes[2].parent, Some(1));
        assert_eq!(plan.nodes[2].index.as_deref(), Some("items_order"));
        assert_eq!(plan.nodes[3].detail.as_deref(), Some("(rowid=?)"));
        assert!(plan.nodes[0].weight > plan.nodes[2].weight);
        assert!(plan.raw.contains("`--USE TEMP B-TREE FOR ORDER BY"));
    }
}
